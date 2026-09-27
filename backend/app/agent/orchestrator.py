"""Minimal Agent Loop (Tool Calling Loop).

[P0] 所谓 Agent Loop，就是一个「决策 → 执行 → 观察 → 再决策」的循环：

    while 还没结束且还有预算:
        decision = LLM(上下文)             # 模型决定：用工具，还是给答案
        if decision 是最终答案: 结束
        result = 本地执行工具(decision)      # 真正干活的是我们的代码
        上下文 += [模型的决策, 工具结果]      # 结果回到上下文，下一轮模型能看见
"""

from __future__ import annotations

import json
import logging
import time
import uuid

from app.agent.prompts import build_agent_messages, build_force_answer_message
from app.agent.schemas import (
    AgentDecision,
    AgentRunResult,
    AgentStepRecord,
    ToolCallRecord,
)
from app.core.config import get_settings
from app.core.security import wrap_untrusted_block
from app.llm.client import LLMClient
from app.llm.errors import LLMError
from app.llm.schemas import ChatMessage, LLMRequest, TokenUsage
from app.tools.base import ToolContext, ToolResult
from app.tools.registry import ToolNotFoundError, ToolRegistry

logger = logging.getLogger(__name__)


def _sum_usage(accumulator: TokenUsage, other: TokenUsage) -> None:
    accumulator.prompt_tokens += other.prompt_tokens
    accumulator.completion_tokens += other.completion_tokens
    accumulator.total_tokens += other.total_tokens


def _preview(text: str, limit: int = 500) -> str:
    return text[:limit] + ("…" if len(text) > limit else "")


async def run_agent(
    *,
    question: str,
    client: LLMClient,
    registry: ToolRegistry,
    max_steps: int | None = None,
    total_timeout_seconds: float | None = None,
) -> AgentRunResult:
    """执行一个最小的 Tool Calling 循环。

    [P0] 三条防失控设计：
    1. max_steps：限制轮数，防止模型陷入死循环
    2. total_timeout_seconds：整个 run 的墙钟时间上限
    3. 工具层的 timeout + 异常兜底：单个工具失败不会让循环崩溃
    """
    settings = get_settings()
    max_steps = max_steps or settings.agent_max_steps
    total_timeout_seconds = total_timeout_seconds or settings.agent_total_timeout_seconds

    run_id = uuid.uuid4().hex[:12]
    started = time.perf_counter()

    messages = build_agent_messages(question, registry.function_schemas(), max_steps)
    steps: list[AgentStepRecord] = []
    tool_calls: list[ToolCallRecord] = []
    usage = TokenUsage()

    async def _ask(llm_messages: list[ChatMessage]) -> tuple[AgentDecision, TokenUsage]:
        request = LLMRequest(
            messages=llm_messages,
            response_format={"type": "json_object"},
            purpose="agent_step",
            metadata={"run_id": run_id},
        )
        result = await client.complete_structured(request, AgentDecision)
        return result.data, result.response.usage

    finished_reason = "max_steps_reached"
    answer = ""
    citations: dict[str, dict] = {}  # chunk_id -> citation，用于去重
    # 「模型输出不符合 schema」的次数。达到上限才放弃，避免无限空转。
    parse_failures = 0
    max_parse_failures = 2

    for step_index in range(1, max_steps + 1):
        elapsed = time.perf_counter() - started
        if elapsed > total_timeout_seconds:
            logger.warning("agent run timeout: run_id=%s elapsed=%.1fs", run_id, elapsed)
            finished_reason = "timeout"
            break

        try:
            decision, step_usage = await _ask(messages)
        except LLMError as exc:
            # [robustness] 「模型输出不符合 schema」是**可修复**的：把原因回灌、本步作废重来，
            # 而不是把整次运行判成"大模型调用失败"（502）。小模型（GLM-4-Flash 等）
            # 偶发不守 JSON 约定是常态，不该升级成服务不可用。
            # 只对 parse 类失败这样做；连接/鉴权等真实故障仍然向上抛。
            if exc.kind != "parse" or parse_failures >= max_parse_failures:
                raise
            parse_failures += 1
            logger.warning(
                "agent 第 %s 步输出不合法（%s/%s），回灌原因重来：%s",
                step_index,
                parse_failures,
                max_parse_failures,
                exc.message,
            )
            messages.append(
                ChatMessage(
                    role="user",
                    content=(
                        "你上一步的输出没有通过 JSON 校验，原因："
                        + exc.message
                        + '。请只输出一个合法 JSON：要么 {"action": {...}}，'
                        '要么 {"final_answer": "..."}，二选一，不要多余文字或代码块。'
                    ),
                )
            )
            continue
        _sum_usage(usage, step_usage)

        # 分支一：模型认为可以结束了
        if decision.final_answer:
            steps.append(
                AgentStepRecord(index=step_index, final_answer=decision.final_answer)
            )
            answer = decision.final_answer
            finished_reason = "final_answer"
            break

        action = decision.action
        if action is None:  # 理论上被 schema 校验挡住了，这里只是防御
            finished_reason = "llm_error"
            break

        # 分支二：模型提名了一个工具 —— 执行权在我们手里
        try:
            tool = registry.get(action.tool)
        except ToolNotFoundError as exc:
            # 模型编造了工具名：不崩溃，把错误当观察结果回灌，让它自己纠正
            logger.warning("agent proposed unknown tool: %s", action.tool)
            result = ToolResult(
                ok=False,
                tool=action.tool,
                error=str(exc),
                error_kind="blocked",
                summary="被拒绝",
            )
            observation = result.to_observation()
        else:
            ctx = ToolContext(
                run_id=run_id,
                max_output_chars=settings.tool_output_max_chars,
                allowed_domains=settings.fetch_allowed_domains_list,
                step_index=step_index,
            )
            result = await tool.execute(action.args, ctx)
            # [P0] 外部内容必须标记为不可信数据后再进上下文
            observation = wrap_untrusted_block(result.to_observation())

        record = ToolCallRecord(
            index=len(tool_calls) + 1,
            tool=result.tool,
            args=action.args,
            ok=result.ok,
            error=result.error,
            error_kind=result.error_kind,
            output_preview=_preview(result.output),
            duration_ms=result.duration_ms,
        )
        tool_calls.append(record)
        steps.append(
            AgentStepRecord(index=step_index, reason=action.reason, tool_call=record)
        )

        # 收集引用：同一个 chunk 被多次检索到只保留一条
        for citation in result.citations:
            chunk_id = citation.get("chunk_id")
            if chunk_id and chunk_id not in citations:
                citations[chunk_id] = citation

        # [P0] Tool Result 如何重新进入上下文：
        # 把「模型的决策」和「工具结果」各追加一条消息，下一轮 LLM 就能看到。
        # 这里用 user 角色承载 observation，因为各家模型对 tool 角色的支持不一致。
        messages.append(
            ChatMessage(
                role="assistant",
                content=json.dumps(
                    {"action": {"tool": action.tool, "args": action.args}},
                    ensure_ascii=False,
                ),
            )
        )
        messages.append(ChatMessage(role="user", content=observation))

    # 步数或时间用尽仍未给出答案 → 强制让模型收尾
    if not answer:
        messages.append(build_force_answer_message())
        try:
            decision, step_usage = await _ask(messages)
            _sum_usage(usage, step_usage)
            answer = decision.final_answer or "（模型未能在限定步数内给出结论）"
        except Exception as exc:  # noqa: BLE001 - 收尾阶段失败也要返回结果
            logger.exception("force answer failed: run_id=%s", run_id)
            answer = f"（生成结论失败：{exc}）"
            finished_reason = "llm_error"

    return AgentRunResult(
        question=question,
        answer=answer,
        steps=steps,
        tool_calls=tool_calls,
        finished_reason=finished_reason,
        citations=list(citations.values()),
        usage=usage.model_dump(),
        latency_ms=int((time.perf_counter() - started) * 1000),
        mock=client.provider_name == "mock",
    )

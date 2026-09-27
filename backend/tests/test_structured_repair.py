"""结构化输出「修复重试」与 AgentDecision 收敛行为的测试。

对应线上问题：小模型（GLM-4-Flash）违反「二选一」约束时，整条链路直接
报「大模型调用失败」。修复后：能救则救（收敛），救不了再带修复提示重试一次。

跑法（在 backend/ 目录下）：
    .venv/Scripts/python.exe -m pytest tests/test_structured_repair.py
"""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from app.agent.orchestrator import run_agent
from app.agent.schemas import AgentDecision
from app.llm.client import BaseLLMClient
from app.llm.errors import LLMError
from app.llm.schemas import ChatMessage, LLMRequest, LLMResponse, TokenUsage
from app.llm.structured import parse_structured_payload
from app.tools.registry import build_default_registry

# ---------------------------------------------------------------------------
# AgentDecision：二选一的收敛
# ---------------------------------------------------------------------------


def test_both_present_keeps_final_answer_and_drops_action():
    decision = AgentDecision(
        action={"tool": "search_web", "args": {"query": "x"}},
        final_answer="这是结论",
    )
    assert decision.final_answer == "这是结论"
    assert decision.action is None  # 丢弃 action，保留模型已产出的答案


def test_action_only_passes_through():
    decision = AgentDecision(action={"tool": "search_web", "args": {"query": "x"}})
    assert decision.action is not None
    assert decision.final_answer is None


def test_final_answer_only_passes_through():
    decision = AgentDecision(final_answer="结论")
    assert decision.action is None
    assert decision.final_answer == "结论"


def test_whitespace_answer_is_treated_as_absent():
    # 空白 answer + action → 视为「只给了 action」
    decision = AgentDecision(action={"tool": "search_web", "args": {}}, final_answer="   ")
    assert decision.action is not None


def test_both_empty_raises_retryable_style_error():
    with pytest.raises(ValidationError) as exc:
        AgentDecision()
    assert "必须二选一" in str(exc.value)


# ---------------------------------------------------------------------------
# 错误信息可读性
# ---------------------------------------------------------------------------


def test_error_message_has_no_leading_colon():
    """model 级校验（loc 为空）不应产生 "…schema：: Value error…" 的双冒号。"""
    with pytest.raises(LLMError) as exc:
        parse_structured_payload('{"foo": 1}', AgentDecision)
    assert "必须二选一" in exc.value.message
    assert "：:" not in exc.value.message
    assert ": Value error" not in exc.value.message


# ---------------------------------------------------------------------------
# complete_structured：带修复提示重试
# ---------------------------------------------------------------------------


class _ScriptedClient(BaseLLMClient):
    """按脚本逐次返回内容的假 client，用于测重试路径。"""

    provider_name = "scripted"

    def __init__(self, outputs: list[str], *, finish_reason: str = "stop") -> None:
        self._outputs = list(outputs)
        self._finish_reason = finish_reason
        self.requests: list[LLMRequest] = []

    async def complete(self, request: LLMRequest) -> LLMResponse:
        self.requests.append(request)
        content = self._outputs.pop(0)
        return LLMResponse(
            content=content,
            model="scripted",
            usage=TokenUsage(),
            latency_ms=0,
            finish_reason=self._finish_reason,
            provider="scripted",
        )


async def test_repairs_after_invalid_output():
    client = _ScriptedClient(['{"action": {}}', '{"final_answer": "ok"}'])
    request = LLMRequest(messages=[ChatMessage(role="user", content="q")], purpose="agent_step")

    result = await client.complete_structured(request, AgentDecision)

    assert result.data.final_answer == "ok"
    assert len(client.requests) == 2  # 首次失败 + 带修复提示重试一次
    # 第二次请求末尾应带上「上次失败原因」的修复提示
    assert "没有通过 JSON 校验" in client.requests[1].messages[-1].content


async def test_gives_up_after_exhausting_attempts():
    client = _ScriptedClient(['{"foo": 1}', '{"bar": 2}'])
    request = LLMRequest(messages=[ChatMessage(role="user", content="q")], purpose="agent_step")

    with pytest.raises(LLMError) as exc:
        await client.complete_structured(request, AgentDecision)

    assert exc.value.kind == "parse"
    assert len(client.requests) == 2  # 用完次数才放弃


async def test_truncation_is_not_retried():
    """被 max_tokens 截断是唯一不重试的情况：重试也不会变好。"""
    client = _ScriptedClient(["这不是 JSON"], finish_reason="length")
    request = LLMRequest(messages=[ChatMessage(role="user", content="q")], purpose="agent_step")

    with pytest.raises(LLMError) as exc:
        await client.complete_structured(request, AgentDecision)

    assert exc.value.kind == "truncated"
    assert len(client.requests) == 1  # 不重试


# ---------------------------------------------------------------------------
# 智能体循环：模型不守规矩时不把整次运行判死
# ---------------------------------------------------------------------------


async def test_agent_survives_invalid_output_and_still_answers():
    """模型输出不合法 → 回灌原因重来；随后给对答案即正常结束（不 502）。"""
    # 前两次 complete 返回不合法（被 complete_structured 的 repair 用掉），第三次给出答案
    client = _ScriptedClient(["{}", "{}", '{"final_answer": "ok"}'])

    result = await run_agent(
        question="q",
        client=client,
        registry=build_default_registry(),
        max_steps=4,
    )

    assert result.finished_reason == "final_answer"
    assert result.answer == "ok"

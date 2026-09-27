"""Agent decision & trace schemas.

[P0] 这里有两类模型：
1. AgentDecision —— **模型每轮要输出的结构**（约束模型）
2. *Record —— **我们记录的轨迹**（给前端展示、给未来的 Evaluation 用）

区分它们很重要：前者要尽可能严格（防止模型乱来），后者要尽可能完整（方便排查）。
"""

from __future__ import annotations

import logging

from pydantic import BaseModel, Field, model_validator

logger = logging.getLogger(__name__)


class ToolCallRequest(BaseModel):
    """模型提名的一次工具调用。注意：只是「提名」，能不能执行由 Registry 决定。"""

    tool: str = Field(description="工具名称，必须是可用工具之一")
    args: dict = Field(default_factory=dict, description="工具参数，必须符合该工具的 schema")
    reason: str = Field(default="", max_length=300, description="为什么在这一步用这个工具")


class AgentDecision(BaseModel):
    """模型每一步的输出：要么调用一个工具，要么给出最终答案。"""

    action: ToolCallRequest | None = None
    final_answer: str | None = None

    @model_validator(mode="after")
    def _resolve_choice(self) -> AgentDecision:
        """[P0] 把「既要又要 / 都不要」**收敛成一个确定选择**，能救则救。

        线上实测：小模型（GLM-4-Flash 这类）经常违反「二选一」约束。此前这里直接
        抛异常 → 整个节点失败 → 接口回一句"大模型调用失败"。把「模型不够听话」变成
        「服务不可用」是不对的，所以改成：

        - **同时给了 action 与 final_answer**：保留 `final_answer`、丢弃 `action`。
          理由：模型已经产出了结论，丢掉它最可惜；提前结束这一步是**可恢复**的
          （研究图里 verify→research 的回环会把证据不足打回来补查），
          而丢掉答案在「强制收尾」路径上只能给用户一句占位文案。
        - **两个都空**：无法凭空造出内容，抛**可重试**错误，
          交由 `BaseLLMClient.complete_structured` 的 repair 重试再要一次。

        无论走哪条，都只在 action / final_answer 恰好有一个时通过，下游 `has_action`
        这类判断因此永远只看一个分支。
        """
        has_action = self.action is not None
        has_answer = bool(self.final_answer and self.final_answer.strip())

        if has_action and has_answer:
            logger.warning(
                "AgentDecision 同时给出 action 与 final_answer，已保留 final_answer、丢弃 action"
            )
            self.action = None
        elif not has_action and not has_answer:
            raise ValueError(
                "必须二选一：要么调用一个工具(action)，要么给出最终答案(final_answer)；"
                "当前两者都为空"
            )
        return self


class ToolCallRecord(BaseModel):
    """一次工具调用的完整记录（可观测性的原子单位）。"""

    index: int
    tool: str
    args: dict
    ok: bool
    error: str | None = None
    error_kind: str | None = None  # invalid_args | timeout | execution_error | blocked
    output_preview: str = ""
    duration_ms: int = 0


class AgentStepRecord(BaseModel):
    """Agent 循环中的一步。"""

    index: int
    reason: str | None = None
    tool_call: ToolCallRecord | None = None
    final_answer: str | None = None


class AgentRunResult(BaseModel):
    """一次 Agent 运行的最终结果 + 完整轨迹。"""

    question: str
    answer: str
    steps: list[AgentStepRecord]
    tool_calls: list[ToolCallRecord]
    finished_reason: str  # final_answer | max_steps_reached | timeout | llm_error
    # 本次运行中，工具实际引用到的来源（document_id / chunk_id / page / quote）
    citations: list[dict] = []
    usage: dict
    latency_ms: int
    mock: bool

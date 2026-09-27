"""Research domain schemas.

[P0] ResearchPlan 是本阶段的核心数据结构：
它既是「LLM 的输出约束」（通过 model_json_schema 传给模型），
也是「前端要渲染的结构」，还是「后面 Agent 要执行的输入」。
一处定义，三处复用 —— 这就是用 Pydantic 建模的收益。
"""

from __future__ import annotations

from pydantic import BaseModel, Field, field_validator, model_validator


class PlanStep(BaseModel):
    """研究计划中的一步。"""

    index: int = Field(default=1, ge=1, description="步骤序号，从 1 开始")
    title: str = Field(default="", min_length=1, max_length=100, description="步骤标题")
    instruction: str = Field(
        default="", min_length=1, max_length=500, description="这一步具体要做什么"
    )

    @field_validator("title", "instruction", mode="before")
    @classmethod
    def _ensure_str(cls, value: object) -> str:
        return str(value) if value is not None else ""


class ResearchPlan(BaseModel):
    """一份研究计划。

    [P0] 四个字段全部必填：模型漏掉任何一个都视为「输出不符合 schema」，
    由上层决定是否重试。这样能保证前端拿到的 plan 一定有目标、子问题、步骤与来源。
    """

    goal: str = Field(min_length=1, max_length=500, description="这项研究要达成的目标")
    questions: list[str] = Field(description="需要回答的子问题")
    steps: list[PlanStep] = Field(description="有序的执行步骤")
    expected_sources: list[str] = Field(description="期望的来源类型（不要写具体 URL）")

    @field_validator("goal", mode="before")
    @classmethod
    def _ensure_goal(cls, value: object) -> str:
        return str(value) if value is not None else ""

    @field_validator("questions", "expected_sources", mode="before")
    @classmethod
    def _coerce_str_list(cls, value: object) -> list[str]:
        if value is None:
            return []
        if isinstance(value, str):
            return [value] if value.strip() else []
        if isinstance(value, list):
            return [str(item) for item in value if item is not None]
        return []

    @field_validator("steps", mode="before")
    @classmethod
    def _normalize_steps(cls, value: object) -> list[dict]:
        if value is None:
            return []
        if isinstance(value, dict):
            # 模型偶尔把 steps 包成 {"step": [...]} 之类的 dict，尝试兜底
            for key in ("steps", "items", "list"):
                if key in value:
                    value = value[key]
                    break
            else:
                return []
        if not isinstance(value, list):
            return []
        normalized: list[dict] = []
        for i, item in enumerate(value, start=1):
            if not isinstance(item, dict):
                continue
            title = str(item.get("title", "") or f"步骤 {i}")
            instruction = str(item.get("instruction", "") or "模型未给出具体说明")
            normalized.append(
                {
                    "index": item.get("index") if item.get("index") is not None else i,
                    "title": title,
                    "instruction": instruction,
                }
            )
        return normalized

    @model_validator(mode="after")
    def _plan_must_have_content(self) -> ResearchPlan:
        """[B22] 空计划判为不合规，交给上层 repair 重试。

        questions / steps 只是 list 没有 min_length：模型偶尔输出
        {"goal": "...", "questions": [], "steps": [], "expected_sources": []}，
        校验能过，但前端只能渲染出一张「计划概览」卡片，
        用户看到的就是"根本没有展示出计划是什么"。
        这里把空计划变成校验失败，planning_service / complete_structured
        的 repair 机制会把具体缺失回灌给模型重来。
        """
        missing: list[str] = []
        if not self.questions:
            missing.append("questions（需要 4~7 个关键子问题）")
        if not self.steps:
            missing.append("steps（需要按 index/title/instruction 给出的有序执行步骤）")
        if missing:
            raise ValueError(
                "计划内容缺失：" + "、".join(missing) + "。请补全后重新输出完整 JSON。"
            )
        # [B24] 只拆出 1~2 个子问题等于没拆 —— 用户看到的就是"把问题复述了一遍"。
        # 判为不合规让 repair 把这条要求回灌给模型（prompt 里要求 4~7 个，这里守底线 3 个）。
        if len(self.questions) < 3:
            raise ValueError(
                f"关键子问题太少（只有 {len(self.questions)} 个）："
                "请从现状/对比/数据/原因/风险等不同维度至少拆出 4 个子问题。"
            )
        return self


class PlanRequest(BaseModel):
    """POST /api/research/plan 的请求体。"""

    question: str = Field(
        min_length=8,
        max_length=2000,
        description="用户的研究问题",
        examples=["研究 2026 年 AI Agent 开发岗位的主要技术要求"],
    )
    max_steps: int = Field(default=6, ge=3, le=10, description="计划最多包含几步")


class PlanResponse(BaseModel):
    """POST /api/research/plan 的响应 data。"""

    plan: ResearchPlan
    model: str
    provider: str
    # 明确告诉前端「这是假数据」，避免把 Mock 结果当成真实模型输出
    mock: bool
    usage: dict
    latency_ms: int
    # [B27] 落库后的记录 id（历史规划列表用）；落库失败时为空
    plan_id: str | None = None

"""Research graph API schemas."""

from __future__ import annotations

from pydantic import BaseModel, Field


class ResearchRunRequest(BaseModel):
    question: str = Field(min_length=8, max_length=2000)
    max_iterations: int = Field(default=3, ge=1, le=8)
    max_verify_attempts: int = Field(default=2, ge=1, le=4)
    # [B14] thread_id 由调用方（前端）生成以便「先订阅 SSE 再启动运行」，
    # 但必须是 thread_ + 12 位十六进制，避免任意字符串污染命名空间、
    # 或被用来撞/覆盖别人的运行（当前没有鉴权，这层格式校验是最小防线）。
    thread_id: str | None = Field(
        default=None,
        pattern=r"^thread_[0-9a-f]{12}$",
        description="留空则新建一次运行；自定义时格式必须为 thread_<12 位十六进制>",
    )


class ResumeRequest(BaseModel):
    approved: bool = Field(default=True, description="false = 人工拒绝，终止本次运行")
    feedback: str | None = Field(
        default=None, max_length=1000, description="人工意见，会进入 write 节点的 prompt"
    )


class ResearchRunResponse(BaseModel):
    thread_id: str
    status: str  # running | awaiting_approval | completed | cancelled | failed
    question: str
    understanding: dict | None = None
    plan: dict | None = None
    analysis: dict | None = None
    verification: dict | None = None
    report: dict | None = None
    steps: list[dict] = []
    tool_calls: list[dict] = []
    citations: list[dict] = []
    # 供 UI 展示的「依据来源」（由后端 app/graph/sources.py 解析产出，前端只渲染）。
    # 每条：{origin: 'web'|'knowledge', title, url, snippet, source}
    # ⚠️ 这个字段**永远存在**（没有来源时是 []），否则前端要写两套分支。
    sources: list[dict] = []
    evidence_count: int = 0
    iteration: int = 0
    verify_attempts: int = 0
    usage_total_tokens: int = 0
    error: str | None = None
    finished_reason: str = ""
    # ---- 搜索配额（T02 向后兼容契约）----
    # 这些字段**永远存在**：配额充裕时就是 0 / 0 / false / None / []，
    # 不是「没有这一项」。否则前端要为「有没有字段」写两套分支。
    credits_used: int = 0  # 本次 run 消耗的搜索积分
    search_calls: int = 0  # 本次 run 的搜索调用次数
    degraded: bool = False  # 本次 run 是否因额度不足而降级
    degraded_reason: str | None = None
    warnings: list[str] = Field(default_factory=list)

"""LLM request/response schemas.

[P0] 这一层是「我们和 LLM 之间的契约」：
上层（Planner / Writer）只构造 LLMRequest、消费 LLMResponse，
不关心底层是 OpenAI、DeepSeek 还是 Mock。
"""

from __future__ import annotations

from typing import Any, Generic, Literal, TypeVar

from pydantic import BaseModel, Field

# 消息角色只有这三种。用 Literal 而不是 str，写错角色时 Pydantic 会直接报错。
Role = Literal["system", "user", "assistant"]


class ChatMessage(BaseModel):
    """一条对话消息。

    [P0] system / user / assistant 的区别：
    - system：给模型的「角色设定与规则」，优先级最高，用户看不到
    - user：用户说的话（本项目中也包括我们拼装的任务输入）
    - assistant：模型之前说过的话（多轮对话时用来带上下文）
    """

    role: Role
    content: str


class LLMRequest(BaseModel):
    """一次 LLM 调用的输入。"""

    messages: list[ChatMessage]
    model: str | None = Field(default=None, description="覆盖默认模型")
    temperature: float = Field(default=0.2, ge=0.0, le=2.0)
    # 单次生成上限（token）。None = 交给 client 的默认值
    # （OpenAI 兼容 → Settings.llm_max_tokens；Ollama → OLLAMA_NUM_PREDICT）。
    #
    # [P0] 这里曾经写死 2000，导致 `LLM_MAX_TOKENS` / `OLLAMA_NUM_PREDICT`
    # 成了**死配置**：图节点与 Agent 构造 LLMRequest 时都没有显式传这个字段，
    # 于是无论 .env 配 4096 还是 8192，线上每一次调用实际都被 2000 截断 ——
    # 表现为长报告 JSON 被腰斩、结构化解析失败、写完报告前的 repair 反复重试。
    max_tokens: int | None = Field(default=None, gt=0)

    # 结构：{"type": "json_object"} 要求模型输出合法 JSON
    response_format: dict[str, Any] | None = None

    # 调用目的，用于日志与后续成本核算（planning / extraction / writing ...）
    purpose: str = "chat"

    # 追踪信息（task_id 等），只进日志，不进 prompt
    metadata: dict[str, Any] = Field(default_factory=dict)

    # ---- 统一模型层新增（换模型时这几个字段是「适配面」）----
    # 是否走流式。False 不影响正确性，只影响体感延迟；
    # 不支持流式的 provider（Mock / 部分兼容层）会自动退化为一次性返回。
    stream: bool = False
    # 厂商私有参数透传（Ollama 的 num_ctx / keep_alive / think 等）。
    # 放在这里而不是散进各处调用点，是为了让「换模型」只改 provider 一处。
    options: dict[str, Any] = Field(default_factory=dict)


class TokenUsage(BaseModel):
    """[P0] Token 用量。

    token 不是字符，也不是单词，而是模型用来计数的「片段」。
    中文通常 1 个字 ≈ 1~2 个 token。它直接决定两件事：
    1) 费用（输入 + 输出分别计价）
    2) 上下文长度上限（超出会被截断或报错）
    """

    prompt_tokens: int = 0
    completion_tokens: int = 0
    total_tokens: int = 0


class LLMResponse(BaseModel):
    """一次 LLM 调用的输出（已归一化，与具体厂商无关）。"""

    content: str
    model: str
    usage: TokenUsage
    latency_ms: int
    finish_reason: str | None = None
    # 厂商原始响应（调试用）；注意不要在这里放 API Key
    raw: dict[str, Any] | None = None
    # 实际作答的 provider（ollama / openai-compatible / mock）。
    # 有了它，UI 才能如实告诉用户「这次结论是本地 qwen3:8b 出的，还是云端兜底出的」。
    provider: str = ""


T = TypeVar("T", bound=BaseModel)


class StructuredResult(BaseModel, Generic[T]):
    """结构化调用的结果：既给解析后的对象，也给原始响应（含 token 与耗时）。"""

    data: T
    response: LLMResponse


class LLMStreamChunk(BaseModel):
    """流式输出的一块。

    为什么要单独定义、而不是直接 yield str：
    调用方（SSE / 前端打字机）除了增量文本，还需要知道「什么时候结束」以及
    「这次调用花了多少 token、耗时多少」。把收尾信息挂在最后一块上，
    就能保持「一个异步迭代器走到底」的简单用法，不用再回调一次拿统计。
    """

    text: str = ""
    done: bool = False
    # 仅最后一块（done=True）携带：完整的响应对象（含 content 全文与 usage）
    response: LLMResponse | None = None

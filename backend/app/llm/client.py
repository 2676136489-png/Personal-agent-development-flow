"""LLM clients.

[P0] 四个核心设计：

1. **Protocol（协议）而不是具体类**
   上层只依赖 `LLMClient` 这个接口，所以换厂商、换 Mock 都不用改业务代码。

2. **模板方法（BaseLLMClient）**
   `complete_structured()` 对所有实现都一样：先拿到文本 → 解析 → 校验。
   所以只有 `complete()` 需要每个厂商自己实现。

3. **工厂 + 依赖注入**
   `get_llm_client()` 决定用哪个实现，FastAPI 通过 `Depends` 注入，
   测试里可以一行替换成 Mock。

4. **统一的模型调用层（本次改造）**
   所有「模型相关」的差异被收进本文件的 provider 实现里：

   | provider            | 实现                     | 适用场景                    |
   |---------------------|--------------------------|-----------------------------|
   | `ollama`            | `OllamaClient`（原生 /api/chat） | **默认**：本地 qwen3:8b    |
   | `openai`            | `OpenAICompatibleClient` | DeepSeek / 通义 / 官方 OpenAI |
   | `mock`              | `MockLLMClient`          | 本地开发 / CI                |

   切换模型 = 改 `LLM_PROVIDER`（+ 对应的一组参数），业务代码零改动。
   `FallbackLLMClient` 负责「本地模型不可用 → 云端兜底」的链路，
   让换主模型这件事不会把线上功能打挂。
"""

from __future__ import annotations

import inspect
import json
import logging
import re
import time
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from functools import lru_cache
from typing import Protocol, TypeVar, runtime_checkable

import httpx
import openai
from pydantic import BaseModel
from tenacity import (
    AsyncRetrying,
    retry_if_exception,
    stop_after_attempt,
    wait_exponential,
)

from app.core.config import Settings, get_settings
from app.core.security import UNTRUSTED_BLOCK_BEGIN as OBSERVATION_MARKER
from app.llm.errors import LLMError
from app.llm.schemas import (
    ChatMessage,
    LLMRequest,
    LLMResponse,
    LLMStreamChunk,
    StructuredResult,
    TokenUsage,
)
from app.llm.structured import parse_structured_payload
from app.observability import metrics

logger = logging.getLogger(__name__)

T = TypeVar("T", bound=BaseModel)


@runtime_checkable
class LLMClient(Protocol):
    """LLM 能力的最小接口。"""

    provider_name: str

    async def complete(self, request: LLMRequest) -> LLMResponse: ...

    async def stream(self, request: LLMRequest) -> AsyncIterator[LLMStreamChunk]: ...

    async def complete_structured(
        self,
        request: LLMRequest,
        schema: type[T],
    ) -> StructuredResult[T]: ...


#: 结构化调用最多尝试几次（含首次）。第二次会带上一次的失败原因重试。
_STRUCTURED_MAX_ATTEMPTS = 2


def _with_repair_hint(request: LLMRequest, error: str) -> LLMRequest:
    """在原请求末尾追加一条「修复提示」，用于结构化输出的第二次尝试。

    保留原始 messages（模型需要看到原任务），只在末尾补一条纠正指令，
    并带上**上一次的具体校验失败原因** —— 否则模型只知道"你错了"，
    往往原样再错一次（与 graph plan 节点的手工 repair 同一经验）。
    """
    hint = (
        "你上一次的输出没有通过 JSON 校验。"
        f"具体原因：{error}\n"
        "请重新输出**一个**符合要求（字段名与类型完全正确、满足全部约束）的 JSON 对象："
        "不要输出任何解释文字，不要使用 ``` 代码块包裹。"
    )
    return request.model_copy(
        update={"messages": [*request.messages, ChatMessage(role="user", content=hint)]}
    )


class BaseLLMClient:
    """所有 client 共享的 structured / streaming 默认逻辑。"""

    provider_name: str = "base"

    async def complete(self, request: LLMRequest) -> LLMResponse:
        raise NotImplementedError

    async def stream(self, request: LLMRequest) -> AsyncIterator[LLMStreamChunk]:
        """流式输出的**兜底实现**：一次性算完，作为一个 chunk 吐出。

        为什么默认这样而不是抛异常：调用方（SSE 接口 / 前端打字机）不应该
        为「这个 provider 支不支持流式」写分支。不支持的实现自动退化成
        「一块吐完」，语义完全一致，只是没有渐进效果。
        真正支持流式的 provider（Ollama / OpenAI 兼容）会覆盖它。

        ⚠️ 即便一次性返回，也要遵守「若干增量块 + 一个收尾块」的协议：
        把正文塞进 done 块而不单独发 chunk 的话，调用方（SSE 路由 / 前端）
        只处理 chunk 事件就会把正文整个丢掉 —— Mock 环境下表现为"流式自测一片空白"。
        """
        response = await self.complete(request)
        if response.content:
            yield LLMStreamChunk(text=response.content)
        yield LLMStreamChunk(text="", done=True, response=response)

    async def complete_structured(
        self,
        request: LLMRequest,
        schema: type[T],
    ) -> StructuredResult[T]:
        """结构化调用：**失败会自动带修复提示重试一次**。

        [robustness] 这是「模型不够听话」与「服务失败」之间最重要的一道缓冲。
        此前 schema 校验一失败就直接抛，整条链路（研究 / 智能体）报"大模型调用失败"。
        实际上这类失败绝大多数是**可修复**的（少字段、字段名写错、二选一约束没满足），
        把上一次的具体失败原因回灌给模型再要一次，通常就对了（与 plan 节点的手工
        repair 同一思路，这里收敛成通用能力）。

        `finish_reason == "length"`（被 max_tokens 截断）是唯一**不重试**的情况：
        根因是 token 预算不够，重试 N 次也不会变好，必须给出可操作的错误信息。
        """
        last_error: LLMError | None = None
        for attempt in range(_STRUCTURED_MAX_ATTEMPTS):
            current = (
                request
                if attempt == 0
                else _with_repair_hint(request, last_error.message if last_error else "")
            )
            response = await self.complete(current)
            try:
                data = parse_structured_payload(response.content, schema)
            except LLMError as exc:
                # [B6] 输出被 max_tokens 截断时，解析失败的根因不是"模型乱写"，
                # 而是 token 预算不够（思考型模型尤其常见：推理过程会吃掉预算）。
                # 这种情况重试 N 次也不会变好，必须给出可操作的错误信息。
                if response.finish_reason == "length":
                    raise LLMError(
                        f"模型输出被 max_tokens 截断（finish_reason=length），"
                        f"结构化输出不完整，请调大 LLM_MAX_TOKENS。原始错误：{exc.message}",
                        kind="truncated",
                        retryable=False,
                    ) from exc
                if not exc.retryable or attempt == _STRUCTURED_MAX_ATTEMPTS - 1:
                    raise
                last_error = exc
                logger.warning(
                    "结构化输出校验失败（第 %s/%s 次），带修复提示重试：%s",
                    attempt + 1,
                    _STRUCTURED_MAX_ATTEMPTS,
                    exc.message,
                )
                continue
            return StructuredResult(data=data, response=response)

        raise LLMError("unreachable", kind="unknown", retryable=False)


def _is_ollama(base_url: str | None) -> bool:
    """判断上游是不是 Ollama。

    [B5] `keep_alive` / `think` 是 Ollama 的私有扩展字段。
    之前对所有 OpenAI 兼容厂商无条件下发，对 OpenAI / DeepSeek / 通义等
    属于未知字段，轻则被忽略、重则 400；而且实测 `think:false` 并不能
    真正关闭 qwen3 的思考（仍返回 reasoning），所以更要收窄作用范围。
    """
    lowered = (base_url or "").lower()
    return "11434" in lowered or "ollama" in lowered


class OpenAICompatibleClient(BaseLLMClient):
    """OpenAI 兼容协议的 client。

    之所以叫 Compatible：DeepSeek、通义千问、Moonshot、智谱、混元等都提供
    OpenAI 同构的 /chat/completions 接口，换 base_url + model 即可切换，
    业务代码零改动。
    """

    provider_name = "openai-compatible"

    def __init__(
        self,
        api_key: str,
        base_url: str | None,
        model: str,
        timeout_seconds: float,
        max_attempts: int,
        default_max_tokens: int = 4096,
    ) -> None:
        # 注意：api_key 只从这里传入，绝不写进日志
        self._client = openai.AsyncOpenAI(
            api_key=api_key,
            base_url=base_url or None,
            timeout=timeout_seconds,
            max_retries=0,  # SDK 自带重试关掉，统一由 tenacity 控制（便于记录每次重试）
        )
        self._model = model
        self._base_url = base_url
        self._timeout = timeout_seconds
        self._max_attempts = max_attempts
        # [P0] 调用点没显式指定 max_tokens 时用这个值（来自 Settings.llm_max_tokens）。
        # 没有它，LLM_MAX_TOKENS 就是死配置 —— 所有结构化输出会被默认值截断。
        self._default_max_tokens = default_max_tokens
        # [B5] 只对 Ollama 下发私有扩展字段
        self._ollama_extra_body = (
            {"keep_alive": 0, "think": False} if _is_ollama(base_url) else None
        )

    async def complete(self, request: LLMRequest) -> LLMResponse:
        payload: dict = {
            "model": request.model or self._model,
            "messages": [message.model_dump() for message in request.messages],
            "temperature": request.temperature,
            "max_tokens": request.max_tokens or self._default_max_tokens,
        }
        if request.response_format:
            payload["response_format"] = request.response_format
        if self._ollama_extra_body:
            payload["extra_body"] = self._ollama_extra_body

        retryer = AsyncRetrying(
            stop=stop_after_attempt(self._max_attempts),
            wait=wait_exponential(multiplier=1, min=1, max=8),
            # 只对「可重试」错误重试：认证失败、参数非法不重试
            retry=retry_if_exception(lambda exc: isinstance(exc, LLMError) and exc.retryable),
            reraise=True,
        )

        started = time.perf_counter()
        async for attempt in retryer:
            with attempt:
                try:
                    raw = await self._client.chat.completions.create(**payload)
                except Exception as exc:  # 统一把 SDK 异常翻译成 LLMError
                    llm_error = self._to_llm_error(exc)
                    logger.warning(
                        "LLM call failed (purpose=%s, attempt=%s): %s",
                        request.purpose,
                        attempt.retry_state.attempt_number,
                        llm_error,
                    )
                    raise llm_error from exc

                latency_ms = int((time.perf_counter() - started) * 1000)
                return self._to_response(raw, latency_ms)

        raise LLMError("unreachable", kind="unknown", retryable=False)

    @staticmethod
    def _to_llm_error(exc: Exception) -> LLMError:
        """把 openai SDK 的异常映射成我们自己的错误类型，并判定是否值得重试。"""
        if isinstance(exc, openai.APITimeoutError):
            return LLMError("调用超时", kind="timeout", retryable=True)
        if isinstance(exc, openai.APIConnectionError):
            return LLMError("网络连接失败", kind="connection", retryable=True)
        if isinstance(exc, openai.RateLimitError):
            return LLMError("被限流（429）", kind="rate_limit", status_code=429, retryable=True)
        if isinstance(exc, openai.AuthenticationError):
            return LLMError(
                "API Key 无效或已失效", kind="auth", status_code=401, retryable=False
            )
        if isinstance(exc, openai.APIStatusError):
            status = exc.status_code
            return LLMError(
                f"上游返回 {status}",
                kind="server" if status >= 500 else "invalid_request",
                status_code=status,
                retryable=status >= 500 or status == 429,
            )
        if isinstance(exc, openai.APIError):
            return LLMError(f"上游错误：{exc.message}", kind="upstream", retryable=True)
        return LLMError(f"未知错误：{exc}", kind="unknown", retryable=False)

    @staticmethod
    def _to_response(raw, latency_ms: int) -> LLMResponse:
        choice = raw.choices[0]
        usage = getattr(raw, "usage", None)
        return LLMResponse(
            content=choice.message.content or "",
            model=getattr(raw, "model", "unknown"),
            usage=TokenUsage(
                prompt_tokens=getattr(usage, "prompt_tokens", 0) or 0,
                completion_tokens=getattr(usage, "completion_tokens", 0) or 0,
                total_tokens=getattr(usage, "total_tokens", 0) or 0,
            ),
            latency_ms=latency_ms,
            finish_reason=getattr(choice, "finish_reason", None),
            provider=OpenAICompatibleClient.provider_name,
        )

    async def stream(self, request: LLMRequest) -> AsyncIterator[LLMStreamChunk]:
        """OpenAI 兼容层的真流式（增量 delta，末尾一块带 usage）。"""
        if not self._should_stream(request):
            async for chunk in super().stream(request):  # type: ignore[misc]
                yield chunk
            return

        payload: dict = {
            "model": request.model or self._model,
            "messages": [message.model_dump() for message in request.messages],
            "temperature": request.temperature,
            "max_tokens": request.max_tokens or self._default_max_tokens,
            "stream": True,
        }
        if request.response_format:
            payload["response_format"] = request.response_format
        if self._ollama_extra_body:
            payload["extra_body"] = self._ollama_extra_body

        started = time.perf_counter()
        pieces: list[str] = []
        finish_reason: str | None = None
        model = request.model or self._model
        usage = TokenUsage()
        try:
            # [FIX] openai 不同版本里 create(stream=True) 返回类型不一致：
            # 有的直接返回 AsyncStream（可 async with），有的 create 本身是协程
            # （需先 await 才拿到流对象）。用 isawaitable 兜底，两种版本都能跑。
            stream = self._client.chat.completions.create(**payload)
            if inspect.isawaitable(stream):
                stream = await stream
            async with stream:  # type: ignore[arg-type]
                async for event in stream:
                    if not event.choices:
                        # 部分兼容层会在末尾单独发一条只带 usage 的消息
                        usage = self._usage_from_stream(getattr(event, "usage", None), usage)
                        continue
                    delta = event.choices[0].delta
                    text = getattr(delta, "content", None) or ""
                    if text:
                        pieces.append(text)
                        yield LLMStreamChunk(text=text)
                    reason = getattr(event.choices[0], "finish_reason", None)
                    finish_reason = finish_reason or reason
                    model = getattr(event, "model", model) or model
        except Exception as exc:
            raise self._to_llm_error(exc) from exc

        content = "".join(pieces)
        response = LLMResponse(
            content=content,
            model=model,
            usage=usage,
            latency_ms=int((time.perf_counter() - started) * 1000),
            finish_reason=finish_reason,
            provider=self.provider_name,
        )
        yield LLMStreamChunk(text="", done=True, response=response)

    @staticmethod
    def _usage_from_stream(stream_usage: object, fallback: TokenUsage) -> TokenUsage:
        """流式末帧的 usage（部分兼容层只在最后一条消息里给）。"""
        if stream_usage is None:
            return fallback
        return TokenUsage(
            prompt_tokens=getattr(stream_usage, "prompt_tokens", 0) or 0,
            completion_tokens=getattr(stream_usage, "completion_tokens", 0) or 0,
            total_tokens=getattr(stream_usage, "total_tokens", 0) or 0,
        )

    @staticmethod
    def _should_stream(request: LLMRequest) -> bool:
        """是否走真流式。

        「要结构化 JSON」时不流式：半截 JSON 既没法增量解析，
        逐字吐出来在 UI 上也是噪音。流式只服务于正文生成（打字机效果）。
        """
        return not request.response_format


class OllamaClient(BaseLLMClient):
    """本地 Ollama（qwen3:8b）客户端，走 Ollama **原生** `/api/chat`。

    为什么不用 OpenAI 兼容层（`http://host:11434/v1`）来连 Ollama：

    1. `keep_alive`（模型常驻显存）、`think`（思考开关）、`num_ctx`（上下文窗口）
       这些**本地推理专属参数**在兼容层里要么不支持、要么行为不确定；
       而它们恰恰决定了本地 8B 模型的延迟与成功率。
    2. 兼容层对 `max_tokens` / `stop` / `format` 的映射各版本不一致，
       排障时看到的现象（"JSON 被截断"）与根因（num_predict 没生效）隔了一层。
    3. 原生接口把 `prompt_eval_count` / `eval_count` / `total_duration` 直接给出，
       token 统计不用再猜。

    与 OpenAI 兼容层的**差异适配**（都在本类内部消化，调用方无感）：

    | OpenAI 语义          | Ollama 原生字段                          |
    |----------------------|------------------------------------------|
    | `max_tokens`         | `options.num_predict`                    |
    | `temperature`        | `options.temperature`                    |
    | `response_format`    | `format: "json"`                         |
    | `top_p` 等           | `options.*`（经 `LLMRequest.options` 透传）|
    | （无对应）           | `keep_alive` / `think` / `num_ctx`       |
    """

    provider_name = "ollama"

    def __init__(
        self,
        base_url: str,
        model: str,
        *,
        timeout_seconds: float = 120.0,
        max_attempts: int = 3,
        keep_alive: str = "5m",
        think: bool = False,
        num_ctx: int = 8192,
        num_predict: int = 4096,
        client_factory: object | None = None,
    ) -> None:
        # 兼容两种写法：`http://host:11434` 与 `http://host:11434/v1`
        self._base_url = base_url.rstrip("/").removesuffix("/v1")
        self._model = model
        self._timeout = timeout_seconds
        self._max_attempts = max_attempts
        self._keep_alive = keep_alive
        self._think = think
        self._num_ctx = num_ctx
        self._num_predict = num_predict
        # 仅测试注入点（httpx.MockTransport）
        self._client_factory = client_factory
        # 共享 client（带连接池）。每次请求新建 AsyncClient 会丢掉 TCP 复用，
        # 高频调用下既慢又会产生大量 TIME_WAIT。
        self._shared_client: httpx.AsyncClient | None = None

    @asynccontextmanager
    async def _http(self) -> AsyncIterator[httpx.AsyncClient]:
        """取一个 httpx client：共享的（生产）或注入的（测试）。

        用上下文管理器是为了兼容两种生命周期：
        - 生产：共享 client 用完不关（否则连接池没意义）
        - 测试：注入的 client 用完要关（MockTransport 通常是一次性的）
        """
        if self._client_factory is not None:
            async with self._client_factory() as injected:  # type: ignore[operator]
                yield injected
            return

        if self._shared_client is None or self._shared_client.is_closed:
            self._shared_client = httpx.AsyncClient(
                timeout=self._timeout,
                limits=httpx.Limits(max_connections=8, max_keepalive_connections=4),
            )
        yield self._shared_client

    def _payload(self, request: LLMRequest, *, stream: bool) -> dict:
        """把统一的 LLMRequest 翻译成 Ollama 的请求体。"""
        options: dict = {
            "temperature": request.temperature,
            # Ollama 用 num_predict 表示「最多生成几个 token」。
            # 思考型模型（qwen3）的推理内容也吃这份预算，所以默认给到 4096。
            "num_predict": request.max_tokens or self._num_predict,
            "num_ctx": self._num_ctx,
        }
        # 调用点可以按需覆盖（例如某一步要更大的窗口）
        options.update({k: v for k, v in request.options.items() if k != "format"})

        payload: dict = {
            "model": request.model or self._model,
            "messages": [message.model_dump() for message in request.messages],
            "stream": stream,
            "keep_alive": self._keep_alive,
            "think": self._think,
            "options": options,
        }
        if request.response_format:
            # Ollama 的 JSON 模式：传 "json" 字符串；也支持直接传 JSON Schema 对象。
            # 这里统一降级为 "json"，schema 校验由我们自己的 parse_structured_payload 负责，
            # 不依赖上游的 schema 能力（兼容性更好）。
            payload["format"] = "json"
        return payload

    async def complete(self, request: LLMRequest) -> LLMResponse:
        payload = self._payload(request, stream=False)
        retryer = AsyncRetrying(
            stop=stop_after_attempt(self._max_attempts),
            wait=wait_exponential(multiplier=1, min=1, max=8),
            retry=retry_if_exception(lambda exc: isinstance(exc, LLMError) and exc.retryable),
            reraise=True,
        )

        started = time.perf_counter()
        async for attempt in retryer:
            with attempt:
                try:
                    async with self._http() as http:
                        resp = await http.post(f"{self._base_url}/api/chat", json=payload)
                except (httpx.TimeoutException, httpx.TransportError) as exc:
                    llm_error = self._to_llm_error(exc)
                    logger.warning(
                        "Ollama call failed (purpose=%s, attempt=%s): %s",
                        request.purpose,
                        attempt.retry_state.attempt_number,
                        llm_error,
                    )
                    raise llm_error from exc

                if resp.status_code >= 400:
                    llm_error = self._to_llm_error(
                        httpx.HTTPStatusError(
                            f"Ollama 返回 {resp.status_code}: {resp.text[:200]}",
                            request=resp.request,
                            response=resp,
                        )
                    )
                    if llm_error.retryable:
                        raise llm_error
                    # 不可重试（模型不存在 / 参数非法）：立刻给调用方明确错误
                    raise llm_error

                latency_ms = int((time.perf_counter() - started) * 1000)
                return self._to_response(resp.json(), latency_ms)

        raise LLMError("unreachable", kind="unknown", retryable=False)

    async def stream(self, request: LLMRequest) -> AsyncIterator[LLMStreamChunk]:
        """原生流式：Ollama 用 NDJSON（一行一个 JSON 对象）而不是 SSE。"""
        payload = self._payload(request, stream=True)
        started = time.perf_counter()
        pieces: list[str] = []
        final: dict = {}

        try:
            async with self._http() as http:
                async with http.stream(
                    "POST", f"{self._base_url}/api/chat", json=payload
                ) as resp:
                    if resp.status_code >= 400:
                        await resp.aread()
                        raise self._to_llm_error(
                            httpx.HTTPStatusError(
                                f"Ollama 返回 {resp.status_code}",
                                request=resp.request,
                                response=resp,
                            )
                        )
                    async for line in resp.aiter_lines():
                        line = line.strip()
                        if not line:
                            continue
                        try:
                            data = json.loads(line)
                        except json.JSONDecodeError:
                            # 中间偶发的非 JSON 心跳行：跳过，不要让整条流崩掉
                            continue
                        message = data.get("message") or {}
                        text = message.get("content") or ""
                        # 思考型模型会把推理过程放在 thinking 字段，正文只取 content
                        if text:
                            pieces.append(text)
                            yield LLMStreamChunk(text=text)
                        if data.get("done"):
                            final = data
                            break
        except (httpx.TimeoutException, httpx.TransportError) as exc:
            raise self._to_llm_error(exc) from exc

        # 收尾块里 Ollama 的 content 通常为空串（正文都在增量块里），
        # 但个别版本会把全文带在最后一块 —— 用 or 兜住这两种情况。
        response = self._to_response(
            {
                **final,
                "message": {
                    "role": "assistant",
                    "content": (final.get("message") or {}).get("content") or "".join(pieces),
                },
            },
            int((time.perf_counter() - started) * 1000),
        )
        yield LLMStreamChunk(text="", done=True, response=response)

    @staticmethod
    def _to_llm_error(exc: Exception) -> LLMError:
        """把 httpx 异常映射成统一错误，并判定是否值得重试。

        Ollama 常见故障的可重试性：
        - 连不上 / 超时 → Ollama 没启动或正在加载模型，重试有意义
        - 404「model not found」→ 模型没 pull，重试一万次也没用
        """
        if isinstance(exc, httpx.TimeoutException):
            return LLMError(
                "Ollama 调用超时（本地模型较慢，可调大 OLLAMA_TIMEOUT_SECONDS）",
                kind="timeout",
                retryable=True,
            )
        if isinstance(exc, httpx.TransportError):
            return LLMError(
                f"无法连接 Ollama（{exc}）；请确认 ollama serve 已启动",
                kind="connection",
                retryable=True,
            )
        if isinstance(exc, httpx.HTTPStatusError):
            status = exc.response.status_code
            if status == 404:
                return LLMError(
                    "Ollama 里没有这个模型（404）：请先执行 ollama pull <model>",
                    kind="invalid_request",
                    status_code=404,
                    retryable=False,
                )
            return LLMError(
                f"Ollama 返回 {status}",
                kind="server" if status >= 500 else "invalid_request",
                status_code=status,
                retryable=status >= 500,
            )
        return LLMError(f"未知错误：{exc}", kind="unknown", retryable=False)

    @staticmethod
    def _to_response(data: dict, latency_ms: int) -> LLMResponse:
        message = data.get("message") or {}
        # Ollama 的 token 统计字段名与 OpenAI 不同，这里统一归一化
        prompt_tokens = data.get("prompt_eval_count") or 0
        completion_tokens = data.get("eval_count") or 0
        return LLMResponse(
            # 思考型模型把推理过程放在 `thinking`，这里只取正文
            content=message.get("content") or "",
            model=data.get("model", "unknown"),
            usage=TokenUsage(
                prompt_tokens=int(prompt_tokens),
                completion_tokens=int(completion_tokens),
                total_tokens=int(prompt_tokens) + int(completion_tokens),
            ),
            latency_ms=latency_ms,
            # Ollama 的结束原因叫 done_reason（"stop" / "length"）
            finish_reason=data.get("done_reason") or ("stop" if data.get("done") else None),
            provider=OllamaClient.provider_name,
        )


class FallbackLLMClient(BaseLLMClient):
    """主 provider 不可用时的兜底链。

    为什么需要它：把主模型换成**本地** Ollama 后，「本机没装 / Ollama 没启动 /
    显存不够」都会让所有 LLM 调用失败。而线上部署环境同样没有 Ollama。
    有了兜底链，换主模型就是**可回退**的操作 —— 不会把已有功能直接打挂。

    触发条件刻意收窄：**只有连接类 / 超时 / 5xx** 才兜底。
    「模型说胡话」「JSON 解析失败」「参数非法」一律不兜底 ——
    那些是业务问题，静默换一个模型只会把错误藏得更深。

    ## 两段式降级（为什么要冷却期）

    主模型挂掉时，如果每次请求都先去试一遍主模型，用户就要为每一次调用
    都付出一整段超时时间（线上 20s × 重试 3 次 = 60s）。所以：

    1. 连续失败达到阈值 → 进入**冷却期**（`cooldown_seconds`）
    2. 冷却期内**直连兜底**，不再碰主模型
    3. 冷却结束后再探一次主模型；成功则彻底恢复

    ## 降级必须对外可见

    `provider_name` 仍然是主模型（那是"配置意图"），但 `active_provider` /
    `degraded` 反映"此时真正在作答的是谁"。`/api/llm/provider` 会如实上报，
    否则线上一直在用云端兜底、界面却写着"本地 Ollama"，属于误导。
    """

    _FALLBACK_KINDS = frozenset({"connection", "timeout", "server"})

    def __init__(
        self,
        primary: LLMClient,
        fallback: LLMClient,
        *,
        threshold: int = 2,
        cooldown_seconds: float = 120.0,
    ) -> None:
        self._primary = primary
        self._fallback = fallback
        self.provider_name = primary.provider_name
        self._failures = 0
        self._threshold = threshold
        self._cooldown_seconds = cooldown_seconds
        # 冷却截止时间（monotonic 秒）。0 = 未降级
        self._degraded_until = 0.0

    # ---------------- 状态（供 /api/llm/provider 展示） ----------------

    @property
    def degraded(self) -> bool:
        """当前是否处于降级（冷却）状态。"""
        return time.monotonic() < self._degraded_until

    @property
    def active_provider(self) -> str:
        """此时真正在作答的 provider（与 `provider_name` 可能不同）。"""
        return self._fallback.provider_name if self.degraded else self._primary.provider_name

    @property
    def fallback_provider_name(self) -> str:
        return self._fallback.provider_name

    def _enter_cooldown(self, kind: str) -> None:
        self._degraded_until = time.monotonic() + self._cooldown_seconds
        logger.warning(
            "主模型 %s 不可用（%s），进入 %.0fs 冷却，期间由 %s 作答",
            self._primary.provider_name,
            kind,
            self._cooldown_seconds,
            self._fallback.provider_name,
        )

    def _note_failure(self, kind: str) -> None:
        self._failures += 1
        if self._failures >= self._threshold:
            self._enter_cooldown(kind)

    # ---------------- 调用 ----------------

    async def complete(self, request: LLMRequest) -> LLMResponse:
        if self.degraded:
            return await self._degraded(request)

        try:
            response = await self._primary.complete(request)
        except LLMError as exc:
            if exc.kind not in self._FALLBACK_KINDS:
                raise
            self._note_failure(exc.kind)
            return await self._degraded(request)
        self._failures = 0
        return response

    async def _degraded(self, request: LLMRequest) -> LLMResponse:
        response = await self._fallback.complete(request)
        # 如实标注真实作答方，UI/日志里不能假装没发生过降级
        return response.model_copy(update={"provider": f"{response.provider}+fallback"})

    async def stream(self, request: LLMRequest) -> AsyncIterator[LLMStreamChunk]:
        if self.degraded:
            async for chunk in self._fallback.stream(request):
                yield chunk
            return
        try:
            async for chunk in self._primary.stream(request):
                yield chunk
        except LLMError as exc:
            if exc.kind not in self._FALLBACK_KINDS:
                raise
            self._note_failure(exc.kind)
            async for chunk in self._fallback.stream(request):
                yield chunk


class MockLLMClient(BaseLLMClient):
    """离线兜底 client。

    [P2] 存在的真实原因：没有 API Key 也能跑通「前端 → 后端 → Agent 循环」全链路，
    否则本地开发、自动化测试、CI 全都依赖外部付费服务。
    目前覆盖两个 purpose：planning（生成计划）与 agent_step（Agent 循环中的决策）。
    """

    provider_name = "mock"

    async def complete(self, request: LLMRequest) -> LLMResponse:
        if request.purpose not in _MOCK_PURPOSES:
            raise LLMError(
                f"MockLLMClient 不支持 purpose='{request.purpose}'，"
                f"支持：{', '.join(sorted(_MOCK_PURPOSES))}",
                kind="invalid_request",
                retryable=False,
            )

        question = _extract_question(request.messages)
        payload = _mock_payload(request, question)
        # ping / stream_probe 是**非结构化**调用（不要求 JSON），
        # Mock 也必须跟着返回纯文本，否则自检接口会显示一段假 JSON。
        content = (
            payload if isinstance(payload, str) else json.dumps(payload, ensure_ascii=False)
        )
        model = f"mock-{request.purpose}"

        return LLMResponse(
            content=content,
            model=model,
            # 粗略估算，仅用于让前端能显示「有数字」
            usage=TokenUsage(
                prompt_tokens=max(1, len(question) // 2),
                completion_tokens=max(1, len(content) // 2),
                total_tokens=max(1, len(question) // 2 + len(content) // 2),
            ),
            latency_ms=0,
            finish_reason="stop",
            provider=self.provider_name,
        )


# Mock 支持的调用目的。每新增一个 LLM 调用点，都要在这里补一份 fixture。
_MOCK_PURPOSES = frozenset(
    {
        "planning",
        "agent_step",
        "understand_task",
        "plan",
        "research_decision",
        "analyze",
        "verify",
        "write",
        # 模型自检（/api/llm/ping、/api/llm/stream）—— 非结构化调用
        "ping",
        "stream_probe",
    }
)


def _extract_question(messages: list[ChatMessage]) -> str:
    """从模板化的 user message 里取出真正的问题文本。"""
    raw = next(
        (m.content for m in reversed(messages) if m.role == "user"),
        "",
    )
    for marker in ("研究问题：", "研究任务：", "任务："):
        if marker in raw:
            return raw.split(marker, 1)[1].strip().split("\n")[0][:200]
    return raw[:200]


def _count_mentioned_evidence(request: LLMRequest) -> int:
    """从请求里读出「已经有 N 条证据」。

    Mock 需要它来决定「还要不要再查一次」，从而让图的循环真的能被观察到。

    [A7] 优先读结构化的 `metadata["evidence_count"]`，读不到再回落到正则。
    之前只有正则一条路：prompt 文案一改，Mock 的收敛判断就悄悄失效，
    而测试仍然全绿（因为断言的是"跑完了"，不是"跑了几轮"）。
    """
    meta = request.metadata or {}
    value = meta.get("evidence_count")
    if isinstance(value, int):
        return value

    raw = next((m.content for m in reversed(request.messages) if m.role == "user"), "")
    match = re.search(r"(?:已经有\s*|证据条数：)\s*(\d+)\s*条?", raw)
    return int(match.group(1)) if match else 0


def _mock_payload(request: LLMRequest, question: str) -> dict | str:
    """按调用目的返回确定性的假数据。

    返回 `str` 表示这是**非结构化**调用（ping / 流式自测），
    返回 `dict` 表示结构化调用（会被 json.dumps 后交给 schema 解析）。
    """
    purpose = request.purpose
    topic = question.strip().rstrip("。.?？") or "未命名研究主题"

    if purpose == "ping":
        return (
            "（离线 Mock）模型自检：当前没有配置真实模型，"
            "这条回复由 MockLLMClient 生成，用于验证调用链路本身是否连通。"
        )

    if purpose == "stream_probe":
        return (
            "（离线 Mock）流式自测：本段文本由 MockLLMClient 一次性返回，"
            "用于验证 SSE 帧格式与前端解析，不代表真实模型的生成速度。"
        )

    if purpose == "understand_task":
        return {
            "goal": f"搞清楚「{topic}」的现状与关键结论",
            "key_questions": [
                f"{topic} 的关键事实是什么？",
                f"哪些来源对 {topic} 的说法更可信？",
            ],
            "scope": "仅基于可获得的公开资料，不推测未公开信息",
        }

    if purpose in ("plan", "planning"):
        return _build_mock_plan(question)

    # research_decision 走 LangGraph 的 research 节点；agent_step 走 Phase 3 的手写循环
    if purpose in ("research_decision", "agent_step"):
        return _mock_agent_decision(request, question)

    if purpose == "analyze":
        return {
            "findings": [
                f"关于「{topic}」，已检索到的资料提供了初步证据（Mock 数据）。",
                "不同来源在细节上存在差异，需要更多证据才能定论（Mock 数据）。",
            ],
            "gaps": ["缺少一手来源", "样本量不足"],
        }

    if purpose == "verify":
        # 证据少于 2 条判定为不足 —— 这样 verify → research 的循环能在 Mock 下被观察到
        count = _count_mentioned_evidence(request)
        enough = count >= 2
        return {
            "verdict": "pass" if enough else "needs_more",
            "reasons": [f"当前证据 {count} 条，{'足以支撑初步结论' if enough else '尚不充分'}"],
            "missing": [] if enough else ["补充一手来源", "交叉验证关键数据"],
        }

    if purpose == "write":
        # [B21] 报告 schema 现在有篇幅硬校验（summary ≥150 字 / 全文 ≥300 字，
        # 见 graph/schemas.py 的 _report_must_have_substance）。
        # Mock 的职责是模仿「一个合格的模型」，所以这里输出的篇幅必须真实达标，
        # 否则 Mock 流程会被自己的校验打回 repair，偏离「离线验证流程」的本职。
        return {
            "title": f"{topic} — 研究报告（Mock）",
            "summary": (
                f"（Mock 数据）本报告围绕「{topic}」展开，基于离线语料库生成，"
                "用于在不调用真实模型的前提下验证研究工作流的完整性。"
                "研究过程中，流水线依次完成了任务理解、计划制定、证据检索、"
                "分析归纳与结论验证五个阶段，各阶段输出均符合预期结构。"
                "需要强调的是，本报告中的全部内容均为占位性质，"
                "不构成任何事实性结论；接入真实模型后，此处将替换为"
                "基于实时检索证据撰写的完整研究内容。"
            ),
            "sections": [
                {
                    "heading": "核心结论",
                    "content": (
                        "（Mock）离线语料为本次研究提供了形式上的证据支撑。"
                        "在真实运行中，本节会基于检索到的网页与知识库片段，"
                        "逐条展开研究问题的核心结论，并在每个结论后标注对应的证据编号，"
                        "例如 [证据1] [证据2]，确保每一句话都可以被溯源与核对。"
                        "当前内容仅用于验证报告渲染链路，不具备事实效力。"
                    ),
                },
                {
                    "heading": "证据概览",
                    "content": (
                        "（Mock）本次运行收集到的证据来自内置离线语料，"
                        "覆盖了研究问题的主要方面，但样本量有限、来源单一。"
                        "真实场景下，证据会来自 Tavily 联网搜索与用户知识库文档，"
                        "并经过检索、读取正文、交叉验证等环节筛选后进入本节。"
                        "Mock 模式的意义在于让前端渲染、事件流与中断确认流程"
                        "可以在无网络、无密钥的环境中完整走通。"
                    ),
                },
                {
                    "heading": "后续建议",
                    "content": (
                        "（Mock）若要获得真实结论，请配置 LLM_API_KEY 与 TAVILY_API_KEY "
                        "后重新运行同一问题。届时报告将基于真实检索证据撰写，"
                        "并在「局限」一节中如实说明证据缺口，例如缺少一手来源、"
                        "数据时效性不足或来源之间存在冲突等，"
                        "帮助读者判断结论的可信边界。"
                    ),
                },
            ],
            "limitations": ["当前为离线 Mock 模式，结论不具备事实效力"],
        }

    return _build_mock_plan(question)


def _mock_agent_decision(request: LLMRequest, question: str) -> dict:
    """模拟 Agent 循环中的一步决策。

    逻辑很简单（也更好调试）：
    - 上下文里还没有任何工具结果 → 先调 search_web
    - 已经有工具结果了 → 收敛，给出 final_answer
    """
    messages = request.messages
    has_observation = any(
        message.role == "user" and OBSERVATION_MARKER in message.content for message in messages
    )
    # research 节点会在 metadata 里写明「已经有 N 条证据」（正则只是兜底），
    # 够 2 条就收尾，这样「research → research → …」的循环在 Mock 下也能被真实跑出来。
    evidence_count = _count_mentioned_evidence(request)

    if not (has_observation or evidence_count >= 2):
        return {
            "action": {
                "tool": "search_web",
                "args": {"query": question[:80], "max_results": 5},
                "reason": "先检索候选来源，再决定是否需要读取正文",
            }
        }

    if has_observation:
        observation = next(
            message.content
            for message in reversed(messages)
            if message.role == "user" and OBSERVATION_MARKER in message.content
        )
        evidence = observation.split("----\n", 1)[-1][:800]
    else:
        evidence = "（已有若干条证据，此处省略）"
    return {
        "final_answer": (
            "（Mock 数据，非真实检索结果）\n\n"
            f"针对「{question}」，检索到的资料摘要如下：\n\n{evidence}\n\n"
            "以上是离线语料，仅用于验证 Agent 循环本身是否跑通。"
        )
    }


def _build_mock_plan(question: str) -> dict:
    """根据问题文本生成一份确定性的研究计划（离线可测）。"""
    topic = question.strip().rstrip("。.?？") or "未命名研究主题"
    return {
        "goal": f"围绕「{topic}」形成有证据支撑、可复核的结论",
        "questions": [
            f"{topic} 的现状与关键事实是什么？",
            f"哪些来源对 {topic} 的描述存在分歧？",
            "基于现有信息，可以给出什么可执行的结论？",
        ],
        "steps": [
            {
                "index": 1,
                "title": "明确研究范围",
                "instruction": f"界定「{topic}」的边界：时间范围、地域范围、对象范围",
            },
            {
                "index": 2,
                "title": "检索核心来源",
                "instruction": "针对每个子问题检索权威来源，记录 URL、标题与发布时间",
            },
            {
                "index": 3,
                "title": "抽取结构化证据",
                "instruction": "从来源中抽取可引用的原文片段，标注来源与位置",
            },
            {
                "index": 4,
                "title": "交叉验证",
                "instruction": "对比不同来源的说法，标出一致点与冲突点",
            },
            {
                "index": 5,
                "title": "形成结论",
                "instruction": "基于证据给出结论，并说明置信度与局限",
            },
        ],
        "expected_sources": [
            "官方一手来源（官网 / 官方文档 / 公告）",
            "行业权威媒体或研究报告",
            "可交叉验证的第三方数据",
        ],
    }


def build_llm_client(settings: Settings, provider: str | None = None) -> LLMClient:
    """按名字构造一个 client（**不含**兜底逻辑，便于测试直接调用）。"""
    name = (provider or settings.llm_provider or "auto").strip().lower()

    if name in ("ollama", "local"):
        return OllamaClient(
            base_url=settings.ollama_base_url,
            model=settings.ollama_model,
            timeout_seconds=settings.ollama_timeout_seconds,
            max_attempts=settings.llm_max_attempts,
            keep_alive=settings.ollama_keep_alive,
            think=settings.ollama_think,
            num_ctx=settings.ollama_num_ctx,
            num_predict=settings.ollama_num_predict,
        )

    if name in ("openai", "openai-compatible", "cloud"):
        return OpenAICompatibleClient(
            api_key=settings.llm_api_key.get_secret_value(),
            base_url=settings.llm_base_url,
            model=settings.llm_model,
            timeout_seconds=settings.llm_timeout_seconds,
            max_attempts=settings.llm_max_attempts,
            # [P0] 让 LLM_MAX_TOKENS 真正生效（此前写死 2000，配置是死的）
            default_max_tokens=settings.llm_max_tokens,
        )

    if name == "mock":
        logger.warning("LLM_PROVIDER=mock：将使用离线假数据，不会产生真实模型调用")
        return MockLLMClient()

    logger.warning("未知 LLM_PROVIDER=%s，回落到离线 Mock", name)
    return MockLLMClient()


def describe_llm_client(client: LLMClient) -> dict:
    """给 UI / 排障用的「当前模型」描述。

    只暴露非敏感信息（provider / 模型名 / 地址），绝不返回 API Key。

    ⚠️ 挂了兜底链时要如实上报「现在真正在作答的是谁」：
    `provider_name` 是**配置意图**（主模型），`active_provider` 是**实际作答方**。
    两者不一致说明发生了降级，UI 必须让用户看见。
    """
    settings = get_settings()
    provider = getattr(client, "provider_name", "unknown")
    is_fallback_chain = hasattr(client, "active_provider")
    if provider == "ollama":
        info = {
            "provider": "ollama",
            "label": "本地 Ollama",
            "model": settings.ollama_model,
            "base_url": settings.ollama_base_url,
            "stream_enabled": settings.llm_stream_enabled,
            "timeout_seconds": settings.ollama_timeout_seconds,
            "keep_alive": settings.ollama_keep_alive,
            "think": settings.ollama_think,
            "num_ctx": settings.ollama_num_ctx,
            "num_predict": settings.ollama_num_predict,
            "fallback": settings.llm_fallback_provider or None,
        }
        return _annotate_degradation(info, client, is_fallback_chain)
    if provider in ("openai-compatible", "openai"):
        info = {
            "provider": "openai-compatible",
            "label": "OpenAI 兼容接口（云端）",
            "model": settings.llm_model,
            "base_url": settings.llm_base_url or "https://api.openai.com/v1",
            "stream_enabled": settings.llm_stream_enabled,
            "timeout_seconds": settings.llm_timeout_seconds,
            "fallback": settings.llm_fallback_provider or None,
        }
        return _annotate_degradation(info, client, is_fallback_chain)

    info = {
        "provider": provider,
        "label": "离线 Mock",
        "model": "mock",
        "base_url": "",
        "stream_enabled": False,
        "timeout_seconds": 0,
        "fallback": None,
    }
    return _annotate_degradation(info, client, is_fallback_chain)


def _annotate_degradation(info: dict, client: LLMClient, is_fallback_chain: bool) -> dict:
    """给描述补上「降级状态」字段。

    为什么单独抽出来：三条 provider 分支都要加同样的字段，
    写三遍必然漏改一处，而漏掉的那一处恰好就是最难排查的"界面显示与实际上不符"。
    """
    if not is_fallback_chain:
        info["active_provider"] = info["provider"]
        info["degraded"] = False
        return info

    active = getattr(client, "active_provider", info["provider"])
    degraded = bool(getattr(client, "degraded", False))
    info["active_provider"] = active
    info["degraded"] = degraded
    info["fallback"] = getattr(client, "fallback_provider_name", info.get("fallback"))
    if degraded:
        # 降级时把 label 说清楚：不能再显示"本地 Ollama"误导用户
        info["label"] = f"{info['label']}（已降级 → {active}）"
        info["degraded_reason"] = "主模型连接失败，当前由兜底 provider 作答"
    return info


class _InstrumentedLLMClient:
    """给任意 `LLMClient` 套一层指标采集（provider 实现零改动）。

    为什么用「包装」而不是在每个 client 里逐处埋点：`complete` / `complete_structured`
    / `stream` 三个入口 × 多个 provider，逐处写必然漏。包一层后只需在
    `get_llm_client()` 这个**唯一出口**套一次，覆盖全部 provider（含兜底链），
    且每次逻辑调用只计一次（internal 的 complete→complete_structured 委托不会重复计数）。

    属性访问全部转发给内层：`active_provider` / `degraded` / `provider_name` 等
    仍能被 `describe_llm_client()` 如实读到，降级状态对外可见性不受影响。
    """

    def __init__(self, inner: LLMClient) -> None:
        self._inner = inner

    def __getattr__(self, item: str) -> object:
        return getattr(self._inner, item)

    @staticmethod
    def _record(request: LLMRequest, response: LLMResponse) -> None:
        metrics.inc(metrics.LLM_CALLS_TOTAL, {"purpose": request.purpose, "kind": "ok"})
        usage = response.usage
        for token_type, count in (
            ("prompt", usage.prompt_tokens),
            ("completion", usage.completion_tokens),
        ):
            if count:
                metrics.inc(
                    metrics.LLM_TOKENS_TOTAL,
                    {"purpose": request.purpose, "token_type": token_type},
                    value=float(count),
                )

    @staticmethod
    def _record_error(request: LLMRequest, exc: LLMError) -> None:
        metrics.inc(metrics.LLM_CALLS_TOTAL, {"purpose": request.purpose, "kind": exc.kind})

    async def complete(self, request: LLMRequest) -> LLMResponse:
        try:
            response = await self._inner.complete(request)
        except LLMError as exc:
            self._record_error(request, exc)
            raise
        self._record(request, response)
        return response

    async def complete_structured(
        self, request: LLMRequest, schema: type[T]
    ) -> StructuredResult[T]:
        try:
            result = await self._inner.complete_structured(request, schema)
        except LLMError as exc:
            self._record_error(request, exc)
            raise
        self._record(request, result.response)
        return result

    async def stream(self, request: LLMRequest) -> AsyncIterator[LLMStreamChunk]:
        try:
            async for chunk in self._inner.stream(request):
                if chunk.done and chunk.response is not None:
                    self._record(request, chunk.response)
                yield chunk
        except LLMError as exc:
            self._record_error(request, exc)
            raise


def _instrument(client: LLMClient) -> LLMClient:
    return _InstrumentedLLMClient(client)


@lru_cache(maxsize=1)
def get_llm_client() -> LLMClient:
    """根据配置决定用哪个 client —— 全后端唯一的模型入口。

    决策顺序：
    1. `LLM_PROVIDER` 显式指定（ollama / openai / mock）→ 直接用；
    2. `auto` → 主模型 Ollama，配了 `LLM_FALLBACK_PROVIDER` 就挂兜底链，
       都没配则退化成 Mock（保证「clone 下来就能跑」不会因为缺服务直接 500）；
    3. 无论走哪条，`LLM_FALLBACK_PROVIDER` 非空都会套上 `FallbackLLMClient`。

    返回前统一套上 `_InstrumentedLLMClient`（指标采集）。
    """
    settings: Settings = get_settings()
    provider = (settings.llm_provider or "auto").strip().lower()

    if provider == "auto":
        # 有云端 Key 就以「本地为主、云端兜底」的方式跑；都没有才纯 Mock
        has_cloud_key = bool(settings.llm_api_key.get_secret_value())
        if not has_cloud_key:
            logger.warning(
                "LLM_PROVIDER=auto 且未配置云端 Key：使用本地 Ollama(%s)，"
                "不可用时回落到离线 Mock",
                settings.ollama_model,
            )
            primary = build_llm_client(settings, "ollama")
            return _instrument(_with_fallback(primary, MockLLMClient(), settings))
        primary = build_llm_client(settings, "ollama")
    else:
        primary = build_llm_client(settings, provider)

    fallback_name = (settings.llm_fallback_provider or "").strip().lower()
    if fallback_name and fallback_name != provider:
        return _instrument(
            _with_fallback(primary, build_llm_client(settings, fallback_name), settings)
        )

    return _instrument(primary)


def _with_fallback(primary: LLMClient, fallback: LLMClient, settings: Settings) -> LLMClient:
    """套上兜底链（阈值与冷却期取自配置，便于按环境调）。"""
    return FallbackLLMClient(
        primary,
        fallback,
        threshold=settings.llm_fallback_threshold,
        cooldown_seconds=settings.llm_fallback_cooldown_seconds,
    )

"""统一模型调用层测试（Ollama / 兜底链 / 流式）。

用 `httpx.MockTransport` 打桩，**不需要本机真的跑 Ollama** ——
CI 里没有 Ollama 也能验证这一层的翻译逻辑与错误处理。
"""

from __future__ import annotations

import json

import httpx
import pytest

from app.llm.client import (
    FallbackLLMClient,
    MockLLMClient,
    OllamaClient,
    describe_llm_client,
)
from app.llm.errors import LLMError
from app.llm.schemas import ChatMessage, LLMRequest


def _ok_payload(content: str = "你好") -> dict:
    return {
        "model": "qwen3:8b",
        "message": {"role": "assistant", "content": content},
        "done": True,
        "done_reason": "stop",
        "prompt_eval_count": 12,
        "eval_count": 8,
    }


def _ndjson(lines: list[dict]) -> str:
    return "".join(json.dumps(line) + "\n" for line in lines)


def _request(**kwargs) -> LLMRequest:
    return LLMRequest(messages=[ChatMessage(role="user", content="hi")], **kwargs)


def test_ollama_translates_request_to_native_api():
    """OpenAI 语义必须被翻译成 Ollama 原生字段（num_predict / options / format）。"""
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured.update(json.loads(request.content))
        return httpx.Response(200, json=_ok_payload())

    client = OllamaClient(
        "http://127.0.0.1:11434",
        "qwen3:8b",
        client_factory=lambda: httpx.AsyncClient(
            transport=httpx.MockTransport(handler), timeout=5.0
        ),
    )

    import asyncio

    response = asyncio.run(
        client.complete(_request(max_tokens=777, response_format={"type": "json_object"}))
    )

    assert captured["model"] == "qwen3:8b"
    assert captured["options"]["num_predict"] == 777, "max_tokens 必须映射到 num_predict"
    assert captured["options"]["temperature"] == pytest.approx(0.2)
    assert captured["format"] == "json", "response_format 必须映射成 Ollama 的 format"
    assert captured["keep_alive"] == "5m"
    assert captured["think"] is False
    # token 统计字段名不同，必须归一化
    assert response.usage.total_tokens == 20
    assert response.provider == "ollama"
    assert response.finish_reason == "stop"


def test_ollama_strips_v1_suffix_from_base_url():
    """`http://host:11434/v1` 与 `http://host:11434` 都要指向原生 /api/chat。"""
    seen: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(str(request.url))
        return httpx.Response(200, json=_ok_payload())

    client = OllamaClient(
        "http://127.0.0.1:11434/v1",
        "qwen3:8b",
        client_factory=lambda: httpx.AsyncClient(
            transport=httpx.MockTransport(handler), timeout=5.0
        ),
    )
    import asyncio

    asyncio.run(client.complete(_request()))
    assert seen[0] == "http://127.0.0.1:11434/api/chat"


def test_ollama_model_missing_is_not_retryable():
    """404 = 模型没 pull，重试一万次也没用，必须立刻抛出且不重试。"""
    calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        return httpx.Response(404, json={"error": "model 'qwen3:8b' not found"})

    client = OllamaClient(
        "http://127.0.0.1:11434",
        "qwen3:8b",
        max_attempts=3,
        client_factory=lambda: httpx.AsyncClient(
            transport=httpx.MockTransport(handler), timeout=5.0
        ),
    )
    import asyncio

    with pytest.raises(LLMError) as exc:
        asyncio.run(client.complete(_request()))
    assert exc.value.retryable is False
    assert calls["n"] == 1, "不可重试错误只能请求一次"


def test_ollama_stream_yields_chunks_then_final_response():
    """流式必须逐块吐文本，并在最后一块带上 usage / latency。"""
    # 真实的 Ollama 流：正文在增量块里，收尾块的 content 是空串
    body = _ndjson(
        [
            {"message": {"content": "你"}, "done": False},
            {"message": {"content": "好"}, "done": False},
            {**_ok_payload(""), "done": True},
        ]
    )

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, text=body)

    client = OllamaClient(
        "http://127.0.0.1:11434",
        "qwen3:8b",
        client_factory=lambda: httpx.AsyncClient(
            transport=httpx.MockTransport(handler), timeout=5.0
        ),
    )

    import asyncio

    async def collect():
        chunks = []
        async for chunk in client.stream(_request()):
            chunks.append(chunk)
        return chunks

    chunks = asyncio.run(collect())
    assert [c.text for c in chunks[:-1]] == ["你", "好"]
    assert chunks[-1].done is True
    assert chunks[-1].response is not None
    assert chunks[-1].response.content == "你好"
    assert chunks[-1].response.usage.total_tokens == 20


class _BrokenClient:
    """永远连接失败的 client（模拟 Ollama 没启动）。"""

    provider_name = "ollama"

    async def complete(self, request: LLMRequest):
        raise LLMError("无法连接 Ollama", kind="connection", retryable=True)

    async def stream(self, request: LLMRequest):
        raise LLMError("无法连接 Ollama", kind="connection", retryable=True)
        yield  # pragma: no cover


def test_fallback_takes_over_on_connection_error():
    """主模型连不上 → 兜底接管，并在响应里如实标注来源。"""
    chain = FallbackLLMClient(_BrokenClient(), MockLLMClient())  # type: ignore[arg-type]
    import asyncio

    response = asyncio.run(chain.complete(_request(purpose="planning")))
    assert response.provider.endswith("+fallback"), "降级必须在 provider 上留痕"


def test_fallback_enters_cooldown_and_reports_degradation():
    """连续失败达到阈值后进入冷却：期间直连兜底，且 degraded/active_provider 如实反映。

    没有冷却期的后果：线上主模型不可用时，每一次调用都要先空等一整段主模型超时。
    """
    calls = {"primary": 0}

    class _CountingBroken(_BrokenClient):
        async def complete(self, request: LLMRequest):
            calls["primary"] += 1
            raise LLMError("无法连接 Ollama", kind="connection", retryable=True)

    chain = FallbackLLMClient(
        _CountingBroken(),
        MockLLMClient(),
        threshold=2,
        cooldown_seconds=60.0,
    )

    import asyncio

    assert chain.degraded is False
    assert chain.active_provider == "ollama"

    asyncio.run(chain.complete(_request(purpose="planning")))
    assert chain.degraded is False, "第一次失败还不该进入冷却"

    asyncio.run(chain.complete(_request(purpose="planning")))
    assert chain.degraded is True, "达到阈值必须进入冷却"
    assert chain.active_provider == "mock"

    before = calls["primary"]
    asyncio.run(chain.complete(_request(purpose="planning")))
    assert calls["primary"] == before, "冷却期内不该再去试探主模型"

    info = describe_llm_client(chain)
    assert info["degraded"] is True
    assert info["active_provider"] == "mock"
    assert "已降级" in info["label"], "界面文案必须说清楚发生了降级"


def test_fallback_recovers_after_cooldown():
    """冷却结束后要再探一次主模型，成功则彻底恢复（不能永久钉在兜底上）。"""
    chain = FallbackLLMClient(_BrokenClient(), MockLLMClient(), threshold=1, cooldown_seconds=0.05)

    import asyncio
    import time

    asyncio.run(chain.complete(_request(purpose="planning")))
    assert chain.degraded is True

    time.sleep(0.08)
    assert chain.degraded is False, "冷却结束后应恢复对主模型的信任"


def test_fallback_does_not_mask_logic_errors():
    """业务性错误（不可重试）绝不能被兜底链悄悄吞掉。"""

    class _BadRequest(_BrokenClient):
        async def complete(self, request: LLMRequest):
            raise LLMError("参数非法", kind="invalid_request", retryable=False)

    chain = FallbackLLMClient(_BadRequest(), MockLLMClient())  # type: ignore[arg-type]
    import asyncio

    with pytest.raises(LLMError):
        asyncio.run(chain.complete(_request(purpose="planning")))

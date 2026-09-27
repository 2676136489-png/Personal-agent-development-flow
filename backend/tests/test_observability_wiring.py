"""可观测性「接入」测试（不只是模块本身，而是**真的被调用到**）。

`test_metrics.py` 只测 metrics 模块自身（手工 inc/observe）。
本文件盯的是另一件事：工具执行 / 搜索 / LLM 调用 / 图运行这些**真实路径**
是否把指标记进去了 —— 否则 metrics.py 就是 400 行死代码，/api/health 恒为空。

另外覆盖本轮激活的工具重试配置（tool_max_attempts / retryable_tool_kinds）。

跑法（在 backend/ 目录下）：
    .venv/Scripts/python.exe -m pytest tests/test_observability_wiring.py
"""

from __future__ import annotations

import time
from types import SimpleNamespace

import httpx
import pytest
from pydantic import BaseModel

from app.graph.service import _record_run
from app.llm.client import MockLLMClient, _InstrumentedLLMClient
from app.llm.schemas import ChatMessage, LLMRequest
from app.observability.metrics import (
    GRAPH_RUN_DURATION_MS,
    GRAPH_RUN_TOTAL,
    LLM_CALLS_TOTAL,
    LLM_TOKENS_TOTAL,
    SEARCH_CALLS_TOTAL,
    SEARCH_CREDITS_USED_TOTAL,
    TOOL_CALLS_TOTAL,
    counter_value,
    reset_metrics,
    snapshot,
)
from app.search.errors import SearchProviderError
from app.tools.base import BaseTool, ToolContext
from app.tools.calculate import CalculateTool
from app.tools.search_provider import TavilySearchProvider
from app.tools.search_web import SearchWebTool


@pytest.fixture(autouse=True)
def _clean_metrics():
    reset_metrics()
    yield
    reset_metrics()


def _ctx() -> ToolContext:
    return ToolContext(run_id="wiring-test")


# ---------------------------------------------------------------------------
# 工具层：execute() 必须记「调用数 + 耗时」
# ---------------------------------------------------------------------------


async def test_tool_execute_records_call_and_duration():
    result = await CalculateTool().execute({"expression": "1 + 1"}, _ctx())
    assert result.ok is True

    assert counter_value(TOOL_CALLS_TOTAL, {"tool": "calculate", "ok": True}) == 1.0
    assert "tool_duration_ms{tool=calculate}" in snapshot()["histograms"]


async def test_tool_failure_is_recorded_with_ok_false():
    result = await CalculateTool().execute({"expression": ""}, _ctx())
    assert result.ok is False
    # 标签值 ok=False 会被归一成字符串 "False"，查询用 bool 也能命中（见 metrics 归一化）
    assert counter_value(TOOL_CALLS_TOTAL, {"tool": "calculate", "ok": False}) == 1.0


# ---------------------------------------------------------------------------
# 搜索：成功既记调用，也记额度（credits）
# ---------------------------------------------------------------------------


async def test_tavily_search_records_call_and_credits():
    transport = httpx.MockTransport(
        lambda request: httpx.Response(
            200, json={"results": [{"title": "t", "url": "u", "content": "c"}]}
        )
    )
    provider = TavilySearchProvider(
        "test-key", quota=None, client_factory=lambda: httpx.AsyncClient(transport=transport)
    )

    results = await provider.search("q", 1, run_key="thread_1")

    assert len(results) == 1
    assert counter_value(SEARCH_CALLS_TOTAL, {"depth": "basic", "result": "ok"}) == 1.0
    # basic = 1 credit
    assert counter_value(SEARCH_CREDITS_USED_TOTAL, {"depth": "basic"}) == 1.0


async def test_tavily_search_failure_records_error_kind_as_result():
    def boom(request: httpx.Request) -> httpx.Response:
        return httpx.Response(503, json={"detail": "upstream down"})

    provider = TavilySearchProvider(
        "test-key",
        quota=None,
        client_factory=lambda: httpx.AsyncClient(transport=httpx.MockTransport(boom)),
    )
    with pytest.raises(SearchProviderError):
        await provider.search("q", 1)

    assert counter_value(SEARCH_CALLS_TOTAL, {"depth": "basic", "result": "upstream_5xx"}) == 1.0
    # 失败不记额度消耗
    assert counter_value(SEARCH_CREDITS_USED_TOTAL, {"depth": "basic"}) == 0.0


# ---------------------------------------------------------------------------
# LLM：包装层记录调用与 token
# ---------------------------------------------------------------------------


async def test_instrumented_llm_records_call_and_tokens():
    client = _InstrumentedLLMClient(MockLLMClient())
    request = LLMRequest(messages=[ChatMessage(role="user", content="hi")], purpose="ping")

    response = await client.complete(request)

    assert response.content
    assert counter_value(LLM_CALLS_TOTAL, {"purpose": "ping", "kind": "ok"}) == 1.0
    # Mock 会给出估算的 token 数（>0），应被记入
    assert counter_value(LLM_TOKENS_TOTAL, {"purpose": "ping", "token_type": "prompt"}) > 0.0


async def test_instrumented_llm_forwards_attributes():
    """包装层必须把 active_provider 等属性透传，否则降级状态对外可见性会丢。"""
    client = _InstrumentedLLMClient(MockLLMClient())
    assert client.provider_name == "mock"


# ---------------------------------------------------------------------------
# 图运行：结果分布 + 耗时
# ---------------------------------------------------------------------------


def test_graph_run_metrics_recorded():
    started = time.perf_counter()
    _record_run(SimpleNamespace(status="completed", finished_reason="completed"), started)

    assert (
        counter_value(GRAPH_RUN_TOTAL, {"status": "completed", "finished_reason": "completed"})
        == 1.0
    )
    assert GRAPH_RUN_DURATION_MS in snapshot()["histograms"]


# ---------------------------------------------------------------------------
# 工具重试（激活 tool_max_attempts / retryable_tool_kinds）
# ---------------------------------------------------------------------------


class _Args(BaseModel):
    x: int = 0


class _FlakyTool(BaseTool):
    """第一次抛可重试错误，第二次成功。"""

    name = "flaky"
    description = "test"
    args_schema = _Args
    timeout_seconds = 5.0

    def __init__(self) -> None:
        self.calls = 0

    async def _run(self, args: BaseModel, ctx: ToolContext) -> str:
        self.calls += 1
        if self.calls == 1:
            raise SearchProviderError("瞬时失败", error_kind="timeout")
        return "ok"


class _NoRetryTool(_FlakyTool):
    """同样的失败，但声明不可重试（模拟计费工具）。"""

    name = "noretry"
    retryable = False


async def test_retryable_tool_retries_transient_failure():
    tool = _FlakyTool()
    result = await tool.execute({"x": 1}, _ctx())

    assert result.ok is True
    assert tool.calls == 2  # 首次失败 + 重试一次


async def test_non_retryable_tool_does_not_retry():
    tool = _NoRetryTool()
    result = await tool.execute({"x": 1}, _ctx())

    assert result.ok is False
    assert result.error_kind == "timeout"
    assert tool.calls == 1  # 只尝试一次


def test_search_web_is_not_retryable_to_avoid_double_credits():
    """计费工具必须关掉自动重试，否则瞬时失败会被重复扣积分。"""
    assert SearchWebTool.retryable is False

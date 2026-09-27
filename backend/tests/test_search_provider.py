"""搜索 provider 的配额行为测试（T02）。

不发真实网络请求：用 `httpx.MockTransport` 伪造 Tavily 的响应，
用 `FakeQuota` 记录 provider 对配额做的每一次操作。

跑法：uv run pytest
"""

from __future__ import annotations

import asyncio
from typing import Any

import httpx
import pytest

from app.search.errors import SearchProviderError
from app.search.quota import Reservation
from app.tools.base import ToolContext
from app.tools.search_provider import (
    StubSearchProvider,
    TavilySearchProvider,
    get_search_provider,
)

TAVILY_URL = "https://api.tavily.com/search"


class FakeQuota:
    """记录调用、可精确控制余额的替身。只实现 provider 用到的那几个方法。"""

    def __init__(self, remaining: int = 1000) -> None:
        self.remaining = remaining
        self.reserved: list[Reservation] = []
        self.settled: list[dict] = []
        self.released: list[dict] = []
        self.posts: list[httpx.Request] = []
        self.asked: int = 0

    def try_reserve(
        self, *, depth: str, run_key: str | None = None
    ) -> Reservation | None:
        # 返回和真实 store 相同的类型：provider 对 reservation 做的是属性访问，
        # 替身如果返回 dict，等于放任 provider 依赖一个假协议。
        credits = 1 if depth == "basic" else 2
        if credits > self.remaining:
            return None
        self.remaining -= credits
        reservation = Reservation(
            reservation_id=f"res_{len(self.reserved)}",
            period_key="2026-09",
            run_key=run_key,
            depth=depth,
            credits=credits,
        )
        self.reserved.append(reservation)
        return reservation

    def remaining_credits(self) -> int:
        return self.remaining

    def settle(self, reservation_id: str, *, failed: bool = False, kind: str | None = None) -> None:
        self.settled.append(
            {"reservation_id": reservation_id, "failed": failed, "kind": kind}
        )

    def release(self, reservation_id: str, *, degraded: bool = False) -> None:
        self.released.append({"reservation_id": reservation_id, "degraded": degraded})


def _transport(handler):
    return lambda: httpx.AsyncClient(transport=httpx.MockTransport(handler))


def _ok_handler(status: int = 200, payload: dict | None = None):
    def handler(request: httpx.Request) -> httpx.Response:
        if status >= 400:
            return httpx.Response(status, json={"detail": "boom"})
        return httpx.Response(
            200,
            json={
                "results": [
                    {"title": "T", "url": "https://example.com/a", "content": "C"},
                ],
                **(payload or {}),
            },
        )

    return handler


def _provider(
    *, quota: FakeQuota | None = None, status: int = 200, handler=None, depth: str | None = None
) -> TavilySearchProvider:
    """`depth=None` → 不传 depth，走 `settings.search_depth`（当前默认 basic）。"""
    return TavilySearchProvider(
        "test-key",
        quota=quota,
        depth=depth,
        client_factory=_transport(handler or _ok_handler(status)),
    )


# ---------- 不计费路径（测试红线 B） ----------


def test_stub_provider_is_not_billed():
    """红线 B：离线语料 provider 必须声明「不计费」。"""
    assert StubSearchProvider.billed is False
    assert StubSearchProvider.depth == "none"


def test_tavily_provider_is_billed_and_reads_search_depth():
    """默认档位由 settings.search_depth 决定，当前是 basic（1 credit/次）。"""
    provider = _provider()
    assert provider.billed is True
    assert provider.depth == "basic"
    assert provider.credits == 1  # basic = 1 credit


def test_tavily_provider_honours_explicit_advanced_depth():
    """单价表两种档位都保留：显式传 advanced 时仍按 2 credits 记。"""
    provider = _provider(depth="advanced")
    assert provider.depth == "advanced"
    assert provider.credits == 2


def test_stub_search_never_touches_quota():
    """红线 B（端到端）：无 Key 时 provider 是 stub，走工具层也必须 ok=True。"""
    from app.tools.search_web import SearchWebTool

    provider = get_search_provider()
    assert isinstance(provider, StubSearchProvider)
    result = asyncio.run(SearchWebTool().execute(
        {"query": "AI Agent 岗位 技术要求"}, ToolContext(run_id="test-run")
    ))
    assert result.ok is True
    assert "example.com" in result.output
    assert result.error_kind is None


# ---------- 预扣 / 结算 / 退款 ----------


async def test_successful_search_settles_the_reservation():
    quota = FakeQuota(remaining=1000)
    provider = _provider(quota=quota)

    results = await provider.search("2026 AI Agent", 3, run_key="thread_1")

    assert len(results) == 1
    assert quota.reserved and quota.reserved[0].credits == 1  # 默认 basic = 1 credit
    assert quota.remaining == 999  # 预扣生效
    assert len(quota.settled) == 1 and quota.settled[0]["failed"] is False
    assert quota.released == []


async def test_reservation_is_made_before_the_request_is_sent():
    """顺序断言：reserve 必须发生在 HTTP 请求之前（否则 429 时积分已超支）。"""
    quota = FakeQuota()

    def handler(request: httpx.Request) -> httpx.Response:
        quota.posts.append(request)
        return httpx.Response(200, json={"results": []})

    provider = TavilySearchProvider(
        "test-key", quota=quota, client_factory=_transport(handler)
    )
    await provider.search("q", 2, run_key="thread_1")
    assert len(quota.reserved) == 1
    assert len(quota.posts) == 1  # 预扣已发生，请求才发出


async def test_pre_deduction_failure_raises_quota_exhausted():
    """余额不足时，请求根本不该发出去。"""
    quota = FakeQuota(remaining=0)

    def handler(request: httpx.Request) -> httpx.Response:
        raise AssertionError("余额不足时不应该发出 HTTP 请求")

    provider = _provider(quota=quota, handler=handler)

    from app.search.errors import QuotaExhaustedError

    with pytest.raises(QuotaExhaustedError) as excinfo:
        await provider.search("q", 3, run_key="thread_1")
    assert excinfo.value.error_kind == "quota_exhausted"
    assert quota.reserved == []
    assert quota.posts == []
    assert "额度" in str(excinfo.value)


async def test_three_hundred_and_sixty_four_refunds_on_402():
    quota = FakeQuota()
    provider = _provider(quota=quota, status=402)
    from app.search.errors import QuotaExhaustedError

    with pytest.raises(QuotaExhaustedError):
        await provider.search("q", 3)
    assert len(quota.released) == 1
    assert quota.released[0]["degraded"] is True  # run 级账本标记为降级
    assert quota.settled == []  # 不计失败调用，因为请求根本没被受理


# ---------- 429 的两义性 ----------


async def test_429_with_balance_is_rate_limit():
    quota = FakeQuota(remaining=1000)
    provider = _provider(quota=quota, status=429)

    from app.search.errors import SearchProviderError

    with pytest.raises(SearchProviderError) as excinfo:
        await provider.search("q", 3)
    assert excinfo.value.error_kind == "rate_limit"
    assert len(quota.released) == 1
    assert quota.released[0]["degraded"] is False  # 只是限流，不是额度问题


async def test_429_without_balance_is_quota_exhausted():
    """余额刚好被这次请求烧光时，同一个 429 必须定性成「额度耗尽」。

    注意这个场景和 `test_pre_deduction_failure_raises_quota_exhausted` 的区别：
    那里余额是 0，预扣阶段就被挡住、请求根本没发出；这里余额恰好够预扣
    （默认 basic = 1），请求发出去了却拿到 429 —— 此时只能用「预扣后余额够不够」
    来消歧。
    """
    quota = FakeQuota(remaining=1)
    provider = _provider(quota=quota, status=429)

    from app.search.errors import QuotaExhaustedError

    with pytest.raises(QuotaExhaustedError):
        await provider.search("q", 3)
    assert quota.remaining == 0  # 预扣确实扣掉了
    assert len(quota.released) == 1
    assert quota.released[0]["degraded"] is True


@pytest.mark.parametrize("status", [500, 502, 503])
async def test_upstream_five_hundred_settles_as_failed(status: int):
    """5xx 必须**抛异常**而不是静默返回 []。

    判据变更说明：这条用例原本断言 `results == []`。那正是 PRD P-1 的病根 ——
    「上游挂了」和「这个话题真的没资料」在调用方眼里完全一样，
    Agent 会带着"没有资料"的错误前提继续写报告。现在失败必须可见。
    """
    quota = FakeQuota()
    provider = _provider(quota=quota, status=status)

    with pytest.raises(SearchProviderError) as exc:
        await provider.search("q", 3)

    assert exc.value.error_kind == "upstream_5xx"
    assert len(quota.settled) == 1
    assert quota.settled[0]["failed"] is True
    assert quota.settled[0]["kind"] == "upstream_5xx"
    assert quota.released == []  # 不退款：请求可能已被受理


async def test_timeout_is_settled_as_timeout():
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("too slow")

    quota = FakeQuota()
    provider = TavilySearchProvider(
        "test-key", quota=quota, client_factory=_transport(handler)
    )

    with pytest.raises(SearchProviderError) as exc:
        await provider.search("q", 3)

    assert exc.value.error_kind == "timeout"
    assert quota.settled[0]["kind"] == "timeout"


async def test_transport_error_is_settled_as_network():
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("refused")

    quota = FakeQuota()
    provider = TavilySearchProvider(
        "test-key", quota=quota, client_factory=_transport(handler)
    )

    with pytest.raises(SearchProviderError) as exc:
        await provider.search("q", 3)

    assert exc.value.error_kind == "network"
    assert quota.settled[0]["kind"] == "network"


async def test_unquoted_provider_without_quota_still_works():
    """配额单例为 None（DB 不可用 / 配额关闭）时，provider 照常工作，只是不记账。"""
    provider = TavilySearchProvider(
        "test-key", quota=None, client_factory=_transport(_ok_handler())
    )
    results: Any = await provider.search("q", 2)
    assert len(results) == 1


def test_unknown_depth_falls_back_to_default():
    """未知 depth 退回 `DEFAULT_DEPTH`（当前 basic），而不是 silent 按 0 记。"""
    provider = TavilySearchProvider("k", depth="huge", quota=None)
    assert provider.depth == "basic"
    assert provider.credits == 1

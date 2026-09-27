"""上线加固测试：安全响应头 / 静态缓存 / 限流中间件。

中间件类**直接**用最小 Starlette app 单测，避免受 `get_settings()` 的 lru_cache
影响（进程级缓存导致测试里改环境变量不生效）。

跑法（在 backend/ 目录下）：
    .venv/Scripts/python.exe -m pytest tests/test_production_hardening.py
"""

from __future__ import annotations

from fastapi.testclient import TestClient
from starlette.applications import Starlette
from starlette.responses import JSONResponse, PlainTextResponse
from starlette.routing import Route

from app.core.middleware import (
    CacheControlMiddleware,
    DailyRunBudgetMiddleware,
    JsonErrorFallbackMiddleware,
    RateLimitMiddleware,
    RunBudgetRegistry,
    SecurityHeadersMiddleware,
)
from app.main import create_app


async def _home(request):  # noqa: ANN001, ANN201 - 测试替身
    return PlainTextResponse("ok")


def _starlette() -> Starlette:
    return Starlette(routes=[Route("/{path:path}", _home)])


# ---------------------------------------------------------------------------
# 安全响应头
# ---------------------------------------------------------------------------


def test_security_headers_are_added():
    client = TestClient(
        SecurityHeadersMiddleware(_starlette(), csp="default-src 'self'", hsts=True)
    )
    headers = {k.lower(): v for k, v in client.get("/x").headers.items()}

    assert headers["x-content-type-options"] == "nosniff"
    assert headers["x-frame-options"] == "DENY"
    assert "referrer-policy" in headers
    assert "permissions-policy" in headers
    assert headers["content-security-policy"] == "default-src 'self'"
    assert "strict-transport-security" in headers


def test_hsts_absent_when_not_production():
    client = TestClient(SecurityHeadersMiddleware(_starlette(), csp="", hsts=False))
    assert "strict-transport-security" not in {k.lower() for k in client.get("/x").headers}


def test_health_endpoint_has_security_headers():
    """端到端：默认（开发）配置下 /api/health 也应带安全头（HSTS 除外）。"""
    client = TestClient(create_app())
    headers = {k.lower(): v for k, v in client.get("/api/health").headers.items()}
    assert headers["x-content-type-options"] == "nosniff"
    assert headers["x-frame-options"] == "DENY"
    assert "content-security-policy" in headers


# ---------------------------------------------------------------------------
# 静态缓存
# ---------------------------------------------------------------------------


def test_cache_control_applied_only_on_prefix():
    client = TestClient(
        CacheControlMiddleware(_starlette(), header_value="public, max-age=99, immutable")
    )
    assert client.get("/assets/a.js").headers["cache-control"] == "public, max-age=99, immutable"
    assert "cache-control" not in {k.lower() for k in client.get("/other").headers}


# ---------------------------------------------------------------------------
# 限流
# ---------------------------------------------------------------------------


def test_rate_limit_blocks_after_threshold_and_returns_envelope():
    client = TestClient(
        RateLimitMiddleware(_starlette(), requests_per_minute=2, paths=("/api/",))
    )
    assert client.get("/api/x").status_code == 200
    assert client.get("/api/x").status_code == 200

    blocked = client.get("/api/x")
    assert blocked.status_code == 429
    assert blocked.headers["retry-after"]
    body = blocked.json()
    assert body["success"] is False
    assert body["error"]["code"] == "rate_limited"


def test_rate_limit_ignores_unmatched_paths():
    client = TestClient(
        RateLimitMiddleware(_starlette(), requests_per_minute=1, paths=("/api/",))
    )
    # 不在限流前缀内的路径无论多少次都放行
    for _ in range(5):
        assert client.get("/health").status_code == 200


# ---------------------------------------------------------------------------
# 每日运行预算
# ---------------------------------------------------------------------------


async def _bad_request(request):  # noqa: ANN001, ANN201 - 测试替身
    """模拟参数校验失败（4xx）：不应消耗用户当天的额度。"""
    return JSONResponse({"ok": False}, status_code=422)


def _budget_client(
    *,
    limit: int = 2,
    paths: tuple[str, ...] = ("/api/graph/research",),
) -> TestClient:
    app = Starlette(
        routes=[
            Route("/api/graph/research", _home, methods=["GET", "POST"]),
            Route("/api/graph/research/{thread_id}/resume", _home, methods=["POST"]),
            Route("/api/agent/run", _home, methods=["POST"]),
            Route("/api/agent/run/invalid", _bad_request, methods=["POST"]),
        ]
    )
    return TestClient(DailyRunBudgetMiddleware(app, per_ip_limit=limit, paths=paths))


def test_daily_budget_blocks_after_limit_and_returns_envelope():
    client = _budget_client(limit=2)

    assert client.post("/api/graph/research").status_code == 200
    assert client.post("/api/graph/research").status_code == 200

    blocked = client.post("/api/graph/research")
    assert blocked.status_code == 429
    assert blocked.headers["retry-after"]
    body = blocked.json()
    assert body["success"] is False
    assert body["error"]["code"] == "daily_budget_exceeded"
    details = body["error"]["details"]
    assert details["limit"] == 2
    assert details["used"] == 2
    # 重置时刻以 epoch 毫秒下发，前端可渲染成本地时间
    assert details["reset_at_ms"] > 0


def test_daily_budget_counts_only_successful_runs():
    """4xx 的失败请求不占额度 —— 连续填错表单不该把当天额度填没了。"""
    client = _budget_client(limit=1, paths=("/api/agent/run", "/api/agent/run/invalid"))

    # 422 不计数：紧接着的成功运行仍被放行（若 422 也计数，这里会直接 429）
    assert client.post("/api/agent/run/invalid").status_code == 422
    assert client.post("/api/agent/run").status_code == 200
    # 成功运行计入额度后，该端点整体停止放行
    assert client.post("/api/agent/run/invalid").status_code == 429


def test_daily_budget_ignores_other_methods_and_paths():
    """GET 同路径、POST 其他路径、以及 resume（前缀相同但非精确匹配）都不计数。"""
    client = _budget_client(limit=1)

    assert client.get("/api/graph/research").status_code == 200
    assert client.post("/api/graph/research/thread_abcdef123456/resume").status_code == 200
    assert client.post("/api/agent/run").status_code == 200  # 未登记的路径不计数

    assert client.post("/api/graph/research").status_code == 200
    assert client.post("/api/graph/research").status_code == 429


def test_daily_budget_resets_on_next_day(monkeypatch):
    monkeypatch.setattr(DailyRunBudgetMiddleware, "_today", staticmethod(lambda: "2026-09-27"))
    client = _budget_client(limit=1)

    assert client.post("/api/graph/research").status_code == 200
    assert client.post("/api/graph/research").status_code == 429

    # 跨到下一个自然日 → 计数归零
    monkeypatch.setattr(DailyRunBudgetMiddleware, "_today", staticmethod(lambda: "2026-09-28"))
    assert client.post("/api/graph/research").status_code == 200


def test_daily_budget_registry_reports_live_usage():
    """注册表快照是「今日额度」接口与前端提示的数据源：用量必须实时可见。"""
    registry = RunBudgetRegistry()
    app = Starlette(routes=[Route("/api/graph/research", _home, methods=["POST"])])
    client = TestClient(
        DailyRunBudgetMiddleware(
            app,
            per_ip_limit=3,
            paths=("/api/graph/research",),
            registry=registry,
        )
    )

    # TestClient 的客户端 IP 固定为 "testclient"
    before = registry.snapshot("testclient")
    assert before is not None
    assert (before["limit"], before["used"], before["remaining"]) == (3, 0, 3)
    assert before["reset_at_ms"] > 0

    client.post("/api/graph/research")
    client.post("/api/graph/research")

    after = registry.snapshot("testclient")
    assert after is not None
    assert (after["used"], after["remaining"]) == (2, 1)
    # 快照按访客隔离：其他 IP 的额度不受影响
    other = registry.snapshot("other-ip")
    assert other is not None
    assert other["used"] == 0


def test_run_budget_endpoint_disabled_returns_zero_snapshot():
    """预算未启用：全零 + enabled=false 的降级快照（HTTP 200，绝不抛异常）。"""
    client = TestClient(create_app())
    body = client.get("/api/settings/run-budget").json()

    assert body["success"] is True
    assert body["data"] == {
        "enabled": False,
        "limit": 0,
        "used": 0,
        "remaining": 0,
        "reset_at_ms": 0,
    }


def test_run_budget_endpoint_reports_live_usage(monkeypatch):
    """预算启用：接口按当前访客回读中间件计数（used/remaining + 恢复时刻）。"""
    from app import main as main_module
    from app.api.routes import settings as settings_routes

    settings = main_module.get_settings().model_copy(
        update={"daily_run_budget_enabled": True, "daily_run_budget_per_ip": 5}
    )
    monkeypatch.setattr(main_module, "get_settings", lambda: settings)
    monkeypatch.setattr(settings_routes, "get_settings", lambda: settings)

    app = main_module.create_app()
    client = TestClient(app)
    # 先打一次请求触发中间件栈构建（注册表里此时才有实例），
    # 再直接给该实例播种计数，模拟「今天已经跑过 2 次」。
    client.get("/api/health")
    middleware = app.state.run_budget_registry._budget
    assert middleware is not None
    middleware._counters["testclient"] = (middleware._today(), 2)

    data = client.get("/api/settings/run-budget").json()["data"]
    assert data["enabled"] is True
    assert (data["limit"], data["used"], data["remaining"]) == (5, 2, 3)
    assert data["reset_at_ms"] > 0


def test_wildcard_cors_disables_credentials(monkeypatch):
    """`CORS_ORIGINS=*` 时必须关掉 credentials 回显（否则等于对全网开放带凭证跨域）。"""
    from app import main as main_module

    settings = main_module.get_settings().model_copy(update={"cors_origins": "*"})
    monkeypatch.setattr(main_module, "get_settings", lambda: settings)

    client = TestClient(main_module.create_app())
    response = client.get("/api/health", headers={"Origin": "https://evil.example"})

    assert response.status_code == 200
    headers = {k.lower(): v for k, v in response.headers.items()}
    assert headers.get("access-control-allow-origin") == "*"
    assert "access-control-allow-credentials" not in headers


# ---------------------------------------------------------------------------
# JSON 兜底：外层异常也必须返回统一信封，而不是纯文本 500
# ---------------------------------------------------------------------------


def test_json_error_fallback_turns_exception_into_json_envelope():
    async def boom(scope, receive, send):  # noqa: ANN001
        raise RuntimeError("boom")

    client = TestClient(JsonErrorFallbackMiddleware(boom), raise_server_exceptions=False)
    response = client.get("/api/whatever")

    assert response.status_code == 500
    body = response.json()
    assert body["success"] is False
    assert body["error"]["code"] == "internal_error"

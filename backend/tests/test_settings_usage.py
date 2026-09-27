"""`GET /api/settings/usage` 契约测试 + 运行响应的向后兼容字段（T02）。

跑法：pytest
"""

from __future__ import annotations

import itertools
import os
from datetime import datetime
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from app.core.config import Settings
from app.graph.service import _to_response
from app.main import create_app
from app.search.quota import SearchQuotaStore

_TMP_ROOT = Path(".pytest_tmp/usage")
_RUN_STAMP = f"{datetime.now():%Y%m%d%H%M%S}_{os.getpid()}"
_seq = itertools.count()


def _db_path() -> Path:
    """和 test_search_quota.py 一样：自己管目录，跑完不删（本机环境的批量删除保护）。"""
    root = _TMP_ROOT / f"run{_RUN_STAMP}"
    root.mkdir(parents=True, exist_ok=True)
    return root / f"{next(_seq):03d}_quota.db"


@pytest.fixture()
def store(monkeypatch: pytest.MonkeyPatch) -> SearchQuotaStore:
    """把进程级配额单例指向一个临时库，避免测试往 storage/ 里写东西。

    `get_search_quota_or_none` 自己带 lru_cache：不清掉的话，上一个用例缓存的
    「已 close 的 store」会被直接返回，报出一堆 Cannot operate on a closed database。
    """
    import app.search.quota as quota_module

    quota_module.get_search_quota_or_none.cache_clear()
    quota = SearchQuotaStore(_db_path(), monthly_credits=1000)
    monkeypatch.setattr(quota_module, "get_search_quota", lambda: quota)
    yield quota
    quota.close()
    quota_module.get_search_quota_or_none.cache_clear()


def _seed(store: SearchQuotaStore, *, calls: int, run_key: str | None = None) -> None:
    """走真实的预扣 -> 结算流程，把「请求已受理」假定为成功。

    `run_key=None` 时 `_upsert_run_locked` 会跳过，run 账本里什么都不留 ——
    正好用来验证「没有 run 数据 → estimated_runs_remaining 为 None」这条分支。
    """
    for _ in range(calls):
        res = store.reserve(depth="advanced", run_key=run_key)
        store.settle(res.reservation_id)


def _set_ledger(store: SearchQuotaStore, *, used: int, calls: int) -> None:
    """直接拨账本：用来构造 75% / 90% 这种靠 reserve 撞不出来的比例。"""
    with store._lock:  # noqa: SLF001 - 测试要验证的就是账本本身
        store._conn.execute(
            "UPDATE search_quota SET credits_used = ?, calls_total = ?", (used, calls)
        )
        store._conn.commit()


def _client() -> TestClient:
    return TestClient(create_app())


# ---------- 端点契约（PRD §3.4） ----------


def test_usage_contract_fields(store: SearchQuotaStore):
    """逐字段对齐 PRD §3.4 的 JSON 契约。"""
    _seed(store, calls=3)
    body = _client().get("/api/settings/usage").json()

    assert body["success"] is True
    data = body["data"]

    assert data["provider"] == "tavily"
    assert data["period_key"] == datetime.now().strftime("%Y-%m")
    assert data["period_start"].endswith("+08:00")
    assert data["period_end"].endswith("+08:00")
    assert data["renews_at"] == data["period_end"]

    assert data["credits_limit"] == 1000
    assert data["credits_used"] == 6
    assert data["credits_remaining"] == 994
    assert data["ratio"] == pytest.approx(0.006, abs=1e-3)  # 小数，不是 0.6
    assert data["warn_level"] == 0
    assert data["warn_level_label"] == "正常"

    assert data["calls_total"] == 3
    assert data["calls_failed_total"] == 0
    assert data["calls_quota_exhausted"] == 0

    assert data["search_depth_default"] == "basic"
    assert data["credits_per_call"] == 1  # basic = 1 credit/次
    assert data["estimated_runs_remaining"] is None  # 没有 run 账本，前端不该渲染「预计」
    assert len(data["daily"]) == 7
    assert all(set(row) == {"date", "calls", "credits"} for row in data["daily"])


def test_usage_estimates_runs_from_recent_history(store: SearchQuotaStore):
    """有 run 账本后才给预测；没有就必须是 None，前端才知道别渲染这一行。"""
    _seed(store, calls=2, run_key="thread_future")  # 2 × 2 credits = 4/次
    data = _client().get("/api/settings/usage").json()["data"]

    assert data["avg_credits_per_run"] == pytest.approx(4.0)
    # (1000 - 4) / 4 = 249，整除向下
    assert data["estimated_runs_remaining"] == (1000 - 4) // 4


def test_usage_reports_warn_label_when_approaching_limit(store: SearchQuotaStore):
    # 先真实预扣到撞上 1000 上限，再把账本拨到 75%，验证「读时算档位」而不是写死阈值
    _seed(store, calls=500)  # 500 × 2 credits = 1000，正好用满
    _set_ledger(store, used=750, calls=375)
    data = _client().get("/api/settings/usage").json()["data"]

    assert data["credits_used"] == 750
    assert data["ratio"] == pytest.approx(0.75)
    assert data["warn_level"] == 2
    assert data["warn_level_label"] == "接近上限"


def test_usage_reports_failed_and_exhausted_counters(store: SearchQuotaStore):
    """calls_failed / calls_quota_exhausted 必须能区分「没搜到」和「没额度了」。"""
    res = store.reserve(depth="advanced", run_key="thread_1")
    store.settle(res.reservation_id, failed=True, kind="upstream_5xx")
    res2 = store.reserve(depth="advanced", run_key="thread_1")
    store.release(res2.reservation_id, degraded=True)

    data = _client().get("/api/settings/usage").json()["data"]
    # calls_total 只数「请求已受理」的；被额度拒绝的那次只进 calls_quota_exhausted，
    # 这正是它和「真的没搜到」的区别所在。
    assert data["calls_total"] == 1
    assert data["calls_failed_total"] == 1
    assert data["calls_quota_exhausted"] == 1
    assert data["credits_used"] == 2  # 退款的那笔没算进去


# ---------- 降级契约（AC-25） ----------


def test_usage_returns_all_zero_when_quota_unavailable(monkeypatch: pytest.MonkeyPatch):
    """配额 DB 不可读：**全 0 + HTTP 200，绝不抛异常**。"""

    def boom() -> SearchQuotaStore:  # noqa: ANN202 - 故意抛错，验证降级路径本身
        raise OSError("disk on fire")

    monkeypatch.setattr("app.search.quota.get_search_quota", boom)
    monkeypatch.setattr("app.graph.service.get_search_quota_or_none", lambda: None)
    response = _client().get("/api/settings/usage")

    assert response.status_code == 200
    data = response.json()["data"]
    for key in (
        "credits_limit",
        "credits_used",
        "credits_remaining",
        "calls_total",
        "calls_failed_total",
        "calls_quota_exhausted",
        "credits_per_call",
        "warn_level",
    ):
        assert data[key] == 0, f"{key} 应为 0"
    for key in ("period_key", "period_start", "period_end", "renews_at", "provider"):
        assert data[key] == "", f"{key} 应为空字符串"
    assert data["daily"] == []
    assert data["estimated_runs_remaining"] is None


# ---------- search_depth 配置校验（fail-fast） ----------
#
# 为什么要测这个：`search_depth` 决定 Tavily 的计费单价（basic=1 / advanced=2）。
# 配错时若只 warning 后静默回落，用户会「以为在用 advanced、实际按 basic 计」，
# 或反过来——两种方向都是看不见的钱包问题。所以非法值必须**启动即报错**。
#
# 用 `Settings(...)` 直接构造（而不是 get_settings()）：后者是 lru_cache 的，
# 进程里只会读一次 .env，拿它测「非法值」会被缓存挡住。


def test_search_depth_rejects_illegal_value():
    """拼错的 SEARCH_DEPTH 必须抛 ValidationError，而不是静默回落。"""
    with pytest.raises(ValidationError) as excinfo:
        Settings(search_depth="advaned")  # 故意拼错：advanced -> advaned

    # 报错信息要能直接看出「合法值是哪两个」
    assert "search_depth" in str(excinfo.value)
    assert "'basic' or 'advanced'" in str(excinfo.value)


def test_search_depth_accepts_both_valid_values():
    """两个合法档位都能构造，且单价表口径不变（basic=1 / advanced=2）。"""
    assert Settings(search_depth="basic").search_depth == "basic"
    assert Settings(search_depth="advanced").search_depth == "advanced"
    assert Settings().search_depth == "basic"  # 默认档仍是 basic


def test_search_depth_is_validated_from_env(monkeypatch: pytest.MonkeyPatch):
    """`.env` / 环境变量写错同样 fail-fast（用户最可能踩的就是这条路径）。"""
    monkeypatch.setenv("SEARCH_DEPTH", "advaned")
    with pytest.raises(ValidationError):
        Settings()

    monkeypatch.setenv("SEARCH_DEPTH", "")  # 写了 key 却忘填值，也是错，不能当默认
    with pytest.raises(ValidationError):
        Settings()


# ---------- ResearchRunResponse 的向后兼容字段 ----------


def test_run_response_exposes_quota_fields(store: SearchQuotaStore):
    response: Any = _to_response("thread_nope", {"question": "x" * 20}, next_nodes=())
    # 配额充裕时这些字段「在且为零」，前端只需要写一份渲染逻辑
    assert response.credits_used == 0
    assert response.search_calls == 0
    assert response.degraded is False
    assert response.degraded_reason is None
    assert response.warnings == []


def test_run_response_reports_this_runs_search_cost(store: SearchQuotaStore):
    for _ in range(3):
        res = store.reserve(depth="advanced", run_key="thread_cost")
        store.settle(res.reservation_id)

    response: Any = _to_response("thread_cost", {"question": "x" * 20}, next_nodes=())
    assert response.search_calls == 3
    assert response.credits_used == 6
    assert response.degraded is False
    assert response.degraded_reason is None


def test_run_response_reports_degradation(store: SearchQuotaStore):
    res = store.reserve(depth="advanced", run_key="thread_degraded")
    store.release(res.reservation_id, degraded=True)

    response: Any = _to_response("thread_degraded", {"question": "x" * 20}, next_nodes=())
    assert response.degraded is True
    assert response.degraded_reason
    assert response.search_calls == 0  # 被拒的那次没产生真实调用
    assert response.credits_used == 0  # 预扣已退款


def test_settings_endpoint_does_not_depend_on_quota(monkeypatch: pytest.MonkeyPatch):
    """失败隔离（PRD §3.4 的主理由）：配额挂了，设置页照常开。"""

    def boom() -> SearchQuotaStore:  # noqa: ANN202
        raise OSError("disk on fire")

    monkeypatch.setattr("app.search.quota.get_search_quota", boom)
    body = _client().get("/api/settings").json()

    assert body["success"] is True
    assert body["data"]["app_name"]

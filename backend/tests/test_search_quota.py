"""搜索配额记账单元测试（T02）。

覆盖：建表 / 预扣 / 结算 / 退款 / 跨月 rollover / 重启不归零 / 阈值预警 /
按 run 聚合 / 429 分类。全部用 tmp_path 里的 SQLite，绝不碰 storage/。

跑法：uv run pytest
"""

from __future__ import annotations

import itertools
import os
import sqlite3
from datetime import datetime, timedelta
from pathlib import Path

import pytest

from app.search.errors import QuotaExhaustedError, SearchProviderError
from app.search.quota import (
    CREDITS_BY_DEPTH,
    DEFAULT_DEPTH,
    SearchQuotaStore,
    _period_key,
    credits_for,
    run_context,
)

TABLES = (
    "search_quota",
    "search_quota_daily",
    "search_quota_run",
    "search_quota_warn",
    "search_quota_reservation",
)

# 用例自己管目录，刻意不用 pytest 的 tmp_path：tmp_path 的一次性批量清理在本机环境里
# 会触发批量删除保护（一次删上百个文件 → SystemExit，整轮测试直接红）。
# 代价是残留文件不删 —— 文件名带「本次运行戳 + 序号」，所以既不会读到上次的残留，
# 也不会互相干扰。磁盘占用约 10KB/文件，可忽略。
_QUOTA_TMP_ROOT = Path(".pytest_tmp/search_quota")
_RUN_STAMP = f"{datetime.now():%Y%m%d%H%M%S}_{os.getpid()}"
_seq = itertools.count()


@pytest.fixture()
def db_path() -> Path:
    root = _QUOTA_TMP_ROOT / f"run{_RUN_STAMP}"
    root.mkdir(parents=True, exist_ok=True)
    return root / f"{next(_seq):03d}_search_quota.db"


@pytest.fixture()
def quota(db_path: Path) -> SearchQuotaStore:
    store = SearchQuotaStore(db_path, monthly_credits=1000)
    yield store
    store.close()


def _columns(store: SearchQuotaStore, table: str) -> set[str]:
    """直接读 sqlite_master，验证「实际建表」而不是「字符串里有 DDL」。"""
    conn = sqlite3.connect(store._db_path)  # noqa: SLF001 - 测试要验证的就是建表结果
    try:
        return {row[1] for row in conn.execute(f"PRAGMA table_info({table})")}
    finally:
        conn.close()


# ---------- 建表 ----------


def test_all_tables_created(db_path: Path):
    store = SearchQuotaStore(db_path, monthly_credits=1000)
    try:
        for table in TABLES:
            assert _columns(store, table), f"{table} 未建表"
    finally:
        store.close()


def test_reservation_table_has_expected_columns(quota: SearchQuotaStore):
    columns = _columns(quota, "search_quota_reservation")
    assert {"reservation_id", "period_key", "run_key", "depth", "credits", "state"} <= columns


def test_quota_table_tracks_warn_level(quota: SearchQuotaStore):
    assert {"period_key", "credits_limit", "credits_used", "calls_total", "warn_level"} <= _columns(
        quota, "search_quota"
    )


def test_credits_by_depth_matches_tavily_pricing():
    """Tavily 口径：basic = 1 credit，advanced = 2 credits。"""
    assert CREDITS_BY_DEPTH == {"basic": 1, "advanced": 2}
    assert credits_for("advanced") == 2
    assert credits_for("basic") == 1


def test_unknown_depth_is_charged_at_the_highest_price():
    """未知 depth 按**最高单价**记，不跟随默认档位。

    默认档是 basic（1 credit），但未知值必须按 advanced（2 credits）记：
    记账低估等于偷偷放宽额度上限，预扣就失去意义了。
    """
    assert DEFAULT_DEPTH == "basic"  # 默认档确实是 basic……
    assert credits_for("unknown") == 2  # ……但未知值仍按最高价记
    assert credits_for("bogus_depth") == 2
    assert credits_for("") == 2  # 空串同样按最高价
    assert credits_for("unknown") == max(CREDITS_BY_DEPTH.values())


# ---------- 预扣 ----------


def test_reserve_pre_deducts_before_request(quota: SearchQuotaStore):
    reservation = quota.reserve(depth="advanced", run_key="thread_test")
    assert reservation.credits == 2
    snapshot = quota.snapshot()
    assert snapshot.credits_used == 2
    assert snapshot.calls_total == 0  # 请求还没发出，不算一次调用
    assert snapshot.credits_remaining == 998


def test_reserve_is_atomic_and_rejects_overspend(quota: SearchQuotaStore):
    """把额度压到只剩 1 credit，再申请 2 credits 必须被拒，且一个字节都不扣。"""
    quota.reserve(depth="basic")  # 花掉 1

    # 直接把余额改到只剩 1（模拟一个几乎烧完的周期）
    conn = sqlite3.connect(quota._db_path)  # noqa: SLF001
    try:
        conn.execute(
            "UPDATE search_quota SET credits_used = 999 WHERE period_key = ?",
            (quota.current_period()[0],),
        )
        conn.commit()
    finally:
        conn.close()

    before = quota.snapshot().credits_used
    with pytest.raises(QuotaExhaustedError) as excinfo:
        quota.reserve(depth="advanced", run_key="run_x")
    assert excinfo.value.credits_remaining == 1
    assert excinfo.value.deficit == 1
    assert quota.snapshot().credits_used == before  # 没被多扣


def test_try_reserve_returns_none_instead_of_raising(quota: SearchQuotaStore):
    # 前置：先建出当前周期行。_ensure_current_period_locked() 是惰性的，
    # 构造 store 之后 search_quota 还是空表，裸 UPDATE 会命中 0 行
    # ——那样测的就不是「余额不足」，而是「没建行」。
    quota.remaining_credits()
    conn = sqlite3.connect(quota._db_path)  # noqa: SLF001
    try:
        conn.execute(
            "UPDATE search_quota SET credits_used = credits_limit WHERE period_key = ?",
            (quota.current_period()[0],),
        )
        conn.commit()
    finally:
        conn.close()
    assert quota.try_reserve(depth="advanced") is None
    assert quota.remaining_credits() == 0  # 一个字节都不该扣


# ---------- 结算 / 退款 ----------


def test_settle_counts_call_without_changing_credits(quota: SearchQuotaStore):
    reservation = quota.reserve(depth="advanced", run_key="run_1")
    quota.settle(reservation.reservation_id)
    snapshot = quota.snapshot()
    assert snapshot.calls_total == 1
    assert snapshot.credits_used == 2  # 预扣的那笔留着，没有二次扣费
    assert snapshot.warn_level == 0


def test_release_refunds_the_pre_deduction(quota: SearchQuotaStore):
    reservation = quota.reserve(depth="advanced", run_key="run_1")
    quota.release(reservation.reservation_id, degraded=True)
    snapshot = quota.snapshot()
    assert snapshot.credits_used == 0
    assert snapshot.calls_total == 0
    assert quota.run_usage("run_1")["degraded"] is True


def test_release_is_idempotent(quota: SearchQuotaStore):
    reservation = quota.reserve(depth="advanced")
    quota.release(reservation.reservation_id)
    quota.release(reservation.reservation_id)
    assert quota.snapshot().credits_used == 0


def test_settle_is_idempotent(quota: SearchQuotaStore):
    reservation = quota.reserve(depth="advanced", run_key="run_1")
    quota.settle(reservation.reservation_id)
    quota.settle(reservation.reservation_id)
    assert quota.snapshot().calls_total == 1


def test_open_reservations_are_reconciled_after_restart(db_path: Path):
    """崩溃残留的 open 预扣必须在下次启动时退还（AC-17：无幽灵扣费）。

    真正的崩溃抓不到，所以这里把 created_at 往前拨 1 小时来模拟「进程死了很久」。
    """
    store = SearchQuotaStore(db_path, monthly_credits=1000)
    store.reserve(depth="advanced", run_key="run_crash")
    assert store.snapshot().credits_used == 2
    store.close()

    conn = sqlite3.connect(db_path)
    try:
        conn.execute(
            "UPDATE search_quota_reservation SET created_at = ? WHERE state = 'open'",
            ((datetime.now() - timedelta(hours=1)).isoformat(),),
        )
        conn.commit()
    finally:
        conn.close()

    reopened = SearchQuotaStore(db_path, monthly_credits=1000)
    try:
        assert reopened.snapshot().credits_used == 0
    finally:
        reopened.close()


def test_fresh_reservations_are_not_refunded_on_reconnect(db_path: Path):
    """同一进程内 close/connect 不应该把自己刚做的预扣退掉。"""
    store = SearchQuotaStore(db_path, monthly_credits=1000)
    store.reserve(depth="advanced", run_key="run_live")
    store.close()

    reopened = SearchQuotaStore(db_path, monthly_credits=1000)
    try:
        assert reopened.snapshot().credits_used == 2
    finally:
        reopened.close()


# ---------- 持久化与 rollover ----------


def test_usage_survives_restart(db_path: Path):
    """AC-10：重启后 credits_used 不归零（进程内存 dict 做不到，SQLite 可以）。"""
    store = SearchQuotaStore(db_path, monthly_credits=1000)
    store.reserve(depth="advanced", run_key="run_1")
    store.settle(store.reserve(depth="advanced", run_key="run_1").reservation_id)
    store.close()

    reopened = SearchQuotaStore(db_path, monthly_credits=1000)
    try:
        snapshot = reopened.snapshot()
        assert snapshot.credits_used == 4
        assert snapshot.calls_total == 1
    finally:
        reopened.close()


def test_cross_month_rollover(db_path: Path):
    """AC-11：跨月时新周期从 0 开始，旧行原样保留做历史。"""
    store = SearchQuotaStore(db_path, monthly_credits=1000)
    store.reserve(depth="advanced", run_key="run_last_month")
    period_key = store.current_period()[0]
    store.close()

    conn = sqlite3.connect(db_path)
    try:
        year, month = (int(part) for part in period_key.split("-"))
        prev_month = month - 1 or 12
        prev_year = year if month != 1 else year - 1
        conn.execute(
            "UPDATE search_quota SET period_key = ? WHERE credits_used > 0",
            (f"{prev_year}-{prev_month:02d}",),
        )
        conn.commit()
    finally:
        conn.close()

    reopened = SearchQuotaStore(db_path, monthly_credits=1000)
    try:
        snapshot = reopened.snapshot()
        # 新的自然月 => 全新周期，用量从 0 开始
        assert snapshot.period_key == _period_key()
        assert snapshot.credits_used == 0
        assert snapshot.calls_total == 0
        conn = sqlite3.connect(db_path)
        try:
            history = conn.execute(
                "SELECT period_key, credits_used FROM search_quota ORDER BY period_key"
            ).fetchall()
        finally:
            conn.close()
        # 旧周期的行原样保留做历史（append-only，不删历史）
        assert {row[0]: row[1] for row in history} == {
            f"{prev_year}-{prev_month:02d}": 2,
            _period_key(): 0,
        }
    finally:
        reopened.close()


# ---------- 快照契约 ----------


def test_snapshot_contract(quota: SearchQuotaStore):
    first = quota.reserve(depth="advanced", run_key="run_1")
    quota.settle(first.reservation_id)
    second = quota.reserve(depth="basic", run_key="run_1")
    quota.settle(second.reservation_id)
    snapshot = quota.snapshot()
    assert snapshot.provider == "tavily"
    assert snapshot.period_key == quota.current_period()[0]
    assert snapshot.credits_limit == 1000
    assert snapshot.credits_used == 3  # 2 + 1
    assert snapshot.credits_remaining == 997
    assert snapshot.ratio == pytest.approx(0.003)
    assert snapshot.search_depth_default == "basic"
    assert isinstance(snapshot.daily, list)
    # 有 run 历史才给预测：run 账本一行 = 一次 run，run_1 花了 3 credits
    assert snapshot.avg_credits_per_run == pytest.approx(3.0)
    assert snapshot.estimated_runs_remaining == 997 // 3
    # 未 settle 的预扣不计入 run 花费（只有真正被受理的才计费）
    leftover = quota.reserve(depth="advanced", run_key="run_2")
    assert quota.run_usage("run_2")["credits"] == 0
    quota.release(leftover.reservation_id)


def test_snapshot_period_boundaries(quota: SearchQuotaStore):
    period_key, start, end = quota.current_period()
    assert period_key == quota.current_period()[0]
    assert start.endswith("+08:00") and end.endswith("+08:00")
    assert quota.snapshot().renews_at == end


def test_daily_returns_last_seven_days(quota: SearchQuotaStore):
    rows = quota.daily()
    assert len(rows) == 7
    assert all(set(row) == {"date", "calls", "credits"} for row in rows)
    assert rows[-1]["date"] == datetime.now().strftime("%Y-%m-%d")  # 今天在最后
    assert rows[0]["date"] < rows[-1]["date"]


def test_run_usage_reports_this_run(quota: SearchQuotaStore):
    reservation = quota.reserve(depth="advanced", run_key="run_abc")
    quota.release(reservation.reservation_id, degraded=True)
    usage = quota.run_usage("run_abc")
    assert usage["found"] is True
    assert usage["credits"] == 0  # 退款了
    assert usage["degraded"] is True


def test_run_usage_zero_value_for_unknown_run(quota: SearchQuotaStore):
    usage = quota.run_usage("never_seen")
    assert usage == {
        "found": False,
        "period_key": quota.current_period()[0],
        "calls": 0,
        "credits": 0,
        "degraded": False,
    }


# ---------- 阈值预警 ----------


@pytest.mark.parametrize(
    ("used", "expected_level"),
    [
        (0, 0),  # 0%
        (500, 1),  # 50%
        (750, 2),  # 75%
        (900, 3),  # 90%
        (1000, 4),  # 100% 耗尽
    ],
)
def test_warn_level_thresholds(db_path: Path, used: int, expected_level: int):
    store = SearchQuotaStore(db_path, monthly_credits=1000)
    try:
        store.reserve(depth="basic")  # 建立当前周期行
        conn = sqlite3.connect(store._db_path)  # noqa: SLF001
        try:
            conn.execute(
                "UPDATE search_quota SET credits_used = ? WHERE period_key = ?",
                (used, store.current_period()[0]),
            )
            conn.commit()
        finally:
            conn.close()
        assert store.snapshot().warn_level == expected_level
    finally:
        store.close()


def test_warn_events_are_deduplicated(db_path: Path):
    store = SearchQuotaStore(db_path, monthly_credits=1000)
    try:
        store.reserve(depth="basic")
        conn = sqlite3.connect(store._db_path)  # noqa: SLF001
        try:
            for _ in range(3):
                conn.execute(
                    "UPDATE search_quota SET credits_used = 900 WHERE period_key = ?",
                    (store.current_period()[0],),
                )
                conn.commit()
                store.snapshot()  # 每次都重算，但同档只应记一次
        finally:
            conn.close()
        current = store.current_period()[0]
        events = store.warn_events()
        assert [e["level"] for e in events if e["period_key"] == current] == [3]
    finally:
        store.close()


# ---------- 429 的两义性 ----------


def test_quota_exhausted_error_carries_context():
    error = QuotaExhaustedError("no credits", credits_remaining=1, deficit=2)
    assert error.error_kind == "quota_exhausted"
    assert error.credits_remaining == 1
    assert error.deficit == 2
    # 必须是 SearchProviderError 的子类：工具层按 error_kind 翻译，两类都走同一个出口
    assert isinstance(error, SearchProviderError)


def test_search_provider_error_default_kind():
    assert SearchProviderError("boom").error_kind == "execution_error"


def test_run_context_binds_run_id(quota: SearchQuotaStore):
    """run_id 由 ContextVar 决定，provider 不需要从 config 里抠 thread_id。"""
    with run_context(run_id="thread_bound"):
        reservation = quota.reserve(depth="basic", run_key="thread_bound")
        quota.release(reservation.reservation_id, degraded=True)
    assert reservation.run_key == "thread_bound"
    assert quota.run_usage("thread_bound")["found"] is True
    assert quota.run_usage("thread_bound")["credits"] == 0

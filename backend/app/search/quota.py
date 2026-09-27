"""搜索配额记账（T02 核心交付物）。

## 计费口径（改代码前先读这一节）

Tavily 的计费：
- `basic`    = **1 credit / 次**
- `advanced` = **2 credits / 次**

当前默认 `search_depth="basic"`（见 `app/core/config.py`），因此 1000 credits 的
免费额度可以完整覆盖 **约 1000 次**搜索。若把 `SEARCH_DEPTH` 切回 `advanced`，
同额度立即缩水为约 500 次 —— 这个 2 倍差就是「配额不可见」造成的第一重伤害，
所以口径必须写在这里、也写进 `/api/settings` 的返回值。

## 为什么必须「预扣」

Tavily 把「额度耗尽」和「请求太频繁」**都返回 429**，状态码无法区分。
如果等拿到 429 再熔断，那笔积分已经花出去了 —— 用户被多扣了钱。
所以：`reserve()` 在**发起 HTTP 请求之前**就用一条 SQL 把积分原子地预扣掉，
请求失败再 `release()` 退款。这是唯一能在时间线上防止超支的手段。

本文件是**全项目唯一允许出现配额相关 SQL 的地方**。

## 单 worker 约束（判据已实测修正，见架构 §2.3.2）

`threading.Lock` 只串行化**本进程这一条连接**，它**不承担防超支的职责** ——
防超支由 `reserve()` 里那条 UPSERT 的 `WHERE` 子句保证，SQLite 的写事务
天然跨进程串行，实测 3 进程 × 6 次预扣、限额 10 / 每次 2，最终
`credits_used=10`，**没有超支**。所以「多 worker 会导致超支」这个说法是错的。

真正的原因有两条，都是实测出来的：

1. **WAL + 长连接在多进程写入下会永久退化为只读。**
   实测 6 进程 × 20 写 × 2 轮：WAL 组 160 成功 / 80 失败，4/12 个进程
   在**此后所有写入**上都失败；DELETE 组 240 成功 / 0 失败。更关键的是，
   另一次「长连接、不重连」（即生产形态）的实测里有 3/6 个进程
   **永久不可写** —— 而 `get_search_quota()` 的 `lru_cache` 单例
   **没有任何重连路径**，一旦退化，这个进程活到重启为止都记不了账。
   注意：单进程单连接（当前生产形态）实测完全正常，本约束是**预防性**的。

2. `__init__` 里的 `_reconcile_open_reservations()` 会退还
   `state='open' AND created_at < now-600s` 的预扣。多 worker 启动时
   每个进程都会执行一次；若某笔预扣的真实请求还在飞（>600s 的慢请求），
   它会被**误退**。退款是 `credits_used - credits`，**减少**用量，
   于是账本低估 → 后续预扣放行 → 这才是真实的超支路径。

因此：
- README 标注「请勿 --workers>1」
- `/api/health` 暴露 `quota_mode: single-worker`（由 observability 层负责）
- 顺带纠正一处旧说法：`synchronous=NORMAL` 在 WAL 下的保证是
  「**进程崩溃**不丢已提交事务」；**断电 / OS 崩溃**时可能丢最后一个
  checkpoint，此时丢的是最近几笔**记账**，不影响已花出去的额度。
"""

from __future__ import annotations

import contextvars
import logging
import sqlite3
import threading
import uuid
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from functools import lru_cache
from pathlib import Path

from app.core.config import get_settings
from app.search.errors import QuotaExhaustedError

logger = logging.getLogger(__name__)

# Tavily 计费口径。新增 depth 时必须同步更新 /api/settings 的前端提示文案。
CREDITS_BY_DEPTH: dict[str, int] = {"basic": 1, "advanced": 2}
DEFAULT_DEPTH = "basic"
# 未知 depth 的记账单价：取**最高**单价，而不是跟着 DEFAULT_DEPTH 走。
# 理由见 credits_for() 的 docstring。
_UNKNOWN_DEPTH_CREDITS = max(CREDITS_BY_DEPTH.values())
_PROVIDER = "tavily"

# 配额窗口 = 自然月。时区固定 +08:00（与业务时区一致），
# 避免服务器 TZ=UTC 时出现「周期边界比用户看到的晚 8 小时」。
_TZ = timezone(timedelta(hours=8), name="UTC+8")

_SCHEMA = """
CREATE TABLE IF NOT EXISTS search_quota (
    period_key      TEXT    PRIMARY KEY,          -- '2026-09'
    credits_limit   INTEGER NOT NULL DEFAULT 1000,
    credits_used    INTEGER NOT NULL DEFAULT 0,   -- 单调不减，SQL 原子累加
    calls_total     INTEGER NOT NULL DEFAULT 0,   -- 含重试的全部真实请求数
    calls_failed    INTEGER NOT NULL DEFAULT 0,   -- 调用了但没受理（超时/5xx）
    calls_exhausted INTEGER NOT NULL DEFAULT 0,   -- 因额度不足被拒（不含退款的）
    warn_level      INTEGER NOT NULL DEFAULT 0,   -- 0 正常 1>=50% 2>=75% 3>=90% 4 耗尽
    updated_at      TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_quota_updated ON search_quota(updated_at);

CREATE TABLE IF NOT EXISTS search_quota_daily (
    day           TEXT    PRIMARY KEY,           -- '2026-09-25'
    period_key    TEXT    NOT NULL,
    calls         INTEGER NOT NULL DEFAULT 0,
    credits       INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_quota_daily_period ON search_quota_daily(period_key);
CREATE INDEX IF NOT EXISTS idx_quota_daily_day ON search_quota_daily(day);

CREATE TABLE IF NOT EXISTS search_quota_run (
    run_key       TEXT    NOT NULL,              -- graph 路径=thread_id，agent 路径=run_<hex>
    period_key    TEXT    NOT NULL,
    calls         INTEGER NOT NULL DEFAULT 0,
    credits       INTEGER NOT NULL DEFAULT 0,
    degraded      INTEGER NOT NULL DEFAULT 0,    -- 本次 run 是否触发过额度降级
    updated_at    TEXT    NOT NULL,
    PRIMARY KEY (period_key, run_key)
);
CREATE INDEX IF NOT EXISTS idx_quota_run_period ON search_quota_run(period_key);

CREATE TABLE IF NOT EXISTS search_quota_warn (
    period_key    TEXT    NOT NULL,
    level         INTEGER NOT NULL,              -- 1=50% 2=75% 3=90% 4=100%
    fired_at      TEXT    NOT NULL,
    credits_used  INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (period_key, level)
);

CREATE TABLE IF NOT EXISTS search_quota_reservation (
    reservation_id TEXT    PRIMARY KEY,          -- 'res_<16hex>'
    period_key     TEXT    NOT NULL,
    run_key        TEXT,
    depth          TEXT    NOT NULL,             -- 'advanced' | 'basic'
    credits        INTEGER NOT NULL,             -- 1 或 2
    state          TEXT    NOT NULL DEFAULT 'open',  -- open | settled | released
    created_at     TEXT    NOT NULL,
    closed_at      TEXT
);
CREATE INDEX IF NOT EXISTS idx_res_open ON search_quota_reservation(state, created_at);
CREATE INDEX IF NOT EXISTS idx_res_period ON search_quota_reservation(period_key, state);
"""


# ----------------------------- 时间 / 周期 -----------------------------


def _now() -> datetime:
    return datetime.now(_TZ)


def _period_key(now: datetime | None = None) -> str:
    return (now or _now()).strftime("%Y-%m")


def _period_bounds(period_key: str) -> tuple[datetime, datetime]:
    """'2026-09' -> (2026-09-01T00:00+08:00, 2026-10-01T00:00+08:00)。"""
    year, month = (int(part) for part in period_key.split("-"))
    start = datetime(year, month, 1, tzinfo=_TZ)
    end = datetime(year + (month == 12), (month % 12) + 1, 1, tzinfo=_TZ)
    return start, end


def _iso(value: datetime) -> str:
    return value.isoformat()


def credits_for(depth: str) -> int:
    """按 depth 查单价；未知 depth 退回**最高单价**（宁可多记，不可少记）。

    这里刻意不跟随 `DEFAULT_DEPTH`：默认值随时可能被调成 `basic`（省额度），
    但「未知值少记一笔」会让账本**低估**真实用量 —— 配额预扣的存在意义就是防超支，
    低估等于把限额悄悄放宽。所以未知值恒按 `max(CREDITS_BY_DEPTH.values())`
    计价，与默认档位解耦：换默认档只改变「选哪个档」，不改变「记错时按什么记」。
    """
    return CREDITS_BY_DEPTH.get((depth or "").strip().lower(), _UNKNOWN_DEPTH_CREDITS)


# ----------------------------- 数据模型 -----------------------------


WARN_LEVEL_LABELS: dict[int, str] = {
    0: "正常",
    1: "已过半",
    2: "接近上限",
    3: "即将耗尽",
    4: "已耗尽",
}


@dataclass(frozen=True)
class QuotaSnapshot:
    """一次额度快照。`GET /api/settings` 的 usage 契约就是它。"""

    provider: str = _PROVIDER
    period_key: str = ""
    period_start: str = ""
    period_end: str = ""
    renews_at: str = ""
    credits_limit: int = 0
    credits_used: int = 0
    credits_remaining: int = 0
    ratio: float = 0.0
    warn_level: int = 0
    calls_total: int = 0
    calls_failed_total: int = 0
    calls_quota_exhausted: int = 0
    search_depth_default: str = DEFAULT_DEPTH
    credits_per_call: int = CREDITS_BY_DEPTH[DEFAULT_DEPTH]
    avg_credits_per_run: float | None = None
    estimated_runs_remaining: int | None = None
    daily: list[dict] = field(default_factory=list)

    @property
    def warn_level_label(self) -> str:
        """档位文案。后端出文案，前端不做档位判断（PRD §3.4 展示契约）。"""
        return WARN_LEVEL_LABELS.get(self.warn_level, "正常")


@dataclass(frozen=True)
class Reservation:
    """一笔 in-flight 的额度占用。"""

    reservation_id: str
    period_key: str
    run_key: str | None
    depth: str
    credits: int


# run_id 的 ContextVar。
#
# 为什么现在就要有它：provider 需要在 `reserve(run_key=...)` 里知道「这次搜索属于哪一次运行」，
# 否则 `search_quota_run` 永远是空的，「这次研究花了多少」就只能靠 state['tool_calls'] 反推。
# 后续 observability 的 tracing 模块（架构文档 §6.1）会把这几个函数整体迁过去。
_run_id_var: contextvars.ContextVar[str | None] = contextvars.ContextVar(
    "search_run_id", default=None
)


def current_run_id() -> str | None:
    """当前 run 的 id；不在任何 run 上下文里则为 None。"""
    return _run_id_var.get()


@contextmanager
def run_context(*, run_id: str) -> Iterator[None]:
    """包住一次 run 的整个执行区间。asyncio 子任务会继承 ContextVar，无需手工透传。"""
    token = _run_id_var.set(run_id)
    try:
        yield
    finally:
        _run_id_var.reset(token)


# ----------------------------- 存储 -----------------------------


class SearchQuotaStore:
    """搜索配额的唯一记账口。所有 SQL 只出现在这个文件里。

    用法：
        quota = SearchQuotaStore(Path("storage/search_quota.db"), monthly_credits=1000)
        res = quota.reserve(depth="advanced", run_key="thread_abc")   # 请求之前
        ...                                                           # 发请求
        quota.settle(res.reservation_id)                              # 成功
        quota.release(res.reservation_id)                             # 上游拒绝受理 -> 退款
    """

    def __init__(
        self,
        db_path: str | Path,
        *,
        monthly_credits: int,
        warn_ratios: tuple[float, ...] = (0.5, 0.75, 0.9),
        depth: str = DEFAULT_DEPTH,
    ) -> None:
        self._db_path = Path(db_path)
        self._db_path.parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(str(self._db_path), check_same_thread=False, timeout=10)
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.execute("PRAGMA synchronous=NORMAL")
        self._conn.executescript(_SCHEMA)
        self._conn.commit()
        self._migrate_columns()
        # 连接被整个进程共享，写操作必须串行化（与 app/rag/store.py 同款）
        self._lock = threading.Lock()

        self._monthly_credits = max(0, int(monthly_credits))
        self._warn_ratios = tuple(sorted(float(r) for r in warn_ratios if r))
        self._depth = (depth or DEFAULT_DEPTH).strip().lower()
        if self._depth not in CREDITS_BY_DEPTH:
            logger.warning("未知的 search_depth=%s，退回 %s", depth, DEFAULT_DEPTH)
            self._depth = DEFAULT_DEPTH

        # 进程崩溃 / 重启后，上一次 open 的预扣并没有对应的真实请求。
        # 启动时一次性把它们 refund 掉，避免「幽灵扣费」。
        self._reconcile_open_reservations()

    # ---------------- 生命周期 ----------------

    def _migrate_columns(self) -> None:
        """给「本模块更早那一版建出来的库」补上新列。

        `CREATE TABLE IF NOT EXISTS` 不会动已存在的表，所以新列必须单独补。
        没有现成库时是空操作；代价是一次 PRAGMA 查询。
        """
        existing = {row[1] for row in self._conn.execute("PRAGMA table_info(search_quota)")}
        for column, definition in (
            ("calls_failed", "INTEGER NOT NULL DEFAULT 0"),
            ("calls_exhausted", "INTEGER NOT NULL DEFAULT 0"),
        ):
            if column not in existing:
                self._conn.execute(
                    f"ALTER TABLE search_quota ADD COLUMN {column} {definition}"
                )
        self._conn.commit()

    def close(self) -> None:
        with self._lock:
            self._conn.close()

    # ---------------- 周期 ----------------

    def current_period(self) -> tuple[str, str, str]:
        """返回 (period_key, period_start, period_end)，'YYYY-MM' 自然月。"""
        period_key = _period_key()
        start, end = _period_bounds(period_key)
        return period_key, _iso(start), _iso(end)

    def _ensure_current_period_locked(self) -> str:
        """写入侧的 lazy rollover：保证当前周期的行存在（已存在则不动用量）。

        跨月时 period_key 自然变化，新周期的行被插入且 credits_used=0，
        旧行原样保留做历史 —— 不需要任何定时任务。
        """
        period_key, _, _ = self.current_period()
        self._conn.execute(
            """INSERT INTO search_quota
                   (period_key, credits_limit, credits_used, calls_total, updated_at)
               VALUES (?, ?, 0, 0, ?)
               ON CONFLICT(period_key) DO UPDATE SET credits_limit = excluded.credits_limit""",
            (period_key, self._monthly_credits, _iso(_now())),
        )
        # 立即收尾事务：否则后面同一条连接上的 SELECT 会读到这里刚开启的
        # 事务快照，看不到别的连接（甚至别的进程）刚刚提交的用量。
        self._conn.commit()
        return period_key

    def _reconcile_open_reservations(self, *, max_age_seconds: float = 600.0) -> None:
        """把上次崩溃留下的 open 预扣退款掉，避免幽灵扣费（架构 §2.3.2 的 AC-17）。

        只对**过期**的 open 预扣退款（默认 10 分钟）：
        - 崩溃后进程已经没了 → 下次启动必定 refund；
        - 同一进程内 close/connect（测试、热重启）→ 不留 TP 的 in-flight 占用，
          否则正常的预扣会被自己退掉。
        """
        cutoff = _iso(datetime.fromtimestamp(_now().timestamp() - max_age_seconds, tz=_TZ))
        with self._lock:
            rows = self._conn.execute(
                """SELECT reservation_id, period_key, credits
                   FROM search_quota_reservation
                   WHERE state = 'open' AND created_at < ?""",
                (cutoff,),
            ).fetchall()
            if not rows:
                return
            refund_by_period: dict[str, int] = {}
            for row in rows:
                refund_by_period[row["period_key"]] = (
                    refund_by_period.get(row["period_key"], 0) + int(row["credits"])
                )
            now = _iso(_now())
            for reservation_id in (row["reservation_id"] for row in rows):
                self._conn.execute(
                    "UPDATE search_quota_reservation SET state = 'released', closed_at = ?"
                    " WHERE reservation_id = ?",
                    (now, reservation_id),
                )
            for period_key, refund in refund_by_period.items():
                self._conn.execute(
                    "UPDATE search_quota"
                    " SET credits_used = MAX(0, credits_used - ?), updated_at = ?"
                    " WHERE period_key = ?",
                    (refund, now, period_key),
                )
            self._conn.commit()
        logger.warning(
            "已退还 %s 条崩溃残留的搜索预扣（共 %s credits）",
            len(rows),
            sum(refund_by_period.values()),
        )

    # ---------------- 预扣 ----------------

    def reserve(self, *, depth: str, run_key: str | None = None) -> Reservation:
        """发起请求前预扣。余额不足直接抛 QuotaExhaustedError，一个字节都不会花出去。

        原子性由单条 SQL 保证：检查与累加在同一个语句里完成，
        不做「读出来 +1 再写回」（那样会丢更新）。
        """
        credits = credits_for(depth)
        period_key = self.current_period()[0]
        reservation_id = f"res_{uuid.uuid4().hex[:16]}"

        with self._lock:
            self._ensure_current_period_locked()
            row = self._conn.execute(
                "SELECT credits_used FROM search_quota WHERE period_key = ?", (period_key,)
            ).fetchone()
            used_before = int(row["credits_used"]) if row else 0

            # WHERE 里同时完成「防超支」判定；DO UPDATE 里完成「原子累加」。
            self._conn.execute(
                """INSERT INTO search_quota
                       (period_key, credits_limit, credits_used, calls_total, updated_at)
                   VALUES (?, ?, ?, 0, ?)
                   ON CONFLICT(period_key) DO UPDATE SET
                       credits_limit = excluded.credits_limit,
                       credits_used  = search_quota.credits_used + excluded.credits_used,
                       calls_total   = search_quota.calls_total  + excluded.calls_total,
                       updated_at    = excluded.updated_at
                   WHERE search_quota.credits_used + excluded.credits_used <= ?""",
                (
                    period_key,
                    self._monthly_credits,
                    credits,
                    _iso(_now()),
                    self._monthly_credits,
                ),
            )
            row = self._conn.execute(
                "SELECT credits_used FROM search_quota WHERE period_key = ?", (period_key,)
            ).fetchone()
            used_after = int(row["credits_used"]) if row else None

            # 注意：不能用 cursor.rowcount 判断成败 —— 实测 sqlite3 在
            # DO UPDATE 的 WHERE 为 false 时仍然返回 rowcount=1（它统计的是
            # 「被这条语句检视的行」）。所以这里用「前后差值」反推是否真的扣上了。
            if used_after != used_before + credits:
                remaining = max(0, self._monthly_credits - used_before)
                raise QuotaExhaustedError(
                    f"搜索额度不足：本次需要 {credits} credits，"
                    f"本期剩余 {remaining} credits，下月 1 日重置。"
                    f"可在设置里用 search_depth 切换档位（basic = 1 credit/次）以节省额度，"
                    f"或等本期额度重置。",
                    credits_remaining=remaining,
                    deficit=credits - remaining,
                )

            self._conn.execute(
                """INSERT INTO search_quota_reservation
                       (reservation_id, period_key, run_key, depth, credits, state, created_at)
                   VALUES (?, ?, ?, ?, ?, 'open', ?)""",
                (reservation_id, period_key, run_key, depth, credits, _iso(_now())),
            )
            self._conn.commit()

        logger.debug(
            "搜索预扣成功 reservation=%s depth=%s credits=%d run_key=%s",
            reservation_id,
            depth,
            credits,
            run_key,
        )
        return Reservation(
            reservation_id=reservation_id,
            period_key=period_key,
            run_key=run_key,
            depth=depth,
            credits=credits,
        )

    def try_reserve(self, *, depth: str, run_key: str | None = None) -> Reservation | None:
        """不抛异常的变体；返回 None = 额度不足。供启动前的 pre-flight 检查使用。"""
        try:
            return self.reserve(depth=depth, run_key=run_key)
        except QuotaExhaustedError:
            return None

    # ---------------- 结算 / 退款 ----------------

    def settle(
        self, reservation_id: str, *, failed: bool = False, kind: str | None = None
    ) -> None:
        """请求受理了（成功或疑似受理）：真实计费或记为一次失败调用。

        - failed=False：正常搜索，credits_used 里那笔预扣**已经生效**，这里只补 calls_total。
        - failed=True：请求疑似已被受理（超时 / 5xx），**不退还预扣**，只计 calls_total。
        """
        with self._lock:
            row = self._conn.execute(
                """SELECT reservation_id, period_key, run_key, credits
                   FROM search_quota_reservation
                   WHERE reservation_id = ? AND state = 'open'""",
                (reservation_id,),
            ).fetchone()
            if row is None:
                # 幂等：重复 settle / 已被 release 过，直接忽略
                return
            period_key = row["period_key"]
            now = _iso(_now())
            run_credits = int(row["credits"])
            self._conn.execute(
                "UPDATE search_quota_reservation SET state = 'settled', closed_at = ?"
                " WHERE reservation_id = ?",
                (now, reservation_id),
            )
            self._conn.execute(
                "UPDATE search_quota SET calls_total = calls_total + 1,"
                " calls_failed = calls_failed + ?, updated_at = ?"
                " WHERE period_key = ?",
                (1 if failed else 0, now, period_key),
            )
            # 预扣时那笔 credits 已经进了「周期总账」，这里额外把它归到 run 名下，
            # 否则 `search_quota_run.credits` 恒为 0，run 级花费和 run 级预测都无从算起。
            self._upsert_run_locked(
                period_key=period_key,
                run_key=row["run_key"],
                calls=1,
                credits=run_credits,
                degraded=1 if (failed and kind == "quota_exhausted") else 0,
                now=now,
            )
            self._conn.commit()

    def release(self, reservation_id: str, *, degraded: bool = False) -> None:
        """请求未被受理（429 / 402）：退还预扣，不计入 credits_used 与 calls_total。

        `degraded=True` 表示这次退款的原因是「额度不足」（而不是上游限流），
        会把 run 级账本标记为降级 —— 与 tool_calls 里的 error_kind=quota_exhausted 对齐。
        """
        with self._lock:
            row = self._conn.execute(
                """SELECT reservation_id, period_key, run_key, credits
                   FROM search_quota_reservation
                   WHERE reservation_id = ? AND state = 'open'""",
                (reservation_id,),
            ).fetchone()
            if row is None:
                return
            now = _iso(_now())
            self._conn.execute(
                "UPDATE search_quota_reservation SET state = 'released', closed_at = ?"
                " WHERE reservation_id = ?",
                (now, reservation_id),
            )
            self._conn.execute(
                "UPDATE search_quota SET credits_used = MAX(0, credits_used - ?),"
                " calls_exhausted = calls_exhausted + ?, updated_at = ?"
                " WHERE period_key = ?",
                (int(row["credits"]), 1 if degraded else 0, now, row["period_key"]),
            )
            self._upsert_run_locked(
                period_key=row["period_key"],
                run_key=row["run_key"],
                calls=0,
                credits=0,
                degraded=1 if degraded else 0,
                now=now,
            )
            self._conn.commit()

    def _upsert_run_locked(
        self,
        *,
        period_key: str,
        run_key: str | None,
        calls: int,
        credits: int,
        degraded: int,
        now: str,
    ) -> None:
        """run 级聚合：回答「这次研究花了多少 + 是否在降级」。"""
        if not run_key:
            return
        self._conn.execute(
            """INSERT INTO search_quota_run
                   (run_key, period_key, calls, credits, degraded, updated_at)
               VALUES (?, ?, ?, ?, ?, ?)
               ON CONFLICT(run_key, period_key) DO UPDATE SET
                   calls    = search_quota_run.calls    + excluded.calls,
                   credits  = search_quota_run.credits  + excluded.credits,
                   degraded = MAX(search_quota_run.degraded, excluded.degraded),
                   updated_at = excluded.updated_at""",
            (run_key, period_key, calls, credits, 1 if degraded else 0, now),
        )

    # ---------------- 查询 ----------------

    @property
    def depth(self) -> str:
        return self._depth

    def remaining_credits(self) -> int:
        """当前周期剩余额度。用于 429 的两义性判定（余额不足 vs 请求太频繁）。"""
        with self._lock:
            period_key = self._ensure_current_period_locked()
            row = self._conn.execute(
                "SELECT credits_used, credits_limit FROM search_quota WHERE period_key = ?",
                (period_key,),
            ).fetchone()
            used = int(row["credits_used"]) if row else 0
            limit = int(row["credits_limit"]) if row else self._monthly_credits
        return max(0, limit - used)

    def snapshot(self) -> QuotaSnapshot:
        """读取时才做 rollover 判定；顺带把「过期周期」的日/预警记录清掉。"""
        period_key, period_start, period_end = self.current_period()
        with self._lock:
            # lazy rollover 的清理侧：只保留当前周期的数据
            self._conn.execute(
                "DELETE FROM search_quota_daily WHERE day < ?", (period_start[:10],)
            )
            self._conn.execute(
                "DELETE FROM search_quota_warn WHERE period_key != ?", (period_key,)
            )
            self._conn.commit()
            period_key = self._ensure_current_period_locked()
            row = self._conn.execute(
                "SELECT * FROM search_quota WHERE period_key = ?", (period_key,)
            ).fetchone()
            used = int(row["credits_used"]) if row else 0
            calls = int(row["calls_total"]) if row else 0
            failed_calls = int(row["calls_failed"]) if row else 0
            exhausted_calls = int(row["calls_exhausted"]) if row else 0
            limit = int(row["credits_limit"]) if row else self._monthly_credits
            warn_level = self._recompute_warn_level_locked(used, limit)
            daily_rows = self._daily_locked()
            avg_per_run = self._avg_credits_per_run_locked()
            estimated = self._estimated_runs_remaining_locked(used, limit, avg_per_run)
            self._conn.commit()

        remaining = max(0, limit - used)
        return QuotaSnapshot(
            provider=_PROVIDER,
            period_key=period_key,
            period_start=period_start,
            period_end=period_end,
            renews_at=period_end,
            credits_limit=limit,
            credits_used=used,
            credits_remaining=remaining,
            ratio=round(used / limit, 4) if limit > 0 else 0.0,
            warn_level=warn_level,
            calls_total=calls,
            calls_failed_total=failed_calls,
            calls_quota_exhausted=exhausted_calls,
            search_depth_default=self._depth,
            credits_per_call=credits_for(self._depth),
            avg_credits_per_run=avg_per_run,
            estimated_runs_remaining=estimated,
            daily=daily_rows,
        )

    def daily(self, days: int = 7) -> list[dict]:
        """最近 N 天的调用量（缺的天补 0），给设置页的迷你图用。"""
        with self._lock:
            self._ensure_current_period_locked()
            rows = self._daily_locked()
        return rows

    def _daily_locked(self) -> list[dict]:
        start_day, _ = _period_bounds(_period_key())
        since = (_now() - timedelta(days=6)).strftime("%Y-%m-%d")
        since = max(since, start_day.strftime("%Y-%m-%d"))
        rows = self._conn.execute(
            "SELECT day, calls, credits FROM search_quota_daily WHERE day >= ? ORDER BY day",
            (since,),
        ).fetchall()
        actual = {row["day"]: row for row in rows}
        result: list[dict] = []
        for offset in range(6, -1, -1):
            day = (_now() - timedelta(days=offset)).strftime("%Y-%m-%d")
            if day < start_day.strftime("%Y-%m-%d"):
                continue
            row = actual.get(day)
            result.append(
                {
                    "date": day,
                    "calls": int(row["calls"]) if row else 0,
                    "credits": int(row["credits"]) if row else 0,
                }
            )
        return result

    def run_usage(self, run_key: str) -> dict:
        """一次 run 的配额消耗。查不到返回「零值 + 当前 period_key」。"""
        period_key, _, _ = self.current_period()
        with self._lock:
            self._ensure_current_period_locked()
            row = self._conn.execute(
                """SELECT calls, credits, degraded FROM search_quota_run
                   WHERE run_key = ? AND period_key = ?""",
                (run_key, period_key),
            ).fetchone()
        if row is None:
            return {
                "found": False,
                "period_key": period_key,
                "calls": 0,
                "credits": 0,
                "degraded": False,
            }
        return {
            "found": True,
            "period_key": period_key,
            "calls": int(row["calls"]),
            "credits": int(row["credits"]),
            "degraded": bool(row["degraded"]),
        }

    def warn_events(self) -> list[dict]:
        """本周期的预警记录（同周期同档只触发一次，用于 SSE 去重）。"""
        with self._lock:
            rows = self._conn.execute(
                "SELECT period_key, level, fired_at, credits_used FROM search_quota_warn"
                " ORDER BY level"
            ).fetchall()
        return [dict(row) for row in rows]

    def _recompute_warn_level_locked(self, used: int, limit: int) -> int:
        """写后 / 读时计算 warn_level 并把新档位记进去重表。"""
        period_key = _period_key()
        ratio = (used / limit) if limit > 0 else 0.0
        level = 0
        for threshold in self._warn_ratios:
            if ratio >= threshold:
                level += 1
        if ratio >= 1.0:
            level = 4

        if level > 0:
            existing = self._conn.execute(
                "SELECT credits_used FROM search_quota_warn WHERE period_key = ? AND level = ?",
                (period_key, level),
            ).fetchone()
            if existing is None:
                self._conn.execute(
                    """INSERT INTO search_quota_warn (period_key, level, fired_at, credits_used)
                       VALUES (?, ?, ?, ?)""",
                    (period_key, level, _iso(_now()), used),
                )
                log = logger.warning if level < 4 else logger.critical
                log(
                    "搜索额度预警 level=%s credits_used=%s/%s ratio=%s",
                    level,
                    used,
                    limit,
                    round(ratio, 4),
                )

        self._conn.execute(
            "UPDATE search_quota SET warn_level = ?, updated_at = ? WHERE period_key = ?",
            (level, _iso(_now()), period_key),
        )
        return level

    def _avg_credits_per_run_locked(self) -> float | None:
        """近 7 天每次 run 的平均积分消耗；没有数据（或全为 0）返回 None。"""
        since = (_now() - timedelta(days=7)).isoformat()
        rows = self._conn.execute(
            "SELECT credits FROM search_quota_run WHERE period_key = ? AND updated_at >= ?",
            (_period_key(), since),
        ).fetchall()
        if not rows:
            return None
        avg = sum(int(row["credits"]) for row in rows) / len(rows)
        return avg if avg > 0 else None

    def _estimated_runs_remaining_locked(
        self, used: int, limit: int, avg_per_run: float | None
    ) -> int | None:
        """按近 7 天每次 run 的平均消耗估算还能跑几次；数据不足返回 None。

        注意 `avg_per_run` 由调用方传入：snapshot 里平均值和预测值要在同一条
        事务快照里算出来，否则「平均 0 但预测出个整数」这种矛盾结果会漏出去。
        """
        if avg_per_run is None or avg_per_run <= 0:
            return None
        remaining = max(0, limit - used)
        return int(remaining // avg_per_run)


# ----------------------------- 进程单例 -----------------------------


@lru_cache(maxsize=1)
def get_search_quota() -> SearchQuotaStore:
    """按配置构造的进程级单例。

    ⚠️ 单 worker 语义。注意**理由不是**「多 worker 会超支」—— 防超支靠
    UPSERT 的 WHERE 子句，实测跨进程安全。真实理由见本模块顶部 docstring：
    WAL 长连接多进程写入会永久退化为只读，而这里的 `lru_cache` 一旦构造
    就不会重建，**没有重连路径**。

    这条「没有重连路径」是设计上的已知债：单例的收益是省掉每次请求的
    连接开销，代价是连接一旦坏掉就只能靠进程重启恢复。当前生产形态是
    单进程单 worker，触发不到；改多 worker 前必须先给这里补重连。
    """
    settings = get_settings()
    return SearchQuotaStore(
        Path(settings.search_quota_db_path),
        monthly_credits=settings.search_quota_monthly_credits,
        warn_ratios=tuple(settings.search_quota_warn_ratios_list),
        depth=settings.search_depth,
    )


@lru_cache(maxsize=1)
def get_search_quota_or_none() -> SearchQuotaStore | None:
    """配额关闭、或 SQLite 不可用时返回 None —— 调用方据此走「不计费」路径。

    降级成不计费（而不是让整个搜索挂掉）是有意的：配额记账是增强项，
    不该因为磁盘故障就把用户的搜索功能打掉。测试红线 B 也依赖这个语义。
    """
    settings = get_settings()
    if not settings.search_quota_enabled:
        return None
    try:
        return get_search_quota()
    except Exception:  # noqa: BLE001 - DB 不可用必须降级，不能打挂搜索
        logger.exception("搜索配额存储不可用，本次搜索按不计费处理（降级）")
        return None


def reset_search_quota_caches() -> None:
    """清掉单例缓存。只应在测试里、或改配置之后调用。"""
    get_search_quota.cache_clear()
    get_search_quota_or_none.cache_clear()

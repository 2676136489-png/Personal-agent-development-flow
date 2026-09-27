"""研究计划持久化。

[B27] 用户要求「研究规划应该和深度研究一样有历史记录」：
生成的计划落 SQLite，研究规划页可以回看、删除历史计划。
与 RunStore 共用同一个 DB 文件（WAL 模式支持多连接），
但表独立：计划是「一次性产物」，没有运行状态机，结构简单得多。
"""

from __future__ import annotations

import json
import logging
import sqlite3
import threading
import uuid
from datetime import UTC, datetime
from pathlib import Path

logger = logging.getLogger(__name__)

_SCHEMA = """
CREATE TABLE IF NOT EXISTS research_plans (
    id          TEXT PRIMARY KEY,
    question    TEXT NOT NULL,
    plan_json   TEXT NOT NULL,
    model       TEXT NOT NULL DEFAULT '',
    provider    TEXT NOT NULL DEFAULT '',
    mock        INTEGER NOT NULL DEFAULT 0,
    usage_json  TEXT,
    latency_ms  INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL
);
"""


class PlanStore:
    """与 RunStore 同款防御：共享连接 + 互斥锁 + WAL。"""

    def __init__(self, db_path: Path) -> None:
        db_path.parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(str(db_path), check_same_thread=False, timeout=10)
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.execute("PRAGMA synchronous=NORMAL")
        self._conn.executescript(_SCHEMA)
        self._conn.commit()
        self._lock = threading.Lock()

    def close(self) -> None:
        with self._lock:
            self._conn.close()

    def save(
        self,
        *,
        question: str,
        plan: dict,
        model: str,
        provider: str,
        mock: bool,
        usage: dict,
        latency_ms: int,
    ) -> dict:
        record = {
            "id": f"plan_{uuid.uuid4().hex[:12]}",
            "question": question,
            "plan": plan,
            "model": model,
            "provider": provider,
            "mock": mock,
            "usage": usage,
            "latency_ms": latency_ms,
            "created_at": datetime.now(UTC).isoformat(),
        }
        with self._lock:
            self._conn.execute(
                """INSERT INTO research_plans
                   (id, question, plan_json, model, provider, mock,
                    usage_json, latency_ms, created_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    record["id"],
                    question,
                    json.dumps(plan, ensure_ascii=False, default=str),
                    model,
                    provider,
                    1 if mock else 0,
                    json.dumps(usage, ensure_ascii=False, default=str),
                    latency_ms,
                    record["created_at"],
                ),
            )
            self._conn.commit()
        return record

    def get(self, plan_id: str) -> dict | None:
        with self._lock:
            row = self._conn.execute(
                "SELECT * FROM research_plans WHERE id = ?", (plan_id,)
            ).fetchone()
        return self._row_to_dict(row) if row else None

    def list_plans(self, limit: int = 20) -> list[dict]:
        with self._lock:
            rows = self._conn.execute(
                "SELECT * FROM research_plans ORDER BY created_at DESC LIMIT ?", (limit,)
            ).fetchall()
        # [B27-hardening] 单条坏记录（plan_json 不是合法 JSON）不能让整个列表 500：
        # 历史列表是「锦上添花」的读路径，宁可少显示一条，也不能让页面报错。
        records: list[dict] = []
        for row in rows:
            try:
                records.append(self._row_to_dict(row))
            except Exception:  # noqa: BLE001
                row_id = row["id"] if "id" in row.keys() else "?"
                logger.warning("skip broken plan row: id=%s", row_id)
        return records

    def delete(self, plan_id: str) -> bool:
        with self._lock:
            cursor = self._conn.execute("DELETE FROM research_plans WHERE id = ?", (plan_id,))
            self._conn.commit()
        return cursor.rowcount > 0

    @staticmethod
    def _row_to_dict(row: sqlite3.Row) -> dict:
        """[B27-hardening] plan_json / usage_json 解析失败时降级为空结构，不抛异常。

        落库时用的是 json.dumps(..., default=str)，正常情况一定能解析回来；
        但跨版本迁移或手工改库都可能留下坏 JSON —— 那是「这一条显示不出来」，
        不是「整个接口挂掉」。
        """
        try:
            plan = json.loads(row["plan_json"]) if row["plan_json"] else {}
        except (json.JSONDecodeError, TypeError):
            plan = {}
        try:
            usage = json.loads(row["usage_json"]) if row["usage_json"] else {}
        except (json.JSONDecodeError, TypeError):
            usage = {}
        return {
            "id": row["id"],
            "question": row["question"],
            "plan": plan,
            "model": row["model"],
            "provider": row["provider"],
            "mock": bool(row["mock"]),
            "usage": usage,
            "latency_ms": row["latency_ms"],
            "created_at": row["created_at"],
        }


_STORE: PlanStore | None = None


def get_plan_store() -> PlanStore:
    """与 RunStore 共用 agent_runs.db 文件（同库不同表）。"""
    global _STORE
    if _STORE is None:
        from app.core.config import get_settings  # noqa: PLC0415  # 延迟 import 保持测试可替换

        _STORE = PlanStore(Path(get_settings().agent_runs_db_path))
    return _STORE


def reset_plan_store() -> None:
    """测试用：换掉单例，让临时 DB 生效。"""
    global _STORE
    if _STORE is not None:
        _STORE.close()
    _STORE = None

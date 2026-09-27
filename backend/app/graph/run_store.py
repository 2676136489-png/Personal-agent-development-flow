"""Agent Run 持久化。

[P0] 为什么要单独存一份：
LangGraph 的 checkpointer（这里用 InMemorySaver）负责「图的运行状态」，
但它是进程内的，重启就没了，也不方便查询历史。
我们要的是「产品视角的运行记录」：任务是什么、到了哪一步、结果如何。

注意：InMemorySaver 意味着**中断后必须在同一进程内恢复**。
需要跨重启恢复时，换成 langgraph-checkpoint-sqlite，其余代码不用改。
"""

from __future__ import annotations

import json
import sqlite3
import threading
import uuid
from datetime import UTC, datetime
from pathlib import Path

from app.core.config import get_settings

_SCHEMA = """
CREATE TABLE IF NOT EXISTS agent_runs (
    id          TEXT PRIMARY KEY,
    thread_id   TEXT NOT NULL UNIQUE,
    question    TEXT NOT NULL,
    status      TEXT NOT NULL,
    state_json  TEXT,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
);
"""


def new_run_id() -> str:
    return f"run_{uuid.uuid4().hex[:16]}"


class RunStore:
    """[B10] 与 EventStore 一样：共享连接加互斥锁 + WAL + 可显式关闭。"""

    def __init__(self, db_path: Path) -> None:
        db_path.parent.mkdir(parents=True, exist_ok=True)
        # [B31] timeout=10：PlanStore 与本 store 共用同一个 .db 文件（不同连接），
        # 写-写并发时 SQLite 默认 busy_timeout=0 会立刻抛 database is locked。
        # 让它在锁上最多等 10 秒，把偶发竞争消化掉。
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

    def upsert(self, *, thread_id: str, question: str, status: str, state: dict | None) -> str:
        now = datetime.now(UTC).isoformat()
        payload = json.dumps(state, ensure_ascii=False, default=str) if state else None

        with self._lock:
            existing = self._conn.execute(
                "SELECT id FROM agent_runs WHERE thread_id = ?", (thread_id,)
            ).fetchone()

            if existing:
                self._conn.execute(
                    """UPDATE agent_runs
                       SET status = ?, state_json = ?, updated_at = ?
                       WHERE thread_id = ?""",
                    (status, payload, now, thread_id),
                )
                run_id = existing["id"]
            else:
                run_id = new_run_id()
                self._conn.execute(
                    """INSERT INTO agent_runs
                       (id, thread_id, question, status, state_json, created_at, updated_at)
                       VALUES (?, ?, ?, ?, ?, ?, ?)""",
                    (run_id, thread_id, question, status, payload, now, now),
                )
            self._conn.commit()
        return run_id

    def get(self, thread_id: str) -> dict | None:
        with self._lock:
            row = self._conn.execute(
                "SELECT * FROM agent_runs WHERE thread_id = ?", (thread_id,)
            ).fetchone()
        return self._row_to_dict(row) if row else None

    def list_runs(self, limit: int = 20, status: str | None = None) -> list[dict]:
        with self._lock:
            if status:
                rows = self._conn.execute(
                    "SELECT * FROM agent_runs WHERE status = ? ORDER BY updated_at DESC LIMIT ?",
                    (status, limit),
                ).fetchall()
            else:
                rows = self._conn.execute(
                    "SELECT * FROM agent_runs ORDER BY updated_at DESC LIMIT ?", (limit,)
                ).fetchall()
        return [self._row_to_dict(row) for row in rows]

    def delete(self, thread_id: str) -> bool:
        """删除一条运行记录。返回是否真的删到了（供 API 区分 404/200）。"""
        with self._lock:
            cursor = self._conn.execute(
                "DELETE FROM agent_runs WHERE thread_id = ?", (thread_id,)
            )
            self._conn.commit()
        return cursor.rowcount > 0

    def delete_all(self) -> int:
        """清空全部运行记录，返回删除条数。

        [B26] 用户明确要求「把历史记录删了」——调试期积累了大量重复/垃圾运行。
        只删 agent_runs；事件表由调用方（service 层）一并清理，保持两张表一致。
        """
        with self._lock:
            cursor = self._conn.execute("DELETE FROM agent_runs")
            self._conn.commit()
        return cursor.rowcount

    @staticmethod
    def _row_to_dict(row: sqlite3.Row) -> dict:
        state = json.loads(row["state_json"]) if row["state_json"] else None
        return {
            "id": row["id"],
            "thread_id": row["thread_id"],
            "question": row["question"],
            "status": row["status"],
            "state": state,
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
        }


_STORE: RunStore | None = None


def get_run_store() -> RunStore:
    global _STORE
    if _STORE is None:
        settings = get_settings()
        _STORE = RunStore(Path(settings.agent_runs_db_path))
    return _STORE

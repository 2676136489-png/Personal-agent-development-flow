"""事件持久化。

[P0] 为什么要落库（而不是只放内存队列）：
用户刷新页面时，SSE 会重新连接 —— 如果没有历史，
他会看到一条空的时间线，尽管任务其实已经跑了一半。
落库后 SSE 连接建立时先回放历史事件，这就是「刷新后能恢复」。
"""

from __future__ import annotations

import json
import sqlite3
import threading
from datetime import UTC, datetime
from pathlib import Path

from app.core.config import get_settings

_SCHEMA = """
CREATE TABLE IF NOT EXISTS events (
    seq        INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id  TEXT NOT NULL,
    type       TEXT NOT NULL,
    payload    TEXT,
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_thread ON events(thread_id, seq);
"""


class EventStore:
    """[B10] 连接是进程内共享的：加互斥锁避免写-写/写-读交错，
    开 WAL 减少写放大，并提供 close() 供应用关闭时释放。
    """

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

    def append(self, *, thread_id: str, type: str, payload: dict) -> dict:
        now = datetime.now(UTC)
        with self._lock:
            cursor = self._conn.execute(
                "INSERT INTO events (thread_id, type, payload, created_at) VALUES (?, ?, ?, ?)",
                (
                    thread_id,
                    type,
                    json.dumps(payload, ensure_ascii=False, default=str),
                    now.isoformat(),
                ),
            )
            self._conn.commit()
            last_id = int(cursor.lastrowid or 0)
        return {
            "id": last_id,
            "thread_id": thread_id,
            "type": type,
            "ts": now.isoformat(),
            "payload": payload,
        }

    def list_since(self, thread_id: str, after_id: int = 0, limit: int = 500) -> list[dict]:
        with self._lock:
            rows = self._conn.execute(
                "SELECT seq, thread_id, type, payload, created_at FROM events"
                " WHERE thread_id = ? AND seq > ? ORDER BY seq LIMIT ?",
                (thread_id, after_id, limit),
            ).fetchall()
        return [
            {
                "id": row["seq"],
                "thread_id": row["thread_id"],
                "type": row["type"],
                "ts": row["created_at"],
                "payload": json.loads(row["payload"]) if row["payload"] else {},
            }
            for row in rows
        ]

    def has_terminal_event(self, thread_id: str, terminal_types: set[str]) -> bool:
        if not terminal_types:
            return False
        placeholders = ", ".join("?" for _ in terminal_types)
        with self._lock:
            row = self._conn.execute(
                f"SELECT 1 FROM events WHERE thread_id = ? AND type IN ({placeholders}) LIMIT 1",  # noqa: S608
                (thread_id, *terminal_types),
            ).fetchone()
        return row is not None

    def delete_for_thread(self, thread_id: str) -> int:
        """删除某次运行的全部事件（与运行记录的删除配套，避免留下孤儿事件）。"""
        with self._lock:
            cursor = self._conn.execute(
                "DELETE FROM events WHERE thread_id = ?", (thread_id,)
            )
            self._conn.commit()
        return cursor.rowcount

    def clear(self) -> int:
        """清空全部事件（与运行记录的清空配套）。"""
        with self._lock:
            cursor = self._conn.execute("DELETE FROM events")
            self._conn.commit()
        return cursor.rowcount


_STORE: EventStore | None = None


def get_event_store() -> EventStore:
    global _STORE
    if _STORE is None:
        settings = get_settings()
        _STORE = EventStore(Path(settings.events_db_path))
    return _STORE

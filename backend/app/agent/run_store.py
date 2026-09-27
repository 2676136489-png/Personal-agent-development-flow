"""智能体工作台的运行历史持久化。

[B39] 用户要求「智能体这里也应该有历史记录，就是用户之前的问题」——
深度研究、研究规划都有历史，智能体工作台却是一次性页面：一刷新，
刚才问过什么、答了什么，全没了。

与 RunStore / PlanStore 共用同一个 DB 文件（WAL 支持多连接），
但表独立：智能体运行没有状态机、没有中断恢复，是「一次性产物」，
结构和 PlanStore 更像 —— 存问题、答案、完整轨迹、用量与耗时即可。
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
CREATE TABLE IF NOT EXISTS agent_workspace_runs (
    id              TEXT PRIMARY KEY,
    question        TEXT NOT NULL,
    answer          TEXT NOT NULL DEFAULT '',
    result_json     TEXT NOT NULL,
    finished_reason TEXT NOT NULL DEFAULT '',
    provider        TEXT NOT NULL DEFAULT '',
    model           TEXT NOT NULL DEFAULT '',
    mock            INTEGER NOT NULL DEFAULT 0,
    usage_json      TEXT,
    latency_ms      INTEGER NOT NULL DEFAULT 0,
    created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_workspace_runs_created
    ON agent_workspace_runs (created_at DESC);
"""


class AgentRunStore:
    """与 RunStore / PlanStore 同款防御：共享连接 + 互斥锁 + WAL。"""

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
        result: dict,
        provider: str,
        model: str,
        mock: bool,
    ) -> dict:
        """保存一次成功的智能体运行。

        只存**成功**的运行：失败时上游抛错、前端拿到的是错误提示，
        没有 result 可存 —— 存一条只有问题的空壳反而让历史列表变成噪声。
        """
        question = str(result.get("question") or "").strip()
        if not question:
            raise ValueError("智能体运行缺少 question，拒绝入库")

        record_id = f"agentrun_{uuid.uuid4().hex[:12]}"
        created_at = datetime.now(UTC).isoformat()
        with self._lock:
            self._conn.execute(
                """INSERT INTO agent_workspace_runs
                   (id, question, answer, result_json, finished_reason,
                    provider, model, mock, usage_json, latency_ms, created_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    record_id,
                    question,
                    str(result.get("answer") or ""),
                    json.dumps(result, ensure_ascii=False, default=str),
                    str(result.get("finished_reason") or ""),
                    provider,
                    model,
                    1 if mock else 0,
                    json.dumps(result.get("usage") or {}, ensure_ascii=False, default=str),
                    int(result.get("latency_ms") or 0),
                    created_at,
                ),
            )
            self._conn.commit()
        return {
            "id": record_id,
            "question": question,
            "created_at": created_at,
        }

    def get(self, record_id: str) -> dict | None:
        with self._lock:
            row = self._conn.execute(
                "SELECT * FROM agent_workspace_runs WHERE id = ?", (record_id,)
            ).fetchone()
        return self._row_to_dict(row) if row else None

    def list_runs(self, limit: int = 20) -> list[dict]:
        """历史列表用**摘要**（不含完整轨迹与答案）。

        为什么不在列表里返回 result：一次运行的轨迹可达数十 KB，
        列表只用于「让用户认得出是哪一次」。完整内容按 id 单独取。
        """
        with self._lock:
            rows = self._conn.execute(
                """SELECT id, question, finished_reason, provider, model, mock,
                          latency_ms, created_at
                   FROM agent_workspace_runs
                   ORDER BY created_at DESC LIMIT ?""",
                (limit,),
            ).fetchall()
        return [
            {
                "id": row["id"],
                "question": row["question"],
                "finished_reason": row["finished_reason"],
                "provider": row["provider"],
                "model": row["model"],
                "mock": bool(row["mock"]),
                "latency_ms": row["latency_ms"],
                "created_at": row["created_at"],
            }
            for row in rows
        ]

    def delete(self, record_id: str) -> bool:
        with self._lock:
            cursor = self._conn.execute(
                "DELETE FROM agent_workspace_runs WHERE id = ?", (record_id,)
            )
            self._conn.commit()
        return cursor.rowcount > 0

    def delete_all(self) -> int:
        with self._lock:
            cursor = self._conn.execute("DELETE FROM agent_workspace_runs")
            self._conn.commit()
        return cursor.rowcount

    @staticmethod
    def _row_to_dict(row: sqlite3.Row) -> dict:
        state = json.loads(row["result_json"]) if row["result_json"] else None
        return {
            "id": row["id"],
            "question": row["question"],
            "result": state,
            "created_at": row["created_at"],
        }


_STORE: AgentRunStore | None = None


def get_agent_run_store() -> AgentRunStore:
    global _STORE
    if _STORE is None:
        from app.core.config import get_settings  # noqa: PLC0415  # 避免模块级循环依赖

        _STORE = AgentRunStore(Path(get_settings().agent_runs_db_path))
    return _STORE

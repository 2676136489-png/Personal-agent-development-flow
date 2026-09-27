"""SQLite-backed knowledge store.

[P0] 为什么用 SQLite 而不是 Postgres/pgvector：
1. 它是 Python 标准库，不需要起任何服务 —— 本地开发零门槛
2. 本阶段的重点是「理解 RAG 管线」，不是搭建基础设施
3. 存储层接口已经隔离，迁移到 pgvector 时只需替换本文件

迁移触发条件（满足任一就该换了）：
- chunk 数量超过 10 万（内存里做余弦检索会变慢）
- 需要多实例共享同一份知识库
"""

from __future__ import annotations

import json
import sqlite3
import threading
import uuid
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from app.core.config import get_settings
from app.rag.schemas import Document, DocumentChunk, Source

_SCHEMA = """
CREATE TABLE IF NOT EXISTS sources (
    id          TEXT PRIMARY KEY,
    type        TEXT NOT NULL,
    name        TEXT NOT NULL,
    url         TEXT,
    created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS documents (
    id               TEXT PRIMARY KEY,
    source_id        TEXT NOT NULL,
    filename         TEXT NOT NULL,
    mime_type        TEXT NOT NULL,
    size_bytes       INTEGER NOT NULL,
    page_count       INTEGER,
    chunk_count      INTEGER NOT NULL DEFAULT 0,
    status           TEXT NOT NULL,
    error            TEXT,
    embedding_model  TEXT,
    created_at       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS document_chunks (
    id              TEXT PRIMARY KEY,
    document_id     TEXT NOT NULL,
    chunk_index     INTEGER NOT NULL,
    content         TEXT NOT NULL,
    page            INTEGER,
    char_start      INTEGER,
    char_end        INTEGER,
    token_estimate  INTEGER NOT NULL DEFAULT 0,
    embedding       BLOB,
    created_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_chunks_document ON document_chunks(document_id);
"""


def _now() -> datetime:
    return datetime.now(UTC)


def _to_iso(value: datetime) -> str:
    return value.isoformat()


def _from_iso(value: str) -> datetime:
    return datetime.fromisoformat(value)


def new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:16]}"


class KnowledgeStore:
    """知识库的读写门面。所有 SQL 只出现在这个文件里。"""

    def __init__(self, db_path: Path) -> None:
        self._db_path = db_path
        self._db_path.parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(str(db_path), check_same_thread=False, timeout=10)
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.execute("PRAGMA synchronous=NORMAL")
        self._conn.executescript(_SCHEMA)
        self._conn.commit()
        # [B10] 连接被整个进程共享，写操作必须串行化
        self._lock = threading.Lock()

    def close(self) -> None:
        with self._lock:
            self._conn.close()

    # ---------- write ----------

    def create_source(self, *, type: str, name: str, url: str | None = None) -> Source:
        source = Source(id=new_id("src"), type=type, name=name, url=url, created_at=_now())
        with self._lock:
            self._conn.execute(
                "INSERT INTO sources (id, type, name, url, created_at) VALUES (?, ?, ?, ?, ?)",
                (
                    source.id,
                    source.type,
                    source.name,
                    source.url,
                    _to_iso(source.created_at),
                ),
            )
            self._conn.commit()
        return source

    def create_document(
        self,
        *,
        source_id: str,
        filename: str,
        mime_type: str,
        size_bytes: int,
        status: str = "processing",
    ) -> Document:
        document = Document(
            id=new_id("doc"),
            source_id=source_id,
            filename=filename,
            mime_type=mime_type,
            size_bytes=size_bytes,
            status=status,
            created_at=_now(),
        )
        with self._lock:
            self._conn.execute(
                """INSERT INTO documents
                   (id, source_id, filename, mime_type, size_bytes, page_count,
                    chunk_count, status, error, embedding_model, created_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    document.id,
                    document.source_id,
                    document.filename,
                    document.mime_type,
                    document.size_bytes,
                    None,
                    0,
                    document.status,
                    None,
                    None,
                    _to_iso(document.created_at),
                ),
            )
            self._conn.commit()
        return document

    def update_document(
        self,
        document_id: str,
        *,
        status: str | None = None,
        error: str | None = None,
        page_count: int | None = None,
        chunk_count: int | None = None,
        embedding_model: str | None = None,
    ) -> None:
        fields: list[str] = []
        values: list[Any] = []
        for column, value in (
            ("status", status),
            ("error", error),
            ("page_count", page_count),
            ("chunk_count", chunk_count),
            ("embedding_model", embedding_model),
        ):
            if value is not None:
                fields.append(f"{column} = ?")
                values.append(value)
        if not fields:
            return
        values.append(document_id)
        with self._lock:
            self._conn.execute(
                f"UPDATE documents SET {', '.join(fields)} WHERE id = ?",  # noqa: S608 - 列名是固定常量
                values,
            )
            self._conn.commit()

    def save_chunks(self, chunks: list[DocumentChunk], embeddings: list[list[float]]) -> None:
        rows = []
        for chunk, vector in zip(chunks, embeddings, strict=True):
            rows.append(
                (
                    chunk.id,
                    chunk.document_id,
                    chunk.chunk_index,
                    chunk.content,
                    chunk.page,
                    chunk.char_start,
                    chunk.char_end,
                    chunk.token_estimate,
                    json.dumps(vector),
                    _to_iso(chunk.created_at),
                )
            )
        with self._lock:
            self._conn.executemany(
                """INSERT INTO document_chunks
                   (id, document_id, chunk_index, content, page, char_start, char_end,
                    token_estimate, embedding, created_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                rows,
            )
            self._conn.commit()

    # ---------- read ----------

    def list_documents(self) -> list[Document]:
        rows = self._conn.execute(
            "SELECT * FROM documents ORDER BY created_at DESC"
        ).fetchall()
        return [self._row_to_document(row) for row in rows]

    def get_document(self, document_id: str) -> Document | None:
        row = self._conn.execute(
            "SELECT * FROM documents WHERE id = ?", (document_id,)
        ).fetchone()
        return self._row_to_document(row) if row else None

    def delete_document(self, document_id: str) -> bool:
        """删除一份文档及其全部 chunk（向量索引会在下次检索时按版本号重建）。"""
        with self._lock:
            self._conn.execute(
                "DELETE FROM document_chunks WHERE document_id = ?", (document_id,)
            )
            cursor = self._conn.execute(
                "DELETE FROM documents WHERE id = ?", (document_id,)
            )
            self._conn.commit()
        return cursor.rowcount > 0

    def get_chunk(self, chunk_id: str) -> DocumentChunk | None:
        row = self._conn.execute(
            "SELECT id, document_id, chunk_index, content, page, char_start, char_end,"
            " token_estimate, created_at FROM document_chunks WHERE id = ?",
            (chunk_id,),
        ).fetchone()
        return self._row_to_chunk(row) if row else None

    def list_chunks(self, document_id: str) -> list[DocumentChunk]:
        rows = self._conn.execute(
            "SELECT id, document_id, chunk_index, content, page, char_start, char_end,"
            " token_estimate, created_at FROM document_chunks WHERE document_id = ?"
            " ORDER BY chunk_index",
            (document_id,),
        ).fetchall()
        return [self._row_to_chunk(row) for row in rows]

    def load_vectors(self, embedding_model: str) -> list[tuple[str, list[float]]]:
        """取出「用当前 embedding 模型生成」的全部向量，用于构建内存索引。"""
        rows = self._conn.execute(
            """SELECT c.id, c.embedding
               FROM document_chunks c
               JOIN documents d ON d.id = c.document_id
               WHERE c.embedding IS NOT NULL AND d.embedding_model = ?""",
            (embedding_model,),
        ).fetchall()
        return [(row["id"], json.loads(row["embedding"])) for row in rows]

    # ---------- mapping ----------

    @staticmethod
    def _row_to_document(row: sqlite3.Row) -> Document:
        return Document(
            id=row["id"],
            source_id=row["source_id"],
            filename=row["filename"],
            mime_type=row["mime_type"],
            size_bytes=row["size_bytes"],
            page_count=row["page_count"],
            chunk_count=row["chunk_count"],
            status=row["status"],
            error=row["error"],
            embedding_model=row["embedding_model"],
            created_at=_from_iso(row["created_at"]),
        )

    @staticmethod
    def _row_to_chunk(row: sqlite3.Row) -> DocumentChunk:
        return DocumentChunk(
            id=row["id"],
            document_id=row["document_id"],
            chunk_index=row["chunk_index"],
            content=row["content"],
            page=row["page"],
            char_start=row["char_start"],
            char_end=row["char_end"],
            token_estimate=row["token_estimate"],
            created_at=_from_iso(row["created_at"]),
        )


_STORE: KnowledgeStore | None = None


def get_knowledge_store() -> KnowledgeStore:
    """进程内单例。"""
    global _STORE
    if _STORE is None:
        settings = get_settings()
        _STORE = KnowledgeStore(Path(settings.knowledge_db_path))
    return _STORE

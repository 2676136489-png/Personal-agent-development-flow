"""Knowledge base service: ingest 与 retrieval 的完整管线。

ingest:  上传 → 解析 → 切块 → embedding → 存库 → 重建索引
retrieve: query → embedding → 余弦检索 → 带上 document/page 信息返回

[P0] 向量模型会换。换完之后旧向量（维度、语义空间都不同）必须重算 ——
否则新旧向量混在一个索引里，检索结果会莫名其妙。所以：
- 每份文档记录生成它的 model id（documents.embedding_model）
- 检索只认当前 model 的向量
- 启动时把「model 不一致」的文档后台重算（reindex_stale）
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime
from pathlib import Path

from app.core.config import Settings, get_settings
from app.core.errors import AppError, ErrorCode
from app.rag.chunking import chunk_document, estimate_tokens, split_sentences
from app.rag.embeddings import (
    EmbeddingProvider,
    embedding_status,
    get_embedding_provider,
)
from app.rag.parsing import ParsedDocument, parse_bytes
from app.rag.schemas import Document, DocumentChunk, RetrievedChunk, Source
from app.rag.store import KnowledgeStore, get_knowledge_store, new_id
from app.rag.vector import VectorIndex

logger = logging.getLogger(__name__)


class KnowledgeService:
    def __init__(
        self,
        store: KnowledgeStore,
        provider: EmbeddingProvider | None = None,
        settings: Settings | None = None,
    ) -> None:
        self._store = store
        self._settings = settings or get_settings()
        # 测试可以注入固定 provider；生产环境每次取当前生效的那个
        # （换模型/换配置不需要重启进程）
        self._provider_override = provider
        self._index = VectorIndex()
        self._version = 0
        self._index_model: str | None = None

    # ---------- 内部工具 ----------

    def _provider(self) -> EmbeddingProvider:
        return self._provider_override or get_embedding_provider()

    async def _chunk(self, parsed: ParsedDocument, provider: EmbeddingProvider) -> list:
        strategy = (self._settings.chunk_strategy or "recursive").strip()
        sentence_vectors = None
        if strategy == "semantic":
            # 语义切分要先用同一个模型把句子向量算出来
            sentence_vectors = {}
            pages = parsed.pages if parsed.pages is not None else [parsed.text]
            for index, page_text in enumerate(pages, start=1 if parsed.pages is not None else 0):
                sentences = split_sentences(page_text)
                sentence_vectors[index] = (
                    await provider.embed([item[0] for item in sentences]) if sentences else []
                )
        return chunk_document(
            parsed,
            strategy=strategy,
            chunk_size=self._settings.chunk_size,
            overlap=self._settings.chunk_overlap,
            min_chunk=self._settings.chunk_min_size,
            sentence_vectors=sentence_vectors,
        )

    async def _process(self, document: Document, parsed: ParsedDocument) -> Document:
        provider = self._provider()
        drafts = await self._chunk(parsed, provider)
        if not drafts:
            raise ValueError("没有从文件中提取到任何文本")

        created_at = datetime.now(UTC)
        chunks = [
            DocumentChunk(
                id=new_id("chk"),
                document_id=document.id,
                chunk_index=index,
                content=draft.content,
                page=draft.page,
                char_start=draft.char_start,
                char_end=draft.char_end,
                token_estimate=estimate_tokens(draft.content),
                created_at=created_at,
            )
            for index, draft in enumerate(drafts)
        ]

        vectors = await provider.embed([chunk.content for chunk in chunks])
        if len(vectors) != len(chunks):
            raise ValueError("embedding 返回数量与 chunk 数量不一致")

        self._store.save_chunks(chunks, vectors)
        self._store.update_document(
            document.id,
            status="ready",
            page_count=parsed.page_count,
            chunk_count=len(chunks),
            embedding_model=provider.model_name,
        )
        self._version += 1
        logger.info(
            "document ingested: id=%s chunks=%s model=%s file=%s",
            document.id,
            len(chunks),
            provider.model_name,
            document.filename,
        )
        return self._store.get_document(document.id) or document

    # ---------- ingest ----------

    async def ingest(
        self,
        *,
        data: bytes,
        filename: str,
        content_type: str | None = None,
    ) -> Document:
        parsed, mime_type = parse_bytes(data, filename, content_type)

        source: Source = self._store.create_source(type="upload", name=filename)
        document = self._store.create_document(
            source_id=source.id,
            filename=filename,
            mime_type=mime_type,
            size_bytes=len(data),
        )

        try:
            # 1) 保存原始文件（路径由 document_id 推导，不必再存一列）
            extension = Path(filename).suffix or ".bin"
            storage_path = Path(self._settings.storage_dir) / f"{document.id}{extension}"
            storage_path.parent.mkdir(parents=True, exist_ok=True)
            storage_path.write_bytes(data)

            return await self._process(document, parsed)
        except Exception as exc:
            #  ingestion 失败不能让请求崩：标记 failed 并把原因暴露给调用方
            logger.exception("document ingestion failed: %s", document.id)
            self._store.update_document(document.id, status="failed", error=str(exc))
            raise AppError(
                code=ErrorCode.VALIDATION_ERROR,
                message=f"文档处理失败：{exc}",
                status_code=400,
            ) from exc

    async def reindex_document(self, document_id: str) -> Document:
        """用当前向量模型重算一份文档（重新切块 + 重新向量化）。"""
        document, parsed = self.load_document_parsed(document_id)
        try:
            self._store.delete_chunks(document_id)
            self._store.update_document(document_id, status="processing", error="")
            return await self._process(document, parsed)
        except Exception as exc:
            logger.exception("document reindex failed: %s", document_id)
            self._store.update_document(document_id, status="failed", error=str(exc))
            raise AppError(
                code=ErrorCode.VALIDATION_ERROR,
                message=f"重建向量失败：{exc}",
                status_code=400,
            ) from exc

    async def reindex_stale(self, *, force: bool = False) -> dict:
        """把所有「向量模型不是当前模型」的文档重算。

        换 embedding 后端后必须跑一次，否则旧向量永远检索不到（也不该被检索到）。
        """
        model = self._provider().model_name
        stale = [
            document
            for document in self._store.list_documents()
            if force or (document.embedding_model or "") != model
        ]
        done, failed = 0, 0
        for document in stale:
            if document.status == "failed" and not self._file_path(document):
                continue
            try:
                await self.reindex_document(document.id)
                done += 1
            except Exception:  # noqa: BLE001 - 单篇失败不影响其余
                failed += 1
                logger.warning("reindex failed: %s", document.filename, exc_info=True)
        if done or failed:
            logger.info("reindex finished: model=%s done=%s failed=%s", model, done, failed)
        return {"model": model, "total": len(stale), "done": done, "failed": failed}

    # ---------- retrieve ----------

    def _ensure_index(self) -> None:
        model = self._provider().model_name
        if self._index_model != model:
            # 换了向量模型：旧索引全部作废
            self._index_model = model
            self._version += 1
        if self._index.is_stale(self._version):
            items = self._store.load_vectors(model)
            self._index.rebuild(items, self._version)
            logger.info("vector index rebuilt: chunks=%s model=%s", self._index.size, model)

    async def search(self, query: str, top_k: int | None = None) -> list[RetrievedChunk]:
        self._ensure_index()
        if self._index.size == 0:
            return []

        limit = top_k or self._settings.retrieval_top_k
        query_vectors = await self._provider().embed([query])
        hits = self._index.search(query_vectors[0], limit)

        results: list[RetrievedChunk] = []
        for chunk_id, score in hits:
            chunk = self._store.get_chunk(chunk_id)
            if chunk is None:
                continue
            document = self._store.get_document(chunk.document_id)
            results.append(
                RetrievedChunk(
                    chunk_id=chunk.id,
                    document_id=chunk.document_id,
                    filename=document.filename if document else "(unknown)",
                    content=chunk.content,
                    score=round(score, 4),
                    page=chunk.page,
                    char_start=chunk.char_start,
                    char_end=chunk.char_end,
                    chunk_index=chunk.chunk_index,
                )
            )
        return results

    # ---------- read ----------

    def list_documents(self) -> list[Document]:
        return self._store.list_documents()

    def list_chunks(self, document_id: str) -> list[DocumentChunk]:
        return self._store.list_chunks(document_id)

    def status(self) -> dict:
        """知识库整体状态：向量后端 + 文档/片段计数 + 待重建数量。"""
        model = self._provider().model_name
        documents = self._store.list_documents()
        stale = [d for d in documents if (d.embedding_model or "") != model]
        return {
            **embedding_status(),
            "documents": len(documents),
            "chunks": self._store.count_chunks(),
            "stale_documents": len(stale),
            "active_model": model,
            "chunk_strategy": self._settings.chunk_strategy,
            "chunk_size": self._settings.chunk_size,
            "chunk_overlap": self._settings.chunk_overlap,
        }

    def delete_document(self, document_id: str) -> bool:
        """删除一份文档：删 chunk + 文档记录，并让向量索引失效重建。"""
        deleted = self._store.delete_document(document_id)
        if deleted:
            # 版本号 +1 → 下次检索时 _ensure_index 会按新版本重建索引
            self._version += 1
        return deleted

    def _file_path(self, document: Document) -> Path | None:
        suffix = Path(document.filename).suffix or ".bin"
        path = Path(self._settings.storage_dir) / f"{document.id}{suffix}"
        return path if path.is_file() else None

    def load_document_parsed(self, document_id: str) -> tuple[Document, ParsedDocument]:
        """读回一份文档的解析结果（RAG 实验台 / 重建向量都要用）。"""
        document = self._store.get_document(document_id)
        if document is None:
            raise AppError(
                code=ErrorCode.NOT_FOUND,
                message=f"找不到这份文档：{document_id}",
                status_code=404,
            )
        path = self._file_path(document)
        if path is not None:
            parsed, _ = parse_bytes(path.read_bytes(), document.filename, document.mime_type)
            return document, parsed

        # 原始文件已被清理：退化成用库里的 chunk 拼回文本（会丢失原始分页）
        chunks = self._store.list_chunks(document_id)
        if not chunks:
            raise AppError(
                code=ErrorCode.NOT_FOUND,
                message=f"这份文档没有可用的原文：{document.filename}",
                status_code=404,
            )
        text = "\n\n".join(chunk.content for chunk in chunks)
        return document, ParsedDocument(pages=None, text=text, page_count=None)


_SERVICE: KnowledgeService | None = None


def get_knowledge_service() -> KnowledgeService:
    global _SERVICE
    if _SERVICE is None:
        _SERVICE = KnowledgeService(
            store=get_knowledge_store(),
            provider=None,
            settings=get_settings(),
        )
    return _SERVICE


# ---------------------------------------------------------------- 预置示例文档

_SEED_DIR = Path(__file__).parent / "seed_docs"


async def seed_knowledge_base_if_empty() -> None:
    """[B29] 补齐预置示例文档（启动钩子调用，后台执行不阻塞服务）。

    空库让「先查知识库再联网」的检索策略形同虚设，新用户也看不到知识库能干什么。

    ⚠️ 判据是「缺哪份补哪份」而不是「库为空才导入」：
    已有知识库（哪怕只有用户传的测试文档）常常更需要示例内容，
    按文件名精确补齐才不会让这个功能在非空库里永久失效。

    幂等：已存在同名 [示例] 文档的会跳过；单篇失败只记日志，不影响其余。
    """
    if not _SEED_DIR.is_dir():
        return
    service = get_knowledge_service()
    existing = {doc.filename for doc in service.list_documents()}

    for path in sorted(_SEED_DIR.glob("*.md")):
        filename = f"[示例] {path.name}"
        if filename in existing:
            continue
        try:
            await service.ingest(
                data=path.read_bytes(),
                filename=filename,
                content_type="text/markdown",
            )
            logger.info("seed document ingested: %s", path.name)
        except Exception:  # noqa: BLE001 - 单篇失败不阻塞启动
            logger.warning("seed document failed: %s", path.name, exc_info=True)

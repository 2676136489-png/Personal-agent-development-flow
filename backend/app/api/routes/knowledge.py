"""Knowledge base endpoints: upload, list, chunks, search."""

from __future__ import annotations

from fastapi import APIRouter, Depends, File, UploadFile

from app.core.config import get_settings
from app.core.errors import AppError, ErrorCode
from app.core.responses import ApiResponse, success_response
from app.rag.schemas import Document, DocumentChunk, RetrievedChunk
from app.rag.service import KnowledgeService, get_knowledge_service
from app.schemas.knowledge import SearchRequest

router = APIRouter(prefix="/knowledge", tags=["knowledge"])

# 允许上传的类型白名单（不要相信客户端传来的 content-type）
_ALLOWED_SUFFIXES = {".pdf", ".md", ".markdown", ".txt"}

_READ_CHUNK_BYTES = 256 * 1024


async def _read_limited(file: UploadFile, max_bytes: int) -> bytes:
    """分块读取上传内容，超过上限就立刻停止（不会把整个文件读进内存）。

    [B2] 客户端声明的 Content-Length 不可信，所以读取过程中仍要累计校验，
    一旦越界立即抛 413 —— 内存占用始终被限制在 max_bytes 之内。
    """
    chunks: list[bytes] = []
    total = 0
    while True:
        chunk = await file.read(_READ_CHUNK_BYTES)
        if not chunk:
            break
        total += len(chunk)
        if total > max_bytes:
            raise AppError(
                code=ErrorCode.VALIDATION_ERROR,
                message=f"文件过大：超过 {max_bytes} 字节上限",
                status_code=413,
            )
        chunks.append(chunk)
    return b"".join(chunks)


@router.post(
    "/documents",
    response_model=ApiResponse[Document],
    summary="上传并摄入一份文档（PDF / Markdown / TXT）",
)
async def upload_document(
    file: UploadFile = File(...),
    service: KnowledgeService = Depends(get_knowledge_service),
) -> ApiResponse[Document]:
    settings = get_settings()
    filename = file.filename or "unnamed"
    suffix = filename[filename.rfind(".") :].lower() if "." in filename else ""

    # [B2] 上传安全三件事：类型白名单、大小上限、文件名可控
    if suffix not in _ALLOWED_SUFFIXES:
        raise AppError(
            code=ErrorCode.VALIDATION_ERROR,
            message=(
                f"不支持的文件类型：{suffix or '未知'}，"
                f"仅支持 {', '.join(sorted(_ALLOWED_SUFFIXES))}"
            ),
            status_code=415,
        )

    # [B2] 先按声明大小拦截，再**分块**读取并边读边校验。
    # 之前是先 await file.read() 再判断大小：上限形同虚设，
    # 一个 2GB 文件会先被完整读进进程内存，才返回 413。
    declared_size = file.size or 0
    if declared_size > settings.upload_max_bytes:
        raise AppError(
            code=ErrorCode.VALIDATION_ERROR,
            message=f"文件过大：{declared_size} 字节，上限 {settings.upload_max_bytes} 字节",
            status_code=413,
        )

    data = await _read_limited(file, settings.upload_max_bytes)
    if not data:
        raise AppError(
            code=ErrorCode.VALIDATION_ERROR,
            message="空文件",
            status_code=400,
        )

    document = await service.ingest(
        data=data,
        filename=filename,
        content_type=file.content_type,
    )
    return success_response(document)


@router.get(
    "/documents",
    response_model=ApiResponse[list[Document]],
    summary="列出已摄入的文档",
)
async def list_documents(
    service: KnowledgeService = Depends(get_knowledge_service),
) -> ApiResponse[list[Document]]:
    return success_response(service.list_documents())


@router.get(
    "/documents/{document_id}/chunks",
    response_model=ApiResponse[list[DocumentChunk]],
    summary="查看某文档被切成哪些块（带页码/字符位置）",
)
async def list_chunks(
    document_id: str,
    service: KnowledgeService = Depends(get_knowledge_service),
) -> ApiResponse[list[DocumentChunk]]:
    return success_response(service.list_chunks(document_id))


@router.delete(
    "/documents/{document_id}",
    response_model=ApiResponse[dict],
    summary="删除一份文档及其全部片段",
)
async def delete_document(
    document_id: str,
    service: KnowledgeService = Depends(get_knowledge_service),
) -> ApiResponse[dict]:
    if not service.delete_document(document_id):
        raise AppError(
            code=ErrorCode.NOT_FOUND,
            message=f"找不到这份文档：{document_id}",
            status_code=404,
        )
    return success_response({"deleted": True, "document_id": document_id})


@router.post(
    "/search",
    response_model=ApiResponse[list[RetrievedChunk]],
    summary="在知识库中做语义检索",
)
async def search_knowledge(
    payload: SearchRequest,
    service: KnowledgeService = Depends(get_knowledge_service),
) -> ApiResponse[list[RetrievedChunk]]:
    results = await service.search(payload.query, payload.top_k)
    return success_response(results)

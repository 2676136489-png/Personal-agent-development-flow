"""RAG 实验台接口：方法清单 + 一次完整流水线的可视化产物。

和 /api/knowledge/* 的分工：
- /knowledge 管**库**（哪些文档、切成什么样、检索命中什么）
- /rag 管**流程**（这次用哪种切法/向量/检索，每一步的中间结果长什么样）
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, Depends

from app.core.config import get_settings
from app.core.errors import AppError, ErrorCode
from app.core.responses import ApiResponse, success_response
from app.llm.errors import LLMError
from app.rag.lab import build_options, run_pipeline
from app.rag.parsing import ParsedDocument
from app.rag.service import KnowledgeService, get_knowledge_service
from app.schemas.rag import RagRunRequest

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/rag", tags=["rag"])


@router.get(
    "/options",
    response_model=ApiResponse[dict],
    summary="可选的切块 / 向量化 / 检索方法（含官方文档链接与参数范围）",
)
async def rag_options() -> ApiResponse[dict]:
    return success_response(build_options())


@router.post(
    "/pipeline",
    response_model=ApiResponse[dict],
    summary="按选定方法跑一遍 RAG，返回每一步的中间产物",
)
async def rag_pipeline(
    payload: RagRunRequest,
    service: KnowledgeService = Depends(get_knowledge_service),
) -> ApiResponse[dict]:
    settings = get_settings()

    if payload.corpus.kind == "document":
        document, parsed = service.load_document_parsed(payload.corpus.document_id or "")
        title = document.filename
    else:
        text = (payload.corpus.text or "").strip()
        parsed = ParsedDocument(pages=None, text=text, page_count=None)
        title = payload.corpus.title or "粘贴的文本"

    if len(parsed.text) > settings.rag_lab_max_chars:
        raise AppError(
            code=ErrorCode.VALIDATION_ERROR,
            message=(
                f"材料太长（{len(parsed.text):,} 字），演示上限 {settings.rag_lab_max_chars:,} 字。"
                "换一份更短的材料，或直接上传进知识库。"
            ),
            status_code=413,
        )

    try:
        result = await run_pipeline(
            query=payload.query.strip(),
            parsed=parsed,
            title=title,
            chunking=payload.chunking.model_dump(),
            embedder_id=payload.embedding.spec_id,
            retrieval=payload.retrieval.model_dump(),
        )
    except ValueError as exc:
        raise AppError(
            code=ErrorCode.VALIDATION_ERROR,
            message=str(exc),
            status_code=400,
        ) from exc
    except LLMError as exc:
        raise AppError(
            code=ErrorCode.UPSTREAM_ERROR,
            message=f"向量化失败：{exc}",
            status_code=502,
        ) from exc

    return success_response(result)

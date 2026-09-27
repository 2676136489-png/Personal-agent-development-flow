"""Research endpoints."""

from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, Query

from app.core.errors import AppError, ErrorCode
from app.core.responses import ApiResponse, success_response
from app.graph.plan_store import get_plan_store
from app.llm.client import LLMClient, get_llm_client
from app.llm.errors import LLMError
from app.schemas.research import PlanRequest, PlanResponse
from app.services.planning_service import create_research_plan

router = APIRouter(prefix="/research", tags=["research"])


@router.post(
    "/plan",
    response_model=ApiResponse[PlanResponse],
    summary="Generate a structured research plan with LLM",
)
async def generate_plan(
    payload: PlanRequest,
    client: LLMClient = Depends(get_llm_client),
) -> ApiResponse[PlanResponse]:
    """把用户的研究问题交给 LLM，返回结构化研究计划。

    [P1] 错误处理策略：
    LLM 是外部依赖，它失败不能让前端看到 500 堆栈。
    统一翻译成 UPSTREAM_ERROR + 502，并把「是哪一类失败」写进 message。
    """
    try:
        plan = await create_research_plan(
            client=client,
            question=payload.question,
            max_steps=payload.max_steps,
        )
    except LLMError as exc:
        raise AppError(
            code=ErrorCode.UPSTREAM_ERROR,
            message=f"大模型调用失败：{exc.message}",
            status_code=502,
            details={"kind": exc.kind, "retryable": exc.retryable},
        ) from exc

    return success_response(plan)


@router.get(
    "/plans",
    response_model=ApiResponse[list[dict]],
    summary="列出历史研究计划",
)
async def list_research_plans(
    limit: int = Query(default=20, ge=1, le=100),
) -> ApiResponse[list[dict]]:
    """[B27] 研究规划页的历史列表：每次成功生成的计划都会落库。

    [B27-hardening] 历史列表是辅助读路径：存储层任何异常都降级为空列表，
    绝不让它把「生成研究计划」所在的页面拖成 500 —— 主流程的可用性
    高于历史回顾。
    """
    try:
        return success_response(get_plan_store().list_plans(limit=limit))
    except Exception:  # noqa: BLE001
        logging.getLogger(__name__).exception("列出历史规划失败，降级返回空列表")
        return success_response([])


@router.delete(
    "/plans/{plan_id}",
    response_model=ApiResponse[dict],
    summary="删除一条历史研究计划",
)
async def delete_research_plan(plan_id: str) -> ApiResponse[dict]:
    if not get_plan_store().delete(plan_id):
        raise AppError(
            code=ErrorCode.NOT_FOUND,
            message=f"找不到这条计划：{plan_id}",
            status_code=404,
        )
    return success_response({"deleted": True, "plan_id": plan_id})

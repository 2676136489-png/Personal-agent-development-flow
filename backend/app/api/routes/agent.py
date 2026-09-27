"""Agent endpoints."""

from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, Query

from app.agent.orchestrator import run_agent
from app.agent.run_store import get_agent_run_store
from app.agent.schemas import AgentRunResult
from app.core.config import get_settings
from app.core.errors import AppError, ErrorCode
from app.core.responses import ApiResponse, success_response
from app.llm.client import LLMClient, get_llm_client
from app.llm.errors import LLMError
from app.schemas.agent import AgentRunRequest
from app.tools.registry import ToolRegistry, build_default_registry

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/agent", tags=["agent"])


def get_tool_registry() -> ToolRegistry:
    """注册表里有哪些工具是**代码决定的**，模型无法扩充。"""
    return build_default_registry()


def _active_model_name(provider: str) -> str:
    """当前 provider 对应的模型名（用于历史记录展示）。

    只用配置值：真实模型名要等 LLM 响应才知道，而它不在 AgentRunResult 里，
    为一条历史记录的展示字段去改编排器的返回结构不划算。
    """
    settings = get_settings()
    return settings.ollama_model if provider == "ollama" else settings.llm_model


@router.post(
    "/run",
    response_model=ApiResponse[AgentRunResult],
    summary="Run the minimal tool-calling agent loop",
)
async def run_agent_endpoint(
    payload: AgentRunRequest,
    client: LLMClient = Depends(get_llm_client),
    registry: ToolRegistry = Depends(get_tool_registry),
) -> ApiResponse[AgentRunResult]:
    """执行一个最小的 Tool Calling 循环并返回完整轨迹。"""
    try:
        result = await run_agent(
            question=payload.question,
            client=client,
            registry=registry,
            max_steps=payload.max_steps,
        )
    except LLMError as exc:
        raise AppError(
            code=ErrorCode.UPSTREAM_ERROR,
            message=f"大模型调用失败：{exc.message}",
            status_code=502,
            details={"kind": exc.kind, "retryable": exc.retryable},
        ) from exc

    # [B39] 落一条历史。持久化失败**不能**把一次成功的运行变成 500 ——
    # 用户要的是答案，历史是附加价值（与研究规划的降级策略一致）。
    try:
        get_agent_run_store().save(
            result=result.model_dump(),
            provider=client.provider_name,
            model=_active_model_name(client.provider_name),
            mock=result.mock,
        )
    except Exception:  # noqa: BLE001
        logger.exception("智能体运行历史保存失败（不影响本次结果返回）")

    return success_response(result)


@router.get(
    "/runs",
    response_model=ApiResponse[list[dict]],
    summary="列出历史智能体运行（用户之前问过的问题）",
)
async def list_agent_runs(
    limit: int = Query(default=20, ge=1, le=100),
) -> ApiResponse[list[dict]]:
    """历史列表是辅助读路径：存储层异常降级为空列表，绝不拖垮主流程。"""
    try:
        return success_response(get_agent_run_store().list_runs(limit=limit))
    except Exception:  # noqa: BLE001
        logger.exception("列出智能体历史失败，降级返回空列表")
        return success_response([])


@router.get(
    "/runs/{record_id}",
    response_model=ApiResponse[dict],
    summary="取一次历史智能体运行的完整结果",
)
async def get_agent_run(record_id: str) -> ApiResponse[dict]:
    record = get_agent_run_store().get(record_id)
    if record is None:
        raise AppError(
            code=ErrorCode.NOT_FOUND,
            message=f"找不到这条智能体记录：{record_id}",
            status_code=404,
        )
    return success_response(record)


@router.delete(
    "/runs/{record_id}",
    response_model=ApiResponse[dict],
    summary="删除一条历史智能体运行",
)
async def delete_agent_run(record_id: str) -> ApiResponse[dict]:
    if not get_agent_run_store().delete(record_id):
        raise AppError(
            code=ErrorCode.NOT_FOUND,
            message=f"找不到这条智能体记录：{record_id}",
            status_code=404,
        )
    return success_response({"deleted": True, "record_id": record_id})

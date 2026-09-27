"""Research graph endpoints."""

from __future__ import annotations

from fastapi import APIRouter, Header, Query
from fastapi.responses import StreamingResponse

from app.core.errors import AppError, ErrorCode
from app.core.responses import ApiResponse, success_response
from app.events.sse import event_stream
from app.graph.service import (
    TERMINAL_STATUSES,
    clear_runs,
    delete_run,
    get_research,
    list_runs,
    resume_research,
    start_research,
)
from app.schemas.graph import ResearchRunRequest, ResearchRunResponse, ResumeRequest

router = APIRouter(prefix="/graph", tags=["graph"])


@router.post(
    "/research",
    response_model=ApiResponse[ResearchRunResponse],
    summary="启动一次 Research Graph 运行（会在写报告前中断等待确认）",
)
async def create_research_run(payload: ResearchRunRequest) -> ApiResponse[ResearchRunResponse]:
    result = await start_research(
        question=payload.question,
        max_iterations=payload.max_iterations,
        max_verify_attempts=payload.max_verify_attempts,
        thread_id=payload.thread_id,
    )
    return success_response(result)


@router.post(
    "/research/{thread_id}/resume",
    response_model=ApiResponse[ResearchRunResponse],
    summary="批准或拒绝，并从中断点继续执行",
)
async def resume_research_run(
    thread_id: str,
    payload: ResumeRequest,
) -> ApiResponse[ResearchRunResponse]:
    current = await get_research(thread_id)
    if current is None:
        raise AppError(
            code=ErrorCode.NOT_FOUND,
            message=f"找不到这次运行：{thread_id}",
            status_code=404,
        )
    # [B4] 之前只拦 completed，导致「已取消」的运行还能被再次批准并生成报告
    # —— 人工拒绝形同虚设。所有终态一律拒绝恢复。
    if current.status in TERMINAL_STATUSES:
        raise AppError(
            code=ErrorCode.VALIDATION_ERROR,
            message=f"这次运行已结束（{current.status}），无需恢复",
            status_code=409,
        )

    result = await resume_research(
        thread_id=thread_id,
        approved=payload.approved,
        feedback=payload.feedback,
    )
    return success_response(result)


@router.get(
    "/research/{thread_id}",
    response_model=ApiResponse[ResearchRunResponse],
    summary="查询一次运行的状态",
)
async def get_research_run(thread_id: str) -> ApiResponse[ResearchRunResponse]:
    result = await get_research(thread_id)
    if result is None:
        raise AppError(
            code=ErrorCode.NOT_FOUND,
            message=f"找不到这次运行：{thread_id}",
            status_code=404,
        )
    return success_response(result)


@router.get("/runs", response_model=ApiResponse[list[dict]], summary="列出历史运行")
async def list_research_runs(
    status: str | None = Query(
        default=None,
        description="按状态过滤：running / awaiting_approval / completed / failed / cancelled",
    ),
    # [B11] 之前 limit 写死 20 且不暴露给调用方，前端「效果评估」页的
    # 「总运行次数」因此最多只能统计 20 条，指标是失真的。
    limit: int = Query(default=50, ge=1, le=500, description="最多返回几条"),
) -> ApiResponse[list[dict]]:
    return success_response(list_runs(limit=limit, status=status))


@router.delete(
    "/runs/{thread_id}",
    response_model=ApiResponse[dict],
    summary="删除一条历史运行（含其事件）",
)
async def delete_research_run(thread_id: str) -> ApiResponse[dict]:
    if not delete_run(thread_id):
        raise AppError(
            code=ErrorCode.NOT_FOUND,
            message=f"找不到这条运行记录：{thread_id}",
            status_code=404,
        )
    return success_response({"deleted": True, "thread_id": thread_id})


@router.delete(
    "/runs",
    response_model=ApiResponse[dict],
    summary="清空全部历史运行（含事件）",
)
async def clear_research_runs() -> ApiResponse[dict]:
    return success_response(clear_runs())


@router.get(
    "/runs/{thread_id}/events",
    response_model=ApiResponse[dict],
    summary="按 id 拉取一次运行的事件（SSE 不可用时的轮询通道）",
)
async def list_research_events(
    thread_id: str,
    after: int = Query(default=0, ge=0, description="只返回 id 大于该值的事件"),
) -> ApiResponse[dict]:
    """[B37] 轮询版事件接口。

    存在的理由：部分反向代理（含当前云端网关）会把 `text/event-stream` 的
    整条响应缓冲住（连响应头都不下发），浏览器 EventSource 会永远停在
    CONNECTING，前端只能靠用户手动刷新。SSE 仍然保留（本地/直连时更低延迟），
    但前端必须有这条可用的替代通道，否则「进度自动更新」在云上根本不成立。

    快照接口（GET /graph/research/{id}）提供步骤，这个接口提供事件，
    两者都是普通 JSON 响应，不会被任何网关缓冲。
    """
    from app.events.store import get_event_store  # noqa: PLC0415  # 避免模块级循环依赖

    events = get_event_store().list_since(thread_id, after_id=after)
    return success_response(
        {
            "events": events,
            "last_id": events[-1]["id"] if events else after,
        }
    )


@router.get("/research/{thread_id}/events", summary="订阅一次运行的事件流（SSE）")
async def stream_research_events(
    thread_id: str,
    last_event_id: str | None = Header(default=None, alias="Last-Event-ID"),
) -> StreamingResponse:
    """SSE 端点。

    [P0] 三个关键行为：
    1. 连接建立时按 `Last-Event-ID` 补发缺失的历史事件（刷新/断线重连都能续上）
    2. 空闲时发心跳注释行，避免被代理掐断
    3. 收到终态事件（completed / failed / cancelled）后主动关闭连接

    [P0] 为什么这里**不校验** thread_id 是否已存在（故意不做 404）：
    前端必须先订阅、再发起运行，才能实时看到进度（运行是由另一个 HTTP 请求启动的，
    等它返回时整轮已经跑完了）。而「先订阅」的那一刻，运行记录往往还没创建。
    代价：一个拼错的 thread_id 只会收到心跳而收不到事件，客户端断开即可回收。
    """
    after_id = int(last_event_id) if last_event_id and last_event_id.isdigit() else 0

    return StreamingResponse(
        event_stream(thread_id, after_id),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
            # 关掉 Nginx 之类反向代理的响应缓冲，否则事件会被攒着一起发
            "X-Accel-Buffering": "no",
        },
    )

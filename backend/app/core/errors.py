"""Error model and global exception handlers.

[P0] 核心思想：业务代码只负责 `raise AppError(...)`，
「如何把它变成 HTTP 响应」由这里统一处理。

为什么需要它：如果不注册全局 handler，未捕获异常会变成 500 + 一堆堆栈，
前端既无法解析，也会把内部信息（文件路径、SQL）泄露给调用方。
"""

from __future__ import annotations

import logging
import traceback
from collections import deque
from datetime import UTC, datetime
from enum import StrEnum

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from app.core.responses import ApiResponse, ErrorDetail

logger = logging.getLogger(__name__)


class ErrorCode(StrEnum):
    """错误码枚举。前端可以据此做分支，避免靠 message 字符串判断。"""

    VALIDATION_ERROR = "validation_error"
    NOT_FOUND = "not_found"
    UNAUTHORIZED = "unauthorized"
    RATE_LIMITED = "rate_limited"
    UPSTREAM_ERROR = "upstream_error"  # 调用外部 API（LLM / 搜索）失败
    INTERNAL_ERROR = "internal_error"


class AppError(Exception):
    """业务异常基类。

    用法：raise AppError(code=ErrorCode.NOT_FOUND, message="task not found", status_code=404)
    """

    def __init__(
        self,
        code: ErrorCode | str,
        message: str,
        status_code: int = 400,
        details: dict | list | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code.value if isinstance(code, ErrorCode) else code
        self.message = message
        self.status_code = status_code
        self.details = details


def _error_payload(code: str, message: str, details: dict | list | None = None) -> dict:
    response = ApiResponse(
        success=False,
        data=None,
        error=ErrorDetail(code=code, message=message, details=details),
    )
    return response.model_dump()


# ------------------------------ [B30] 最近错误环形缓冲 ------------------------------
# 沙箱部署看不到进程日志文件；线上间歇性 500 的堆栈只能靠进程内存留底。
# 只存异常类型/消息/堆栈尾部/请求路径，不含请求体（避免用户输入进诊断端点）。
_RECENT_ERRORS: deque[dict] = deque(maxlen=20)


def record_recent_error(request: Request, exc: Exception) -> None:
    """把未处理异常记入环形缓冲，供 /api/debug/recent-errors 查看。"""
    try:
        stack_lines: list[str] = traceback.format_exception(exc)
        _RECENT_ERRORS.appendleft(
            {
                "time": datetime.now(UTC).isoformat(),
                "path": request.url.path,
                "method": request.method,
                "type": type(exc).__name__,
                "message": str(exc)[:300],
                # 堆栈太长只留尾部：根因帧几乎总在最后几帧
                "stack_tail": "".join(stack_lines[-6:])[-1500:],
            }
        )
    except Exception:  # noqa: BLE001 - 诊断记录本身绝不能抛
        logger.debug("record_recent_error failed", exc_info=True)


def recent_errors() -> list[dict]:
    return list(_RECENT_ERRORS)


def register_exception_handlers(app: FastAPI) -> None:
    """把四类异常都转成统一响应格式。"""

    @app.exception_handler(AppError)
    async def _handle_app_error(request: Request, exc: AppError) -> JSONResponse:
        # 业务异常通常不是 bug，用 WARNING 而不是 ERROR，避免污染告警
        logger.warning("AppError %s: %s", exc.code, exc.message)
        return JSONResponse(
            status_code=exc.status_code,
            content=_error_payload(exc.code, exc.message, exc.details),
        )

    @app.exception_handler(StarletteHTTPException)
    async def _handle_http_error(request: Request, exc: StarletteHTTPException) -> JSONResponse:
        # 404 等由框架抛出的 HTTP 异常，映射成我们自己的错误码
        code = (
            ErrorCode.NOT_FOUND.value
            if exc.status_code == 404
            else ErrorCode.INTERNAL_ERROR.value
        )
        return JSONResponse(
            status_code=exc.status_code,
            content=_error_payload(code, str(exc.detail)),
        )

    @app.exception_handler(RequestValidationError)
    async def _handle_validation_error(
        request: Request,
        exc: RequestValidationError,
    ) -> JSONResponse:
        # 参数校验失败：把「哪个字段错了」回传，但只回传结构化信息，不回传原始输入值
        # （避免把用户密码等敏感字段写进响应）
        details = [
            {"field": ".".join(str(p) for p in err["loc"]), "message": err["msg"]}
            for err in exc.errors()
        ]
        return JSONResponse(
            status_code=422,
            content=_error_payload(
                ErrorCode.VALIDATION_ERROR.value,
                "request validation failed",
                details,
            ),
        )

    @app.exception_handler(Exception)
    async def _handle_unexpected(request: Request, exc: Exception) -> JSONResponse:
        # 兜底：记录完整堆栈到日志，但只把「发生了什么」告诉调用方，不泄露内部细节
        logger.exception("Unhandled exception: %s", exc)
        # [B30] 同时落入进程内环形缓冲：沙箱环境看不到文件日志，
        # /api/debug/recent-errors 是定位线上间歇性 500 的唯一窗口。
        record_recent_error(request, exc)
        return JSONResponse(
            status_code=500,
            content=_error_payload(ErrorCode.INTERNAL_ERROR.value, "internal server error"),
        )

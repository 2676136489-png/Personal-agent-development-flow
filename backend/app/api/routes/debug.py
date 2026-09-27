"""诊断端点：线上环境的「眼睛」。

[B30] 沙箱部署看不到进程日志文件，间歇性 500 的真实堆栈只存在于进程内存。
这里把它暴露成只读端点 —— 只含异常类型/消息/堆栈尾部/请求路径，
不含请求体或用户数据。响应体也经过 JSON 兜底中间件，本身是安全的。
"""

from __future__ import annotations

from fastapi import APIRouter

from app.core.errors import recent_errors
from app.core.responses import ApiResponse, success_response

router = APIRouter(prefix="/debug", tags=["debug"])


@router.get(
    "/recent-errors",
    response_model=ApiResponse[list[dict]],
    summary="最近 20 条未处理异常（类型/消息/堆栈尾部），排查线上 500 用",
)
async def get_recent_errors() -> ApiResponse[list[dict]]:
    return success_response(recent_errors())

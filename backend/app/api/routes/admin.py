"""管理员权限状态。

前端设置页用它判断：
1. 后端有没有配置 ADMIN_TOKEN（没配置 = 只读演示，写操作永久禁用）
2. 当前浏览器里的令牌是否有效

这个接口**故意不要求登录**：它只返回两个布尔值，不泄露令牌本身。
"""

from __future__ import annotations

from fastapi import APIRouter, Header

from app.core.responses import ApiResponse, success_response
from app.core.security import ADMIN_TOKEN_HEADER, admin_enabled, is_admin_token_valid

router = APIRouter(prefix="/admin", tags=["admin"])


@router.get("/status", summary="管理员权限状态（只返回布尔值，不回显令牌）")
async def admin_status(
    x_admin_token: str | None = Header(default=None, alias=ADMIN_TOKEN_HEADER),
) -> ApiResponse[dict]:
    return success_response(
        {
            "configured": admin_enabled(),
            "authenticated": is_admin_token_valid(x_admin_token),
        }
    )

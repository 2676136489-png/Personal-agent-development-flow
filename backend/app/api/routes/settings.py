"""系统设置端点。

只暴露「安全、非敏感」的配置，密钥类字段必须脱敏或隐藏。
"""

from __future__ import annotations

from dataclasses import asdict

from fastapi import APIRouter, Request

from app.core.config import get_settings
from app.core.middleware import RunBudgetRegistry, client_ip
from app.core.responses import ApiResponse, success_response
from app.search.quota import QuotaSnapshot, get_search_quota_or_none

router = APIRouter(prefix="/settings", tags=["settings"])


@router.get("", summary="获取系统设置（脱敏）")
async def get_settings_public() -> ApiResponse[dict]:
    settings = get_settings()
    return success_response(
        {
            "app_name": settings.app_name,
            "environment": settings.environment,
            "version": settings.version,
            "llm_provider": settings.llm_provider,
            "llm_base_url": settings.llm_base_url,
            "llm_model": settings.llm_model,
            "llm_timeout_seconds": settings.llm_timeout_seconds,
            "llm_max_attempts": settings.llm_max_attempts,
            "llm_temperature": settings.llm_temperature,
            "llm_max_tokens": settings.llm_max_tokens,
            "search_provider": settings.search_provider,
            "has_tavily_key": bool(settings.tavily_api_key.get_secret_value()),
            "has_llm_key": bool(settings.llm_api_key.get_secret_value()),
            "agent_max_steps": settings.agent_max_steps,
            "agent_total_timeout_seconds": settings.agent_total_timeout_seconds,
            "graph_max_iterations": settings.graph_max_iterations,
            "graph_max_verify_attempts": settings.graph_max_verify_attempts,
            "embedding_provider": settings.embedding_provider,
            "embedding_model": settings.embedding_model,
            "cors_origins": settings.cors_origins_list,
            # 访问与额度：让「每日预算」从隐形拦截变成可见额度（设置页展示用）
            "rate_limit_enabled": settings.rate_limit_enabled,
            "rate_limit_requests_per_minute": settings.rate_limit_requests_per_minute,
            "daily_run_budget_enabled": settings.daily_run_budget_enabled,
            "daily_run_budget_per_ip": settings.daily_run_budget_per_ip,
        }
    )


@router.get("/run-budget", summary="今日深度研究额度（当前访客）")
async def get_run_budget(request: Request) -> ApiResponse[dict]:
    """工作流提示与设置页「访问与额度」分组的数据源。

    数据是预算中间件的**只读快照**（不改变计数）。预算未启用 / 注册表为空时返回
    全零 + `enabled=false` 的降级快照（与 `/settings/usage` 同一套契约）：
    数值全 0、HTTP 200，前端只需写一份渲染逻辑。
    """
    settings = get_settings()
    registry: RunBudgetRegistry | None = getattr(
        request.app.state, "run_budget_registry", None
    )
    snapshot = registry.snapshot(client_ip(request.scope)) if registry else None
    if not settings.daily_run_budget_enabled or snapshot is None:
        return success_response(
            {"enabled": False, "limit": 0, "used": 0, "remaining": 0, "reset_at_ms": 0}
        )
    return success_response({"enabled": True, **snapshot})


def _zero_usage() -> dict:
    """配额不可读时的全零快照。

    PRD §3.4 的降级契约：数值全 0、字符串空、HTTP 200，**绝不抛异常**。
    返回全零而不是缺字段，是为了让前端只需写一份渲染逻辑。
    """
    data = asdict(QuotaSnapshot())
    # PRD §3.4 的降级契约是「数值全 0、字符串空」：`credits_per_call` 虽然平时是
    # 个常量，但「配额不可读」时它和 `search_depth_default` 一样都不可信，
    # 前端按契约拿全 0 即可。
    data.update(
        {
            "period_key": "",
            "period_start": "",
            "period_end": "",
            "renews_at": "",
            "provider": "",
            "search_depth_default": "",
            "credits_per_call": 0,
            "warn_level_label": "未知",
            "daily": [],
        }
    )
    return data


@router.get("/usage", summary="搜索配额用量快照")
async def get_usage() -> ApiResponse[dict]:
    """设置页的「用量」分组用。

    刻意与 `GET /settings` 分开（PRD §3.4）：配额 SQLite 在全新安装 / 文件损坏时
    可能读不到，而设置页是必读数据 —— 不能因为用量统计挂掉连设置页都开不了。

    ⚠️ 单 worker 语义：配额锁是进程内的，`--workers>1` 会低估用量。
    """
    quota = get_search_quota_or_none()
    if quota is None:
        # 配额关闭 / DB 不可用 → 全零 + 200，前端据此隐藏整个「用量」分组
        return success_response(_zero_usage())
    snapshot = quota.snapshot()
    data = asdict(snapshot)
    data["warn_level_label"] = snapshot.warn_level_label
    return success_response(data)

"""Application entry point.

[P0] create_app() 是「应用工厂」模式：
不在模块导入时就构造好 app，而是提供一个函数来创建。
好处：
1. 测试里可以用不同配置创建多个 app 实例，互不干扰
2. 启动参数（CORS、路由、中间件）集中在一处，不会出现「改了这里忘了那里」
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.middleware.gzip import GZipMiddleware

from app.agent.run_store import get_agent_run_store
from app.api.routes import api_router
from app.core.config import get_settings
from app.core.errors import register_exception_handlers
from app.core.logging import configure_logging
from app.core.middleware import (
    CacheControlMiddleware,
    DailyRunBudgetMiddleware,
    JsonErrorFallbackMiddleware,
    RateLimitMiddleware,
    RequestContextMiddleware,
    RunBudgetRegistry,
    SecurityHeadersMiddleware,
)
from app.events.store import get_event_store
from app.graph.run_store import get_run_store
from app.rag.store import get_knowledge_store


class UTF8JSONResponse(JSONResponse):
    """强制声明 charset=utf-8,避免中文 Windows 浏览器按 GBK 解码 JSON 导致乱码."""

    media_type = "application/json; charset=utf-8"


def _close_sqlite_handles() -> None:
    """[B10] SQLite 连接是进程级单例，应用关闭时显式释放（WAL 才能正常收尾）。

    单个连接关闭失败不能影响其余连接，所以逐个 try。
    """
    for name, closer in (
        ("events", lambda: get_event_store().close()),
        ("agent_runs", lambda: get_run_store().close()),
        ("agent_workspace_runs", lambda: get_agent_run_store().close()),
        ("knowledge", lambda: get_knowledge_store().close()),
    ):
        try:
            closer()
        except Exception:  # noqa: BLE001 - 关闭阶段不应再抛出
            logging.getLogger(__name__).exception("关闭 SQLite 连接失败：%s", name)


def _frontend_dist_dir() -> Path | None:
    """定位已构建的前端产物目录；没构建过就返回 None。

    为什么要支持「同端口托管前端」：托管沙箱只暴露**一个** HTTP 端口，
    没有第二个端口给 Vite dev server。所以线上必须由 FastAPI 同时提供
    前端页面和 /api，否则前端页面能打开但每个请求都连不上后端。

    目录查找顺序（先看环境变量、再看约定位置）：
    1. `FRONTEND_DIST` —— 显式指定。既支持绝对路径，也支持**相对路径**：
       相对路径会**相对于 backend/ 目录**解析（`app/main.py` 的 parents[1]），
       而不是相对于进程的当前工作目录 —— 否则从别的 cwd 启动（比如 systemd
       或容器里 `cd /`）就会解析到错误位置，表现为「明明配了却找不到前端」。
    2. `backend/frontend_dist` —— 随 backend 一起上传的自包含副本（线上用）。
    3. `backend/../frontend/dist` —— 仓库里前端构建的标准输出位置（本地用）。

    **返回 None 是合法状态，不是错误**：后端可以独立运行（开发时前端跑
    Vite dev server 直连 /api），此时不该因为「没有前端产物」就启动失败。
    """
    backend_root = Path(__file__).resolve().parents[1]

    # 配置优先：`FRONTEND_DIST`（Settings 字段，可由 .env 驱动）。
    # 用 get_settings() 而不是直接读 os.environ：pydantic-settings 不会把
    # .env 里的未知键写回 os.environ，直接读环境变量会漏掉 .env 里的配置。
    try:
        configured = get_settings().frontend_dist.strip()
    except Exception:  # noqa: BLE001 - 配置异常不该让静态托管整段失效
        configured = ""

    candidates: list[Path] = []
    if configured:
        raw = Path(configured)
        # 绝对路径直接用；相对路径锚到 backend/，不依赖 cwd
        candidates.append(raw if raw.is_absolute() else backend_root / raw)
    # ⚠️ 目录名用 `webapp` 而非 `frontend_dist`：线上部署工具会把名字含 `dist` 的目录
    #    当"构建产物"排除，导致前端产物永远传不上去（后端却会更新）。见 .env.production 注释。
    candidates.append(backend_root / "webapp")
    candidates.append(backend_root / "frontend_dist")
    candidates.append(Path(__file__).resolve().parents[2] / "frontend" / "dist")

    for candidate in candidates:
        if (candidate / "index.html").is_file():
            return candidate
    return None


def _mount_frontend(app: FastAPI) -> bool:
    """把前端产物挂到根路径，并给 SPA 路由做 fallback。返回是否挂载成功。

    **顺序是关键**：本函数必须在 `include_router(api_router)` **之后**调用。
    Starlette 按注册顺序匹配路由，根挂载（`/`）如果先注册会把 `/api/...`
    一并吃掉，表现为「所有接口都返回前端 HTML」——这是最容易踩的坑。

    为什么要 SPA fallback：前端是 React Router 的单页应用，
    `/workflow`、`/knowledge` 这类路径在服务端并没有对应文件。
    直接刷新会 404。所以约定：**不是 /api 开头、且磁盘上找不到该文件**的
    请求，一律返回 index.html，交给前端路由处理。
    """
    dist = _frontend_dist_dir()
    if dist is None:
        logging.getLogger(__name__).info(
            "未找到前端构建产物（frontend/dist），仅以 API 模式运行。"
            "如需同端口提供前端页面，请先在 frontend/ 执行 npm run build。"
        )
        return False

    settings = get_settings()
    assets_dir = dist / "assets"
    if assets_dir.is_dir():
        # 带内容哈希的静态资源，可以放心长缓存。
        # 外层依次套：GZip（压缩 JS/CSS，静态资源非流式，安全）→ Cache-Control（immutable）。
        # ⚠️ 只在静态挂载点做 GZip，**不给全局加** GZipMiddleware：那会把 SSE 事件流也缓冲压缩，
        #    导致事件被憋到连接结束才吐（SSE 是本服务核心功能）。
        assets_app: object = StaticFiles(directory=assets_dir)
        assets_app = GZipMiddleware(assets_app, minimum_size=800)  # type: ignore[arg-type]
        if settings.static_assets_immutable:
            assets_app = CacheControlMiddleware(
                assets_app,  # type: ignore[arg-type]
                header_value=f"public, max-age={settings.static_assets_max_age}, immutable",
            )
        app.mount("/assets", assets_app, name="assets")  # type: ignore[arg-type]

    index_file = dist / "index.html"
    # index.html 必须 no-cache：否则部署后浏览器仍用旧 HTML，指向已删除的旧 chunk → 白屏
    index_headers = {"Cache-Control": "no-cache"}

    @app.get(
        "/{full_path:path}",
        include_in_schema=False,
        # 必须显式声明 response_class 并关掉自动 response_model：
        # 这个处理函数同时可能返回 FileResponse 与 JSONResponse，
        # 而 FastAPI 会尝试从返回类型注解推导 Pydantic 响应模型，
        # 遇到 `FileResponse | JSONResponse` 这种联合类型会直接抛
        # FastAPIError 让应用启动失败。返回的是 Response 对象，
        # 本来也不需要 Pydantic 做序列化。
        response_class=FileResponse,
        response_model=None,
    )
    async def _spa_fallback(full_path: str):  # noqa: ANN202 - 返回 Response 联合类型
        """兜底路由：优先返回磁盘上的真实文件，否则回退到 index.html。"""
        # `/api/*` 走到这里说明没有任何 API 路由匹配上。
        # 这里**必须 raise 而不是自己造一个 404 响应**：
        # `app/core/errors.py` 注册了 StarletteHTTPException 处理器，会把 404
        # 映射成项目统一的错误信封（`{"success": false, "error": {"code": "not_found"}}`）。
        # 若我们直接 `return JSONResponse({"detail": "Not Found"})`，虽然状态码同为
        # 404，但响应体绕过了统一格式，前端按信封解析会拿到 undefined
        # ——tests/test_health.py 的 `test_unknown_route_returns_unified_error_envelope`
        # 正是盯这条契约的（它曾因此变红）。
        if full_path == "api" or full_path.startswith("api/"):
            raise StarletteHTTPException(status_code=404, detail="Not Found")

        if full_path:
            candidate = (dist / full_path).resolve()
            # 防目录穿越：解析后必须仍在 dist 之内
            if candidate.is_file() and candidate.is_relative_to(dist.resolve()):
                return FileResponse(candidate)

        return FileResponse(index_file, headers=index_headers)

    logging.getLogger(__name__).info("已挂载前端静态产物：%s", dist)
    return True


@asynccontextmanager
async def _lifespan(_: FastAPI) -> AsyncIterator[None]:
    # 启动：知识库为空时后台导入预置示例文档（不阻塞服务就绪）
    from app.rag.service import seed_knowledge_base_if_empty  # noqa: PLC0415

    seed_task = asyncio.create_task(seed_knowledge_base_if_empty())
    yield
    # 关闭：先等 seed 与后台图任务收尾，再释放 SQLite 连接
    from app.graph.service import _drain_background_tasks  # noqa: PLC0415  # 避免循环 import

    try:
        await asyncio.wait_for(seed_task, timeout=30)
        await asyncio.wait_for(_drain_background_tasks(), timeout=10)
    except Exception:  # noqa: BLE001 - 关闭阶段不阻塞退出
        logging.getLogger(__name__).warning("后台任务未在超时内收尾，强制退出")
    _close_sqlite_handles()


def create_app() -> FastAPI:
    settings = get_settings()
    configure_logging(settings.log_level)

    app = FastAPI(
        title=settings.app_name,
        version=settings.version,
        description="AI Research Workspace backend (Phase 1 skeleton)",
        # 生产环境默认关闭交互式文档（暴露全部接口结构）；可用 API_DOCS_ENABLED=true 临时打开
        docs_url=f"{settings.api_prefix}/docs" if settings.api_docs_enabled else None,
        openapi_url=f"{settings.api_prefix}/openapi.json" if settings.api_docs_enabled else None,
        default_response_class=UTF8JSONResponse,
        lifespan=_lifespan,
    )

    # [P0] 中间件执行顺序：后注册的在外层。
    # CORS 必须在最外层，否则带错误状态码的响应（401/500）不会带 CORS 头，
    # 浏览器会以「CORS 错误」的形式报错，掩盖真正的错误原因。
    app.add_middleware(RequestContextMiddleware)
    # 限流：昂贵端点防滥用（默认关；生产 .env.production 打开）
    if settings.rate_limit_enabled:
        app.add_middleware(
            RateLimitMiddleware,
            requests_per_minute=settings.rate_limit_requests_per_minute,
            paths=tuple(settings.rate_limit_path_list),
        )
    # 「今日额度」查询的实例登记处：中间件在栈构建时把实例登记进来，
    # 路由（GET /api/settings/run-budget）经 request.app.state 读取实时计数。
    run_budget_registry = RunBudgetRegistry()
    app.state.run_budget_registry = run_budget_registry
    # 每日运行预算：与限流互补的第二道闸（拦「细水长流刷一整天」）
    if settings.daily_run_budget_enabled:
        app.add_middleware(
            DailyRunBudgetMiddleware,
            per_ip_limit=settings.daily_run_budget_per_ip,
            paths=tuple(settings.daily_run_budget_path_list),
            registry=run_budget_registry,
        )
    # 安全响应头：纯 ASGI，不缓冲响应体（SSE 安全）
    if settings.security_headers_enabled:
        app.add_middleware(
            SecurityHeadersMiddleware,
            csp=settings.content_security_policy,
            hsts=settings.is_production,
        )
    # 最外层 JSON 兜底：外层中间件自身抛异常时也返回统一 JSON（而不是纯文本 500）
    # 必须在内层中间件（限流/安全头/请求上下文）之外、CORS 之内。
    app.add_middleware(JsonErrorFallbackMiddleware)
    # CORS：单端口部署下前后端**同源**，浏览器根本不发跨域请求，白名单只对
    # 「将来前端被单独托管」的场景有意义。
    # ⚠️ allow_credentials 不能与 "*" 同用：二者并存时 Starlette 会退化成
    # 「回显请求方的任意 Origin + 允许携带凭证」，等于对全网开放带凭证的跨域请求。
    # 本项目不使用 Cookie/凭证，因此只有显式白名单时才开启 credentials。
    cors_origins = settings.cors_origins_list
    app.add_middleware(
        CORSMiddleware,
        allow_origins=cors_origins,
        allow_credentials="*" not in cors_origins,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    register_exception_handlers(app)
    app.include_router(api_router, prefix=settings.api_prefix)

    # ⚠️ 必须在 include_router 之后：根挂载会吞掉后注册的路由（详见 _mount_frontend）
    _mount_frontend(app)

    return app


# uvicorn 的入口：uvicorn app.main:app
app = create_app()

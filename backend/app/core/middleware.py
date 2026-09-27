"""HTTP middlewares.

[P2] 当前只需知道它做了两件事：给每个请求生成 request_id、打印访问日志。

request_id 的作用：前端报错时只要把这个 ID 给你，
你就能在后端日志里精确定位到那一次请求（后面 Agent 有几十次工具调用时，这个是刚需）。

注意：这里用 BaseHTTPMiddleware 是为了可读性（写法接近普通函数）。
后面做 SSE 长连接时会换成纯 ASGI 中间件，因为 BaseHTTPMiddleware
对流式响应有已知的性能与行为问题——这是明确的「技术债」，先欠着。
"""

from __future__ import annotations

import logging
import time
import uuid
from collections import defaultdict, deque

from starlette.datastructures import MutableHeaders
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse, Response
from starlette.types import ASGIApp, Message, Receive, Scope, Send

logger = logging.getLogger("access")


def client_ip(scope: Scope) -> str:
    """从 ASGI scope 解析客户端 IP：优先取反代写入的 `X-Forwarded-For` 首跳。

    限流与每日预算共用这一份逻辑，避免两处对「同一个客户端」的判断不一致。
    """
    for name, value in scope.get("headers", []):
        if name == b"x-forwarded-for":
            first = value.decode("latin-1").split(",")[0].strip()
            if first:
                return first
    client = scope.get("client")
    return client[0] if client else "unknown"


class RequestContextMiddleware(BaseHTTPMiddleware):
    def __init__(self, app: ASGIApp) -> None:
        super().__init__(app)

    async def dispatch(self, request: Request, call_next) -> Response:
        # 如果调用方（例如前端或网关）已经传了 request_id 就沿用，方便跨服务串联
        request_id = request.headers.get("X-Request-ID") or uuid.uuid4().hex[:12]
        request.state.request_id = request_id

        started = time.perf_counter()
        try:
            response = await call_next(request)
        except Exception:
            # 异常会交给 exception handler 处理，这里只负责记录耗时
            logger.error("request_id=%s %s %s failed", request_id, request.method, request.url.path)
            raise

        duration_ms = round((time.perf_counter() - started) * 1000, 2)
        response.headers["X-Request-ID"] = request_id
        logger.info(
            "request_id=%s %s %s -> %s (%.2fms)",
            request_id,
            request.method,
            request.url.path,
            response.status_code,
            duration_ms,
        )
        return response


class SecurityHeadersMiddleware:
    """给所有响应补安全响应头（**纯 ASGI**，不缓冲响应体）。

    为什么用纯 ASGI 而不是 BaseHTTPMiddleware：本服务有 SSE 长连接
    （/api/llm/stream、事件流）。BaseHTTPMiddleware 会包一层缓冲，对流式响应
    有已知的延迟/行为问题（见本模块顶部技术债说明）。安全头只是往响应上挂字段，
    纯 ASGI 的 `send` 包装是最轻且对流式零影响的做法。

    `setdefault` 语义：不覆盖框架/路由已经显式设置的同名头。
    """

    def __init__(
        self,
        app: ASGIApp,
        *,
        csp: str = "",
        hsts: bool = False,
    ) -> None:
        self.app = app
        headers: list[tuple[bytes, bytes]] = [
            (b"x-content-type-options", b"nosniff"),
            (b"x-frame-options", b"DENY"),
            (b"referrer-policy", b"strict-origin-when-cross-origin"),
            (b"permissions-policy", b"geolocation=(), microphone=(), camera=()"),
            (b"cross-origin-opener-policy", b"same-origin"),
        ]
        if csp:
            headers.append((b"content-security-policy", csp.encode("latin-1")))
        if hsts:
            # 仅在 HTTPS（生产反代）下有意义；本地 http 下发会污染浏览器
            headers.append(
                (b"strict-transport-security", b"max-age=31536000; includeSubDomains")
            )
        self._headers = headers

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        async def send_wrapper(message: Message) -> None:
            if message["type"] == "http.response.start":
                mutable = MutableHeaders(scope=message)
                for name, value in self._headers:
                    mutable.setdefault(name.decode("latin-1"), value.decode("latin-1"))
            await send(message)

        await self.app(scope, receive, send_wrapper)


class RateLimitMiddleware:
    """进程内滑窗限流，保护昂贵的 LLM / 搜索端点免被刷爆额度。

    **纯 ASGI**：命中限流时直接返回 429，不进入路由。

    设计取舍：
    - 进程内 dict（单 worker 语义，与配额一致）——重启归零，够用且零依赖；
    - 按客户端 IP（优先取反代的 X-Forwarded-For 首跳）分桶；
    - 仅对配置的路径前缀生效，静态资源与 /api/health 不受影响；
    - 返回统一错误信封（与 app/core/errors.py 同构），前端无需分支。
    """

    def __init__(
        self,
        app: ASGIApp,
        *,
        requests_per_minute: int,
        paths: tuple[str, ...],
    ) -> None:
        self.app = app
        self._limit = max(1, requests_per_minute)
        self._paths = tuple(p for p in paths if p)
        self._window = 60.0
        self._hits: dict[str, deque[float]] = defaultdict(deque)

    def _should_limit(self, path: str) -> bool:
        return any(path.startswith(prefix) for prefix in self._paths)

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or not self._should_limit(scope.get("path", "")):
            await self.app(scope, receive, send)
            return

        now = time.monotonic()
        key = client_ip(scope)
        bucket = self._hits[key]
        cutoff = now - self._window
        while bucket and bucket[0] < cutoff:
            bucket.popleft()

        if len(bucket) >= self._limit:
            retry_after = max(1, int(bucket[0] + self._window - now) + 1)
            logger.warning("rate limit exceeded: ip=%s path=%s", key, scope.get("path"))
            response = JSONResponse(
                status_code=429,
                content={
                    "success": False,
                    "data": None,
                    "error": {
                        "code": "rate_limited",
                        "message": "请求过于频繁，请稍后再试",
                        "details": None,
                    },
                },
                headers={"Retry-After": str(retry_after)},
            )
            await response(scope, receive, send)
            return

        bucket.append(now)
        # 防止长期闲置的 IP 在字典里越积越多（极简清理：桶空则移除）
        if not bucket:
            self._hits.pop(key, None)
        await self.app(scope, receive, send)


class RunBudgetRegistry:
    """每日预算中间件的**实例登记处**：让「今日额度」接口读到实时计数。

    为什么需要登记：Starlette 的 `add_middleware` 只记「类 + 参数」，实例化发生在
    中间件栈构建时，外部拿不到实例。于是让中间件在构造时把自己登记进来 ——
    栈构建一定早于任何请求进入路由，所以接口读到的必然是当前进程的真实计数。

    每个 app 一个实例（`create_app()` 里挂到 `app.state`）；预算未启用时保持为空，
    `snapshot()` 返回 None，由接口降级成全零快照。
    """

    def __init__(self) -> None:
        self._budget: DailyRunBudgetMiddleware | None = None

    def attach(self, middleware: DailyRunBudgetMiddleware) -> None:
        self._budget = middleware

    def snapshot(self, key: str) -> dict[str, int] | None:
        if self._budget is None:
            return None
        return self._budget.snapshot(key)


class DailyRunBudgetMiddleware:
    """按客户端 IP 的**每日运行预算**：公开站点防「细水长流式刷量」烧穿 API 额度。

    与 RateLimitMiddleware（分钟级滑窗）是互补的两道闸：
    - 限流拦的是「短时间高频」；
    - 预算拦的是「不紧不慢刷一整天」——30 次/分钟的上限放一天是 4.3 万次调用，
      足以把大模型 API 与搜索额度全部烧光。

    只统计**创建一次昂贵运行**的端点（默认 `POST /api/graph/research` 与
    `POST /api/agent/run`），且用**精确路径匹配**：
    `/api/graph/research/{thread_id}/resume` 是「继续已有运行」，不计数 ——
    它天然受制于该 run 的创建次数，若也在中途拦截，用户已完成的一半工作会白费。

    计数时机是**响应成功之后**（2xx）：参数校验失败（4xx/5xx）的请求不消耗
    用户当天的额度，避免「连续填错表单把额度填没了」。

    纯 ASGI（同 SecurityHeadersMiddleware）：SSE 等流式响应原样透传，不做缓冲。
    进程内计数、单 worker 语义（与限流/配额一致，勿 --workers>1）；自然日归零。
    """

    def __init__(
        self,
        app: ASGIApp,
        *,
        per_ip_limit: int,
        paths: tuple[str, ...],
        registry: RunBudgetRegistry | None = None,
    ) -> None:
        self.app = app
        self._limit = max(1, per_ip_limit)
        self._paths = frozenset(p for p in paths if p)
        # key(IP) -> (自然日, 当日已用次数)
        self._counters: dict[str, tuple[str, int]] = {}
        # 兜底清理阈值：条目超过它就丢掉非今日的旧桶，防止长期运行内存无界增长
        self._max_keys = 4096
        # 登记到注册表：供「今日额度」接口读取（栈构建时执行，早于任何请求）
        if registry is not None:
            registry.attach(self)

    @staticmethod
    def _today() -> str:
        """服务器本地时区的自然日字符串；跨天即视为归零，无需定时任务。"""
        return time.strftime("%Y-%m-%d", time.localtime())

    def _used(self, key: str, today: str) -> int:
        day, used = self._counters.get(key, (today, 0))
        return used if day == today else 0

    @staticmethod
    def _reset_hint() -> tuple[int, int]:
        """返回 (距下一个自然日的秒数, 重置时刻的 epoch 毫秒)。

        秒数给 `Retry-After`；毫秒给前端把「将于 xx:xx 恢复」渲染成本地时间。
        """
        now = time.time()
        local = time.localtime(now)
        tomorrow = (
            time.mktime((local.tm_year, local.tm_mon, local.tm_mday, 0, 0, 0, 0, 0, -1)) + 86400
        )
        return max(1, int(tomorrow - now) + 1), int(tomorrow * 1000)

    def snapshot(self, key: str) -> dict[str, int]:
        """只读额度视图（不改变计数）：供「今日额度」接口做「还剩几次」的展示。"""
        today = self._today()
        used = self._used(key, today)
        _, reset_at_ms = self._reset_hint()
        return {
            "limit": self._limit,
            "used": used,
            "remaining": max(0, self._limit - used),
            "reset_at_ms": reset_at_ms,
        }

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if (
            scope["type"] != "http"
            or scope.get("method", "").upper() != "POST"
            or scope.get("path", "") not in self._paths
        ):
            await self.app(scope, receive, send)
            return

        today = self._today()
        key = client_ip(scope)
        used = self._used(key, today)

        if used >= self._limit:
            retry_after, reset_at_ms = self._reset_hint()
            # 文案在这里预设，避免在深层缩进里写超长行（E501）
            message = f"今日运行次数已达上限（{self._limit} 次/天），额度将于次日自动恢复"
            logger.warning(
                "daily run budget exceeded: ip=%s path=%s used=%s", key, scope.get("path"), used
            )
            response = JSONResponse(
                status_code=429,
                content={
                    "success": False,
                    "data": None,
                    "error": {
                        "code": "daily_budget_exceeded",
                        "message": message,
                        "details": {
                            "limit": self._limit,
                            "used": used,
                            "reset_at_ms": reset_at_ms,
                        },
                    },
                },
                headers={"Retry-After": str(retry_after)},
            )
            await response(scope, receive, send)
            return

        status_code = 0

        async def send_wrapper(message: Message) -> None:
            nonlocal status_code
            if message["type"] == "http.response.start":
                status_code = int(message.get("status", 0))
            await send(message)

        await self.app(scope, receive, send_wrapper)

        # 只在运行真的创建成功（2xx）后计数
        if 200 <= status_code < 300:
            day, current = self._counters.get(key, (today, 0))
            self._counters[key] = (today, (current if day == today else 0) + 1)
            self._prune(today)

    def _prune(self, today: str) -> None:
        if len(self._counters) <= self._max_keys:
            return
        self._counters = {k: v for k, v in self._counters.items() if v[0] == today}


class JsonErrorFallbackMiddleware:
    """最外层兜底：把「外层中间件自身抛出的未处理异常」转成统一 JSON 500。

    为什么需要它：FastAPI 的全局异常处理器位于应用的 `ExceptionMiddleware`（**内层**），
    而本项目还有若干**更外层**的自定义中间件（安全头 / 限流 / 请求上下文）。
    一旦这些外层中间件自己抛异常，Starlette 默认返回**纯文本** "Internal Server Error"
    —— 前端拿到的就不是 JSON，报「后端返回了非 JSON 响应」，且毫无诊断信息。

    本中间件只作用于**出错路径**：正常响应原样透传（不缓冲），因此对 SSE 无影响。
    注册位置：必须在那些外层中间件的**更外层**、但在 CORS 的**内层**
    （CORS 需要包在最外面，才能给错误响应也补上 CORS 头）。
    """

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        response_started = False

        async def send_wrapper(message: Message) -> None:
            nonlocal response_started
            if message["type"] == "http.response.start":
                response_started = True
            await send(message)

        try:
            await self.app(scope, receive, send_wrapper)
        except Exception:
            logger.exception("ASGI 边界未处理异常：path=%s", scope.get("path"))
            if response_started:
                # 响应已经开始（例如 SSE 已发出响应头），无法再改写为 JSON
                raise
            response = JSONResponse(
                status_code=500,
                content={
                    "success": False,
                    "data": None,
                    "error": {
                        "code": "internal_error",
                        "message": "internal server error",
                        "details": None,
                    },
                },
            )
            await response(scope, receive, send)


class CacheControlMiddleware:
    """给匹配路径的响应补 `Cache-Control`（纯 ASGI，不依赖框架内部 API）。

    用于 `/assets`（文件名带内容哈希）：`public, max-age=..., immutable`
    让浏览器**永不重复校验**哈希资源；新版本靠新文件名自然失效。
    """

    def __init__(self, app: ASGIApp, *, header_value: str, path_prefix: str = "/assets") -> None:
        self.app = app
        self._value = header_value
        self._prefix = path_prefix

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or not scope.get("path", "").startswith(self._prefix):
            await self.app(scope, receive, send)
            return

        async def send_wrapper(message: Message) -> None:
            if message["type"] == "http.response.start":
                MutableHeaders(scope=message).setdefault("Cache-Control", self._value)
            await send(message)

        await self.app(scope, receive, send_wrapper)

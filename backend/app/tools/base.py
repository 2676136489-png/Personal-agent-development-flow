"""Tool abstraction.

[P0] 一个 Tool 就是「模型可以提名、由我们本地执行的一个函数」。

关键设计（模板方法模式）：
`BaseTool.execute()` 对所有工具都一样，负责：
    参数校验 → 超时控制 → 异常捕获 → 计时 → 统一 ToolResult

子类只需要实现 `_run()`，也就是「这个工具真正干什么」。
好处：不可能出现"某个工具忘了处理超时"或"某个工具的异常把整个 Agent 带崩"。
"""

from __future__ import annotations

import asyncio
import logging
import time
from abc import ABC, abstractmethod
from dataclasses import dataclass, field

from pydantic import BaseModel, ValidationError

from app.core.config import get_settings
from app.observability import metrics
from app.search.errors import QuotaExhaustedError, SearchProviderError

logger = logging.getLogger(__name__)


@dataclass
class ToolContext:
    """工具执行时的上下文（只读配置 + 追踪信息）。"""

    run_id: str
    max_output_chars: int = 3000
    allowed_domains: list[str] = field(default_factory=list)
    step_index: int = 0
    # 工具可以把结构化产物放在这里（例如检索到的引用），
    # 由 execute() 统一收集进 ToolResult.citations
    artifacts: dict = field(default_factory=dict)


class ToolError(Exception):
    """工具内部**可分类**的失败。

    携带 `error_kind`，由 `BaseTool.execute()` 翻译成 `ToolResult.error_kind`。
    存在的意义：让非搜索类工具（如 fetch_webpage 的网络超时）也能给出
    「timeout / network」这类**可被上层识别与重试**的信号，而不是被兜底成
    无法区分的 `execution_error`（那会让「目标站点连不上」看起来像「代码 bug」）。
    """

    def __init__(self, message: str, *, error_kind: str) -> None:
        super().__init__(message)
        self.error_kind = error_kind


class ToolResult(BaseModel):
    """[P0] 工具执行的统一结果。

    无论成功失败都返回这个对象 —— 工具失败**不是异常**，而是 Agent 可以观察并应对的事实。
    """

    ok: bool
    tool: str
    output: str = ""          # 成功时的输出（已截断、已清洗）
    summary: str = ""         # 给前端/日志看的短摘要
    error: str | None = None
    error_kind: str | None = None  # invalid_args | timeout | execution_error | blocked
    duration_ms: int = 0
    # 结构化引用（哪些 document/chunk 支撑了这次结果）。
    # 有了它，最终答案才能反推出「这句话来自哪个文件的第几页」。
    citations: list[dict] = []

    def to_observation(self) -> str:
        """把结果序列化成「要喂回给模型」的文本。

        失败也要返回文本：否则模型不知道发生了什么，只会反复重试同一个动作。
        """
        if self.ok:
            return self.output
        return f"[工具执行失败] tool={self.tool} kind={self.error_kind} error={self.error}"


class BaseTool(ABC):
    """所有工具的基类。"""

    name: str
    description: str
    args_schema: type[BaseModel]
    timeout_seconds: float = 10.0
    # 是否参与「瞬时失败自动重试」（配置见 Settings.tool_max_attempts / retryable_tool_kinds）。
    # 默认开启；**计费类工具（search_web）必须关掉**：一次超时/网络的瞬时失败若被重试，
    # provider 会再预扣一笔 credits（超时保守不退款），等于一次逻辑搜索被重复扣费。
    retryable: bool = True

    async def execute(self, raw_args: dict, ctx: ToolContext) -> ToolResult:
        """执行工具并保证不抛异常（除系统级错误外）。

        [P0] 四层保护：
        1. 参数校验失败 → ok=False（模型传错参数是很常见的，不算崩溃）
        2. 搜索配额/限流 → 翻译成 error_kind，绝不归类成 execution_error（见下）
        3. 超时 → 用 asyncio.wait_for 强制结束
        4. 其他异常 → 捕获并记录，绝不让异常冒泡到 Agent 主循环

        [T02] 为什么搜索类异常要单独拦一层：
        `TavilySearchProvider` 失败时抛的是 `SearchProviderError`（携带 error_kind），
        如果直接落到第 4 层，会被吞成 `execution_error` ——
        「额度耗尽」这个最关键的信号就丢了，上层只会看到「工具失败」，
        于是又去重试，继续烧积分（PRD P-1）。

        [T-obs] 这里是**全项目唯一的工具调用收敛点**：所有工具都从 execute() 走，
        所以指标（调用数 + 耗时直方图）只在这里记一次即可覆盖全部工具，
        且记的是「一次逻辑调用（含重试）的最终结果」，不会被重试放大。
        """
        started = time.perf_counter()

        try:
            args = self.args_schema.model_validate(raw_args)
        except ValidationError as exc:
            problems = "; ".join(
                f"{'.'.join(str(p) for p in err['loc'])}: {err['msg']}" for err in exc.errors()[:3]
            )
            return self._finish(self._failure("invalid_args", f"参数不合法：{problems}", started))

        result = await self._run_with_retry(args, ctx, started)
        return self._finish(result)

    async def _run_with_retry(
        self, args: BaseModel, ctx: ToolContext, started: float
    ) -> ToolResult:
        """按配置对「可重试的瞬时失败」做退避重试。

        配置项（此前是死配置，从未被读取）：
        - `tool_max_attempts`：最多尝试几次（含首次）
        - `retryable_tool_kinds`：哪些 error_kind 值得重试
          （默认 timeout / network / upstream_5xx / rate_limit）
        - `tool_retry_backoff_min/max`：指数退避区间

        `self.retryable=False`（计费工具）时只尝试一次。
        """
        settings = get_settings()
        attempts = max(1, settings.tool_max_attempts) if self.retryable else 1
        retryable_kinds = settings.retryable_tool_kinds_set

        result = await self._attempt(args, ctx, started)
        attempt_no = 1
        while (
            attempt_no < attempts
            and not result.ok
            and result.error_kind in retryable_kinds
        ):
            delay = min(
                settings.tool_retry_backoff_max,
                settings.tool_retry_backoff_min * (2 ** (attempt_no - 1)),
            )
            logger.warning(
                "tool %s 第 %s 次失败（kind=%s），%.2fs 后重试",
                self.name,
                attempt_no,
                result.error_kind,
                delay,
            )
            await asyncio.sleep(delay)
            attempt_no += 1
            result = await self._attempt(args, ctx, started)
        return result

    async def _attempt(self, args: BaseModel, ctx: ToolContext, started: float) -> ToolResult:
        """执行一次工具逻辑，把各类异常翻译成统一的 ToolResult。"""
        try:
            output = await asyncio.wait_for(self._run(args, ctx), timeout=self.timeout_seconds)
        except QuotaExhaustedError as exc:
            # 额度耗尽：不重试（重试就是继续烧积分），且必须被上层看见
            logger.warning("搜索额度耗尽：%s", exc)
            return self._failure("quota_exhausted", str(exc), started)
        except SearchProviderError as exc:
            # 上游限流/服务不可用：保留真实 error_kind，让上层决定要不要重试
            logger.warning("搜索失败 kind=%s：%s", exc.error_kind, exc)
            return self._failure(exc.error_kind, str(exc), started)
        except ToolError as exc:
            # 工具自定义的可分类失败（如 fetch 的超时/网络）：保留 error_kind
            logger.warning("tool %s 失败 kind=%s：%s", self.name, exc.error_kind, exc)
            return self._failure(exc.error_kind, str(exc), started)
        except TimeoutError:  # Python 3.11+ 起 asyncio.TimeoutError 就是内置 TimeoutError
            logger.warning("tool timeout: %s", self.name)
            return self._failure("timeout", f"工具执行超过 {self.timeout_seconds} 秒", started)
        except Exception as exc:  # noqa: BLE001 - 工具层的任何异常都必须被兜住
            logger.exception("tool execution failed: %s", self.name)
            return self._failure("execution_error", str(exc), started)

        duration_ms = int((time.perf_counter() - started) * 1000)
        truncated = output[: ctx.max_output_chars]
        return ToolResult(
            ok=True,
            tool=self.name,
            output=truncated,
            summary=f"{len(truncated)} 字符",
            duration_ms=duration_ms,
            citations=list(ctx.artifacts.get("citations", [])),
        )

    def _finish(self, result: ToolResult) -> ToolResult:
        """记指标并返回最终结果（含参数校验失败这一路径）。"""
        metrics.inc(metrics.TOOL_CALLS_TOTAL, {"tool": self.name, "ok": result.ok})
        metrics.observe(metrics.TOOL_DURATION_MS, float(result.duration_ms), {"tool": self.name})
        return result

    @abstractmethod
    async def _run(self, args: BaseModel, ctx: ToolContext) -> str:
        """工具真正的逻辑。返回要给模型的文本。"""
        raise NotImplementedError

    def _failure(self, kind: str, message: str, started: float) -> ToolResult:
        return ToolResult(
            ok=False,
            tool=self.name,
            error=message,
            error_kind=kind,
            summary="失败",
            duration_ms=int((time.perf_counter() - started) * 1000),
        )

    def function_schema(self) -> dict:
        """[P0] Function Schema：告诉模型「这个工具叫什么、能干什么、需要什么参数」。

        它就是 args_schema 的 JSON Schema + 名字 + 描述。
        模型只能根据这段描述来决定怎么用，所以 description 写得越具体，调用越准。
        """
        return {
            "name": self.name,
            "description": self.description,
            "parameters": self.args_schema.model_json_schema(),
        }

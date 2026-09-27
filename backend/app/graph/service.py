"""Research graph service: 启动 / 中断 / 恢复 / 查询。

[P0] 中断与恢复的真实价值：
报告是「要交给别人的东西」，发布前必须让人看一眼。
LangGraph 的 checkpointer 让这件事不需要我们自己写状态机：
图在 write 前停下，人确认后再用同一个 thread_id 继续即可。

[B25] 为什么 start / resume 改成**后台执行**：
同步 `await graph.ainvoke(...)` 要等完整条流水线（理解→计划→研究循环→分析→
验证，max_iterations=8 时 2~5 分钟），远超托管网关约 60s 的请求超时 ——
用户看到的是 504 Gateway Time-out，而后台图其实还在裸跑。
现在接口落一条 running 记录后立即返回，图在 asyncio 后台任务里执行，
进度靠 SSE 推送、终态靠事件触发前端回拉 —— HTTP 请求生命周期与图的
执行生命周期彻底解耦。
"""

from __future__ import annotations

import asyncio
import logging
import time
import uuid

from app.core.config import get_settings
from app.core.errors import AppError, ErrorCode
from app.events.bus import emit
from app.events.schemas import EventType
from app.graph.graph import build_initial_state, get_research_graph
from app.graph.run_store import get_run_store
from app.graph.sources import build_knowledge_sources, dedupe_sources, is_relevant_citation
from app.observability import metrics
from app.schemas.graph import ResearchRunResponse
from app.search.quota import WARN_LEVEL_LABELS, get_search_quota_or_none

logger = logging.getLogger(__name__)

_RECURSION_LIMIT = 50  # LangGraph 层面的最后一道保险

# `warn_level >= 2`（75% / 90%）才值得拿一条 SSE 之外的提示打扰用户；
# level 1（已过半）只在日志和 /settings/usage 里出现。
_USER_FACING_WARN_LEVEL = 2

# [B25] 后台任务注册表：防止「fire-and-forget」的协程被 GC 提前回收
# （CPython 只保留对 Task 的弱引用，没有强引用时任务可能被静默取消）。
# [B33] 从 set 改为 dict（thread_id → Task）：
#  1) 支持按 thread 查活跃任务 —— 用户批准生成报告后刷新页面再点一次批准，
#     能识别「报告正在生成中」并拒绝，而不是重复跑一次 write；
#  2) 删除历史记录时可判断是否有活任务。
_TASKS: dict[str, asyncio.Task] = {}


def _has_active_task(thread_id: str) -> bool:
    task = _TASKS.get(thread_id)
    return task is not None and not task.done()


def _config(thread_id: str) -> dict:
    return {"configurable": {"thread_id": thread_id}, "recursion_limit": _RECURSION_LIMIT}


def _quota_view(thread_id: str) -> dict:
    """本次 run 的搜索配额消耗。配额不可用时返回全是零值的同一份结构。

    这里是**只读**的：不参与图的执行，也不回填 state。
    run 账本里的 credits/degraded 由 provider 在预扣时写入（app/tools/search_provider.py）。
    """
    quota = get_search_quota_or_none()
    if quota is None:
        # 配额关闭 / DB 不可用：契约要求「字段在、值为零」
        return {
            "credits_used": 0,
            "search_calls": 0,
            "degraded": False,
            "degraded_reason": None,
            "warnings": [],
        }
    run = quota.run_usage(thread_id)
    warnings: list[str] = []
    for event in quota.warn_events():
        level = int(event["level"])
        if level >= _USER_FACING_WARN_LEVEL:
            warnings.append(
                f"搜索额度已用 {int(event['credits_used'])}/{event['period_key']} "
                f"周期额度（{WARN_LEVEL_LABELS.get(level, '已超限')}）"
            )
    return {
        "credits_used": int(run["credits"]),
        "search_calls": int(run["calls"]),
        "degraded": bool(run["degraded"]),
        "degraded_reason": ("搜索额度不足，本次运行可能缺少联网证据" if run["degraded"] else None),
        "warnings": warnings,
    }


def _to_response(thread_id: str, values: dict, next_nodes: tuple[str, ...]) -> ResearchRunResponse:
    """从 checkpointer 的 values 推导对外状态。

    [B33] 关键：`next_nodes`（接下来要执行的节点）在**图执行中途**也是非空的
    （LangGraph 逐步推进，任何时刻都有 pending 节点），绝不能把「next 非空」
    直接当成「等待人工确认」—— 否则执行中查询会被误标成 awaiting_approval，
    用户刷新页面就看到确认框，以为流程停了。
    「等待确认」的唯一定义：图真正停在 write 节点**之前**（next 恰为 write）
    且还没有批准标记。
    """
    usage = values.get("usage") or []
    total_tokens = sum(item.get("total_tokens", 0) for item in usage)

    persisted = values.get("status")
    waiting_at_write = next_nodes == ("write",)
    if persisted in TERMINAL_STATUSES or persisted == "awaiting_approval":
        status = persisted
    elif waiting_at_write and not values.get("approval_granted"):
        # 首次跑到写报告前的中断点：等人工确认
        status = "awaiting_approval"
    else:
        # 其余一律是「运行中」：包括执行中途与已批准正在写报告
        status = "running"

    # [B38] 响应层兜底过滤：只把达标的知识库片段交给前端。
    # 节点侧已经过滤过，这里再挡一道的理由：
    # 1. 修复前产生的运行记录仍在 run store 里，读出来还是脏的；
    # 2. 知识库来源是唯一带「相关度」的结构化来源，任何遗漏路径都会
    #    直接呈现在「依据来源」里（用户明确反馈过这件事）。
    #
    # 知识库来源直接由达标的 citations 重建，而不是去过滤 state["sources"]
    # —— 后者只存了拼好的元信息字符串，靠字符串反查 chunk_id 太脆。
    citations = [c for c in (values.get("citations") or []) if is_relevant_citation(c)]
    web_sources = [s for s in (values.get("sources") or []) if s.get("origin") != "knowledge"]
    sources = dedupe_sources([*build_knowledge_sources(citations), *web_sources])

    return ResearchRunResponse(
        thread_id=thread_id,
        status=status,
        question=values.get("question", ""),
        understanding=values.get("understanding"),
        plan=values.get("plan"),
        analysis=values.get("analysis"),
        verification=values.get("verification"),
        report=values.get("report"),
        steps=values.get("steps") or [],
        tool_calls=values.get("tool_calls") or [],
        citations=citations,
        sources=dedupe_sources(sources),
        evidence_count=len(values.get("evidence") or []),
        iteration=values.get("iteration", 0),
        verify_attempts=values.get("verify_attempts", 0),
        usage_total_tokens=total_tokens,
        error=values.get("error"),
        finished_reason=values.get("finished_reason") or "",
        **_quota_view(thread_id),
    )


def _announce(thread_id: str, response: ResearchRunResponse) -> None:
    """广播生命周期事件。终态事件会让 SSE 连接关闭。"""
    if response.status == "awaiting_approval":
        emit(
            thread_id,
            EventType.APPROVAL_REQUIRED,
            {"node": "write", "summary": "报告生成前需要人工确认"},
        )
    elif response.status == "completed":
        emit(
            thread_id,
            EventType.TASK_COMPLETED,
            {"title": (response.report or {}).get("title"), "node": "write"},
        )
    elif response.status == "cancelled":
        emit(thread_id, EventType.TASK_CANCELLED, {"reason": "rejected_by_human"})
    elif response.status == "failed":
        emit(thread_id, EventType.TASK_FAILED, {"error": response.error})


# 终态：进入这些状态后不允许再 resume（人工拒绝必须是终态）
TERMINAL_STATUSES = frozenset({"completed", "cancelled", "failed"})


def _record_run(response: ResearchRunResponse, started: float) -> None:
    """记一次图运行的指标（结果分布 + 墙钟耗时）。

    只在 start / resume 的**终态收敛点**调用：读路径（get_research）不记，
    否则「查一次状态」会被算成一次运行。
    """
    metrics.inc(
        metrics.GRAPH_RUN_TOTAL,
        {"status": response.status, "finished_reason": response.finished_reason or "unknown"},
    )
    metrics.observe(metrics.GRAPH_RUN_DURATION_MS, (time.perf_counter() - started) * 1000)


async def _snapshot(thread_id: str, announce: bool = False) -> ResearchRunResponse:
    graph = get_research_graph()
    snapshot = await graph.aget_state(_config(thread_id))
    values = dict(snapshot.values or {})

    if not values:
        # checkpointer 里没有这次运行（InMemorySaver 在进程重启后就是空的）。
        # 这里必须抛错让上层回落到数据库，否则会用空状态把历史记录覆盖掉。
        raise LookupError(f"thread {thread_id} 不在内存 checkpointer 中")

    response = _to_response(thread_id, values, next_nodes=tuple(snapshot.next or ()))
    if announce:
        _announce(thread_id, response)

    # 落库：产品视角的运行记录（与 checkpointer 互补）
    #
    # [B3] 把**派生状态**（awaiting_approval 等）一并写进 state["status"]。
    # 之前只写图内部的 status 字段（中断时还是 "running"），
    # 导致进程重启后从数据库回落时，一个"等待人工确认"的运行被显示成"运行中"，
    # 用户会一直等下去。
    persisted = dict(values)
    persisted["status"] = response.status
    get_run_store().upsert(
        thread_id=thread_id,
        question=response.question,
        status=response.status,
        state=persisted,
    )
    return response


async def _run_graph_background(
    *,
    thread_id: str,
    initial: dict | None,
    started: float,
) -> None:
    """[B25] 后台执行图 + 异常兜底。

    两件必须做的事：
    1. 图跑完（或中断在 write 前）后落库 + 广播生命周期事件 —— 与旧同步路径一致
    2. 图抛任何异常都不能裸奔：请求早已返回，没人会接住这个异常。
       捕获后落库 failed + 发 TASK_FAILED，让 SSE 那端的前端能收尾
       （否则前端会一直停在「运行中」）。
    """
    graph = get_research_graph()
    try:
        await graph.ainvoke(initial, _config(thread_id))
        response = await _snapshot(thread_id, announce=True)
        _record_run(response, started)
    except asyncio.CancelledError:
        # 进程关闭时的正常取消：不要吞掉，也不要改写成 failed
        raise
    except Exception as exc:  # noqa: BLE001 - 后台任务没有调用方，必须在这里兜底
        logger.exception("后台图执行失败：thread=%s", thread_id)
        store = get_run_store()
        record = store.get(thread_id) or {"question": "", "state": {}}
        state = dict(record.get("state") or {})
        state["error"] = f"{type(exc).__name__}: {exc}"
        store.upsert(
            thread_id=thread_id,
            question=record.get("question") or state.get("question", ""),
            status="failed",
            state=state,
        )
        emit(thread_id, EventType.TASK_FAILED, {"error": f"{type(exc).__name__}: {exc}"})


def _spawn_graph(thread_id: str, task: asyncio.Task) -> None:
    """注册后台任务，防止被 GC 提前回收；完成后自动注销。"""
    _TASKS[thread_id] = task
    task.add_done_callback(lambda t: _TASKS.pop(thread_id, None))


async def _drain_background_tasks() -> None:
    """等待所有后台图任务结束。

    两个用途：进程关闭时的优雅收尾（main.py lifespan），
    以及测试里「启动 → 等图跑完 → 断言终态」的同步点。
    """
    while _TASKS:
        await asyncio.gather(*list(_TASKS.values()), return_exceptions=True)


async def start_research(
    *,
    question: str,
    max_iterations: int | None = None,
    max_verify_attempts: int | None = None,
    thread_id: str | None = None,
) -> ResearchRunResponse:
    settings = get_settings()
    started = time.perf_counter()
    tid = thread_id or f"thread_{uuid.uuid4().hex[:12]}"
    initial = build_initial_state(
        question=question,
        max_iterations=max_iterations or settings.graph_max_iterations,
        max_verify_attempts=max_verify_attempts or settings.graph_max_verify_attempts,
    )
    emit(
        tid,
        EventType.TASK_STARTED,
        {"question": question, "max_iterations": initial["max_iterations"]},
    )
    # 先落一条 running 记录，这样 SSE 端点能立刻校验 thread_id 是否合法
    get_run_store().upsert(thread_id=tid, question=question, status="running", state=initial)

    # [B33] 同一 thread 已有图在跑（用户手速快的重复点击）→ 拒绝而不是叠一个任务
    if _has_active_task(tid):
        raise AppError(
            code=ErrorCode.VALIDATION_ERROR,
            message="这次研究已在后台运行中，请稍候刷新查看进度，无需重复启动",
            status_code=409,
        )

    # [B25] 关键解耦：图放到后台任务里跑，接口立即返回 running 快照。
    # 同步等待整条流水线（2~5 分钟）必然撞上网关 ~60s 超时（504）。
    _spawn_graph(
        tid,
        asyncio.create_task(_run_graph_background(thread_id=tid, initial=initial, started=started)),
    )
    return _to_response(tid, initial, next_nodes=())


async def resume_research(
    *,
    thread_id: str,
    approved: bool = True,
    feedback: str | None = None,
) -> ResearchRunResponse:
    graph = get_research_graph()
    config = _config(thread_id)
    started = time.perf_counter()

    # [B3] 先确认这次运行在内存 checkpointer 里还活着。
    # 进程重启后 InMemorySaver 是空的，此时直接 ainvoke(None, ...) 会抛
    # EmptyInputError，被全局兜底 handler 吞成一句毫无信息量的 500。
    # 这里提前给出可操作的错误。
    checkpoint = await graph.aget_state(config)
    if not checkpoint.values:
        raise AppError(
            code=ErrorCode.VALIDATION_ERROR,
            message="这次运行已不可恢复：进程重启后内存中的中断点已丢失，请重新发起一次研究",
            status_code=409,
        )

    # [B4] 终态不可复活。人工拒绝（cancelled）必须是终态：
    # 否则一次 POST /resume {approved:true} 就能把被拒绝的任务重新跑完并出报告。
    # 拦截放在 service 层而不是只放在路由层 —— 状态机正确性不该依赖调用方。
    current_status = (checkpoint.values or {}).get("status")
    if current_status in TERMINAL_STATUSES:
        raise AppError(
            code=ErrorCode.VALIDATION_ERROR,
            message=f"这次运行已结束（{current_status}），无需恢复",
            status_code=409,
        )

    if not approved:
        # 人工拒绝：不继续写报告，把状态标记为 cancelled 并保存
        await graph.aupdate_state(
            config,
            {"status": "cancelled", "finished_reason": "rejected_by_human"},
        )
        response = await _snapshot(thread_id, announce=True)
        _record_run(response, started)
        return response

    # [B33] 防重复批准：报告已在后台生成时，再点一次「批准」会叠加一个 write 任务。
    # （典型触发：批准后刷新页面 —— 恢复的是批准瞬间的旧状态。）
    if _has_active_task(thread_id):
        raise AppError(
            code=ErrorCode.VALIDATION_ERROR,
            message="报告正在生成中，请稍候刷新页面查看结果，无需重复操作",
            status_code=409,
        )

    # [B33] 批准的第一件事是把状态持久化（无论有无人工意见）：
    # 1. status=running —— 刷新恢复看到「生成报告中」而不是再次弹确认框；
    # 2. approval_granted=True —— 独立标记，_to_response 用它区分
    #    「已批准正在写报告」和「首次跑到 write 前的中断点」。
    # 之前只在有 feedback 时才写状态，导致「批准后、write 完成」的窗口里
    # 记录仍是 awaiting_approval —— 用户刷新后确认框再次出现，诱导重复批准。
    await graph.aupdate_state(
        config,
        {
            "status": "running",
            "approval_granted": True,
            **({"feedback": feedback} if feedback else {}),
        },
    )

    # [B25] write 节点含 1~2 次 GLM 调用（repair 重试时约 60s+），
    # 与 start 一样放后台执行、立即返回 running，终态经 SSE 推送。
    _spawn_graph(
        thread_id,
        asyncio.create_task(
            _run_graph_background(thread_id=thread_id, initial=None, started=started)
        ),
    )
    # [B33] checkpoint 是批准**之前**取的（第 320 行），里面没有刚刚写进去的
    # approval_granted —— 若只用 `current["status"] = "running"` 覆盖，
    # 这里推导出 awaiting_approval，接口刚返回就自相矛盾，前端拿到确认框。
    # 直接把本次批准的结果并进本地副本，不依赖再读一次（后台任务可能正在并发写）。
    current = dict(checkpoint.values or {})
    current.update({"status": "running", "approval_granted": True})
    return _to_response(thread_id, current, next_nodes=("write",))


async def get_research(thread_id: str) -> ResearchRunResponse | None:
    """优先读图的状态；读不到（例如进程重启后内存 checkpoint 丢失）就用落库记录。"""
    try:
        return await _snapshot(thread_id)
    except Exception:  # noqa: BLE001 - checkpointer 里没有这个 thread
        record = get_run_store().get(thread_id)
        if record is None:
            return None
        return _to_response(thread_id, record["state"] or {}, next_nodes=())


def list_runs(limit: int = 20, status: str | None = None) -> list[dict]:
    return get_run_store().list_runs(limit, status=status)


def delete_run(thread_id: str) -> bool:
    """删除一次运行：运行记录与事件一起删，不留孤儿数据。

    注意：只删「落库记录」。内存 checkpointer 里的中断现场动不了，
    但那只影响「还没跑完的旧 run 能否恢复」——删除历史本来就是放弃它。
    """
    from app.events.store import get_event_store  # noqa: PLC0415  # 避免模块级循环依赖

    deleted = get_run_store().delete(thread_id)
    if deleted:
        get_event_store().delete_for_thread(thread_id)
    return deleted


def clear_runs() -> dict:
    """清空全部历史运行（用户明确要求清理调试期积累的大量垃圾记录）。"""
    from app.events.store import get_event_store  # noqa: PLC0415

    runs_deleted = get_run_store().delete_all()
    events_deleted = get_event_store().clear()
    return {"runs_deleted": runs_deleted, "events_deleted": events_deleted}

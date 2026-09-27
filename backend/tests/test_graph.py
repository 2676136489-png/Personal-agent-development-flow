"""Research graph tests: 循环、上限、中断、恢复。

跑法：uv run pytest
"""

from __future__ import annotations

import uuid

from app.api.routes.graph import stream_research_events
from app.events.bus import get_event_bus
from app.events.sse import event_stream
from app.graph.graph import (
    build_initial_state,
    get_research_graph,
    route_after_research,
    route_after_verify,
)
from app.graph.service import (
    _drain_background_tasks,
    get_research,
    resume_research,
    start_research,
)

QUESTION = "研究 2026 年 AI Agent 开发岗位的主要技术要求，并分析共同点。"


def test_conditional_edge_routes_back_to_research():
    """证据不足且未到上限 → 回到 research（这就是「循环」）"""
    state = build_initial_state(question=QUESTION, max_iterations=3)
    assert route_after_research(state) == "research"


def test_conditional_edge_stops_at_max_iterations():
    """达到最大轮数必须停止，否则就是无限循环"""
    state = build_initial_state(question=QUESTION, max_iterations=2)
    state["iteration"] = 2
    assert route_after_research(state) == "retrieve"


def test_conditional_edge_stops_when_research_done():
    state = build_initial_state(question=QUESTION)
    state["research_done"] = True
    assert route_after_research(state) == "retrieve"


def test_conditional_edge_stops_after_repeated_failures():
    state = build_initial_state(question=QUESTION)
    state["failure_streak"] = 2
    assert route_after_research(state) == "retrieve"


def test_verify_pass_goes_to_write():
    state = build_initial_state(question=QUESTION)
    state["verification"] = {"verdict": "pass"}
    assert route_after_verify(state) == "write"


def test_verify_needs_more_loops_back_but_has_limit():
    state = build_initial_state(question=QUESTION, max_verify_attempts=2)
    state["verification"] = {"verdict": "needs_more"}
    state["verify_attempts"] = 1
    assert route_after_verify(state) == "research"

    state["verify_attempts"] = 2
    assert route_after_verify(state) == "write"


def test_graph_has_interrupt_before_write():
    graph = get_research_graph()
    # LangGraph 会把 interrupt 节点记录在编译后的图上
    assert "write" in graph.interrupt_before_nodes


async def test_full_run_interrupts_then_resumes():
    """完整流程：启动 → 在 write 前中断 → 批准后完成

    [B25] 接口契约已改为「立即返回 running + 图在后台执行」，
    所以每个阶段都要先 drain 后台任务，再从落库记录断言状态。
    """
    started = await start_research(question=QUESTION, max_iterations=3)
    assert started.status == "running"  # 立即返回，图在后台跑

    await _drain_background_tasks()

    # 1) 中断在写报告之前
    stored = await get_research(started.thread_id)
    assert stored is not None
    assert stored.status == "awaiting_approval"
    assert stored.report is None
    # 2) 前面的节点都跑过了
    nodes = [step["node"] for step in stored.steps]
    assert nodes[0] == "understand_task"
    assert "plan" in nodes and "analyze" in nodes and "verify" in nodes
    # 3) 有工具调用与证据
    assert stored.tool_calls
    assert stored.evidence_count >= 1
    # 4) 循环受最大轮数约束
    assert stored.iteration <= 3

    # 5) 带人工意见恢复（批准分支同样是后台执行）
    resumed = await resume_research(
        thread_id=started.thread_id,
        approved=True,
        feedback="请补充局限性说明",
    )
    assert resumed.status == "running"

    await _drain_background_tasks()

    final = await get_research(started.thread_id)
    assert final is not None
    assert final.status == "completed"
    assert final.report is not None
    assert final.report["sections"]


async def test_rejecting_stops_the_run():
    started = await start_research(question=QUESTION, max_iterations=1)
    # 等图跑到 write 前的中断点，否则 resume 时还没有可恢复的中断状态
    await _drain_background_tasks()
    rejected = await resume_research(thread_id=started.thread_id, approved=False)

    assert rejected.status == "cancelled"
    assert rejected.report is None


async def test_events_endpoint_streams_before_run_record_exists():
    """前端会「先订阅、再发起运行」以求实时，所以记录还没建时不能直接拒绝（404）。

    这里直接调用路由函数：若把「记录不存在就报错」的校验加回来，本测试会抛异常而失败。
    不通过 HTTP 测是为了避免消费一个无限的事件流（会挂住测试）。
    """
    response = await stream_research_events("thread_not_started", None)
    assert response.media_type == "text/event-stream"


async def test_subscribing_before_run_receives_live_events():
    """前端「先订阅、再运行」能拿到实时事件的底层保证：

    事件通过 EventBus 广播给已订阅的队列，而不是只能从数据库回放。
    """
    # 事件是落库持久化的（events.db），固定 thread_id 会和历史运行串上，所以用唯一 id
    thread_id = f"thread_live_{uuid.uuid4().hex[:8]}"
    bus = get_event_bus()
    queue, history = bus.subscribe(thread_id, last_event_id=0)
    try:
        assert history == []  # 订阅那一刻还没有任何事件

        await start_research(question=QUESTION, max_iterations=1, thread_id=thread_id)

        # 运行结束后，订阅者队列里应已堆着运行期间实时投递的事件
        assert not queue.empty()
    finally:
        bus.unsubscribe(thread_id, queue)


async def test_live_subscriber_receives_terminal_event():
    """在线订阅者必须收到终态事件本体（task_completed）。

    否则前端只看得到连接断开，会显示成「连接中断」而不是「已完成」。
    """
    thread_id = f"thread_term_{uuid.uuid4().hex[:8]}"
    bus = get_event_bus()
    queue, _ = bus.subscribe(thread_id, last_event_id=0)
    try:
        started = await start_research(question=QUESTION, max_iterations=1, thread_id=thread_id)
        # [B25] 图在后台跑：先等它到 write 前中断，再批准，再等 write 完成
        await _drain_background_tasks()
        await resume_research(thread_id=started.thread_id, approved=True)
        await _drain_background_tasks()

        received: list[str] = []
        while not queue.empty():
            received.append(queue.get_nowait()["type"])

        assert "task_completed" in received
    finally:
        bus.unsubscribe(thread_id, queue)


async def test_event_stream_replays_and_formats_events():
    """事件流先回放历史（刷新/断线重连不丢），且报文格式符合 SSE 规范。"""
    started = await start_research(question=QUESTION, max_iterations=1)

    chunks: list[str] = []
    async for chunk in event_stream(started.thread_id, last_event_id=0):
        chunks.append(chunk)
        if len(chunks) >= 3:  # 历史事件足够，无需等待心跳
            break

    assert chunks[0].startswith("id: ")
    assert "event: task_started" in chunks[0]
    assert '"type": "task_started"' in chunks[0]


# =============================================================================
# [T10] 阶段顺序契约：让「评审员要记得核对」变成「CI 必须红」
# =============================================================================
# 背景：前端进度阶梯（FlowOverview 的 7 步）+ 进度条分母（runProgress.ts 的
# BASE_NODES = 7）都依赖「正常阶段恰好是这 7 个、顺序是这个顺序」。
# 在此断言之前，grep "add_node|STAGE_ORDER" tests/ 是零命中 —— 也就是说
# graph.py:80-87 那 8 行 add_node 的顺序【没有任何测试在看】。
#
# ⚠️ 断言策略：从 graph.nodes 运行时对象读顺序，不抄第二份字面量列表。
#    抄列表 = 用一份会漂的副本去守另一份会漂的副本（副本两边都是我写的，
#    还会自己绿）。runtime introspection 读的是编译产物本身。
#
# ⚠️ add_node 的注册顺序 ≠ 执行顺序。这里断言的是【注册顺序】，
#    它的唯一用途是给前端提供一个稳定的阶段序号来源（1..7 + fail）。
#    真正的执行顺序由 add_edge/add_conditional_edges 决定，另见路由测试。


def test_stage_order_matches_frontend_contract():
    """正常阶段必须是这 7 个、且顺序固定；fail 是第 8 个、显式失败终态。

    这条断言存在的理由：前端 BASE_NODES = 7（runProgress.ts:25 的 §12.2
    封闭名单 ①）和 FlowOverview 的 7 步，都把「7」写死了。图里插一个
    正常节点，前端分母就静默失准 —— 而 0.95 钳制会把这个失准藏起来
    （分母偏大 → 进度条偏慢 → 看起来只是「跑得慢」，不像 bug）。
    """
    graph = get_research_graph()

    # 从运行时对象读节点，不在测试里抄第二份列表。
    # ⚠️ LangGraph 在 compile 时会自动注入一个 `__start__` 哨兵节点
    #    （对应 START 这个虚拟入口），它不是 add_node 声明的业务节点，必须滤掉。
    #    这个事实正是「为什么不能抄一份字面量列表」的活证据：
    #    抄列表的人不会知道有 `__start__`，而 runtime introspection 会如实告诉你。
    registered = [name for name in graph.nodes if not name.startswith("__")]

    # fail 是短路终态，不进正常阶段序列（graph.py:87）
    assert "fail" in registered, "fail 节点缺失：显式失败终态是 design 的一部分"

    stages = [name for name in registered if name != "fail"]

    assert stages == [
        "understand_task",
        "plan",
        "research",
        "retrieve",
        "analyze",
        "verify",
        "write",
    ], (
        "正常阶段序列与前端契约不符。\n"
        "前端依赖：runProgress.ts 的 BASE_NODES = 7（封闭名单 ①）；"
        "FlowOverview.tsx 的 STEPS 条数。\n"
        "节点增删/重排必须先同步前端分母，否则进度条会静默失准"
        "（0.95 钳制会把失准伪装成「跑得慢」）。\n"
        f"当前实际：{stages}"
    )

    assert len(stages) == 7, f"正常阶段数必须为 7（前端 BASE_NODES），实际 {len(stages)}"

    # fail 必须是最后一个注册的（与 graph.py 的书写顺序一致）
    assert registered[-1] == "fail", (
        f"fail 应为最后一个注册节点（graph.py 的 8 处 add_node 顺序），实际末位是 {registered[-1]}"
    )


def test_start_and_end_are_wired():
    """START 指向第一个阶段、最后一个阶段指向 END —— 保证阶段序列首尾闭合。

    没有这条，上面那条顺序断言可能在一个「顺序对但没接线」的图上通过。
    """
    from langgraph.graph import END, START

    graph = get_research_graph()
    node_names = set(graph.nodes)

    assert "understand_task" in node_names
    assert "write" in node_names

    # 用 get_graph() 拿底层结构，核对边存在
    drawable = graph.get_graph()
    edges = {(e.source, e.target) for e in drawable.edges}

    start_out = [e for e in edges if e[0] == START]
    write_out = [e for e in edges if e[0] == "write"]
    fail_out = [e for e in edges if e[0] == "fail"]

    assert (START, "understand_task") in edges, f"START 未接线到 understand_task：{start_out}"
    assert ("write", END) in edges, f"write 未接线到 END；实际 write 出边 {write_out}"
    assert ("fail", END) in edges, f"fail 未接线到 END；实际 fail 出边 {fail_out}"

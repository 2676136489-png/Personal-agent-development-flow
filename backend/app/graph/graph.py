"""Graph assembly: 节点 + 边 + 条件边 + 中断点。

[P0] 三个概念：
- **Edge（边）**：把两个节点连起来，表示"做完 A 就做 B"。
- **Conditional Edge（条件边）**：做完 A 之后，**根据 State 的内容**决定下一步去哪 ——
  这就是循环、重试、分支的实现方式，也是 LangGraph 的核心价值所在。
- **interrupt_before**：在执行某个节点前暂停（Human-in-the-loop）。
  这里设在 write 之前：报告发布前需要人工确认，这是产品的真实要求。
"""

from __future__ import annotations

from functools import lru_cache

from langgraph.checkpoint.memory import InMemorySaver
from langgraph.graph import END, START, StateGraph

from app.graph.nodes import (
    analyze_node,
    fail_node,
    plan_node,
    research_node,
    retrieve_node,
    understand_task,
    verify_node,
    write_node,
)
from app.graph.state import ResearchState

MAX_FAILURE_STREAK = 2  # 连续失败这么多次就不再重试，避免在同一个坑里打转


def route_after_research(state: ResearchState) -> str:
    """research 之后：再来一轮，还是进入检索阶段？

    循环的出口条件必须写全，否则就是无限循环：
    1. 达到最大轮数
    2. 模型认为信息够了
    3. 连续失败太多次

    [P0] 即使前面某个节点已经报错，也必须先经过 retrieve 节点做联网检索，
    不能因为 error 而直接跳到 analyze —— 否则会出现「报告里只有知识库失败提示、
    完全没有联网搜索结果」的情况。
    """
    if state.get("iteration", 0) >= state.get("max_iterations", 3):
        return "retrieve"
    if state.get("research_done"):
        return "retrieve"
    if state.get("failure_streak", 0) >= MAX_FAILURE_STREAK:
        return "retrieve"
    return "research"  # 条件边指向自己 = 循环


def route_after_analyze(state: ResearchState) -> str:
    """[A5] 节点失败时不再硬着头皮写报告，而是走显式失败终态。

    之前这里返回 "write"，会在 analysis 为空、证据不足的情况下产出一份
    内容空泛却标着 completed 的报告，比直接报失败更容易误导用户。
    """
    if state.get("error"):
        return "fail"
    return "verify"


def route_after_verify(state: ResearchState) -> str:
    """verify 之后：通过就写报告，不通过就回炉补充研究（有次数上限）。"""
    if state.get("error"):
        return "fail"
    verdict = (state.get("verification") or {}).get("verdict")
    if verdict == "pass":
        return "write"
    if state.get("verify_attempts", 0) >= state.get("max_verify_attempts", 2):
        return "write"
    return "research"


def build_research_graph():
    graph = StateGraph(ResearchState)

    graph.add_node("understand_task", understand_task)
    graph.add_node("plan", plan_node)
    graph.add_node("research", research_node)
    graph.add_node("retrieve", retrieve_node)
    graph.add_node("analyze", analyze_node)
    graph.add_node("verify", verify_node)
    graph.add_node("write", write_node)
    graph.add_node("fail", fail_node)  # [A5] 显式失败终态

    graph.add_edge(START, "understand_task")
    graph.add_edge("understand_task", "plan")
    graph.add_edge("plan", "research")

    # [P0] 条件边：research 可以指向自己（循环），也可以前进
    # [A6] 去掉了永远不会命中的 "analyze" 分支（route_after_research 从不返回它）
    graph.add_conditional_edges(
        "research",
        route_after_research,
        {"research": "research", "retrieve": "retrieve"},
    )
    graph.add_edge("retrieve", "analyze")

    graph.add_conditional_edges(
        "analyze",
        route_after_analyze,
        {"verify": "verify", "fail": "fail"},
    )
    graph.add_conditional_edges(
        "verify",
        route_after_verify,
        {"research": "research", "write": "write", "fail": "fail"},
    )
    graph.add_edge("write", END)
    graph.add_edge("fail", END)

    return graph.compile(
        checkpointer=InMemorySaver(),
        interrupt_before=["write"],  # 写报告前暂停，等人工确认
    )


@lru_cache(maxsize=1)
def get_research_graph():
    """图是「结构」，编译一次即可；运行状态全部存在 checkpointer 里。"""
    return build_research_graph()


def build_initial_state(
    *,
    question: str,
    max_iterations: int = 5,
    max_verify_attempts: int = 2,
) -> ResearchState:
    """构造图的初始状态。

    默认值只服务「直接调用」的场景（测试 / 脚本）；正式运行由
    `service.start_research` 显式传入 `Settings.graph_max_iterations`，
    config.py 的默认值与此处保持一致（5 = 覆盖多子问题所需的轮数下限）。
    """
    return ResearchState(
        question=question,
        max_iterations=max_iterations,
        max_verify_attempts=max_verify_attempts,
        understanding=None,
        plan=None,
        analysis=None,
        verification=None,
        report=None,
        steps=[],
        tool_calls=[],
        citations=[],
        evidence=[],
        usage=[],
        iteration=0,
        verify_attempts=0,
        research_done=False,
        failure_streak=0,
        finished_reason="",
        error=None,
        feedback=None,
        status="running",
    )

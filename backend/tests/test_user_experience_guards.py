"""[B33]/[B34] 用户体验防护的回归测试。

1. [B33] 重复批准防护：批准后刷新页面再点批准（高频用户行为），后端必须拒绝
   而不是叠加第二个 write 任务；批准瞬间状态必须持久化为 running，
   刷新恢复看到的是「生成报告中」而不是又弹确认框。
2. [B34] 知识库弱相关被拒：score 低于门槛的片段不进证据、不挡联网检索。
"""

from __future__ import annotations

import asyncio
import json
from typing import Any

import pytest
from pydantic import BaseModel

from app.core.errors import AppError
from app.graph.service import (
    _drain_background_tasks,
    get_research,
    resume_research,
    start_research,
)
from app.tools.base import BaseTool, ToolContext
from app.tools.registry import ToolRegistry

QUESTION = "研究 2026 年 AI Agent 开发岗位的主要技术要求，并分析共同点。"


# ------------------------- [B33] 重复批准防护 -------------------------


async def test_double_approval_is_rejected(monkeypatch: pytest.MonkeyPatch):
    """批准后 write 仍在后台跑，第二次批准必须 409，而不是叠加任务。"""
    started = await start_research(question=QUESTION, max_iterations=1)
    await _drain_background_tasks()  # 跑到 write 前的 interrupt

    # 让 write 阶段慢一点，制造「批准后仍在后台跑」的窗口
    from langgraph.checkpoint.memory import InMemorySaver  # noqa: F401  # 确认可导入

    import app.graph.graph as graph_mod

    real_graph = graph_mod.get_research_graph()

    class SlowGraph:
        def __getattr__(self, name: str) -> Any:
            return getattr(real_graph, name)

        async def ainvoke(self, inp: Any, config: dict) -> Any:
            await asyncio.sleep(0.5)
            return await real_graph.ainvoke(inp, config)

    monkeypatch.setattr(graph_mod, "get_research_graph", lambda: SlowGraph())
    # service 里是 `from app.graph.graph import get_research_graph` 拿到的引用，
    # _run_graph_background 里每次都调 get_research_graph() —— 补丁两个命名空间
    import app.graph.service as svc

    monkeypatch.setattr(svc, "get_research_graph", lambda: SlowGraph())

    first = await resume_research(thread_id=started.thread_id, approved=True)
    assert first.status == "running"

    with pytest.raises(AppError, match="报告正在生成中"):
        await resume_research(thread_id=started.thread_id, approved=True)

    await _drain_background_tasks()
    final = await get_research(started.thread_id)
    assert final is not None and final.status == "completed"
    assert final.report is not None


async def test_approval_persists_running_status_immediately():
    """批准后（无人工意见）状态也要立刻落库为 running —— 刷新恢复不再弹确认框。"""
    started = await start_research(question=QUESTION, max_iterations=1)
    await _drain_background_tasks()

    resumed = await resume_research(thread_id=started.thread_id, approved=True)
    assert resumed.status == "running"

    # 立即查询（write 还在后台跑）：落库状态必须是 running 而不是 awaiting_approval
    immediate = await get_research(started.thread_id)
    assert immediate is not None
    assert immediate.status in ("running", "completed"), (
        "批准后状态必须立刻离开 awaiting_approval，否则刷新后确认框会再次出现"
    )
    await _drain_background_tasks()


async def test_status_is_never_awaiting_approval_while_executing():
    """图执行中途查询状态，必须报 running —— 这是「刷新后流程变了」的根因。

    LangGraph 每推进一步 `snapshot.next` 都非空，若拿「next 非空」当中断标志，
    研究进行到一半时刷新页面就会看到确认框（实际任务在跑），
    用户以为流程停了/丢了，于是又点一次批准 —— 流程被推着往前跑，行为不可预期。
    """
    started = await start_research(question=QUESTION, max_iterations=1)
    try:
        # 此刻后台任务正在跑（understand → plan → research…），先不等它
        snapshot = await get_research(started.thread_id)
        assert snapshot is not None
        assert snapshot.status != "awaiting_approval", (
            "图仍在执行中，状态不能被推成 awaiting_approval"
        )
    finally:
        await _drain_background_tasks()

    # 跑到写报告前的中断点，才允许出现确认态
    final = await get_research(started.thread_id)
    assert final is not None
    if final.status == "awaiting_approval":
        assert final.report is None


# ------------------------- [B34] 知识库弱相关被拒 -------------------------


class _FakeKBArgs(BaseModel):
    query: str = "q"
    top_k: int = 3


class _FakeWebArgs(BaseModel):
    query: str = "q"
    max_results: int = 3


class _LowScoreKBTool(BaseTool):
    """固定返回低分片段的知识库工具（模拟「主题沾边但实际不相关」）。"""

    name = "search_knowledge_base"
    description = "fake"
    args_schema = _FakeKBArgs

    async def _run(self, args: BaseModel, ctx: ToolContext) -> str:
        ctx.artifacts["citations"] = [
            {
                "chunk_id": "chk_1",
                "document_id": "doc_1",
                "filename": "[示例] x.md",
                "page": None,
                "quote": "沾边但不相关的内容",
                "score": 0.21,
            }
        ]
        return '[{"score": 0.21, "content": "沾边但不相关"}]'


class _FakeWebTool(BaseTool):
    name = "search_web"
    description = "fake"
    args_schema = _FakeWebArgs
    retryable = False

    async def _run(self, args: BaseModel, ctx: ToolContext) -> str:
        return "伪联网结果（真实运行时是 Tavily 的 JSON）"


# ------------------------- [B35] 证据可溯源 / 结论可核对 -------------------------


class _HighScoreKBTool(BaseTool):
    """命中知识库（score 高于门槛）的工具。"""

    name = "search_knowledge_base"
    description = "fake"
    args_schema = _FakeKBArgs

    async def _run(self, args: BaseModel, ctx: ToolContext) -> str:
        ctx.artifacts["citations"] = [
            {
                "chunk_id": "chk_ok",
                "document_id": "doc_ok",
                "filename": "Agent 岗招要求汇总（2026）.md",
                "page": None,
                "quote": "相关片段",
                "score": 0.72,
            }
        ]
        return '[{"score": 0.72, "content": "相关知识库片段正文"}]'


class _JsonWebTool(BaseTool):
    """返回真实结构的联网搜索结果（带标题），用于验证来源标签。"""

    name = "search_web"
    description = "fake"
    args_schema = _FakeWebArgs
    retryable = False

    async def _run(self, args: BaseModel, ctx: ToolContext) -> str:
        results = [
            {
                "title": "2026 年 AI Agent 岗位技能白皮书",
                "url": "https://a.example/p1",
                "content": "正文一",
            },
            {
                "title": "某招聘平台技术分析",
                "url": "https://b.example/p2",
                "content": "正文二",
            },
        ]
        return json.dumps(results, ensure_ascii=False)


async def _run_retrieve(
    monkeypatch: pytest.MonkeyPatch,
    registry: ToolRegistry,
    *,
    semantic: bool = True,
) -> dict:
    """单独跑一次 retrieve 节点，返回它产出的状态更新。

    `semantic` 决定「向量是否有语义能力」：False 时知识库会被 [B38] 守卫拦住。
    """
    import app.graph.nodes as nodes_mod
    from app.graph.nodes import retrieve_node

    monkeypatch.setattr(nodes_mod, "resolve_deps", lambda config: None)
    monkeypatch.setattr(nodes_mod, "_deps", lambda config: (None, registry))
    monkeypatch.setattr(nodes_mod, "embeddings_have_semantic_power", lambda: semantic)

    return await retrieve_node(
        {
            "question": QUESTION,
            "understanding": {"key_questions": ["子问题一"]},
            "iteration": 0,
        },
        {"configurable": {"thread_id": "thread_label"}},
    )


async def test_kb_evidence_label_carries_document_name(
    monkeypatch: pytest.MonkeyPatch,
):
    """知识库证据必须带命中文档名 —— 实例对不上时能追到是哪份材料。"""
    update = await _run_retrieve(monkeypatch, ToolRegistry([_HighScoreKBTool()]))
    evidence = update.get("evidence", [])
    assert evidence, "应当命中知识库"
    assert "知识库《Agent 岗招要求汇总（2026）.md》" in evidence[0], evidence[0]


async def test_kb_is_skipped_when_embeddings_lack_semantics(
    monkeypatch: pytest.MonkeyPatch,
):
    """[B38] 向量无语义能力时，知识库结果不得进入证据链。

    实测数据（哈希向量）：相关查询「向量数据库选型对比」得 0.587，
    而完全无关的「深度学习模型部署与量化」拿到 0.473 —— 相关与不相关
    分数严重重叠，任何阈值都切不开。此时唯一正确的做法是不采用它，
    否则用户看到的引用就是「与研究内容驴唇不对马嘴」。
    """
    update = await _run_retrieve(
        monkeypatch,
        ToolRegistry([_HighScoreKBTool(), _JsonWebTool()]),
        semantic=False,
    )
    assert not update.get("citations"), "无语义能力时不得产生知识库引用"
    assert not any((s or {}).get("origin") == "knowledge" for s in update.get("sources", [])), (
        "无语义能力时不得产生知识库来源"
    )
    assert not any("知识库《" in item for item in update.get("evidence", []))
    # 明确记录「为什么没用知识库」，用户才不会以为是漏检
    assert any("知识库未参与" in s["summary"] for s in update.get("steps", []))


async def test_web_evidence_label_carries_page_title(monkeypatch: pytest.MonkeyPatch):
    """联网证据必须带真实网页标题，而不是无信息量的「联网搜索」。"""
    # 注册表里不放知识库工具 → 必然走联网分支
    update = await _run_retrieve(monkeypatch, ToolRegistry([_JsonWebTool()]))
    evidence = update.get("evidence", [])
    assert evidence, "应当产生联网证据"
    assert "2026 年 AI Agent 岗位技能白皮书" in evidence[0], evidence[0]


# ResearchReport 带「全文不少于 200 字」的校验，桩数据必须达标才能构造出来。
# 填充句对测试要验证的行为没有任何影响。
_STUB_FILL = "本节结合已给出的证据，逐条说明主要发现及其相互关系，并说明其成立前提与适用边界。"


async def _write_with_stub_report(monkeypatch: pytest.MonkeyPatch, content: str) -> dict:
    """用固定正文跑一次 write_node，返回落库的 report。"""
    from types import SimpleNamespace

    import app.graph.nodes as nodes_mod
    from app.graph.nodes import write_node

    class _StubClient:
        async def complete_structured(self, request: Any, schema: type) -> Any:
            payload = schema(
                title="标题",
                summary="一段用于满足长度校验的摘要文本。",
                sections=[{"title": "第一节", "content": content + _STUB_FILL * 6}],
            )
            return SimpleNamespace(
                data=payload,
                response=SimpleNamespace(
                    usage=SimpleNamespace(model_dump=lambda: {"total_tokens": 1})
                ),
            )

    monkeypatch.setattr(nodes_mod, "_deps", lambda config: (_StubClient(), None))
    update = await write_node(
        {"question": QUESTION, "evidence": ["[知识库] 一段证据"]},
        {"configurable": {"thread_id": "thread_write"}},
    )
    assert update["status"] == "completed"
    return update["report"]


async def test_report_without_evidence_markers_is_flagged(
    monkeypatch: pytest.MonkeyPatch,
):
    """报告正文一处 [证据N] 都没标 → 必须写进 limitations，不能当作已核对的结论交付。"""
    report = await _write_with_stub_report(
        monkeypatch,
        "本节讨论研究问题涉及的主要方面，并说明各部分之间的相互关系与影响，"
        "本段刻意不出现任何证据编号，用来模拟模型自行发挥的情形。"
        "以上是正文的全部内容，用于满足长度校验。",
    )
    assert any("未经证据核对" in item for item in report["limitations"])


async def test_report_with_evidence_markers_is_not_flagged(
    monkeypatch: pytest.MonkeyPatch,
):
    """正文已标注 [证据N] 时不该误报。"""
    report = await _write_with_stub_report(
        monkeypatch,
        "本节依据[证据1]展开，说明该来源给出的主要结论及其适用范围，"
        "并进一步讨论该结论对其他相关方面可能产生的影响与约束条件。"
        "以上是正文的全部内容，用于满足长度校验。",
    )
    assert all("未经证据核对" not in item for item in report["limitations"])


async def test_low_relevance_kb_hits_fall_back_to_web(monkeypatch: pytest.MonkeyPatch):
    """知识库只有 0.21 分的弱相关片段 → 不算命中，必须回退联网搜索。"""
    import app.graph.nodes as nodes_mod
    from app.graph.nodes import retrieve_node
    from app.tools.registry import ToolRegistry

    started = await start_research(question=QUESTION, max_iterations=1)
    await _drain_background_tasks()

    captured: dict[str, Any] = {"web_queries": []}

    def fake_web_run(self: Any, args: BaseModel, ctx: ToolContext) -> str:
        captured["web_queries"].append(getattr(args, "query", ""))
        return "伪联网结果"

    monkeypatch.setattr(_FakeWebTool, "_run", fake_web_run)

    registry = ToolRegistry([_LowScoreKBTool(), _FakeWebTool()])
    monkeypatch.setattr(nodes_mod, "resolve_deps", lambda config: None)
    monkeypatch.setattr(
        nodes_mod,
        "_deps",
        lambda config: (None, registry),
    )

    state = {
        "question": QUESTION,
        "understanding": {"key_questions": ["子问题一", "子问题二"]},
        "iteration": 0,
    }
    update = await retrieve_node(state, {"configurable": {"thread_id": started.thread_id}})

    # 知识库弱相关 → 两个子问题都走了联网
    assert len(captured["web_queries"]) == 2
    # 弱相关片段不进证据（避免污染结论）
    assert not any("知识库" in item for item in update.get("evidence", []))
    await _drain_background_tasks()

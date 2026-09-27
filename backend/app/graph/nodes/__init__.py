"""Graph nodes: 每个节点只做一件事。

[P0] Node 是什么：
一个节点就是一个函数，签名为 (state, config) -> 局部更新。
它不调用下一个节点，也不知道自己后面是谁 —— 流程由 Edge 决定。
这是「图」和「一串 if/else」的本质区别：节点可复用、可重排、可被条件边跳过或重复执行。

本阶段刻意**不拆成多个 Agent**：所有节点共享同一份 State 和同一个 LLM client，
它们是「一个 Agent 的多个阶段」，而不是多个互相通信的 Agent。
"""

from __future__ import annotations

import json
import logging
import re
import time
from typing import Any

from langchain_core.runnables import RunnableConfig
from pydantic import BaseModel

from app.agent.schemas import AgentDecision
from app.core.config import get_settings
from app.core.security import wrap_untrusted_block
from app.events.bus import emit
from app.events.schemas import EventType
from app.graph import prompts
from app.graph.nodes.common import resolve_deps
from app.graph.schemas import (
    AnalysisResult,
    ResearchReport,
    TaskUnderstanding,
    VerificationResult,
)
from app.graph.sources import (
    KB_MIN_SCORE,
    build_knowledge_sources,
    citation_score,
    dedupe_sources,
    is_relevant_citation,
    parse_web_sources,
)
from app.graph.state import ResearchState
from app.llm.client import LLMClient
from app.llm.errors import LLMError
from app.llm.schemas import LLMRequest
from app.rag.embeddings import embeddings_have_semantic_power
from app.schemas.research import ResearchPlan
from app.tools.base import ToolContext
from app.tools.registry import ToolRegistry

logger = logging.getLogger(__name__)

# [B21] 证据预览从 600 提到 1200：write/analyze 节点需要足够的原文素材才能写出
# 有细节的报告；600 字截断常把一条证据拦腰切断，模型只能复述半截信息。
# GLM-4-Flash 的 128k 上下文完全吃得下，成本可控。
_EVIDENCE_PREVIEW = 1200
_ARGS_SNAPSHOT_CHARS = 500


def _short(text: str | None, limit: int = 24) -> str:
    """来源标签用的短标题（太长会淹没证据正文本身）。"""
    value = (text or "").strip().replace("\n", " ")
    return value if len(value) <= limit else value[: limit - 1] + "…"


def _kb_label(citations: list[dict]) -> str:
    """知识库证据的来源标签：优先用命中的那份文档名。

    [B35] 之前 evidence 只有 `[知识库]` + 正文，模型写出一个「实例」时
    无从标注它出自哪份文档，用户也就看不出实例与研究内容对不上。
    把文档名写进标签，可追溯性就落在证据本身上，而不是靠模型自觉。
    """
    for citation in citations:
        name = str(citation.get("filename") or "").strip()
        if name:
            return f"知识库《{_short(name, 30)}》"
    return "知识库"


# [B38] 知识库相关度门槛统一放在 `app/graph/sources.py`
# —— 那里是「知识库来源」的唯一构造点，规则只有一份。
# ⚠️ 门槛必须对**所有**写入 citations/evidence 的路径生效。之前只有
# `retrieve_node` 用了它，`research_node`（LLM 自主选工具的链路）没有 ——
# 于是 0.32 / 0.31 分的片段照样出现在「引用来源」里。
_KB_MIN_SCORE = KB_MIN_SCORE


def knowledge_base_is_trustworthy() -> bool:
    """[B38] 现在能不能把知识库检索结果当作**依据**？

    只在一个条件下说「不能」：向量没有语义能力（本地哈希兜底），
    且配置要求语义（`rag_semantic_required`，默认 True）。

    注意这**不是**「禁用知识库」：知识库页面照常可用，用户也能检索浏览；
    被拦住的只是「拿它当研究证据」——因为字面匹配的检索结果无法区分
    相关与不相关，写进报告就是污染。
    """
    if not get_settings().rag_semantic_required:
        return True
    try:
        return embeddings_have_semantic_power()
    except Exception:  # noqa: BLE001 - 判断不出来就保守处理
        return False


def _kb_unusable_reason() -> str:
    return (
        "当前向量检索没有语义能力（EMBEDDING_PROVIDER 回退为本地哈希向量），"
        "无法区分「相关」与「字面重叠」，故不采用知识库作为研究依据；"
        "本问题改用联网搜索。配置真实 embedding 模型后知识库会自动恢复参与。"
    )


def _relevant_kb_citations(citations: list[dict]) -> list[dict]:
    """只保留达到相关度门槛的知识库片段。"""
    return [citation for citation in citations if is_relevant_citation(citation)]


def _top_kb_score(citations: list[dict]) -> float:
    if not citations:
        return 0.0
    return max(citation_score(citation) for citation in citations)


def _web_label(sources: list[dict]) -> str:
    """联网证据的来源标签：用真实网页标题，不用「联网搜索」这种无信息量的前缀。"""
    titles = [str(item.get("title") or "").strip() for item in sources[:3]]
    titles = [title for title in titles if title]
    if not titles:
        return "联网搜索"
    return "联网搜索：" + " / ".join(_short(title, 20) for title in titles)


# [A8] 只有完全由我们本地生成、不含任何外部内容的工具可以免标记。
# 其余（联网搜索 / 网页抓取 / 知识库文档）一律当作不可信数据包裹后再进上下文：
# 知识库文档虽然由用户上传，但仍可能来自第三方，不能默认可信。
_TRUSTED_TOOLS = frozenset({"calculate"})

# [P1] retrieve 节点每轮最多覆盖几个子问题。
# 上限 3 是「覆盖度 vs 搜索额度」的平衡：SEARCH_QUOTA_PER_RUN_CAP 是 12，
# 而一次 run 里 retrieve 最多被调用 3 次（初次 + 两次回炉）。
_RETRIEVE_MAX_QUERIES = 3
# 注入 research prompt 的「待补充清单」条数上限
_PENDING_LIMIT = 6
# 注入 research prompt 的「已执行动作」条数上限
_EXECUTED_ACTIONS_LIMIT = 8
_EXECUTED_ARGS_CHARS = 120


def _pick_retrieve_queries(state: ResearchState) -> list[str]:
    """挑出本轮检索要覆盖的子问题清单。

    [P1] 此前 retrieve 只检索 `key_questions[0]` 一条 query —— 任务理解拆出的
    子问题里只有一个会被覆盖，这正是「深度研究不深」最直接的根因。现在：
    1. 优先用 `understanding.key_questions`（任务理解产出的子问题清单）；
    2. 为空时回退计划目标 / 原始问题，保证永远至少有一条 query；
    3. 按 verify_attempts 滚动窗口 —— 回炉后的下一轮先搜还没搜过的子问题，
       而不是每轮都从第 1 条重来。
    """
    understanding = state.get("understanding") or {}
    candidates = [
        str(item).strip()
        for item in (understanding.get("key_questions") or [])
        if str(item).strip()
    ]
    if not candidates:
        goal = (state.get("plan") or {}).get("goal") or state["question"]
        candidates = [str(goal).strip()]

    seen: set[str] = set()
    unique: list[str] = []
    for item in candidates:
        key = item.lower()
        if key in seen:
            continue
        seen.add(key)
        unique.append(item)

    offset = (state.get("verify_attempts") or 0) * _RETRIEVE_MAX_QUERIES
    offset %= len(unique)
    rotated = unique[offset:] + unique[:offset]
    return rotated[:_RETRIEVE_MAX_QUERIES]


def _pending_questions(state: ResearchState) -> list[str]:
    """汇总「还缺什么」：verify 的 missing/reasons + analyze 的 gaps。

    [P1] 回炉循环（verify needs_more → research）此前完全不把这些缺口
    交给模型，补充研究只能盲目重搜。这里去重后注入 research 的 prompt。
    """
    items: list[str] = []
    verification = state.get("verification") or {}
    # 只有判定「证据不足」时，missing/reasons 才是待办；pass 的 reasons 是解释性的
    if verification.get("verdict") and verification.get("verdict") != "pass":
        items.extend(str(item) for item in (verification.get("missing") or []))
        items.extend(str(item) for item in (verification.get("reasons") or []))
    analysis = state.get("analysis") or {}
    items.extend(str(item) for item in (analysis.get("gaps") or []))

    seen: set[str] = set()
    result: list[str] = []
    for item in items:
        text = item.strip()
        key = text.lower()
        if not text or key in seen:
            continue
        seen.add(key)
        result.append(text[:200])
    return result[:_PENDING_LIMIT]


def _executed_actions(state: ResearchState) -> list[str]:
    """最近几条已执行动作的「工具(参数)」摘要。

    [P1] 没有这份清单时，模型在回炉轮会反复用同一个 query 搜同一件事。
    """
    actions: list[str] = []
    for call in (state.get("tool_calls") or [])[-_EXECUTED_ACTIONS_LIMIT:]:
        args = json.dumps(call.get("args") or {}, ensure_ascii=False)
        if len(args) > _EXECUTED_ARGS_CHARS:
            args = args[:_EXECUTED_ARGS_CHARS] + "…"
        status = "" if call.get("ok", True) else "（失败）"
        actions.append(f"{call.get('tool', '未知工具')}({args}){status}")
    return actions


def _tool_call_entry(result: Any, args: dict) -> dict:
    """工具调用落库记录（retrieve 节点用），字段与 research 节点保持同一口径。"""
    return {
        "tool": result.tool,
        "args": args,
        "ok": result.ok,
        "error": result.error,
        "error_kind": result.error_kind,
        "duration_ms": result.duration_ms,
    }


def _safe_args(args: object) -> dict:
    """落库前把模型给出的 args 规范化：只保留 JSON 基本类型，并限制体积。

    [A8] args 完全由模型生成，直接落库再回显给前端有两条风险：
    一是嵌套过深/超大对象的存储膨胀，二是非 JSON 类型导致序列化后失真。
    """
    if not isinstance(args, dict):
        return {}
    cleaned: dict = {}
    for key, value in list(args.items())[:20]:
        if isinstance(value, (str, int, float, bool)) or value is None:
            cleaned[str(key)[:50]] = (
                value[:_ARGS_SNAPSHOT_CHARS] if isinstance(value, str) else value
            )
        else:
            cleaned[str(key)[:50]] = json.dumps(value, ensure_ascii=False, default=str)[
                :_ARGS_SNAPSHOT_CHARS
            ]
    return cleaned


def _thread_id(config: RunnableConfig) -> str:
    """节点发事件需要知道自己在哪一次运行里 —— 从 LangGraph 的 config 里取。"""
    return str((config or {}).get("configurable", {}).get("thread_id", "unknown"))


def _deps(config: RunnableConfig | None) -> tuple[LLMClient, ToolRegistry]:
    """从 config 里取依赖，取不到就用默认实现。

    这样做的好处：测试可以注入假 client / 假 registry，节点代码零改动。

    [T03] 具体实现已经搬到 `nodes.common.resolve_deps()` —— 那里是依赖清单的
    唯一出处。本函数只保留「拆成 (client, registry) 二元组」这个老口径，
    等 T04 把 8 个节点拆成 `_xxx_logic(state, deps)` 后连同本函数一起消失。
    """
    deps = resolve_deps(config)
    return deps.llm, deps.registry


async def _ask(
    client: LLMClient,
    messages: list[Any],
    schema: type[BaseModel],
    purpose: str,
    metadata: dict | None = None,
) -> tuple[BaseModel, dict]:
    """统一的结构化 LLM 调用。

    [A7] metadata 用来携带「结构化上下文」（例如当前证据条数），
    Mock client 优先读它而不是去正则匹配 prompt 文案 —— 后者会随着
    prompt 调整悄悄失效，而测试却依然全绿。
    """
    request = LLMRequest(
        messages=messages,
        response_format={"type": "json_object"},
        purpose=purpose,
        metadata=metadata or {},
    )
    result = await client.complete_structured(request, schema)
    return result.data, result.response.usage.model_dump()


def _step(node: str, summary: str) -> dict:
    return {"node": node, "summary": summary}


def _failed(message: str) -> dict:
    """出错时统一收敛：不让异常打断图，而是记录错误并进入收尾。"""
    return {"error": message}


# ------------------------------ nodes ------------------------------


async def understand_task(state: ResearchState, config: RunnableConfig) -> dict:
    thread_id = _thread_id(config)
    client, _ = _deps(config)
    emit(thread_id, EventType.PLANNING, {"node": "understand_task", "summary": "解析研究目标"})
    try:
        data, usage = await _ask(
            client,
            prompts.understanding_messages(state["question"]),
            TaskUnderstanding,
            "understand_task",
        )
    except LLMError as exc:
        return _failed(f"理解任务失败：{exc.message}")

    emit(
        thread_id,
        EventType.PLANNING,
        {"node": "understand_task", "summary": f"{len(data.key_questions)} 个关键问题"},
    )
    return {
        "understanding": data.model_dump(),
        "steps": [_step("understand_task", data.goal)],
        "usage": [{"purpose": "understand_task", **usage}],
    }


async def plan_node(state: ResearchState, config: RunnableConfig) -> dict:
    thread_id = _thread_id(config)
    client, _ = _deps(config)
    understanding = state.get("understanding") or {"goal": state["question"]}
    emit(thread_id, EventType.PLANNING, {"node": "plan", "summary": "生成研究计划"})

    data = None
    usage: dict = {}
    last_err = ""
    # [P0] 计划生成容错：模型偶尔会漏字段。先正常生成，失败再用 repair 提示重试一次；
    # 仍失败则退化为「从理解结果合成的最小可用计划」，保证后续检索/研究流程不中断。
    #
    # [A4] 第二次尝试会把上一次的具体失败原因（哪个字段不合规）回灌给模型，
    # 否则 repair 提示只知道"你错了"，模型大概率原样再错一次。
    for attempt in range(2):
        try:
            data, usage = await _ask(
                client,
                prompts.plan_messages(
                    understanding,
                    repair=attempt > 0,
                    repair_hint=last_err if attempt > 0 else None,
                ),
                ResearchPlan,
                "plan",
            )
            break
        except LLMError as exc:
            last_err = exc.message
            logger.warning("plan 生成失败（第 %s 次）：%s", attempt + 1, exc.message)

    if data is None:
        data = _fallback_plan(understanding)
        emit(
            thread_id,
            EventType.PLAN_CREATED,
            {"steps": len(data.steps), "goal": data.goal, "fallback": True},
        )
        return {
            "plan": data.model_dump(),
            "steps": [_step("plan", f"{len(data.steps)} 步计划（兜底）")],
            "usage": [],
        }

    emit(thread_id, EventType.PLAN_CREATED, {"steps": len(data.steps), "goal": data.goal})
    return {
        "plan": data.model_dump(),
        "steps": [_step("plan", f"{len(data.steps)} 步计划")],
        "usage": [{"purpose": "plan", **usage}],
    }


def _fallback_plan(understanding: dict) -> ResearchPlan:
    """计划生成彻底失败时的兜底：从任务理解里抽出目标/子问题，拼一个最小可运行计划。

    [A3] 这里必须用 **dict** 而不是 PlanStep 对象来构造 steps：
    ResearchPlan 的 steps 校验器只接受 dict，传对象会被静默过滤成空列表，
    导致「兜底计划」反而一份 0 步的计划（曾经的线上问题）。
    """
    goal = understanding.get("goal") or "完成本次研究"
    questions = [str(q) for q in (understanding.get("key_questions") or []) if q] or [goal]
    steps = [
        {
            "index": index,
            "title": f"回答子问题：{question}"[:100],
            "instruction": f"检索并整理关于「{question}」的证据"[:500],
        }
        for index, question in enumerate(questions[:6], start=1)
    ]
    return ResearchPlan(
        goal=goal,
        questions=questions[:7],
        steps=steps,  # type: ignore[arg-type]  # 交给 ResearchPlan 的 validator 规范化
        expected_sources=["招聘网站", "技术博客", "官方文档", "行业报告"],
    )


async def research_node(state: ResearchState, config: RunnableConfig) -> dict:
    """[P0] Tool Calling 与 Graph 的集成点。

    这个节点每执行一次 = 一轮「LLM 决策 → 执行一个工具」。
    是否再来一轮由**条件边**决定（而不是节点内的 for 循环），
    这样每一轮都会被 checkpoint 记录下来，中断后可以从断点继续。
    """
    thread_id = _thread_id(config)
    client, registry = _deps(config)
    settings = get_settings()

    try:
        decision, usage = await _ask(
            client,
            prompts.research_messages(
                tool_schemas=registry.function_schemas(),
                evidence=state.get("evidence", []),
                plan=state.get("plan"),
                # [P1] 回炉轮的两个关键输入：还缺什么、已经做过什么
                pending_questions=_pending_questions(state),
                executed=_executed_actions(state),
            ),
            AgentDecision,
            "research_decision",
            metadata={"evidence_count": len(state.get("evidence", []))},
        )
    except LLMError as exc:
        # [P0] 决策失败不要直接致命：累加失败计数，交给条件边决定是再来一轮还是进入检索。
        # 这样即使模型连续决策失败，也一定会走到 retrieve 节点做联网搜索，不会整图空转。
        return {
            "failure_streak": state.get("failure_streak", 0) + 1,
            "iteration": state.get("iteration", 0) + 1,
            "research_done": False,
            "steps": [_step("research", f"研究决策失败（重试）：{exc.message[:60]}")],
        }

    usage_record = {"purpose": "research_decision", **usage}

    # 模型认为信息够了 → 结束 research 阶段
    if decision.final_answer:
        return {
            "research_done": True,
            "failure_streak": 0,
            "iteration": state.get("iteration", 0) + 1,
            "evidence": [f"初步结论：{decision.final_answer[:_EVIDENCE_PREVIEW]}"],
            "steps": [_step("research", "模型判定信息已充分")],
            "usage": [usage_record],
        }

    action = decision.action
    if action is None:
        return _failed("模型既没有选择工具也没有给出结论")

    # [B38] LLM 可能自己挑中知识库。向量无语义能力时不能让它当依据用 ——
    # 字面匹配的结果会把无关片段带进证据链，正是用户反馈的那个问题。
    # 这里拒绝并把原因写进观察，让模型下一轮改走联网搜索。
    if action.tool == "search_knowledge_base" and not knowledge_base_is_trustworthy():
        emit(
            thread_id,
            EventType.TOOL_COMPLETED,
            {
                "tool": action.tool,
                "ok": False,
                "error_kind": "blocked",
                "error": "知识库检索缺语义能力，本轮不可作为依据",
            },
        )
        return {
            "iteration": state.get("iteration", 0) + 1,
            "failure_streak": 0,
            "research_done": False,
            "evidence": [f"[知识库] {_kb_unusable_reason()}"],
            "tool_calls": [
                {
                    "tool": action.tool,
                    "args": _safe_args(action.args),
                    "ok": False,
                    "error": "知识库检索缺语义能力",
                    "error_kind": "blocked",
                    "duration_ms": 0,
                }
            ],
            "steps": [_step("research", "知识库不可用（缺语义能力），改走联网搜索")],
            "usage": [usage_record],
        }

    ctx = ToolContext(
        run_id=str((config or {}).get("configurable", {}).get("thread_id", "graph")),
        max_output_chars=settings.tool_output_max_chars,
        allowed_domains=settings.fetch_allowed_domains_list,
        step_index=state.get("iteration", 0) + 1,
    )

    args_summary = json.dumps(action.args, ensure_ascii=False)[:200]
    emit(
        thread_id,
        EventType.TOOL_STARTED,
        {"tool": action.tool, "input_summary": args_summary, "reason": action.reason},
    )

    try:
        tool = registry.get(action.tool)
    except Exception as exc:  # 未知工具：记录为一次被拒绝的调用，不崩溃
        emit(
            thread_id,
            EventType.TOOL_COMPLETED,
            {"tool": action.tool, "ok": False, "error_kind": "blocked", "error": str(exc)},
        )
        return {
            "failure_streak": state.get("failure_streak", 0) + 1,
            "iteration": state.get("iteration", 0) + 1,
            # 重置「已完成」标记：若本轮是被 verify 打回的补充研究，要重新积累
            "research_done": False,
            "tool_calls": [
                {
                    "tool": action.tool,
                    "args": _safe_args(action.args),
                    "ok": False,
                    "error": str(exc),
                    "error_kind": "blocked",
                    "duration_ms": 0,
                }
            ],
            "steps": [_step("research", f"工具被拒绝：{action.tool}")],
            "usage": [usage_record],
        }

    result = await tool.execute(action.args, ctx)

    emit(
        thread_id,
        EventType.TOOL_COMPLETED,
        {
            "tool": result.tool,
            "ok": result.ok,
            "duration_ms": result.duration_ms,
            "output_summary": result.summary,
            "error": result.error,
            "error_kind": result.error_kind,
        },
    )

    observation = result.to_observation()
    if result.ok:
        # [A8] 除纯本地计算外，所有工具输出都标记为不可信数据后再进上下文
        if action.tool in _TRUSTED_TOOLS:
            evidence_text = f"[内部工具] {observation[:_EVIDENCE_PREVIEW]}"
        else:
            evidence_text = (
                f"[{action.tool}] {wrap_untrusted_block(observation[:_EVIDENCE_PREVIEW])}"
            )
    else:
        evidence_text = None

    safe_args = _safe_args(action.args)
    update: dict = {
        "iteration": state.get("iteration", 0) + 1,
        "failure_streak": (state.get("failure_streak", 0) + 1) if not result.ok else 0,
        "research_done": False,
        "tool_calls": [
            {
                "tool": result.tool,
                "args": safe_args,
                "ok": result.ok,
                "error": result.error,
                "error_kind": result.error_kind,
                "duration_ms": result.duration_ms,
            }
        ],
        "steps": [_step("research", f"{result.tool}：{result.summary}")],
        "usage": [usage_record],
    }
    # [B38] 知识库结果按相关度过滤 —— 与 retrieve_node 用同一条门槛。
    # 不过滤的话，LLM 只要选了 search_knowledge_base，0.2~0.3 分的沾边片段
    # 就会直接进「引用来源」，用户看到的引用与研究问题完全对不上。
    relevant_citations = _relevant_kb_citations(result.citations or [])
    if result.citations and not relevant_citations:
        # 全部弱相关：不记引用、不把沾边正文塞进证据，改为给模型一句明确的
        # 事实信号，让它在下一轮改走联网搜索，而不是拿这些材料硬写结论。
        best = _top_kb_score(result.citations)
        asked = str((action.args or {}).get("query") or state.get("question") or "")
        evidence_text = (
            f"[知识库] 知识库中没有与该查询足够相关的内容"
            f"（最高相关度 {best:.2f}，低于门槛 {_KB_MIN_SCORE}）。"
            f"请改用联网搜索等其他途径获取信息，不要依据无关片段作答。"
        )
        logger.info(
            "research 节点：知识库结果全为弱相关（query=%s，最高 %.2f），已丢弃",
            asked[:60],
            best,
        )

    if relevant_citations:
        update["citations"] = relevant_citations
        update["sources"] = dedupe_sources(build_knowledge_sources(relevant_citations))
    if result.ok and result.tool == "search_web":
        # 联网搜索的结构化来源：在这里解析，别让前端去 parse 一段可能被截断的 JSON
        update["sources"] = dedupe_sources(parse_web_sources(result.output))
    if evidence_text:
        update["evidence"] = [evidence_text]
    return update


async def retrieve_node(state: ResearchState, config: RunnableConfig) -> dict:
    """固定动作：对每个关键子问题，先查自己的知识库，未命中再回退真实联网搜索。

    这里不需要 LLM 决策（规则驱动），所以直接调用工具。

    [P1] 此前只检索 `key_questions[0]` **一条** query：任务理解拆出的子问题里
    只有一个会被覆盖，这正是「深度研究不深」最直接的根因。现在按子问题逐个检索，
    每个子问题都是「知识库优先、未命中才联网」—— 命中知识库的子问题不再消耗
    搜索额度；回炉轮通过 verify_attempts 滚动起点，优先补搜没搜过的子问题。
    """
    thread_id = _thread_id(config)
    _, registry = _deps(config)
    settings = get_settings()

    queries = _pick_retrieve_queries(state)
    ctx = ToolContext(
        run_id=str((config or {}).get("configurable", {}).get("thread_id", "graph")),
        max_output_chars=settings.tool_output_max_chars,
        # [B15] 之前这里漏了 allowed_domains，导致域名白名单在 retrieve 节点失效
        allowed_domains=settings.fetch_allowed_domains_list,
    )
    # [P1] 保留 query 字段（= 首个查询）：前端事件文案读的是 p.query
    emit(
        thread_id,
        EventType.RETRIEVAL_STARTED,
        {"query": queries[0], "queries": queries, "top_k": 3},
    )

    started = time.perf_counter()
    evidence: list[str] = []
    tool_calls: list[dict] = []
    citations: list[dict] = []
    sources: list[dict] = []
    total_duration_ms = 0
    kb_hits = 0

    # [B34] 相关度门槛：向量检索返回的是「最不坏的那条」，不是「真的相关」。
    # score 0.2~0.3 的弱相关片段（例如知识库里只有主题沾边的示例文档）会
    # 把联网检索挡在门外，还污染证据与结论 —— 用户看到的引用与研究问题
    # 驴唇不对马嘴。只有最高分达到门槛才算「命中」。
    # [B38] 门槛提到模块级 `_KB_MIN_SCORE`，research_node 共用同一条规则。
    kb_min_score = _KB_MIN_SCORE

    # [B38] 检索能力守卫：向量无语义能力时，知识库结果不可用作依据。
    # 用户反复反馈「引用里全是不相干的内容」—— 根因就在这里（见 _kb_unusable_reason）。
    kb_usable = knowledge_base_is_trustworthy()
    if not kb_usable:
        logger.info("知识库本轮不参与：%s", _kb_unusable_reason())

    for query in queries:
        # 1) 先查知识库（命中即止，该子问题不再联网）
        kb_result = None
        kb_args = {"query": query, "top_k": 3}
        if kb_usable:
            try:
                kb_tool = registry.get("search_knowledge_base")
                kb_result = await kb_tool.execute(kb_args, ctx)
            except Exception:  # 知识库不可用不应阻断整个研究工作流
                kb_result = None

        kb_scores = [float(c.get("score") or 0) for c in (kb_result.citations if kb_result else [])]
        kb_relevant = bool(kb_scores) and max(kb_scores) >= kb_min_score

        if kb_result is not None and kb_result.ok and kb_result.citations and kb_relevant:
            kb_hits += 1
            total_duration_ms += kb_result.duration_ms
            # [B38] 只收达标片段。top_k=3 时同批返回的往往还有 0.2~0.3 分的
            # 沾边片段 —— 只要最高的那条过了门槛就整批收下，正是用户看到
            # 「相关度 0.32 / 0.31」出现在引用来源里的原因。
            accepted = _relevant_kb_citations(kb_result.citations)
            citations.extend(accepted)
            tool_calls.append(_tool_call_entry(kb_result, kb_args))
            # [A8] 知识库文档同样可能来自第三方，统一按不可信数据包裹后再进上下文
            # [B35] 标签里带上命中的文档名，证据才可追溯到「哪一份材料」
            evidence.append(
                f"[{_kb_label(accepted)}] "
                f"{wrap_untrusted_block(kb_result.output[:_EVIDENCE_PREVIEW])}"
            )
            continue

        if kb_result is not None and kb_result.ok and kb_result.citations and not kb_relevant:
            # 弱相关被拒：如实记一条工具调用，用户在时间线里能看到「为何走了联网」
            logger.info(
                "知识库弱相关被拒（max_score=%.2f < %.2f），该子问题回退联网",
                max(kb_scores),
                kb_min_score,
            )
            tool_calls.append(_tool_call_entry(kb_result, kb_args))

        # 2) 知识库没命中 → 回退真实联网搜索（search_web 背后已是 Tavily）
        web_args = {"query": query, "max_results": 3}
        web_result = None
        try:
            web_tool = registry.get("search_web")
            web_result = await web_tool.execute(web_args, ctx)
        except Exception:
            web_result = None
        if web_result is None:
            continue
        # 失败也落一条记录：让使用者看得到「尝试过但没有结果」
        tool_calls.append(_tool_call_entry(web_result, web_args))
        total_duration_ms += web_result.duration_ms
        if web_result.ok:
            # 网页结果在这里解析成结构化来源，别让前端去 parse 可能被截断的 JSON
            web_sources = parse_web_sources(web_result.output)
            evidence.append(
                f"[{_web_label(web_sources)}] "
                f"{wrap_untrusted_block(web_result.output[:_EVIDENCE_PREVIEW])}"
            )
            sources = dedupe_sources([*sources, *web_sources])

    used_source = "知识库" if kb_hits else ("联网搜索" if sources else "无命中")
    step_summary = f"{used_source}：覆盖 {len(queries)} 个子问题，证据 +{len(evidence)}"
    if not kb_usable:
        # 在时间线里明说「为什么这次没用知识库」，否则用户会以为是漏检
        step_summary += "（知识库未参与：检索缺语义能力）"
    emit(
        thread_id,
        EventType.RETRIEVAL_COMPLETED,
        {
            "ok": bool(evidence),
            "hits": len(citations) + len(sources),
            "queries": queries,
            "kb_hits": kb_hits,
            "kb_usable": kb_usable,
            "duration_ms": total_duration_ms or int((time.perf_counter() - started) * 1000),
            "output_summary": f"覆盖 {len(queries)} 个子问题，新增 {len(evidence)} 段证据",
            "source": used_source,
        },
    )

    update: dict = {
        "tool_calls": tool_calls,
        "steps": [_step("retrieve", step_summary)],
    }
    if citations:
        update["citations"] = citations
        update["sources"] = dedupe_sources([*build_knowledge_sources(citations), *sources])
    elif sources:
        update["sources"] = sources
    if evidence:
        update["evidence"] = evidence
    return update


async def analyze_node(state: ResearchState, config: RunnableConfig) -> dict:
    thread_id = _thread_id(config)
    client, _ = _deps(config)
    emit(thread_id, EventType.ANALYSIS_STARTED, {"evidence_count": len(state.get("evidence", []))})
    try:
        data, usage = await _ask(
            client,
            prompts.analyze_messages(state["question"], state.get("evidence", [])),
            AnalysisResult,
            "analyze",
        )
    except LLMError as exc:
        return _failed(f"分析失败：{exc.message}")

    emit(
        thread_id,
        EventType.ANALYSIS_COMPLETED,
        {"findings": len(data.findings), "gaps": len(data.gaps)},
    )
    return {
        "analysis": data.model_dump(),
        "steps": [_step("analyze", f"{len(data.findings)} 条结论 / {len(data.gaps)} 处缺口")],
        "usage": [{"purpose": "analyze", **usage}],
    }


async def verify_node(state: ResearchState, config: RunnableConfig) -> dict:
    thread_id = _thread_id(config)
    client, _ = _deps(config)
    analysis = state.get("analysis") or {}
    emit(
        thread_id,
        EventType.VERIFICATION_STARTED,
        {"attempt": state.get("verify_attempts", 0) + 1},
    )
    try:
        data, usage = await _ask(
            client,
            prompts.verify_messages(
                state["question"],
                analysis,
                # [P1] 传证据正文而不是条数：核查员必须能逐条核对
                # findings 里标注的 [证据N] 是否真实、是否真的支持该结论
                state.get("evidence", []),
            ),
            VerificationResult,
            "verify",
            metadata={"evidence_count": len(state.get("evidence", []))},
        )
    except LLMError as exc:
        return _failed(f"验证失败：{exc.message}")

    emit(
        thread_id,
        EventType.VERIFICATION_COMPLETED,
        {"verdict": data.verdict, "reasons": data.reasons},
    )
    return {
        "verification": data.model_dump(),
        "verify_attempts": state.get("verify_attempts", 0) + 1,
        "steps": [_step("verify", f"判定：{data.verdict}")],
        "usage": [{"purpose": "verify", **usage}],
    }


async def write_node(state: ResearchState, config: RunnableConfig) -> dict:
    """生成最终报告。这是图的中断点（interrupt_before=["write"]）。"""
    thread_id = _thread_id(config)
    client, _ = _deps(config)
    emit(thread_id, EventType.REPORT_STARTED, {"has_feedback": bool(state.get("feedback"))})
    try:
        data, usage = await _ask(
            client,
            prompts.write_messages(
                state["question"],
                state.get("analysis") or {},
                state.get("evidence", []),
                state.get("feedback"),
                plan=state.get("plan"),
                # [P1] 注入来源清单：报告要点名出处时只能用清单里的真实来源
                sources=state.get("sources"),
            ),
            ResearchReport,
            "write",
        )
    except LLMError as exc:
        return _failed(f"撰写报告失败：{exc.message}")

    # [B35] 溯源兜底：报告正文若一个 [证据N] 都没标，说明写出来的实例
    # 无法对应到任何依据 —— 与其静默交付一份「看起来像那么回事」的报告，
    # 不如如实写进 limitations，让用户知道哪些结论未经证据核对。
    body = data.summary or ""
    body += "".join(section.content or "" for section in data.sections)
    if not re.search(r"\[证据\s*\d+\]", body):
        data.limitations = [
            *(data.limitations or []),
            "报告正文未标注任何 [证据N] 出处，其中的实例与数据未经证据核对，引用前请人工核验来源。",
        ]
        logger.warning("research thread=%s: 报告未标注证据编号，已写入 limitations", thread_id)

    return {
        "report": data.model_dump(),
        "status": "completed",
        "finished_reason": "completed",
        "steps": [_step("write", data.title)],
        "usage": [{"purpose": "write", **usage}],
    }


async def fail_node(state: ResearchState, config: RunnableConfig) -> dict:
    """[A5] 失败终态节点。

    之前 `route_after_analyze` / `route_after_verify` 在 error 时直接跳 write，
    结果是在 analysis 为空、evidence 可能也不足的情况下硬写一份空壳报告，
    用户看到的却是 `completed`。这里改成显式走失败终态：
    终态事件由 service._announce 统一广播（避免与这里重复发一条）。
    """
    error = state.get("error") or "未知错误"
    logger.warning("research graph failed: thread=%s error=%s", _thread_id(config), error)
    return {
        "status": "failed",
        "finished_reason": state.get("finished_reason") or "node_error",
        "steps": [_step("fail", f"流程失败：{error[:80]}")],
    }

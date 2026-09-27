"""内容质量防线的回归测试。

覆盖三处用户可见的质量问题：
1. [B20] 模型双重转义留下的字面 \\n 必须恢复为真实换行（structured.py 单点治理）
2. [B21] 「一句话 summary + 空 sections」的水报告必须判为不合规（触发 repair 重试）
3. [B22] questions/steps 为空的「空计划」必须判为不合规（前端不再面对空卡片）

[P1] 另覆盖「深度研究不深」的四条链路：子问题覆盖、缺口回灌、
已执行动作回灌、核查可见证据原文。
"""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from app.graph import prompts
from app.graph.graph import build_initial_state
from app.graph.nodes import (
    _executed_actions,
    _pending_questions,
    _pick_retrieve_queries,
)
from app.graph.schemas import ResearchReport
from app.llm.structured import parse_structured_payload
from app.schemas.research import ResearchPlan

# ------------------------- [B20] 字面 \n 恢复 -------------------------


def test_literal_newline_restored_in_strings():
    """GLM 双重转义的典型输出：解析后必须是真换行，不是字面 \\n。"""
    long_line = "详" * 200  # 让篇幅校验（B21）达标，聚焦换行行为本身
    payload = (
        '{"title": "标题", "summary": "' + long_line + '\\\\n第二段", '
        '"sections": [{"heading": "小节", "content": "' + long_line + '\\\\n乙\\\\t丙"}], '
        '"limitations": []}'
    )
    report = parse_structured_payload(payload, ResearchReport)
    assert report.summary == long_line + "\n第二段"
    assert report.sections[0].content == long_line + "\n乙\t丙"


def test_literal_newline_restored_in_nested_lists():
    """嵌套在数组/对象深处的字符串也要被恢复。"""
    payload = (
        '{"goal": "目标", "questions": ["问题一\\\\n补充", "问题二", "问题三"], '
        '"steps": [{"index": 1, "title": "步骤", "instruction": "做\\\\n这个"}], '
        '"expected_sources": ["官方文档"]}'
    )
    plan = parse_structured_payload(payload, ResearchPlan)
    assert plan.questions[0] == "问题一\n补充"
    assert plan.steps[0].instruction == "做\n这个"


def test_real_newline_not_double_unescaped():
    """合法 JSON 里的真换行（\\n 转义写法）保持原样，不能被二次处理。"""
    long_line = "详" * 320  # sections 为空时，全文 300 字的下限也要由 summary 独立满足
    payload = (
        '{"title": "t", "summary": "' + long_line + '\\n真换行", "sections": [], "limitations": []}'
    )
    report = parse_structured_payload(payload, ResearchReport)
    assert report.summary == long_line + "\n真换行"
    assert "\\n" not in report.summary


# ------------------------- [B21] 水报告拦截 -------------------------


def _long_text(chars: int) -> str:
    return "详" * chars


def test_empty_sections_and_short_summary_rejected():
    """一句话 summary + 空 sections = 用户看到的「报告怎么这么短」。"""
    with pytest.raises(ValidationError, match="报告内容过少"):
        ResearchReport(title="t", summary="很短的一句话。", sections=[], limitations=[])


def test_thin_report_rejected():
    """全文不足 300 字：sections 非空但每节都是短语堆砌。"""
    with pytest.raises(ValidationError, match="报告内容过少"):
        ResearchReport(
            title="t",
            summary=_long_text(120),
            sections=[{"heading": "结论", "content": "只有一句。"}],
            limitations=[],
        )


def test_substantial_report_accepted():
    """合规报告：summary ≥150 字 + 小节展开后全文 ≥300 字。"""
    report = ResearchReport(
        title="t",
        summary=_long_text(160),
        sections=[{"heading": "结论", "content": _long_text(220)}],
        limitations=[],
    )
    assert len(report.sections) == 1


# ------------------------- [B22] 空计划拦截 -------------------------


def _valid_plan_kwargs() -> dict:
    return {
        "goal": "研究目标",
        "questions": ["子问题一", "子问题二", "子问题三", "子问题四"],
        "steps": [{"index": 1, "title": "第一步", "instruction": "检索证据"}],
        "expected_sources": ["官方文档"],
    }


def test_plan_with_empty_questions_rejected():
    kwargs = _valid_plan_kwargs()
    kwargs["questions"] = []
    with pytest.raises(ValidationError, match="计划内容缺失"):
        ResearchPlan(**kwargs)


def test_plan_with_empty_steps_rejected():
    kwargs = _valid_plan_kwargs()
    kwargs["steps"] = []
    with pytest.raises(ValidationError, match="计划内容缺失"):
        ResearchPlan(**kwargs)


def test_valid_plan_accepted():
    plan = ResearchPlan(**_valid_plan_kwargs())
    assert len(plan.steps) == 1


# =============================================================================
# [P1] 深度研究链路：子问题覆盖 / 缺口回灌 / 核查可见证据
# 背景：retrieve 只搜 key_questions[0]、verify 只看证据条数、回炉不带缺口清单，
# 是「深度研究不深、报告像表面文章」的三条根因。
# =============================================================================


def test_retrieve_covers_multiple_key_questions():
    """retrieve 必须覆盖多个子问题，而不是只搜第一条。"""
    state = build_initial_state(question="研究 AI Agent 岗位要求")
    state["understanding"] = {"key_questions": [f"子问题{i}" for i in range(1, 6)]}

    first = _pick_retrieve_queries(state)
    assert first == ["子问题1", "子问题2", "子问题3"]

    # 回炉轮（verify_attempts=1）滚动到下一条开始，优先补搜没搜过的子问题
    state["verify_attempts"] = 1
    second = _pick_retrieve_queries(state)
    assert second == ["子问题4", "子问题5", "子问题1"]
    assert set(second) != set(first)


def test_retrieve_falls_back_to_question_and_dedupes():
    """没有子问题时回退到原始问题；重复子问题只保留一条。"""
    state = build_initial_state(question="原始问题")
    assert _pick_retrieve_queries(state) == ["原始问题"]

    state["understanding"] = {"key_questions": ["重复问题", "重复问题", "另一个问题"]}
    assert _pick_retrieve_queries(state) == ["重复问题", "另一个问题"]


def test_pending_questions_merge_verify_and_analysis_gaps():
    """回炉补研究前必须把「还缺什么」汇总出来（去重、保序）。"""
    state = build_initial_state(question="q")
    state["verification"] = {
        "verdict": "needs_more",
        "reasons": ["证据不足"],
        "missing": ["缺少 2026 年薪资数据"],
    }
    state["analysis"] = {"findings": [], "gaps": ["缺少一手来源", "缺少 2026 年薪资数据"]}

    assert _pending_questions(state) == [
        "缺少 2026 年薪资数据",
        "证据不足",
        "缺少一手来源",
    ]


def test_pending_questions_ignored_when_verdict_pass():
    """verdict=pass 时 reasons 是解释性的，不应被当成待补充事项。"""
    state = build_initial_state(question="q")
    state["verification"] = {"verdict": "pass", "reasons": ["都核对过了"], "missing": []}
    state["analysis"] = {"gaps": []}
    assert _pending_questions(state) == []


def test_executed_actions_render_tool_calls_with_failure_mark():
    """已执行动作清单要能区分成功与失败，避免模型原样重试。"""
    state = build_initial_state(question="q")
    state["tool_calls"] = [
        {"tool": "search_web", "args": {"query": "关键词A"}, "ok": True},
        {"tool": "search_web", "args": {"query": "关键词B"}, "ok": False},
    ]
    actions = _executed_actions(state)
    assert actions[0].startswith("search_web(")
    assert "关键词A" in actions[0]
    assert actions[1].endswith("（失败）")


def test_research_prompt_injects_pending_and_executed():
    """research 的 user message 必须带上待补充清单与已执行动作。"""
    messages = prompts.research_messages(
        tool_schemas=[{"name": "search_web"}],
        evidence=["[证据片段]"],
        plan={"goal": "目标"},
        pending_questions=["缺少 2026 年薪资数据"],
        executed=["search_web({\"query\": \"关键词A\"})"],
    )
    assert messages[0].role == "system"
    user = messages[1].content
    assert "缺少 2026 年薪资数据" in user
    assert "已执行动作" in user
    assert "关键词A" in user


def test_verify_prompt_contains_evidence_text():
    """核查员必须看到证据原文，而不是只看到「证据条数」。"""
    messages = prompts.verify_messages("q", {"findings": ["结论 [证据1]"]}, ["证据正文-甲"])
    user = messages[1].content
    assert "证据正文-甲" in user
    assert "证据条数" not in user


def test_evidence_numbering_is_consistent_across_prompts():
    """analyze / write 的证据编号必须同为 [证据N]，且 write 能看到来源清单。"""
    analysis_messages = prompts.analyze_messages("q", ["甲", "乙"])
    write_messages = prompts.write_messages(
        "q",
        {"findings": ["结论 [证据1]"]},
        ["甲", "乙"],
        None,
        sources=[{"title": "某来源", "url": "https://example.com/a"}],
    )
    assert "[证据1] 甲" in analysis_messages[1].content
    assert "[证据2] 乙" in analysis_messages[1].content
    assert "[证据1] 甲" in write_messages[1].content
    assert "https://example.com/a" in write_messages[1].content

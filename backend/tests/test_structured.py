"""Structured output parsing tests.

跑法：uv run pytest
"""

from __future__ import annotations

import pytest

from app.llm.errors import LLMError
from app.llm.structured import parse_structured_payload
from app.schemas.research import ResearchPlan

# [B24] ResearchPlan 现在要求 questions ≥ 3（少于 3 个子问题判为「拆解不及格」），
# 这里的 payload 只验证解析容错，不是验证内容策略，所以给足 4 个。
_VALID_PLAN = """
{"goal": "g", "questions": ["q1", "q2", "q3", "q4"],
 "steps": [{"index": 1, "title": "t", "instruction": "i"}],
 "expected_sources": ["s"]}
"""


def test_parses_valid_json():
    plan = parse_structured_payload(_VALID_PLAN, ResearchPlan)
    assert plan.goal == "g"
    assert plan.steps[0].index == 1


def test_tolerates_markdown_code_fence():
    """模型经常用 ```json 包裹输出，必须能容错"""
    fenced = f"```json\n{_VALID_PLAN.strip()}\n```"
    assert parse_structured_payload(fenced, ResearchPlan).goal == "g"


def test_tolerates_surrounding_text():
    noisy = f"好的，这是计划：\n{_VALID_PLAN.strip()}\n希望对你有帮助"
    assert parse_structured_payload(noisy, ResearchPlan).goal == "g"


def test_rejects_output_missing_required_field():
    with pytest.raises(LLMError) as exc_info:
        parse_structured_payload('{"goal": "只有 goal"}', ResearchPlan)
    assert exc_info.value.kind == "parse"
    assert exc_info.value.retryable is True


def test_rejects_non_json_output():
    with pytest.raises(LLMError) as exc_info:
        parse_structured_payload("我无法完成这个请求", ResearchPlan)
    assert exc_info.value.kind == "parse"

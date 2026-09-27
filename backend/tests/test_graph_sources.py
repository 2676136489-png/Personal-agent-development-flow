"""app/graph/sources.py 的解析测试。

重点覆盖三类真实风险：
1. 正常 JSON → 结构化来源
2. **被截断的 JSON**（tool_output_max_chars 会砍断输出）→ 正则捞回，不能整批丢掉
3. 去重与知识库转换

这些用例直接对应一次 P0 事故：前端原本依赖 `tool_calls[].output_preview`，
而图路径根本没有这个字段，导致「依据来源」面板恒为空。
"""

from __future__ import annotations

import json

from app.graph.sources import (
    build_knowledge_sources,
    dedupe_sources,
    parse_web_sources,
)


def test_parses_search_web_json():
    payload = json.dumps(
        [
            {
                "title": "AI Agent 岗位要求",
                "url": "https://example.com/a",
                "content": "需要 Python 与 RAG 经验",
                "source": "tavily",
            },
            {
                "title": "研究智能体实践",
                "url": "https://example.com/b",
                "content": "关键是证据留存",
                "source": "tavily",
            },
        ],
        ensure_ascii=False,
    )
    sources = parse_web_sources(payload)

    assert len(sources) == 2
    assert sources[0]["origin"] == "web"
    assert sources[0]["title"] == "AI Agent 岗位要求"
    assert sources[0]["url"] == "https://example.com/a"
    assert sources[0]["snippet"] == "需要 Python 与 RAG 经验"
    assert sources[0]["source"] == "tavily"


def test_salvages_truncated_json():
    """输出被 tool_output_max_chars 截断 → 至少要把 URL 捞回来。"""
    full = [
        {"title": "完整的一条", "url": "https://example.com/1", "content": "摘要一"},
        {"title": "被砍断的一条", "url": "https://example.com/2", "content": "摘要二"},
    ]
    head = json.dumps(full[0], ensure_ascii=False)
    truncated = json.dumps(full, ensure_ascii=False)[: len(head) + 40]

    sources = parse_web_sources(truncated)
    urls = [item["url"] for item in sources]

    # 关键断言：截断不能导致「一条来源都没有」
    assert "https://example.com/1" in urls


def test_empty_input_returns_empty_list():
    """空输入 / 非 JSON 噪声都不许抛异常——来源是可增强项。"""
    assert parse_web_sources("") == []
    assert parse_web_sources("   ") == []
    assert parse_web_sources("没有检索到相关内容。") == []


def test_items_without_url_are_dropped():
    """没有 URL 的来源不可溯源，展示出来没意义。"""
    payload = json.dumps(
        [{"title": "无链接", "url": "", "content": "x"}, {"title": "有链接", "url": "https://e.com/1"}],
        ensure_ascii=False,
    )
    sources = parse_web_sources(payload)
    assert [item["url"] for item in sources] == ["https://e.com/1"]


def test_knowledge_citations_become_sources():
    citations = [
        {
            "chunk_id": "c1",
            "document_id": "d1",
            "filename": "内部报告.pdf",
            "page": 3,
            "quote": "关键结论原文",
            "score": 0.87,
        }
    ]
    sources = build_knowledge_sources(citations)

    assert len(sources) == 1
    assert sources[0]["origin"] == "knowledge"
    assert sources[0]["title"] == "内部报告.pdf"
    assert sources[0]["url"] == ""
    assert "第 3 页" in (sources[0]["source"] or "")
    assert "0.87" in (sources[0]["source"] or "")


def test_dedupe_keeps_first_occurrence():
    dup = [
        {"origin": "web", "title": "A", "url": "https://e.com/1", "snippet": "x"},
        {"origin": "web", "title": "A2", "url": "https://e.com/1", "snippet": "y"},
        {"origin": "web", "title": "B", "url": "https://e.com/2", "snippet": "z"},
    ]
    result = dedupe_sources(dup)
    assert [item["title"] for item in result] == ["A", "B"]

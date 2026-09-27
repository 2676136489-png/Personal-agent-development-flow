"""把工具输出解析成「可展示的依据来源」。

为什么要有这一层（本次 P0 修复的根因）：

之前前端想展示「这条结论来自哪个网页」，只能去读 `tool_calls[].output_preview`。
但 `output_preview` **只存在于 Agent 路径**（`app/agent/orchestrator.py`），
LangGraph 的 research / retrieve 节点组装 `tool_calls` 时压根没有这个字段
（`app/graph/nodes/__init__.py`）——于是深度研究页的「依据来源」永远是空的。

更深一层的问题是：让前端去 `JSON.parse` 一段被截断过的工具输出，
等于把「协议解析」这份工作放到了最不该放的地方。正确做法是：
**谁产出数据谁负责结构化**，后端在这里解析好，前端只管渲染。

因此本模块承担三件事：
1. 联网搜索：把 search_web 的 JSON 输出解析成 sources（**容错截断**）
2. 知识库：把 citations 转成同构的 sources（origin=knowledge）
3. 去重：同一 URL / 同一 chunk 只保留一条
"""

from __future__ import annotations

import json
import logging
import re
from typing import Any

logger = logging.getLogger(__name__)

# 单条来源的摘要长度上限。超过会撑爆 API 响应与前端卡片。
SNIPPET_LIMIT = 400

# [B38] 知识库片段的相关度门槛（全图唯一事实源）。
#
# 向量检索返回的是「最不坏的那条」，不是「真的相关」：库里存着示例文档时，
# 任何问题都能捞到 0.2~0.3 分的沾边片段。这些片段一旦进了证据与引用，
# 用户看到的就是「结论里的内容和我的研究问题驴唇不对马嘴」。
#
# 放在这个模块而不是某个节点里：本模块是知识库来源的唯一构造点，
# 规则落在这里，任何调用路径都不可能绕过。
KB_MIN_SCORE = 0.35


def citation_score(citation: dict) -> float:
    """取一条知识库片段的相关度。缺失/非数值一律当 0（= 不可用）。"""
    try:
        return float(citation.get("score") or 0)
    except (TypeError, ValueError):
        return 0.0


def is_relevant_citation(citation: dict) -> bool:
    """这条知识库片段是否达到「可当作依据」的相关度。"""
    return citation_score(citation) >= KB_MIN_SCORE


# 截断兜底用的正则：从半截 JSON 里也能救回 url / title / snippet。
# 为什么需要：search_web 的输出会被 `tool_output_max_chars`（默认 3000）截断，
# 最后一条结果往往是半个对象，json.loads 直接失败。
# 「因为一条坏了就丢掉全部来源」是不可接受的，所以用正则尽量捞。
_URL_RE = re.compile(r'"url"\s*:\s*"([^"]+)"')
_TITLE_RE = re.compile(r'"title"\s*:\s*"([^"]*)"')
_CONTENT_RE = re.compile(r'"(?:content|snippet)"\s*:\s*"((?:[^"\\]|\\.)*)"')


def _clip(text: str | None, limit: int = SNIPPET_LIMIT) -> str:
    if not text:
        return ""
    value = text.strip()
    return value if len(value) <= limit else value[:limit] + "…"


def _normalize_web_item(item: Any) -> dict | None:
    """把一条搜索结果归一化成前端可渲染的结构。"""
    if not isinstance(item, dict):
        return None
    url = str(item.get("url") or "").strip()
    if not url:
        # 没有 URL 的来源不可溯源，展示出来也没意义
        return None
    return {
        "origin": "web",
        "title": _clip(str(item.get("title") or "").strip() or url, 200),
        "url": url,
        "snippet": _clip(str(item.get("content") or item.get("snippet") or "")),
        "source": str(item.get("source") or "").strip() or None,
    }


def parse_web_sources(output: str) -> list[dict]:
    """解析 search_web 的输出（一段 JSON 数组），失败时退回正则。

    返回值永远是 list —— 解析不出来就返回空列表，由调用方决定怎么展示，
    这里不抛异常：来源是可增强项，不该把一次研究搞挂。
    """
    if not output or not output.strip():
        return []

    try:
        parsed = json.loads(output)
    except (ValueError, TypeError):
        return _salvage_truncated(output)

    if isinstance(parsed, dict):
        parsed = parsed.get("results") or []
    if not isinstance(parsed, list):
        return []

    sources: list[dict] = []
    for item in parsed:
        normalized = _normalize_web_item(item)
        if normalized:
            sources.append(normalized)
    return sources


def _salvage_truncated(output: str) -> list[dict]:
    """从被截断的 JSON 文本里尽量捞回完整的结果片段。"""
    urls = _URL_RE.findall(output)
    if not urls:
        logger.warning("搜索输出既不是合法 JSON 也捞不到 URL，本次不产出来源")
        return []

    titles = _TITLE_RE.findall(output)
    contents = _CONTENT_RE.findall(output)
    sources: list[dict] = []
    for index, url in enumerate(urls):
        title = titles[index] if index < len(titles) else url
        snippet = contents[index] if index < len(contents) else ""
        # 最后一条常常是半截对象，摘要为空也照样收下（URL 才是溯源的关键）
        sources.append(
            {
                "origin": "web",
                "title": _clip(title, 200),
                "url": url,
                "snippet": _clip(snippet),
                "source": None,
                "truncated": True,
            }
        )
    logger.warning("搜索输出被截断，正则捞回 %d 条来源（可能缺少摘要）", len(sources))
    return sources


def build_knowledge_sources(citations: list[dict] | None) -> list[dict]:
    """把知识库的 citations 转成与联网来源同构的结构。

    同构的意义：前端只认 `run.sources` 一个字段，
    不必为「这次是搜网页还是查知识库」写两套渲染。

    [B38] 这里自带相关度门槛过滤 —— 它是「知识库来源」的唯一构造点，
    把规则放在这里，任何调用点（无论哪个节点、还是响应组装层）都不可能
    再漏出弱相关片段。用户看到的「相关度 0.32 / 0.31」就是这么漏出去的。
    """
    sources: list[dict] = []
    for citation in citations or []:
        if not isinstance(citation, dict):
            continue
        if not is_relevant_citation(citation):
            continue
        chunk_id = str(citation.get("chunk_id") or "").strip()
        if not chunk_id:
            continue
        page = citation.get("page")
        score = citation.get("score")
        parts = [f"第 {page} 页" if page else "", f"片段 {chunk_id}"]
        if isinstance(score, (int, float)):
            parts.append(f"相关度 {score:.2f}")
        sources.append(
            {
                "origin": "knowledge",
                "title": str(citation.get("filename") or "知识库文档").strip(),
                "url": "",
                "snippet": _clip(str(citation.get("quote") or "")),
                "source": " · ".join([p for p in parts if p]),
            }
        )
    return sources


def dedupe_sources(sources: list[dict]) -> list[dict]:
    """按 URL（联网）或 title+snippet（知识库）去重，保留首次出现的那条。"""
    seen: set[str] = set()
    result: list[dict] = []
    for item in sources:
        key = item.get("url") or f"{item.get('title')}|{item.get('snippet')}"
        if key in seen:
            continue
        seen.add(key)
        result.append(item)
    return result

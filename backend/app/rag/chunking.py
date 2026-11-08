"""Chunking: 把长文本切成可检索的小块。

[P0] 为什么必须切块：
1. **上下文长度有限**：一本 300 页的 PDF 塞不进 prompt
2. **检索要精准**：整篇文档只有一个向量，任何 query 都会命中它，等于没检索
3. **引用要精确**：Citation 要指向「第几页的哪一段」，整篇文档没法指

这里实现了 5 种策略，都是业界文档里能查到出处的主流做法（见 CHUNKER_OPTIONS）：

- fixed     固定窗口 + 软断句（LangChain CharacterTextSplitter 的思路）
- recursive 递归字符切分（RecursiveCharacterTextSplitter：先段落、再句子、最后硬切）
- sentence  句子窗口（按句边界装满一块，边界不从句子中间断）
- markdown  按标题层级切分（MarkdownHeaderTextSplitter：块带标题路径）
- semantic  语义切分（相邻句向量相似度跌到分位阈值以下就断开）

为什么需要 overlap：
严格按 800 字切断，正好落在句子中间时这个 chunk 语义不完整，跨边界的答案两边都
检索不到。重叠 120 字让边界信息在两侧都出现。语义切分不需要 overlap —— 它按语义
断点切，边界本来就是完整的句子。
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from app.rag.parsing import ParsedDocument

# 递归切分的分隔符优先级：段落 → 换行 → 句号 → 感叹/问号 → 分号 → 逗号 → 硬切
_RECURSIVE_SEPARATORS = ["\n\n", "\n", "。", "！", "？", "；", "，", " "]

_HEADING_RE = re.compile(r"^(#{1,6})\s+(.+?)\s*$", re.MULTILINE)
_SENTENCE_RE = re.compile(r"[^。！？!?；;\n]+[。！？!?；;]?")


@dataclass
class ChunkDraft:
    content: str
    page: int | None
    char_start: int | None
    char_end: int | None
    # Markdown 切分时记录的标题路径（"一级 › 二级"），检索结果里能看出这段属于哪一节
    heading: str | None = None


def estimate_tokens(text: str) -> int:
    """粗略估算 token 数：中文按 1 字 1 token，英文按 4 字符 1 token。"""
    chinese = sum(1 for char in text if "\u4e00" <= char <= "\u9fff")
    others = len(text) - chinese
    return chinese + others // 4


# ------------------------------------------------------------------ 基础工具


def split_sentences(text: str) -> list[tuple[str, int, int]]:
    """句级切分，返回 (句子, 起, 止)。不追求语言学正确，只要边界稳定。"""
    sentences: list[tuple[str, int, int]] = []
    for match in _SENTENCE_RE.finditer(text):
        raw = match.group(0)
        if not raw.strip():
            continue
        sentences.append((raw, match.start(), match.end()))
    return sentences


def _trim_span(text: str, start: int, end: int) -> tuple[int, int] | None:
    segment = text[start:end]
    left = len(segment) - len(segment.lstrip())
    right = len(segment.rstrip())
    if right <= left:
        return None
    return start + left, start + right


def _split_keep_separator(text: str, separator: str) -> list[tuple[int, int]]:
    """按分隔符切开，但把分隔符保留在前一段的末尾（保住原本的标点）。"""
    if not separator:
        return [(0, len(text))] if text else []
    spans: list[tuple[int, int]] = []
    start = 0
    for match in re.finditer(re.escape(separator), text):
        end = match.end()
        if end > start:
            spans.append((start, end))
        start = end
    if start < len(text):
        spans.append((start, len(text)))
    return spans


def _hard_split(length: int, size: int) -> list[tuple[int, int]]:
    return [(i, min(i + size, length)) for i in range(0, length, size)]


def _recursive_units(
    text: str,
    separators: list[str],
    size: int,
) -> list[tuple[int, int]]:
    """把文本递归拆成不超过 size 的原子片段（偏移相对 text）。"""
    if len(text) <= size:
        return [(0, len(text))] if text else []

    for index, separator in enumerate(separators):
        if separator and separator not in text:
            continue
        spans = _split_keep_separator(text, separator) if separator else []
        if len(spans) <= 1:
            continue
        units: list[tuple[int, int]] = []
        for start, end in spans:
            if end - start > size:
                units.extend(
                    (start + sub_start, start + sub_end)
                    for sub_start, sub_end in _recursive_units(
                        text[start:end], separators[index + 1 :], size
                    )
                )
            else:
                units.append((start, end))
        return units

    return _hard_split(len(text), size)


_BOUNDARY_CHARS = "。！？!?；;\n"


def _carry_start(text: str, start: int, end: int, overlap: int) -> int:
    """下一块该从哪开始：上一块尾部 overlap 字之内，向前吸附到句首。

    返回 end 表示「这块不带重叠」。只在能找到句末标点时回退，避免把
    下一块的开头切在句子中间 —— 带重叠是为了不丢边界信息，
    不是为了造出一个读不通的开头。
    """
    if overlap <= 0:
        return end
    target = max(end - overlap, start + 1)
    for index in range(target, end):
        if text[index - 1] in _BOUNDARY_CHARS:
            return index
    return end


def _merge_units(
    text: str,
    units: list[tuple[int, int]],
    size: int,
    overlap: int,
    min_chunk: int,
) -> list[tuple[int, int]]:
    """把原子片段贪心合并成块，相邻块共享一段 overlap 大小的重叠区。

    重叠记在 size 预算里：下一块从上一块尾部 overlap 字处起算，
    再往后装新片段直到装满 —— 于是「块不超过 chunk_size」和
    「相邻块有重叠」两条同时成立。重叠只能落在片段边界附近，
    一个 300 字的段落配 80 字重叠时不会把段落拦腰截断。
    """
    if not units:
        return []

    chunks: list[tuple[int, int]] = []
    start, end = units[0]
    for unit in units[1:]:
        if unit[1] - start <= size:
            end = unit[1]
            continue
        chunks.append((start, end))
        start = _carry_start(text, start, end, overlap)
        if unit[1] - start > size:
            # 重叠把预算吃光了：宁可少一段共享区，也不切出超长块
            start = unit[0]
        end = unit[1]
    chunks.append((start, end))

    if min_chunk > 0 and len(chunks) > 1:
        merged: list[tuple[int, int]] = []
        for span in chunks:
            if merged and span[1] - span[0] < min_chunk:
                merged[-1] = (merged[-1][0], span[1])
            else:
                merged.append(span)
        chunks = merged

    return chunks


def _spans_to_drafts(
    text: str,
    spans: list[tuple[int, int]],
    *,
    page: int | None = None,
    offset: int = 0,
    heading: str | None = None,
) -> list[ChunkDraft]:
    drafts: list[ChunkDraft] = []
    for start, end in spans:
        trimmed = _trim_span(text, start, end)
        if trimmed is None:
            continue
        real_start, real_end = trimmed
        drafts.append(
            ChunkDraft(
                content=text[real_start:real_end],
                page=page,
                char_start=offset + real_start,
                char_end=offset + real_end,
                heading=heading,
            )
        )
    return drafts


# ------------------------------------------------------------------ 各策略


def chunk_text(text: str, chunk_size: int, overlap: int) -> list[ChunkDraft]:
    """固定窗口切分（带软断句），用于 Markdown / TXT。

    保留这个名字是因为它是最早的入口，测试与文档都引用它。
    """
    return chunk_fixed(text, chunk_size, overlap)


def chunk_fixed(text: str, chunk_size: int, overlap: int) -> list[ChunkDraft]:
    """固定窗口 + 软断句：尽量在句号/换行处收尾，避免把句子切断。"""
    if not text.strip():
        return []

    spans: list[tuple[int, int]] = []
    start = 0
    length = len(text)
    while start < length:
        end = min(start + chunk_size, length)
        if end < length:
            for pivot in range(end, start + chunk_size // 2, -1):
                if text[pivot - 1] in "。！？\n":
                    end = pivot
                    break
        spans.append((start, end))
        if end >= length:
            break
        start = max(end - overlap, start + 1)

    return _spans_to_drafts(text, spans)


def chunk_recursive(
    text: str,
    chunk_size: int,
    overlap: int,
    min_chunk: int = 0,
) -> list[ChunkDraft]:
    """递归字符切分：按分隔符优先级逐级下切，再合并成块。"""
    if not text.strip():
        return []
    units = _recursive_units(text, _RECURSIVE_SEPARATORS, chunk_size)
    spans = _merge_units(text, units, chunk_size, overlap, min_chunk)
    return _spans_to_drafts(text, spans)


def chunk_sentence(
    text: str, chunk_size: int, overlap: int, min_chunk: int = 0
) -> list[ChunkDraft]:
    """句子窗口：以整句为最小单位装满一块，边界永远落在句号后。"""
    if not text.strip():
        return []
    sentences = split_sentences(text)
    if not sentences:
        return chunk_recursive(text, chunk_size, overlap, min_chunk)

    spans = _merge_units(
        text,
        [(start, end) for _, start, end in sentences],
        chunk_size,
        overlap,
        min_chunk,
    )
    return _spans_to_drafts(text, spans)


def chunk_markdown(
    text: str,
    chunk_size: int,
    overlap: int,
    min_chunk: int = 0,
    keep_heading: bool = True,
) -> list[ChunkDraft]:
    """按 Markdown 标题层级切分，块上带标题路径。"""
    if not text.strip():
        return []

    headings = [
        (match.start(), len(match.group(1)), match.group(2).strip())
        for match in _HEADING_RE.finditer(text)
    ]
    if not headings:
        return chunk_recursive(text, chunk_size, overlap, min_chunk)

    drafts: list[ChunkDraft] = []
    stack: list[tuple[int, str]] = []
    for index, (position, level, title) in enumerate(headings):
        while stack and stack[-1][0] >= level:
            stack.pop()
        stack.append((level, title))
        path = " › ".join(item[1] for item in stack)

        section_end = headings[index + 1][0] if index + 1 < len(headings) else len(text)
        section = text[position:section_end]
        body_start = position + len(section) - len(section.lstrip("\n"))
        if not keep_heading:
            # 跳过标题行本身
            newline = section.find("\n")
            body_start = position + (newline + 1 if newline >= 0 else len(section))

        for span_start, span_end in _merge_units(
            # 传这一节的切片而不是整篇：块偏移是相对 body_start 的，
            # 吸附句首要在同一套坐标系里找标点，否则会读错位置
            text[body_start:section_end],
            _recursive_units(text[body_start:section_end], _RECURSIVE_SEPARATORS, chunk_size),
            chunk_size,
            overlap,
            min_chunk,
        ):
            trimmed = _trim_span(text, body_start + span_start, body_start + span_end)
            if trimmed is None:
                continue
            drafts.append(
                ChunkDraft(
                    content=text[trimmed[0] : trimmed[1]],
                    page=None,
                    char_start=trimmed[0],
                    char_end=trimmed[1],
                    heading=path,
                )
            )
    return drafts


def semantic_breakpoints(
    similarities: list[float],
    percentile: float,
) -> list[int]:
    """相似度序列里该断开的句间位置（返回句子下标，表示「在这一句之前断开」）。

    ⚠️ 判据是**跌幅**而不是相似度本身：
    只把所有边界按相似度排序、取最低的那一档，在短文档上会切得极碎
    （中文段落里相邻句相似度普遍 0.6~0.8，最低的 10% 也有 0.6）。
    真正有信息的是「相对前一个边界，这里掉了多少」—— 段落结束处会突然掉一截，
    段内句子之间几乎持平。所以算 `1 - sim` 的分布，只在跌幅最大的
    那 (1 - percentile) 部分断开。
    """
    if not similarities:
        return []
    import numpy as np

    distances = [1.0 - score for score in similarities]
    threshold = float(np.quantile(distances, max(0.0, min(percentile, 1.0))))
    if threshold <= 1e-6:
        # 全文相似度几乎不变（同一段话反复出现）：没有可信的断点，交回按大小切
        return []
    return [index + 1 for index, distance in enumerate(distances) if distance > threshold]


def chunk_semantic(
    text: str,
    sentence_vectors: list[list[float]],
    chunk_size: int,
    breakpoint_percentile: float = 0.9,
    min_chunk: int = 0,
) -> list[ChunkDraft]:
    """语义切分：相邻句向量相似度低于分位阈值处断开，再按大小上限二次切分。

    sentence_vectors 由调用方先用**同一个** embedding 模型算好 ——
    切块这一步本身不联网，它只是拿相似度做断点判断。
    """
    if not text.strip():
        return []
    sentences = split_sentences(text)
    if len(sentences) <= 2 or len(sentence_vectors) != len(sentences):
        return chunk_fixed(text, chunk_size, 0)

    import numpy as np

    matrix = np.asarray(sentence_vectors, dtype=np.float32)
    norms = np.linalg.norm(matrix, axis=1, keepdims=True)
    matrix = matrix / np.where(norms == 0, 1, norms)
    similarities = (matrix[:-1] * matrix[1:]).sum(axis=1).tolist()

    breaks = set(semantic_breakpoints(similarities, breakpoint_percentile))
    groups: list[tuple[int, int]] = []
    start_index = 0
    for index in range(1, len(sentences)):
        if index in breaks:
            groups.append((sentences[start_index][1], sentences[index - 1][2]))
            start_index = index
    groups.append((sentences[start_index][1], sentences[-1][2]))

    # 语义组可能只有一句话（十几个字）：并在相邻组里，否则会产出一堆
    # 「检索得到但读不懂」的碎片。只在低于最小块大小时合并，不跨越正常断点。
    if min_chunk > 0 and len(groups) > 1:
        merged_groups = [groups[0]]
        for span in groups[1:]:
            if merged_groups[-1][1] - merged_groups[-1][0] < min_chunk:
                merged_groups[-1] = (merged_groups[-1][0], span[1])
            else:
                merged_groups.append(span)
        groups = merged_groups

    drafts: list[ChunkDraft] = []
    for start, end in groups:
        span = end - start
        if span <= chunk_size:
            drafts.extend(_spans_to_drafts(text, [(start, end)]))
            continue
        # 语义组超过上限：内部再递归切，避免出现一个超大块
        for sub_start, sub_end in _merge_units(
            text[start:end],
            _recursive_units(text[start:end], _RECURSIVE_SEPARATORS, chunk_size),
            chunk_size,
            0,
            min_chunk,
        ):
            drafts.extend(_spans_to_drafts(text, [(start + sub_start, start + sub_end)]))
    return drafts


# ------------------------------------------------------------------ 统一入口


def chunk_document(
    parsed: ParsedDocument,
    *,
    strategy: str = "recursive",
    chunk_size: int = 800,
    overlap: int = 120,
    min_chunk: int = 0,
    keep_heading: bool = True,
    breakpoint_percentile: float = 0.9,
    sentence_vectors: dict[int, list[list[float]]] | None = None,
) -> list[ChunkDraft]:
    """按策略切一份文档。

    PDF 逐页切（保留页码），文本类整篇切。语义切分需要的句向量由
    `sentence_vectors` 按页下标传入（无页码时 key 为 0）。
    """
    pages = parsed.pages
    if pages is None:
        return _chunk_single(
            parsed.text,
            strategy=strategy,
            chunk_size=chunk_size,
            overlap=overlap,
            min_chunk=min_chunk,
            keep_heading=keep_heading,
            breakpoint_percentile=breakpoint_percentile,
            sentence_vectors=(sentence_vectors or {}).get(0),
        )

    drafts: list[ChunkDraft] = []
    offset = 0
    for page_index, page_text in enumerate(pages, start=1):
        if page_text.strip():
            page_drafts = _chunk_single(
                page_text,
                strategy=strategy,
                chunk_size=chunk_size,
                overlap=overlap,
                min_chunk=min_chunk,
                keep_heading=keep_heading,
                breakpoint_percentile=breakpoint_percentile,
                sentence_vectors=(sentence_vectors or {}).get(page_index),
            )
            for draft in page_drafts:
                drafts.append(
                    ChunkDraft(
                        content=draft.content,
                        page=page_index,
                        char_start=offset + (draft.char_start or 0),
                        char_end=offset + (draft.char_end or 0),
                        heading=draft.heading,
                    )
                )
        offset += len(page_text) + 2  # +2 是拼接页时加的 \n\n

    return drafts


def _chunk_single(
    text: str,
    *,
    strategy: str,
    chunk_size: int,
    overlap: int,
    min_chunk: int,
    keep_heading: bool,
    breakpoint_percentile: float,
    sentence_vectors: list[list[float]] | None,
) -> list[ChunkDraft]:
    if strategy == "fixed":
        return chunk_fixed(text, chunk_size, overlap)
    if strategy == "sentence":
        return chunk_sentence(text, chunk_size, overlap, min_chunk)
    if strategy == "markdown":
        return chunk_markdown(text, chunk_size, overlap, min_chunk, keep_heading)
    if strategy == "semantic":
        return chunk_semantic(
            text,
            sentence_vectors or [],
            chunk_size,
            breakpoint_percentile,
            min_chunk,
        )
    return chunk_recursive(text, chunk_size, overlap, min_chunk)


def chunk_parsed_document(
    parsed: ParsedDocument,
    chunk_size: int,
    overlap: int,
) -> list[ChunkDraft]:
    """兼容旧调用方的入口（默认递归切分）。"""
    return chunk_document(parsed, strategy="recursive", chunk_size=chunk_size, overlap=overlap)


# ------------------------------------------------------------------ 选项元数据

# 前端「切块方法」下拉的唯一数据源：说明、官方文档、需要哪些参数。
CHUNKER_OPTIONS: list[dict] = [
    {
        "id": "recursive",
        "label": "递归字符切分",
        "summary": "先按段落切，段落太大再按句子切，最后才硬切——实际效果最稳的默认选择。",
        "doc_label": "LangChain · RecursiveCharacterTextSplitter",
        "doc_url": "https://python.langchain.com/docs/how_to/recursive_text_splitter/",
        "params": ["chunk_size", "overlap", "min_chunk"],
        "needs_embedding": False,
        "best_for": "结构不规整的长文（论文正文、网页正文、会议记录）",
    },
    {
        "id": "fixed",
        "label": "固定窗口切分",
        "summary": "每块固定字数，只在句号/换行处做一次软断句。最简单、可预测。",
        "doc_label": "LangChain · CharacterTextSplitter",
        "doc_url": "https://python.langchain.com/api_reference/text_splitters/character/langchain_text_splitters.character.CharacterTextSplitter.html",
        "params": ["chunk_size", "overlap"],
        "needs_embedding": False,
        "best_for": "格式统一的文本（日志、字幕、规整的说明文档）",
    },
    {
        "id": "sentence",
        "label": "句子窗口切分",
        "summary": "按句子装满一块，重叠按整句回退，绝不会从句号中间断开。",
        "doc_label": "LlamaIndex · SentenceWindowNodeParser",
        "doc_url": "https://docs.llamaindex.ai/en/stable/examples/node_postprocessor/MetadataReplacementDemo/",
        "params": ["chunk_size", "overlap", "min_chunk"],
        "needs_embedding": False,
        "best_for": "问答型资料，答案通常就是一两句完整的话",
    },
    {
        "id": "markdown",
        "label": "Markdown 标题切分",
        "summary": "按 # / ## / ### 的层级切，每块带上「一级 › 二级」标题路径。",
        "doc_label": "LangChain · MarkdownHeaderTextSplitter",
        "doc_url": "https://python.langchain.com/docs/how_to/markdown_header_metadata_splitter/",
        "params": ["chunk_size", "overlap", "min_chunk", "keep_heading"],
        "needs_embedding": False,
        "best_for": "结构化文档：README、规范、手册、Wiki",
    },
    {
        "id": "semantic",
        "label": "语义切分（向量断点）",
        "summary": "先算相邻句子的向量相似度，相似度掉到分位阈值以下就断开——按意思切而不是按字数。",
        "doc_label": "LangChain · SemanticChunker",
        "doc_url": "https://python.langchain.com/docs/how_to/semantic-chunker/",
        "params": ["chunk_size", "breakpoint_percentile", "min_chunk"],
        "needs_embedding": True,
        "best_for": "话题跳跃多的长文（访谈、多主题报告）",
    },
]

"""RAG 流水线的可观测执行器：每一步的输入、输出、耗时都摊开返回。

[P0] 为什么要有这个模块（而不是直接复用 KnowledgeService.search）：
知识库检索是「黑盒取 top-k」，返回的只有最终那几条。而理解 RAG 需要的恰恰是
**中间过程**：这段文字为什么被切在这里、两块的边界重叠了多少字、向量在空间里
长什么样、BM25 排第一的那条为什么被混合检索挤到第三。

所以这里把管线拆成五步，每步都产出可渲染的结构：

    parse → chunk → embed → index → retrieve

它**不写库**（除了可选地读取知识库文档的原文），是一台「实验台」：
换一种切法、换一个向量模型、换一种检索方式，立刻能看到差异。

到检索为止，**不接大模型**：RAG 的前半段是「建索引 + 找回证据」，这一段可以
完全离线跑通、也完全可测量；把召回结果拼成 prompt 交给模型生成是另一半的事，
混在一起会让「检索没召回」和「模型没答好」这两类问题分不开。
"""

from __future__ import annotations

import json
import logging
import time
from pathlib import Path
from typing import Any

import numpy as np

from app.core.config import get_settings
from app.rag.chunking import (
    CHUNKER_OPTIONS,
    chunk_document,
    estimate_tokens,
    split_sentences,
)
from app.rag.embeddings import (
    EmbeddingProvider,
    get_provider,
    get_provider_by_id,
)
from app.rag.parsing import ParsedDocument
from app.rag.retrieval import (
    RETRIEVER_OPTIONS,
    RetrievalIndex,
    build_index,
    search,
)
from app.rag.store import new_id

logger = logging.getLogger(__name__)

# 文本预览上限：超过就不回传全文（前端只画色带，不需要几十万字符）
TEXT_PREVIEW_LIMIT = 20_000
# 热力图最多画多少行（payload 控制）
HEATMAP_ROWS = 40
HEATMAP_DIMS = 16
# 落盘索引保留最近几份（实验台产物，没必要长期堆积）
INDEX_KEEP = 5


def _alpha(retrieval: dict[str, Any]) -> float:
    value = retrieval.get("alpha")
    return float(0.6 if value is None else value)


def _ms(start: float) -> float:
    return round((time.perf_counter() - start) * 1000, 1)


async def run_pipeline(
    *,
    query: str,
    parsed: ParsedDocument,
    title: str,
    chunking: dict[str, Any],
    embedder_id: str | None,
    retrieval: dict[str, Any],
) -> dict[str, Any]:
    """跑一次完整 RAG，返回每步的产物。异常由调用方翻译成业务错误。"""
    settings = get_settings()
    started = time.perf_counter()
    run_id = new_id("rag")
    stages: list[dict[str, Any]] = []
    warnings: list[str] = []

    provider: EmbeddingProvider = (
        get_provider_by_id(embedder_id) if embedder_id else get_provider(None)
    )
    strategy = str(chunking.get("strategy") or "recursive")
    chunk_size = int(chunking.get("chunk_size") or settings.chunk_size)
    overlap = int(chunking.get("overlap") or 0)
    min_chunk = int(chunking.get("min_chunk") or 0)
    keep_heading = bool(chunking.get("keep_heading", True))
    percentile = float(chunking.get("breakpoint_percentile") or 0.9)

    # ---------- 1. 解析 ----------
    stage_start = time.perf_counter()
    text = parsed.text or ""
    if not text.strip():
        raise ValueError("这份材料没有可用的文本内容")
    paragraphs = [p for p in text.split("\n\n") if p.strip()]
    parse_payload = {
        "chars": len(text),
        "paragraphs": len(paragraphs),
        "pages": parsed.page_count,
        "sentences": len(split_sentences(text)),
        "preview": text[:TEXT_PREVIEW_LIMIT],
        "truncated": len(text) > TEXT_PREVIEW_LIMIT,
        "title": title,
    }
    stages.append(
        {
            "key": "parse",
            "label": "解析",
            "ms": _ms(stage_start),
            "summary": f"{len(text):,} 字 · {len(paragraphs)} 段",
            "detail": parse_payload,
        }
    )

    # ---------- 2. 切块 ----------
    stage_start = time.perf_counter()
    sentence_vectors: dict[int, list[list[float]]] | None = None
    if strategy == "semantic":
        sentence_vectors = await _embed_sentences(parsed, provider)
        if not provider.spec.semantic:
            warnings.append("语义切分当前用的是哈希向量，断点质量会明显下降")

    drafts = chunk_document(
        parsed,
        strategy=strategy,
        chunk_size=chunk_size,
        overlap=overlap,
        min_chunk=min_chunk,
        keep_heading=keep_heading,
        breakpoint_percentile=percentile,
        sentence_vectors=sentence_vectors,
    )
    if not drafts:
        raise ValueError("按当前参数切不出任何块，试试调小「块大小」或换一种切块方式")

    if len(drafts) > settings.rag_lab_max_chunks:
        warnings.append(
            f"切出 {len(drafts)} 块，只保留前 {settings.rag_lab_max_chunks} 块做演示"
        )
        drafts = drafts[: settings.rag_lab_max_chunks]

    chunk_rows = [
        {
            "index": index,
            "content": draft.content,
            "preview": draft.content[:220],
            "chars": len(draft.content),
            "tokens": estimate_tokens(draft.content),
            "char_start": draft.char_start,
            "char_end": draft.char_end,
            "page": draft.page,
            "heading": draft.heading,
        }
        for index, draft in enumerate(drafts)
    ]
    overlaps = _overlap_pairs(chunk_rows)
    chunk_payload = {
        "strategy": strategy,
        "chunks": chunk_rows,
        "overlaps": overlaps,
        "avg_chars": round(sum(row["chars"] for row in chunk_rows) / len(chunk_rows), 1),
        "avg_tokens": round(sum(row["tokens"] for row in chunk_rows) / len(chunk_rows), 1),
        "total_tokens": sum(row["tokens"] for row in chunk_rows),
        "used_embedding_for_split": strategy == "semantic",
    }
    stages.append(
        {
            "key": "chunk",
            "label": "切块",
            "ms": _ms(stage_start),
            "summary": f"{len(chunk_rows)} 块 · 平均 {chunk_payload['avg_chars']} 字",
            "detail": chunk_payload,
        }
    )

    # ---------- 3. 向量化 ----------
    stage_start = time.perf_counter()
    vectors = await provider.embed([row["content"] for row in chunk_rows])
    if len(vectors) != len(chunk_rows):
        raise ValueError("向量数量与块数量不一致")
    matrix = np.asarray(vectors, dtype=np.float32)
    norms = np.linalg.norm(matrix, axis=1)
    dims = int(matrix.shape[1])

    query_vector = (await provider.embed([query]))[0]
    projection, query_point, explained = _project(vectors, query_vector)

    embed_payload = {
        "spec_id": provider.spec.id,
        "label": provider.spec.label,
        "model": provider.spec.model,
        "semantic": provider.spec.semantic,
        "dims": dims,
        "count": len(vectors),
        "stats": {
            "norm_min": round(float(norms.min()), 3) if len(norms) else 0,
            "norm_max": round(float(norms.max()), 3) if len(norms) else 0,
            "norm_mean": round(float(norms.mean()), 3) if len(norms) else 0,
            "value_min": round(float(matrix.min()), 3) if matrix.size else 0,
            "value_max": round(float(matrix.max()), 3) if matrix.size else 0,
        },
        "heatmap": _heatmap(matrix),
        "projection": projection,
        "query_point": query_point,
        "explained": explained,
        "query_preview": [round(float(v), 4) for v in query_vector[:HEATMAP_DIMS]],
    }
    stages.append(
        {
            "key": "embed",
            "label": "向量化",
            "ms": _ms(stage_start),
            "summary": f"{len(vectors)} × {dims} 维 · {provider.spec.model}",
            "detail": embed_payload,
        }
    )

    # ---------- 4. 建索引 ----------
    # 向量化产出的是「一堆数字」，检索要的是「能查的结构」。这一 步把两者之间的
    # 落差补齐：归一化向量矩阵（检索时余弦 = 一次点积）、BM25 倒排表（词 → 块号），
    # 并落一份到磁盘 —— 索引本来就该是离线的、可复用的，而不是每次查询重算。
    stage_start = time.perf_counter()
    texts = [row["content"] for row in chunk_rows]
    index = build_index(texts, vectors)
    files = _persist_index(index, run_id)
    stage_ms = _ms(stage_start)
    index_payload = {
        "kind": "flat",
        "count": index.count,
        "dims": index.dims,
        "terms": len(index.postings),
        "postings": index.posting_count,
        "avg_tokens": round(index.avg_len, 1),
        "vector_bytes": index.vector_bytes,
        "term_bytes": index.term_bytes,
        "total_bytes": index.vector_bytes + index.term_bytes,
        "build_ms": index.build_ms,
        "store_ms": round(max(0.0, stage_ms - index.build_ms), 1),
        "sample": index.sample_terms(),
        "files": files,
        "kept": INDEX_KEEP,
    }
    stages.append(
        {
            "key": "index",
            "label": "建索引",
            "ms": stage_ms,
            "summary": f"{index.count} 条向量 · 词表 {len(index.postings):,} · {_kb(index.vector_bytes + index.term_bytes)}",
            "detail": index_payload,
        }
    )

    # ---------- 5. 检索 ----------
    stage_start = time.perf_counter()
    outcome = search(
        index,
        texts=texts,
        query=query,
        query_vector=query_vector,
        method=str(retrieval.get("method") or "hybrid_rrf"),
        top_k=int(retrieval.get("top_k") or settings.retrieval_top_k),
        candidate_k=int(retrieval.get("candidate_k") or 20),
        rrf_k=int(retrieval.get("rrf_k") or 60),
        alpha=_alpha(retrieval),
        mmr_lambda=float(retrieval.get("mmr_lambda") or 0.7),
        min_score=float(retrieval.get("min_score") or 0),
    )
    for hit in [*outcome.selected, *outcome.candidates]:
        chunk = chunk_rows[hit["index"]]
        hit["heading"] = chunk["heading"]
        hit["page"] = chunk["page"]
        if hit["selected"]:
            hit["content"] = chunk["content"]

    retrieve_payload = {
        "method": outcome.method,
        "selected": outcome.selected,
        "candidates": outcome.candidates,
        "meta": outcome.meta,
    }
    stages.append(
        {
            "key": "retrieve",
            "label": "检索",
            "ms": _ms(stage_start),
            "summary": f"{outcome.method} · 命中 {len(outcome.selected)} 条",
            "detail": retrieve_payload,
        }
    )

    if not provider.spec.semantic:
        warnings.append(
            "当前向量模型是哈希兜底：能跑通流程，但「换个说法也能找到」的能力不存在"
        )

    return {
        "run_id": run_id,
        "query": query,
        "title": title,
        "config": {
            "chunking": {
                "strategy": strategy,
                "chunk_size": chunk_size,
                "overlap": overlap,
                "min_chunk": min_chunk,
                "keep_heading": keep_heading,
                "breakpoint_percentile": percentile,
            },
            "embedding": {
                "spec_id": provider.spec.id,
                "model": provider.spec.model,
                "label": provider.spec.label,
                "semantic": provider.spec.semantic,
                "dims": dims,
            },
            "retrieval": {
                "method": outcome.method,
                "top_k": int(retrieval.get("top_k") or settings.retrieval_top_k),
                "candidate_k": int(retrieval.get("candidate_k") or 20),
                "rrf_k": int(retrieval.get("rrf_k") or 60),
                "alpha": _alpha(retrieval),
                "mmr_lambda": float(retrieval.get("mmr_lambda") or 0.7),
                "min_score": float(retrieval.get("min_score") or 0),
            },
        },
        "stages": stages,
        "warnings": warnings,
        "total_ms": _ms(started),
    }


# ------------------------------------------------------------------ 辅助


def _overlap_pairs(rows: list[dict]) -> list[dict]:
    """相邻块之间的重叠区间，用于在色带上画出「这两块有 N 字是重复的」。"""
    pairs: list[dict] = []
    for left, right in zip(rows, rows[1:], strict=False):
        if left["char_end"] is None or right["char_start"] is None:
            continue
        shared = left["char_end"] - right["char_start"]
        if shared > 0:
            pairs.append(
                {
                    "left": left["index"],
                    "right": right["index"],
                    "chars": shared,
                    "start": right["char_start"],
                    "end": left["char_end"],
                }
            )
    return pairs


async def _embed_sentences(
    parsed: ParsedDocument,
    provider: EmbeddingProvider,
) -> dict[int, list[list[float]]]:
    """按页把句子向量算好（语义切分用）。key 与 chunk_document 的页下标一致。"""
    pages = parsed.pages if parsed.pages is not None else [parsed.text]
    result: dict[int, list[list[float]]] = {}
    for page_index, page_text in enumerate(pages, start=1 if parsed.pages is not None else 0):
        sentences = split_sentences(page_text)
        if not sentences:
            result[page_index] = []
            continue
        result[page_index] = await provider.embed([item[0] for item in sentences])
    return result


def _heatmap(matrix: np.ndarray) -> dict:
    """取前若干维做色块图。用全局最大绝对值归一化，颜色之间才可比。"""
    rows = min(HEATMAP_ROWS, matrix.shape[0])
    dims = min(HEATMAP_DIMS, matrix.shape[1])
    block = matrix[:rows, :dims]
    scale = float(np.abs(block).max()) if block.size else 1.0
    scale = scale or 1.0
    return {
        "rows": rows,
        "cols": dims,
        "values": [[round(float(value) / scale, 3) for value in row] for row in block],
        "scale": round(scale, 4),
        "total_chunks": int(matrix.shape[0]),
    }


def _project(
    vectors: list[list[float]],
    query_vector: list[float],
) -> tuple[list[dict], dict | None, list[float]]:
    """PCA 降维到三维：让人能看见「问题落在向量空间的哪一片」。

    用 SVD 而不是随机投影 —— 样本就是这几十个块，SVD 的代价可以忽略，
    而且前三个主成分的顺序稳定，同一个语料每次画出来的位置一致。
    取第三维不是为了好看：二维投影里两块叠在一起时，拉开第三个方向才分得清前后。

    同时返回三个轴各自解释的方差占比 —— 合计通常远小于 1，这个数字本身就是信息：
    它说明 2048 维里有大量长尾，摊在三个方向上的只是一部分。
    """
    matrix = np.asarray(vectors, dtype=np.float32)
    if matrix.ndim != 2 or matrix.shape[0] == 0:
        return [], None, []

    mean = matrix.mean(axis=0)
    centered = matrix - mean
    try:
        left, singular, right = np.linalg.svd(centered, full_matrices=False)
    except np.linalg.LinAlgError:  # pragma: no cover - 数值极端情况
        return (
            [{"x": 0.0, "y": 0.0, "z": 0.0, "index": i} for i in range(matrix.shape[0])],
            None,
            [],
        )

    coords = left[:, :3] * singular[:3]
    if coords.shape[1] < 3:  # 块数不足三个时没有第三主成分
        coords = np.pad(coords, ((0, 0), (0, 3 - coords.shape[1])))

    points = [
        {
            "x": round(float(coords[i, 0]), 4),
            "y": round(float(coords[i, 1]), 4),
            "z": round(float(coords[i, 2]), 4),
            "index": i,
        }
        for i in range(coords.shape[0])
    ]

    query_point = None
    if right.shape[0] >= 1:
        components = right[:3]
        projected = (np.asarray(query_vector, dtype=np.float32) - mean) @ components.T
        if len(projected) < 3:
            projected = np.pad(projected, (0, 3 - len(projected)))
        query_point = {
            "x": round(float(projected[0]), 4),
            "y": round(float(projected[1]), 4),
            "z": round(float(projected[2]), 4),
        }
    return points, query_point, _explained(singular)


def _explained(singular: np.ndarray) -> list[float]:
    """前三个主成分各解释了多少方差（占比），不足三维补 0。"""
    power = np.square(singular.astype(np.float64))
    total = float(power.sum())
    if total <= 0:  # 所有块向量完全相同，没有可解释的方差
        return [0.0, 0.0, 0.0]
    ratios = [float(value) for value in (power[:3] / total)]
    ratios += [0.0] * (3 - len(ratios))
    return [round(value, 4) for value in ratios]


def _index_root() -> Path:
    """索引落盘目录：与 documents 同级，仍在部署目录之外的 data/ 下。"""
    return Path(get_settings().storage_dir).parent / "rag_index"


def _kb(size: int) -> str:
    if size >= 1024 * 1024:
        return f"{size / 1024 / 1024:.1f} MB"
    if size >= 1024:
        return f"{size / 1024:.0f} KB"
    return f"{size} B"


def _persist_index(index: RetrievalIndex, run_id: str) -> list[dict]:
    """把索引写一份到磁盘，返回文件清单。

    为什么实验台也要落盘：检索阶段的输入应该是一份**已建好的**索引，而不是
    内存里那个临时数组 —— 这正是向量库（pgvector / Milvus / FAISS）在做的事。
    落盘失败不影响检索（只读文件系统上照样能跑），所以这里兜住 OSError。
    """
    target = _index_root() / run_id
    try:
        target.mkdir(parents=True, exist_ok=True)
        vectors_path = target / "vectors.f32"
        index.unit.astype(np.float32).tofile(vectors_path)
        lexicon_path = target / "lexicon.json"
        lexicon_path.write_text(
            json.dumps(
                {
                    "shape": [index.count, index.dims],
                    "dtype": "float32",
                    "normalized": True,
                    "avg_tokens": round(index.avg_len, 2),
                    "postings": {term: sorted(rows.items()) for term, rows in index.postings.items()},
                },
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )
        _prune_indexes(target.parent)
        return [
            {"name": vectors_path.name, "role": "归一化向量", "bytes": vectors_path.stat().st_size},
            {"name": lexicon_path.name, "role": "倒排表", "bytes": lexicon_path.stat().st_size},
        ]
    except OSError as error:  # pragma: no cover - 只读文件系统
        logger.warning("索引落盘失败：%s", error)
        return []


def _prune_indexes(root: Path, keep: int = INDEX_KEEP) -> None:
    """只留最近几份：实验台的索引是演示产物，没必要长期堆积。"""
    try:
        candidates = sorted(
            (path for path in root.iterdir() if path.is_dir()),
            key=lambda path: path.stat().st_mtime,
            reverse=True,
        )
    except OSError:  # pragma: no cover
        return
    for stale in candidates[keep:]:
        try:
            for child in stale.glob("*"):
                child.unlink(missing_ok=True)
            stale.rmdir()
        except OSError:  # pragma: no cover
            logger.debug("清理旧索引失败：%s", stale)


def build_options() -> dict[str, Any]:
    """给前端的「方法可选清单」。"""
    from app.rag.embeddings import available_spec_ids, discover_embedders
    from app.rag.options import PARAM_OPTIONS

    reachable = available_spec_ids()
    embedders = [
        {**spec.public(), "available": spec.id in reachable, "recommended": index == 0}
        for index, spec in enumerate(discover_embedders())
    ]
    return {
        "chunkers": CHUNKER_OPTIONS,
        "embedders": embedders,
        "retrievers": RETRIEVER_OPTIONS,
        "params": PARAM_OPTIONS,
        "defaults": {
            "chunking": {"strategy": "recursive", "chunk_size": 400, "overlap": 80},
            "retrieval": {"method": "hybrid_rrf", "top_k": 5, "candidate_k": 20},
        },
    }

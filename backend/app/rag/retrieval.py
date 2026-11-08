"""Retrieval strategies: 稠密向量 / BM25 / 混合 / MMR。

[P0] 为什么要不止一种检索：
- 稠密（向量余弦）擅长「换个说法也能找到」，但对专有名词、型号、编号不敏感 ——
  「RTX 4090 的显存」里那个数字，向量模型经常糊掉，BM25 一查就有。
- BM25 擅长精确词命中，但用户换个说法就完全找不到。
两者互补，所以工业界默认是混合检索，再用 RRF 或加权把两份排名合起来。

五种方法（都能在公开文档里查到出处，见 RETRIEVER_OPTIONS）：

- dense           余弦相似度 top-k
- bm25            Okapi BM25（k1=1.5, b=0.75），中文按 bigram 建索引
- hybrid_rrf      倒数排名融合（RRF, k=60）—— 只看名次，不看分数量纲，最省心
- hybrid_weighted 分数归一化后加权（alpha 控制稠密权重）
- mmr             最大边际相关性：在相关性之外惩罚「和已选块太像」的块

MMR 与 hybrid 的区别：hybrid 解决「怎么找到」，MMR 解决「找回来的一堆是不是重复的」。
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

import numpy as np

_WORD_RE = re.compile(r"[A-Za-z0-9_]+")
_CJK_RE = re.compile(r"[\u4e00-\u9fff]")


def bm25_tokens(text: str) -> list[str]:
    """BM25 的分词：英文/数字按词，中文按相邻二字（bigram）。

    中文为什么要 bigram：没有分词词典时，单字会让「向量」和「数量」共享一个「量」，
    噪声极大；bigram 只多一倍索引量，但把「向量」「检索」这类词保留下来了。
    """
    tokens: list[str] = []
    buffer = ""
    cjk_run: list[str] = []
    for char in text:
        if _CJK_RE.match(char):
            if buffer:
                tokens.extend(w.lower() for w in _WORD_RE.findall(buffer))
                buffer = ""
            cjk_run.append(char)
        else:
            if len(cjk_run) >= 2:
                tokens.extend(a + b for a, b in zip(cjk_run, cjk_run[1:], strict=False))
            elif cjk_run:
                tokens.append(cjk_run[0])
            cjk_run = []
            buffer += char
    if buffer:
        tokens.extend(w.lower() for w in _WORD_RE.findall(buffer))
    if len(cjk_run) >= 2:
        tokens.extend(a + b for a, b in zip(cjk_run, cjk_run[1:], strict=False))
    elif cjk_run:
        tokens.append(cjk_run[0])
    return tokens


def bm25_scores(
    query_tokens: list[str],
    doc_tokens: list[list[str]],
    *,
    k1: float = 1.5,
    b: float = 0.75,
) -> np.ndarray:
    """标准 Okapi BM25。返回每个文档一个分数。"""
    n_docs = len(doc_tokens)
    if n_docs == 0 or not query_tokens:
        return np.zeros(n_docs, dtype=np.float32)

    lengths = np.asarray([len(tokens) for tokens in doc_tokens], dtype=np.float32)
    avg_len = float(lengths.mean()) or 1.0

    scores = np.zeros(n_docs, dtype=np.float32)
    for term in set(query_tokens):
        df = sum(1 for tokens in doc_tokens if term in tokens)
        if df == 0:
            continue
        idf = float(np.log(1.0 + (n_docs - df + 0.5) / (df + 0.5)))
        for index, tokens in enumerate(doc_tokens):
            tf = tokens.count(term)
            if tf == 0:
                continue
            denom = tf + k1 * (1 - b + b * lengths[index] / avg_len)
            scores[index] += idf * (tf * (k1 + 1)) / denom
    return scores


def cosine_matrix(vectors: np.ndarray) -> np.ndarray:
    """行归一化。归一化后余弦相似度就是点积。"""
    norms = np.linalg.norm(vectors, axis=1, keepdims=True)
    return vectors / np.where(norms == 0, 1, norms)


def _normalize(scores: np.ndarray) -> np.ndarray:
    low, high = float(scores.min()), float(scores.max())
    if high - low < 1e-9:
        return np.zeros_like(scores)
    return (scores - low) / (high - low)


def _ranks(scores: np.ndarray) -> np.ndarray:
    """名次从 1 开始（分数越高名次越小）。"""
    order = np.argsort(-scores)
    ranks = np.empty(len(scores), dtype=np.int32)
    ranks[order] = np.arange(1, len(scores) + 1)
    return ranks


@dataclass
class RetrievalOutcome:
    """检索结果：选中的命中 + 全部候选的分数明细（给可视化用）。"""

    method: str
    selected: list[dict] = field(default_factory=list)
    candidates: list[dict] = field(default_factory=list)
    meta: dict = field(default_factory=dict)


def retrieve(
    *,
    texts: list[str],
    vectors: list[list[float]],
    query: str,
    query_vector: list[float],
    method: str,
    top_k: int,
    candidate_k: int,
    rrf_k: int = 60,
    alpha: float = 0.6,
    mmr_lambda: float = 0.7,
    min_score: float = 0.0,
) -> RetrievalOutcome:
    matrix = np.asarray(vectors, dtype=np.float32)
    if matrix.ndim != 2 or matrix.shape[0] == 0:
        return RetrievalOutcome(method=method, meta={"reason": "没有可检索的向量"})

    unit = cosine_matrix(matrix)
    query_unit = np.asarray(query_vector, dtype=np.float32)
    q_norm = float(np.linalg.norm(query_unit))
    query_unit = query_unit / q_norm if q_norm else query_unit
    dense = unit @ query_unit

    doc_tokens = [bm25_tokens(text) for text in texts]
    bm25 = bm25_scores(bm25_tokens(query), doc_tokens)
    dense_rank = _ranks(dense)
    bm25_rank = _ranks(bm25)

    pool = max(1, min(candidate_k, len(texts)))
    fused = np.zeros(len(texts), dtype=np.float32)
    selected_indices: list[int] = []
    meta: dict = {}

    if method == "bm25":
        order = np.argsort(-bm25)[:top_k]
        selected_indices = [int(i) for i in order]
        fused = bm25
    elif method == "hybrid_rrf":
        fused = (1.0 / (rrf_k + dense_rank) + 1.0 / (rrf_k + bm25_rank)).astype(np.float32)
        order = np.argsort(-fused)[:top_k]
        selected_indices = [int(i) for i in order]
        meta["rrf_k"] = rrf_k
    elif method == "hybrid_weighted":
        fused = (alpha * _normalize(dense) + (1 - alpha) * _normalize(bm25)).astype(np.float32)
        order = np.argsort(-fused)[:top_k]
        selected_indices = [int(i) for i in order]
        meta["alpha"] = alpha
    elif method == "mmr":
        fused = dense
        selected_indices = _mmr_select(
            dense=dense,
            unit=unit,
            query_unit=query_unit,
            top_k=top_k,
            pool=pool,
            lam=mmr_lambda,
        )
        meta["mmr_lambda"] = mmr_lambda
        meta["pool"] = pool
    else:  # dense
        fused = dense
        order = np.argsort(-dense)[:top_k]
        selected_indices = [int(i) for i in order]

    # 阈值过滤只在分数有可解释量纲时启用（RRF 的分数量级 ≈ 0.03，BM25 无上界）
    if min_score > 0 and method in {"dense", "hybrid_weighted"}:
        selected_indices = [i for i in selected_indices if float(fused[i]) >= min_score]

    selected = [
        _hit(index, fused, dense, bm25, dense_rank, bm25_rank, texts, selected=True)
        for index in selected_indices
    ]
    for rank, hit in enumerate(selected, start=1):
        hit["rank"] = rank

    # 可视化候选：两种召回各自的前 pool 名 + 已选中的并集
    candidate_set = set(selected_indices)
    candidate_set.update(int(i) for i in np.argsort(-dense)[:pool])
    candidate_set.update(int(i) for i in np.argsort(-bm25)[:pool])
    candidates = [
        _hit(
            index,
            fused,
            dense,
            bm25,
            dense_rank,
            bm25_rank,
            texts,
            selected=index in selected_indices,
        )
        for index in candidate_set
    ]
    candidates.sort(key=lambda item: -float(item["score"]))

    meta["dense_range"] = [round(float(dense.min()), 4), round(float(dense.max()), 4)]
    meta["bm25_range"] = [round(float(bm25.min()), 4), round(float(bm25.max()), 4)]
    meta["pool"] = pool
    meta["corpus_size"] = len(texts)

    return RetrievalOutcome(method=method, selected=selected, candidates=candidates, meta=meta)


def _hit(
    index: int,
    fused: np.ndarray,
    dense: np.ndarray,
    bm25: np.ndarray,
    dense_rank: np.ndarray,
    bm25_rank: np.ndarray,
    texts: list[str],
    *,
    selected: bool,
) -> dict:
    return {
        "index": index,
        "score": round(float(fused[index]), 4),
        "dense": round(float(dense[index]), 4),
        "bm25": round(float(bm25[index]), 4),
        "dense_rank": int(dense_rank[index]),
        "bm25_rank": int(bm25_rank[index]),
        "selected": selected,
        "preview": texts[index][:160],
    }


def _mmr_select(
    *,
    dense: np.ndarray,
    unit: np.ndarray,
    query_unit: np.ndarray,
    top_k: int,
    pool: int,
    lam: float,
) -> list[int]:
    """最大边际相关性：每轮挑「与问题相关」减去「与已选重复」最大的那个。"""
    pool_indices = [int(i) for i in np.argsort(-dense)[:pool]]
    selected: list[int] = []
    while pool_indices and len(selected) < top_k:
        best_index = None
        best_value = -1e9
        for index in pool_indices:
            relevance = float(dense[index])
            redundancy = (
                max(float(unit[index] @ unit[chosen]) for chosen in selected) if selected else 0.0
            )
            value = lam * relevance - (1 - lam) * redundancy
            if value > best_value:
                best_value = value
                best_index = index
        if best_index is None:
            break
        selected.append(best_index)
        pool_indices.remove(best_index)
    return selected


# ------------------------------------------------------------------ 选项元数据

RETRIEVER_OPTIONS: list[dict] = [
    {
        "id": "dense",
        "label": "稠密向量检索",
        "summary": "把问题也变成向量，取余弦相似度最高的 k 个块。换个说法也能找到。",
        "doc_label": "Pinecone · Vector similarity",
        "doc_url": "https://www.pinecone.io/learn/vector-similarity/",
        "params": ["top_k", "candidate_k", "min_score"],
        "needs_embedding": True,
        "best_for": "自然语言提问、概念性问答",
    },
    {
        "id": "bm25",
        "label": "BM25 关键词检索",
        "summary": "经典词频-逆文档频率排序，精确命中术语、型号、编号。不需要向量。",
        "doc_label": "Wikipedia · Okapi BM25",
        "doc_url": "https://en.wikipedia.org/wiki/Okapi_BM25",
        "params": ["top_k"],
        "needs_embedding": False,
        "best_for": "查专有名词、错误码、数字、人名",
    },
    {
        "id": "hybrid_rrf",
        "label": "混合检索 · RRF",
        "summary": "向量与 BM25 各出一份排名，用 1/(k+名次) 相加融合。不用调权重。",
        "doc_label": "Cormack et al. 2009 · Reciprocal Rank Fusion",
        "doc_url": "https://plg.uwaterloo.ca/~gvcormac/cormacksigir09-rrf.pdf",
        "params": ["top_k", "candidate_k", "rrf_k"],
        "needs_embedding": True,
        "best_for": "生产默认：两种召回都要，又不想调参",
    },
    {
        "id": "hybrid_weighted",
        "label": "混合检索 · 加权",
        "summary": "两份分数各自归一化后按 alpha 加权。alpha 越大越依赖语义。",
        "doc_label": "Weaviate · Hybrid search fusion",
        "doc_url": "https://docs.weaviate.io/weaviate/search/hybrid",
        "params": ["top_k", "alpha", "min_score"],
        "needs_embedding": True,
        "best_for": "已知该偏语义还是偏关键词的场景",
    },
    {
        "id": "mmr",
        "label": "MMR 多样性重排",
        "summary": "在相关性之外惩罚「和已选块太像」的候选，让返回的几条不是同一段话的复印件。",
        "doc_label": "Carbonell & Goldstein 1998 · MMR",
        "doc_url": "https://www.cs.cmu.edu/~jgc/publication/The_Use_MMR_Diversity_Based_LTMIR_1998.pdf",
        "params": ["top_k", "candidate_k", "mmr_lambda"],
        "needs_embedding": True,
        "best_for": "长文档里同一话题反复出现，结果高度重复时",
    },
]

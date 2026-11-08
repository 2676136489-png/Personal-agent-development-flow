"""RAG 实验台测试：切块策略 / 检索策略 / 流水线接口。

这些测试都在离线档位下跑（conftest 把 EMBEDDING_PROVIDER 设为 hash）：
验证的是「策略本身的行为」与「接口协议」，不是向量模型的质量。
"""

from __future__ import annotations

import re

from fastapi.testclient import TestClient

from app.main import create_app
from app.rag.chunking import (
    chunk_document,
    chunk_markdown,
    chunk_recursive,
    chunk_semantic,
    chunk_sentence,
    split_sentences,
)
from app.rag.parsing import ParsedDocument
from app.rag.retrieval import bm25_scores, bm25_tokens, retrieve

SAMPLE = """# 向量数据库选型

## 选型维度
评估向量数据库通常看召回质量、写入吞吐、运维成本与生态兼容性。
HNSW 在中小规模下表现稳定，IVF-PQ 更适合超大规模。

## 常见方案
pgvector 复用现有 PostgreSQL，事务与备份只有一套；千万级向量后建索引会变慢。
Milvus 面向十亿级规模，但组件多、运维成本高。
"""


# ---------- 切块 ----------


def test_recursive_chunks_never_exceed_size():
    drafts = chunk_recursive("这是一段测试文本。" * 200, chunk_size=200, overlap=40)
    assert len(drafts) > 1
    assert all(len(draft.content) <= 200 for draft in drafts)


def test_recursive_prefers_paragraph_boundary():
    drafts = chunk_recursive(SAMPLE, chunk_size=80, overlap=0)
    # 递归优先在 \n\n 处断开，块里不应该出现被截断的半个句子标题
    assert any("选型维度" in draft.content for draft in drafts)


def test_recursive_chunks_share_overlap_without_overflow():
    text = "".join(f"第{index}句讲的是切块边界与检索召回的关系。" for index in range(40))
    drafts = chunk_recursive(text, chunk_size=200, overlap=60)
    assert len(drafts) >= 3
    # 重叠既要在（色带上才画得出斜纹），又不能把块撑过 chunk_size
    shared = [left.char_end - right.char_start for left, right in zip(drafts, drafts[1:])]
    assert all(0 < chars <= 60 for chars in shared)
    assert all(len(draft.content) <= 200 for draft in drafts)
    # 边界吸附到句首：除了第一块，其余块都从「第 N 句」的句首起
    assert all(re.match(r"第\d+句", draft.content) for draft in drafts[1:])


def test_markdown_overlap_starts_on_sentence():
    body = "".join(f"第{index}句讲的是切块边界与重叠的关系。" for index in range(30))
    text = f"# 手册\n\n## 长章节\n{body}\n"
    drafts = chunk_markdown(text, chunk_size=200, overlap=60)
    assert len(drafts) >= 3
    # 同一节内部相邻块才有重叠；跨节是重新起算，不该串到上一节
    shared = [
        left.char_end - right.char_start
        for left, right in zip(drafts, drafts[1:])
        if left.heading == right.heading
    ]
    assert shared and all(0 < chars <= 60 for chars in shared)
    # 每节内部的重叠也要吸到句首：否则块会从「的是……」这种半句开头
    body_chunks = [draft for draft in drafts[1:] if not draft.content.startswith("#")]
    assert len(body_chunks) >= 2
    assert all(re.match(r"第\d+句", draft.content) for draft in body_chunks)


def test_markdown_overlap_stays_inside_section():
    drafts = chunk_markdown(SAMPLE, chunk_size=90, overlap=40)
    for left, right in zip(drafts, drafts[1:]):
        assert right.char_start >= left.char_start
        if right.heading != left.heading:
            # 换节了就重新起算，不把上一节的尾巴带进来
            assert right.char_end - right.char_start <= 90


def test_markdown_chunks_carry_heading_path():
    drafts = chunk_markdown(SAMPLE, chunk_size=120, overlap=0, keep_heading=True)
    assert drafts
    assert any(draft.heading == "向量数据库选型 › 选型维度" for draft in drafts)


def test_sentence_chunks_end_on_sentence_boundary():
    text = "第一句完整内容。" * 30
    drafts = chunk_sentence(text, chunk_size=60, overlap=20)
    assert len(drafts) > 1
    assert all(draft.content.endswith("。") for draft in drafts)


def test_semantic_chunks_break_on_vector_jump():
    text = (
        "关于向量检索的第一句话。关于向量检索的第二句话。"
        "今天中午吃什么比较好呢。这附近新开了家面馆。"
    )
    # 四句两组：前两句同簇，后两句另成一簇
    vectors = [
        [1.0, 0.0, 0.0],
        [0.98, 0.02, 0.0],
        [0.0, 1.0, 0.0],
        [0.01, 0.99, 0.0],
    ]
    drafts = chunk_semantic(text, vectors, chunk_size=200, breakpoint_percentile=0.5)
    assert len(drafts) == 2
    assert drafts[0].content.endswith("第二句话。")
    assert "面馆" in drafts[1].content


def test_split_sentences_keeps_offsets():
    text = "第一句。第二句！"
    sentences = split_sentences(text)
    assert [item[0] for item in sentences] == ["第一句。", "第二句！"]
    assert sentences[0][1] == 0


def test_chunk_document_keeps_page_numbers():
    parsed = ParsedDocument(
        pages=["第一页内容。" * 20, "第二页内容。" * 20], text="", page_count=2
    )
    drafts = chunk_document(parsed, strategy="recursive", chunk_size=120, overlap=20)
    assert drafts[0].page == 1
    assert drafts[-1].page == 2


# ---------- 检索 ----------


def test_bm25_prefers_exact_term():
    docs = ["pgvector 的性能与事务", "红烧肉的家常做法", "Milvus 集群部署"]
    scores = bm25_scores(bm25_tokens("Milvus"), [bm25_tokens(doc) for doc in docs])
    assert int(scores.argmax()) == 2


def test_bm25_ignores_unseen_terms():
    scores = bm25_scores(bm25_tokens("完全不存在"), [bm25_tokens("A"), bm25_tokens("B")])
    assert scores.tolist() == [0.0, 0.0]


def _fake_corpus():
    texts = ["向量检索的召回率优化", "今天天气不错适合出门", "检索增强生成 RAG 的流程"]
    vectors = [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.95, 0.05, 0.0]]
    return texts, vectors


def test_dense_retrieval_ranks_by_cosine():
    texts, vectors = _fake_corpus()
    outcome = retrieve(
        texts=texts,
        vectors=vectors,
        query="召回率",
        query_vector=[1.0, 0.02, 0.0],
        method="dense",
        top_k=2,
        candidate_k=3,
    )
    assert outcome.selected[0]["index"] == 0
    assert outcome.selected[0]["rank"] == 1
    assert 0 <= outcome.selected[0]["score"] <= 1


def test_hybrid_rrf_uses_both_rankings():
    texts, vectors = _fake_corpus()
    outcome = retrieve(
        texts=texts,
        vectors=vectors,
        query="RAG",
        query_vector=[1.0, 0.0, 0.0],
        method="hybrid_rrf",
        top_k=3,
        candidate_k=3,
        rrf_k=60,
    )
    # RRF 分数一定落在 1/(k+1) 量级，而不是余弦量级
    assert all(hit["score"] < 0.05 for hit in outcome.selected)
    assert outcome.meta["rrf_k"] == 60
    # 精确命中 "RAG" 的那条在 BM25 里必须排第一
    assert min(outcome.candidates, key=lambda hit: hit["bm25_rank"])["index"] == 2


def test_mmr_picks_diverse_results():
    texts = ["同一个话题的三种说法 A", "同一个话题的三种说法 B", "完全不同的话题 C"]
    # A、B 向量几乎重合，C 正交
    vectors = [[1.0, 0.0], [0.999, 0.001], [0.0, 1.0]]
    outcome = retrieve(
        texts=texts,
        vectors=vectors,
        query="话题",
        query_vector=[1.0, 0.0],
        method="mmr",
        top_k=2,
        candidate_k=3,
        mmr_lambda=0.3,
    )
    picked = {hit["index"] for hit in outcome.selected}
    assert picked == {0, 2}


def test_min_score_filters_dense_hits():
    texts, vectors = _fake_corpus()
    outcome = retrieve(
        texts=texts,
        vectors=vectors,
        query="召回率",
        query_vector=[1.0, 0.0, 0.0],
        method="dense",
        top_k=3,
        candidate_k=3,
        min_score=0.9,
    )
    assert all(hit["score"] >= 0.9 for hit in outcome.selected)


# ---------- 接口 ----------


def test_options_expose_all_methods_and_docs():
    client = TestClient(create_app())
    body = client.get("/api/rag/options").json()
    assert body["success"] is True
    data = body["data"]
    assert {item["id"] for item in data["chunkers"]} == {
        "recursive",
        "fixed",
        "sentence",
        "markdown",
        "semantic",
    }
    assert {item["id"] for item in data["retrievers"]} == {
        "dense",
        "bm25",
        "hybrid_rrf",
        "hybrid_weighted",
        "mmr",
    }
    # 每个方法都要能指向一份官方文档，界面上要能点出去
    assert all(item["doc_url"].startswith("https://") for item in data["chunkers"])
    assert all(item["doc_url"].startswith("https://") for item in data["retrievers"])


def test_pipeline_returns_every_stage():
    client = TestClient(create_app())
    response = client.post(
        "/api/rag/pipeline",
        json={
            "query": "向量数据库怎么选型",
            "corpus": {"kind": "text", "text": SAMPLE},
            "chunking": {"strategy": "markdown", "chunk_size": 120, "overlap": 0},
            "retrieval": {"method": "hybrid_weighted", "top_k": 2, "candidate_k": 3},
        },
    )
    assert response.status_code == 200, response.text
    data = response.json()["data"]
    assert [stage["key"] for stage in data["stages"]] == [
        "parse",
        "chunk",
        "embed",
        "retrieve",
        "assemble",
    ]
    chunk_stage = next(stage for stage in data["stages"] if stage["key"] == "chunk")
    assert chunk_stage["detail"]["chunks"], "切块结果不能为空"
    assert chunk_stage["detail"]["chunks"][0]["char_start"] == 0
    embed_stage = next(stage for stage in data["stages"] if stage["key"] == "embed")
    assert embed_stage["detail"]["dims"] > 0
    assert embed_stage["detail"]["heatmap"]["rows"] > 0
    prompt_stage = next(stage for stage in data["stages"] if stage["key"] == "assemble")
    assert "【资料】" in prompt_stage["detail"]["text"]
    # 离线档位必须给出「没有语义能力」的提示，而不是假装正常
    assert any("哈希" in warning for warning in data["warnings"])


def test_pipeline_rejects_blank_text():
    client = TestClient(create_app())
    response = client.post(
        "/api/rag/pipeline",
        json={"query": "问题", "corpus": {"kind": "text", "text": "   "}},
    )
    assert response.status_code == 422

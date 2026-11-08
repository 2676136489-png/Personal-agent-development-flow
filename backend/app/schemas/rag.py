"""RAG 实验台的请求模型。

为什么参数要给上下界：切块 5 字一块、检索 top_k=500 这类输入会让
一次请求产生上千次向量调用或几 MB 的响应，必须在这里挡住。
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field, model_validator

ChunkStrategy = Literal["recursive", "fixed", "sentence", "markdown", "semantic"]
RetrievalMethod = Literal["dense", "bm25", "hybrid_rrf", "hybrid_weighted", "mmr"]


class CorpusSpec(BaseModel):
    kind: Literal["document", "text"] = "text"
    document_id: str | None = Field(default=None, description="kind=document 时必填")
    text: str | None = Field(default=None, max_length=200_000, description="kind=text 时必填")
    title: str | None = Field(default=None, max_length=200)

    @model_validator(mode="after")
    def _check(self) -> CorpusSpec:
        if self.kind == "document" and not self.document_id:
            raise ValueError("kind=document 时必须提供 document_id")
        if self.kind == "text" and not (self.text or "").strip():
            raise ValueError("kind=text 时必须提供 text")
        return self


class ChunkConfig(BaseModel):
    strategy: ChunkStrategy = "recursive"
    chunk_size: int = Field(default=500, ge=120, le=2000)
    overlap: int = Field(default=80, ge=0, le=500)
    min_chunk: int = Field(default=60, ge=0, le=300)
    keep_heading: bool = True
    breakpoint_percentile: float = Field(default=0.9, ge=0.5, le=0.99)


class EmbedConfig(BaseModel):
    # None = 用当前生效的后端（自动选择）
    spec_id: str | None = Field(default=None, max_length=120)


class RetrievalConfig(BaseModel):
    method: RetrievalMethod = "hybrid_rrf"
    top_k: int = Field(default=5, ge=1, le=12)
    candidate_k: int = Field(default=20, ge=3, le=60)
    rrf_k: int = Field(default=60, ge=10, le=120)
    alpha: float = Field(default=0.6, ge=0, le=1)
    mmr_lambda: float = Field(default=0.7, ge=0, le=1)
    min_score: float = Field(default=0.0, ge=0, le=1)


class RagRunRequest(BaseModel):
    query: str = Field(min_length=2, max_length=500)
    corpus: CorpusSpec
    chunking: ChunkConfig = Field(default_factory=ChunkConfig)
    embedding: EmbedConfig = Field(default_factory=EmbedConfig)
    retrieval: RetrievalConfig = Field(default_factory=RetrievalConfig)

"""Embedding providers.

[P0] Embedding 是什么：把一段文本变成一串固定长度的数字（向量），
使得「意思相近的文本，向量也相近」。有了它才能做语义检索 ——
否则只能用关键词匹配，用户问"怎么优化检索效果"就匹配不到写的是"提升召回率"的段落。

两种实现：
- OpenAIEmbeddingProvider：调用 /embeddings 接口（需要 Key）
- HashEmbeddingProvider：本地确定性伪向量（无 Key 时兜底）
  ⚠️ 它只做字面/词面匹配，没有语义泛化能力，仅用于让链路可跑通。
"""

from __future__ import annotations

import hashlib
import logging
import re
from functools import lru_cache
from typing import Protocol

import openai

from app.core.config import Settings, get_settings
from app.llm.client import _is_ollama  # noqa: PLC2701  # 跨模块复用的 Ollama 判定
from app.llm.errors import LLMError

logger = logging.getLogger(__name__)

_CJK_RE = re.compile(r"[\u4e00-\u9fff]")
_WORD_RE = re.compile(r"[A-Za-z0-9_]+")


class EmbeddingProvider(Protocol):
    model_name: str

    async def embed(self, texts: list[str]) -> list[list[float]]: ...


def _tokenize(text: str) -> list[str]:
    """中文按字切、英文按词切 —— 这样哈希向量对中英混排都有一定区分度。"""
    tokens: list[str] = []
    buffer = ""
    for char in text.lower():
        if _CJK_RE.match(char):
            if buffer:
                tokens.extend(_WORD_RE.findall(buffer))
                buffer = ""
            tokens.append(char)
        else:
            buffer += char
    if buffer:
        tokens.extend(_WORD_RE.findall(buffer))
    return tokens


class HashEmbeddingProvider:
    """离线兜底：把 token 哈希到固定维度的向量（类似 hashing trick）。

    确定性（同一文本永远同一向量），无需网络，不产生费用。
    """

    model_name = "local-hash-v1"

    def __init__(self, dimension: int) -> None:
        self._dimension = dimension

    async def embed(self, texts: list[str]) -> list[list[float]]:
        import numpy as np

        vectors = []
        for text in texts:
            vector = np.zeros(self._dimension, dtype=np.float32)
            for token in _tokenize(text):
                digest = hashlib.md5(token.encode("utf-8")).digest()
                index = int.from_bytes(digest[:4], "big") % self._dimension
                vector[index] += 1.0
            norm = float(np.linalg.norm(vector))
            vectors.append((vector / norm).tolist() if norm > 0 else vector.tolist())
        return vectors


class OpenAIEmbeddingProvider:
    """OpenAI 兼容的 /embeddings 接口。"""

    def __init__(self, api_key: str, base_url: str | None, model: str, timeout: float) -> None:
        self._client = openai.AsyncOpenAI(
            api_key=api_key,
            base_url=base_url or None,
            timeout=timeout,
        )
        self.model_name = model
        # [B5] keep_alive 是 Ollama 私有字段，只对 Ollama 下发
        self._ollama_extra_body = {"keep_alive": 0} if _is_ollama(base_url) else None

    async def embed(self, texts: list[str]) -> list[list[float]]:
        kwargs: dict = {"model": self.model_name, "input": texts}
        if self._ollama_extra_body:
            kwargs["extra_body"] = self._ollama_extra_body
        try:
            response = await self._client.embeddings.create(**kwargs)
        except Exception as exc:  # 与外部 API 一样：统一翻译成自己的错误类型
            raise LLMError(f"embedding 调用失败：{exc}", kind="upstream", retryable=True) from exc
        return [list(item.embedding) for item in response.data]


@lru_cache(maxsize=1)
def get_embedding_provider() -> EmbeddingProvider:
    settings: Settings = get_settings()
    provider = settings.embedding_provider

    if provider == "auto":
        provider = "openai" if settings.embedding_api_key.get_secret_value() else "hash"

    if provider == "hash":
        logger.warning("EMBEDDING_PROVIDER=hash：使用本地哈希向量，检索只有字面匹配能力")
        return HashEmbeddingProvider(settings.embedding_dimension)

    if not settings.embedding_api_key.get_secret_value():
        raise LLMError(
            "EMBEDDING_PROVIDER=openai 但未配置 EMBEDDING_API_KEY",
            kind="auth",
            retryable=False,
        )

    return OpenAIEmbeddingProvider(
        api_key=settings.embedding_api_key.get_secret_value(),
        base_url=settings.embedding_base_url,
        model=settings.embedding_model,
        timeout=settings.embedding_timeout_seconds,
    )


def embeddings_have_semantic_power() -> bool:
    """当前向量是否具备**语义**检索能力（而不是字面匹配）。

    [B38] 这个判断是「能不能把检索结果当作依据」的前提，必须显式问出来。

    为什么不能只看 score 阈值：
    哈希向量的分数分布在 0.3~0.6，**相关与不相关严重重叠** ——
    实测「向量数据库选型对比」得 0.587（相关），而完全无关的
    「深度学习模型部署与量化」却能拿到 0.473。任何绝对阈值都切不开它，
    因为字面 token 重叠和语义相关本来就是两回事。
    """
    try:
        return not isinstance(get_embedding_provider(), HashEmbeddingProvider)
    except Exception:  # noqa: BLE001 - 取不到 provider 时按「不可信」处理，宁可不用
        return False

"""Embedding providers：把文本变成向量，并提供运行时的后端发现。

[P0] 为什么必须有真正的 embedding：
向量检索的全部价值来自「意思相近 → 向量相近」。哈希向量只是把 token 撒进固定维度，
它算出来的相似度**等于字面重合度**：用户问「怎么提升召回率」永远匹配不到写
「优化检索效果」的段落。这种检索不能当作结论的依据。

本模块解决三件事：

1. **后端发现**（discover_embedders）：按优先级列出当前环境**真的能用**的向量后端
   - 显式配置的 EMBEDDING_BASE_URL + EMBEDDING_API_KEY
   - 复用 LLM 的 OpenAI 兼容端点（同一个 Key，省掉再来一份配置）
   - 本地 Ollama（有端口在听才算可用）
   - 哈希伪向量（离线兜底，明确标记 semantic=False）
2. **可用性判定**（resolve_default_spec）：只挑确实能连上的，连不上就降级并**记录原因**，
   让 UI 能明说「现在是字面匹配」，而不是悄悄退化。
3. **统一调用**（embed / embed_query）：批量、按 index 排序、错误翻译、查询缓存。
"""

from __future__ import annotations

import hashlib
import logging
import re
import socket
from dataclasses import dataclass
from functools import lru_cache
from typing import Literal, Protocol
from urllib.parse import urlparse

import openai

from app.core.config import Settings, get_settings
from app.llm.client import _is_ollama  # noqa: PLC2701  # 跨模块复用的 Ollama 判定
from app.llm.errors import LLMError

logger = logging.getLogger(__name__)

_CJK_RE = re.compile(r"[\u4e00-\u9fff]")
_WORD_RE = re.compile(r"[A-Za-z0-9_]+")

# 各家的默认向量模型。仅在配置为空、或配置与端点明显不匹配时兜底。
_DEFAULT_MODEL_BY_TAG = {
    "bigmodel": "embedding-3",
    "ollama": "nomic-embed-text",
    "openai": "text-embedding-3-small",
    "siliconflow": "BAAI/bge-m3",
    "dashscope": "text-embedding-v3",
    "custom": "text-embedding-3-small",
}

# 已知模型的维度（用于 UI 展示；真实维度仍以接口返回为准）
_KNOWN_DIMS = {
    "embedding-3": 2048,
    "embedding-2": 1024,
    "text-embedding-3-small": 1536,
    "text-embedding-3-large": 3072,
    "nomic-embed-text": 768,
    "BAAI/bge-m3": 1024,
    "text-embedding-v3": 1024,
}


class EmbeddingProvider(Protocol):
    spec: EmbedderSpec

    @property
    def model_name(self) -> str: ...

    async def embed(self, texts: list[str]) -> list[list[float]]: ...


@dataclass(frozen=True)
class EmbedderSpec:
    """一个「可被选择」的向量后端。

    id 会写进 documents.embedding_model，所以它必须能唯一标识
    「用哪个端点 + 哪个模型」——换后端后旧向量自动不再参与检索。
    """

    id: str
    label: str
    provider: Literal["openai", "hash"]
    model: str
    base_url: str | None = None
    api_key: str | None = None
    dims: int | None = None
    note: str = ""

    @property
    def semantic(self) -> bool:
        return self.provider != "hash"

    def public(self) -> dict:
        """给前端的信息（**不含** api_key）。"""
        return {
            "id": self.id,
            "label": self.label,
            "provider": self.provider,
            "model": self.model,
            "dims": self.dims,
            "semantic": self.semantic,
            "note": self.note,
            "endpoint": _safe_endpoint(self.base_url),
        }


def _safe_endpoint(base_url: str | None) -> str:
    """只暴露 host，避免把带 token 的 URL 回给前端。"""
    if not base_url:
        return ""
    parsed = urlparse(base_url)
    return parsed.netloc or base_url


def _host_tag(base_url: str) -> str:
    lowered = (base_url or "").lower()
    if "bigmodel" in lowered or "zhipu" in lowered:
        return "bigmodel"
    if "11434" in lowered or "ollama" in lowered:
        return "ollama"
    if "openai.com" in lowered:
        return "openai"
    if "siliconflow" in lowered:
        return "siliconflow"
    if "dashscope" in lowered:
        return "dashscope"
    return "custom"


def _model_for_tag(tag: str, configured: str) -> str:
    """配置里的模型名与端点不匹配时纠正。

    典型场景：把 EMBEDDING_BASE_URL 指向智谱，却沿用了
    text-embedding-3-small —— 接口只会返回 404，而且报错信息完全指不到配置。
    """
    model = (configured or "").strip()
    if not model:
        return _DEFAULT_MODEL_BY_TAG.get(tag, "text-embedding-3-small")
    if tag == "bigmodel" and not model.startswith("embedding"):
        return _DEFAULT_MODEL_BY_TAG["bigmodel"]
    if tag == "ollama" and (model.startswith("text-embedding") or "/" in model):
        return _DEFAULT_MODEL_BY_TAG["ollama"]
    return model


def _port_open(base_url: str, timeout: float = 0.4) -> bool:
    """端口是否有人监听。用于判定本地 Ollama 是否可用（不做 HTTP 请求，避免阻塞）。"""
    parsed = urlparse(base_url)
    host = parsed.hostname or ""
    if not host:
        return False
    port = parsed.port or (443 if parsed.scheme == "https" else 80)
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except OSError:
        return False


def _is_local(base_url: str) -> bool:
    host = (urlparse(base_url).hostname or "").lower()
    return host in {"127.0.0.1", "localhost", "0.0.0.0", "::1"}


# ------------------------------------------------------------------ 哈希兜底


def _tokenize(text: str) -> list[str]:
    """中文按「字 + 相邻二字」切、英文按词切。

    加 bigram 是为了让哈希向量至少能对上「向量检索」这种词组，
    而不是把四个字拆散成互不相干的四次命中。它仍然是字面匹配，
    不要指望它有语义泛化能力。
    """
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

    cjk = [t for t in tokens if len(t) == 1 and _CJK_RE.match(t)]
    tokens.extend(f"{a}{b}" for a, b in zip(cjk, cjk[1:], strict=False))
    return tokens


class HashEmbeddingProvider:
    """离线兜底：把 token 哈希到固定维度（hashing trick）。

    确定性、无网络、零成本，但**没有语义能力** —— `semantic` 恒为 False，
    上层据此决定「能不能把检索结果当作依据」。
    """

    model_name = "local-hash-v1"

    def __init__(self, dimension: int) -> None:
        self._dimension = dimension
        self.spec = EmbedderSpec(
            id=self.model_name,
            label="哈希伪向量（离线兜底）",
            provider="hash",
            model=self.model_name,
            dims=dimension,
            note="只做字面/词面匹配，没有语义泛化能力",
        )
        self.dims = dimension
        self.semantic = False

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


# ------------------------------------------------------------ OpenAI 兼容后端


class OpenAIEmbeddingProvider:
    """任何 OpenAI 兼容的 /embeddings 端点（智谱 / OpenAI / Ollama /v1 …）。"""

    def __init__(
        self,
        spec: EmbedderSpec,
        *,
        timeout: float,
        batch_size: int = 16,
    ) -> None:
        self.spec = spec
        self.dims = spec.dims
        self.semantic = True
        self._batch_size = max(1, batch_size)
        self._client = openai.AsyncOpenAI(
            api_key=spec.api_key or "not-needed",
            base_url=spec.base_url or None,
            timeout=timeout,
        )
        # keep_alive 是 Ollama 私有字段，只对 Ollama 下发
        self._extra_body = {"keep_alive": 0} if _is_ollama(spec.base_url) else None

    @property
    def model_name(self) -> str:
        return self.spec.id

    async def embed(self, texts: list[str]) -> list[list[float]]:
        if not texts:
            return []
        vectors: list[list[float]] = []
        for start in range(0, len(texts), self._batch_size):
            batch = texts[start : start + self._batch_size]
            kwargs: dict = {"model": self.spec.model, "input": batch}
            if self._extra_body:
                kwargs["extra_body"] = self._extra_body
            try:
                response = await self._client.embeddings.create(**kwargs)
            except Exception as exc:  # 与外部 API 一样：统一翻译成自己的错误类型
                raise LLMError(
                    f"embedding 调用失败（{self.spec.label}）：{exc}",
                    kind="upstream",
                    retryable=True,
                ) from exc
            items = sorted(response.data, key=lambda item: getattr(item, "index", 0))
            if len(items) != len(batch):
                raise LLMError(
                    f"embedding 返回数量不一致（{len(items)} != {len(batch)}）",
                    kind="upstream",
                    retryable=False,
                )
            vectors.extend([list(item.embedding) for item in items])

        if vectors and self.dims is None:
            self.dims = len(vectors[0])
            _KNOWN_DIMS[self.spec.model] = self.dims
        return vectors


# ---------------------------------------------------------------- 后端发现


def _hash_spec(settings: Settings) -> EmbedderSpec:
    return EmbedderSpec(
        id="local-hash-v1",
        label="哈希伪向量（离线兜底）",
        provider="hash",
        model="local-hash-v1",
        dims=settings.embedding_dimension,
        note="只做字面匹配，用于没有可用向量后端时保证链路可跑",
    )


_DISCOVER_TTL_SECONDS = 30.0
_DISCOVER_CACHE: tuple[float, list[EmbedderSpec]] | None = None


def discover_embedders(*, refresh: bool = False) -> list[EmbedderSpec]:
    """按优先级列出候选后端（**不看可用性**，只看配置）。

    产出顺序即偏好顺序：显式配置 > 复用 LLM 端点 > 本地 Ollama > 哈希。

    带 30s 缓存：发现过程包含一次本地端口探测（socket，最多 0.4s），
    而状态接口 / 每次检索都会问一次，没必要反复探。
    """
    import time

    global _DISCOVER_CACHE
    now = time.monotonic()
    if not refresh and _DISCOVER_CACHE and now - _DISCOVER_CACHE[0] < _DISCOVER_TTL_SECONDS:
        return list(_DISCOVER_CACHE[1])

    specs = _discover_uncached()
    _DISCOVER_CACHE = (now, specs)
    return list(specs)


def _discover_uncached() -> list[EmbedderSpec]:
    settings = get_settings()
    preference = (settings.embedding_provider or "auto").strip().lower()
    if preference == "hash":
        return [_hash_spec(settings)]

    specs: list[EmbedderSpec] = []

    # ① 显式配置（EMBEDDING_BASE_URL + EMBEDDING_API_KEY）
    key = settings.embedding_api_key.get_secret_value().strip()
    base = (settings.embedding_base_url or "").strip()
    if key and base:
        tag = _host_tag(base)
        model = _model_for_tag(tag, settings.embedding_model)
        specs.append(
            EmbedderSpec(
                id=f"{tag}:{model}",
                label=f"{_label_for_tag(tag)} · {model}",
                provider="openai",
                model=model,
                base_url=base,
                api_key=key,
                dims=_KNOWN_DIMS.get(model),
                note="来自 EMBEDDING_BASE_URL / EMBEDDING_API_KEY",
            )
        )

    # ② 复用 LLM 的 OpenAI 兼容端点：同一份 Key，不需要额外配置
    if settings.embedding_reuse_llm_credentials:
        llm_key = settings.llm_api_key.get_secret_value().strip()
        llm_base = (settings.llm_base_url or "").strip()
        llm_is_http = settings.llm_provider in {"openai", "openai-compatible", "auto"}
        if llm_key and llm_base and llm_is_http:
            tag = _host_tag(llm_base)
            model = _model_for_tag(tag, settings.embedding_model if tag != "bigmodel" else "")
            specs.append(
                EmbedderSpec(
                    id=f"{tag}:{model}",
                    label=f"{_label_for_tag(tag)} · {model}",
                    provider="openai",
                    model=model,
                    base_url=llm_base,
                    api_key=llm_key,
                    dims=_KNOWN_DIMS.get(model),
                    note="复用 LLM 端点与 Key",
                )
            )

    # ③ 本地 Ollama（只有端口在听才算候选，避免每次请求都等一次超时）
    ollama_base = (settings.ollama_base_url or "").strip()
    if preference in {"auto", "ollama"} and ollama_base and _port_open(ollama_base):
        tag = "ollama"
        same_host = base and _host_tag(base) == "ollama"
        model = _model_for_tag(tag, settings.embedding_model if same_host else "")
        specs.append(
            EmbedderSpec(
                id=f"{tag}:{model}",
                label=f"本地 Ollama · {model}",
                provider="openai",
                model=model,
                base_url=f"{ollama_base.rstrip('/')}/v1",
                api_key="ollama",
                dims=_KNOWN_DIMS.get(model),
                note="本地推理，不需要 Key",
            )
        )

    # ④ 兜底
    specs.append(_hash_spec(settings))

    # 按 id 去重（保留先出现的、优先级更高的那条）
    seen: set[str] = set()
    unique: list[EmbedderSpec] = []
    for spec in specs:
        if spec.id in seen:
            continue
        seen.add(spec.id)
        unique.append(spec)
    return unique


def _label_for_tag(tag: str) -> str:
    return {
        "bigmodel": "智谱 BigModel",
        "ollama": "本地 Ollama",
        "openai": "OpenAI",
        "siliconflow": "硅基流动",
        "dashscope": "通义百炼",
        "custom": "OpenAI 兼容端点",
    }.get(tag, "OpenAI 兼容端点")


def _reachable(spec: EmbedderSpec) -> bool:
    if spec.provider == "hash":
        return True
    if spec.base_url and _is_local(spec.base_url):
        return _port_open(spec.base_url)
    return bool(spec.api_key)


def available_spec_ids() -> set[str]:
    """当前确实能连上的后端 id 集合。"""
    return {spec.id for spec in discover_embedders() if _reachable(spec)}


def resolve_default_spec() -> tuple[EmbedderSpec, str | None]:
    """选出当前真正生效的后端，并给出降级原因（没降级则为 None）。"""
    specs = discover_embedders()
    for spec in specs:
        if not _reachable(spec):
            continue
        reason = None
        if not spec.semantic:
            reason = _degraded_reason(specs)
        return spec, reason
    return _hash_spec(get_settings()), "没有可用的向量后端"


def _degraded_reason(specs: list[EmbedderSpec]) -> str:
    semantic = [s for s in specs if s.semantic]
    if not semantic:
        return "未配置 EMBEDDING_API_KEY，且本地 Ollama 不可达：检索只有字面匹配能力"
    names = "、".join(s.label for s in semantic)
    return f"以下向量后端均连不上：{names}，已退回字面向量"


@lru_cache(maxsize=8)
def get_provider(spec_id: str | None = None) -> EmbeddingProvider:
    """取一个 provider。`spec_id=None` 表示用当前生效的那个。"""
    settings = get_settings()
    if spec_id is None:
        spec, reason = resolve_default_spec()
        if reason:
            logger.warning("embedding 降级：%s", reason)
    else:
        candidates = {spec.id: spec for spec in discover_embedders()}
        spec = candidates.get(spec_id)
        if spec is None:
            raise LLMError(f"未知的向量后端：{spec_id}", kind="validation", retryable=False)

    if spec.provider == "hash":
        return HashEmbeddingProvider(settings.embedding_dimension)
    return OpenAIEmbeddingProvider(
        spec,
        timeout=settings.embedding_timeout_seconds,
        batch_size=settings.embedding_batch_size,
    )


def get_embedding_provider() -> EmbeddingProvider:
    return get_provider(None)


def get_provider_by_id(spec_id: str) -> EmbeddingProvider:
    return get_provider(spec_id)


def clear_provider_cache() -> None:
    """配置变更或测试替换 Settings 后调用。"""
    global _DISCOVER_CACHE
    _DISCOVER_CACHE = None
    get_provider.cache_clear()


def embedding_status() -> dict:
    """给 UI 的状态快照：当前后端、候选列表、是否具备语义能力。"""
    spec, reason = resolve_default_spec()
    provider = get_provider(None)
    dims = getattr(provider, "dims", spec.dims)
    reachable_ids = {s.id for s in discover_embedders() if _reachable(s)}
    return {
        "active": {**spec.public(), "dims": dims or spec.dims},
        "semantic": spec.semantic,
        "degraded_reason": reason,
        "candidates": [
            {**candidate.public(), "available": candidate.id in reachable_ids}
            for candidate in discover_embedders()
        ],
    }


def embeddings_have_semantic_power() -> bool:
    """当前向量是否具备**语义**检索能力（而不是字面匹配）。

    [B38] 这个判断是「能不能把检索结果当作依据」的前提，必须显式问出来：
    哈希向量的分数分布严重重叠，任何绝对阈值都切不开相关与不相关。
    """
    try:
        return bool(get_embedding_provider().spec.semantic)
    except Exception:  # noqa: BLE001 - 取不到 provider 时按「不可信」处理，宁可不用
        return False


_QUERY_CACHE: dict[tuple[str, str], list[float]] = {}
_QUERY_CACHE_LIMIT = 256


async def embed_query(text: str, provider: EmbeddingProvider | None = None) -> list[float]:
    """查询向量（带缓存）。

    同一个 query 在「检索测试 → 详情展开」里会被反复请求，
    而 embedding 是整条链路里最贵的一步，缓存掉是纯收益。
    """
    active = provider or get_embedding_provider()
    cache_key = (active.model_name, text)
    cached = _QUERY_CACHE.get(cache_key)
    if cached is not None:
        return cached

    vectors = await active.embed([text])
    if not vectors:
        raise LLMError("embedding 返回了空结果", kind="upstream", retryable=True)
    vector = vectors[0]
    if len(_QUERY_CACHE) >= _QUERY_CACHE_LIMIT:
        _QUERY_CACHE.clear()
    _QUERY_CACHE[cache_key] = vector
    return vector

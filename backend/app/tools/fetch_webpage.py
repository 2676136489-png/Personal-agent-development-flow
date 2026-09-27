"""fetch_webpage tool.

[P0] 这是本项目风险最高的工具：它会让服务器去访问模型给出的 URL。
因此有三道闸：
1. assert_public_http_url：挡掉内网地址与危险 scheme（SSRF）
2. 超时 + 不跟随重定向（重定向是绕过 SSRF 校验的经典手法）
3. 内容清洗 + 长度截断（外部内容一律视为不可信数据）
"""

from __future__ import annotations

import html
import re
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

import httpx
from pydantic import BaseModel, Field

from app.core.security import assert_public_http_url, sanitize_untrusted_text
from app.tools.base import BaseTool, ToolContext, ToolError

_USER_AGENT = "AIResearchWorkspaceBot/0.1 (+research agent)"

_SCRIPT_RE = re.compile(r"<(script|style)[^>]*>.*?</\1>", re.IGNORECASE | re.DOTALL)
_COMMENT_RE = re.compile(r"<!--.*?-->", re.DOTALL)
_TAG_RE = re.compile(r"<[^>]+>")
_BLANK_RE = re.compile(r"\n{3,}")

# [B9] 抓取单个页面的体积上限：正文抓取只需要前若干 KB，
# 超过这个量级基本可以确定不是正常网页（或是在进行内存攻击）。
_MAX_RESPONSE_BYTES = 2 * 1024 * 1024


async def _read_limited(response: httpx.Response, max_bytes: int) -> str:
    """流式读取响应体，超过上限就停止（内存占用恒定）。"""
    chunks: list[bytes] = []
    total = 0
    async for chunk in response.aiter_bytes():
        total += len(chunk)
        if total > max_bytes:
            chunks.append(chunk[: max_bytes - (total - len(chunk))])
            break
        chunks.append(chunk)
    data = b"".join(chunks)
    # 不指定编码时 httpx 会用响应头推断；出错则退回 utf-8 并忽略非法字节
    try:
        return data.decode(response.encoding or "utf-8")
    except (UnicodeDecodeError, LookupError):
        return data.decode("utf-8", errors="ignore")


class FetchWebpageArgs(BaseModel):
    url: str = Field(min_length=1, max_length=2000, description="要抓取的完整 URL，必须 http/https")
    max_chars: int = Field(default=4000, ge=200, le=20000, description="最多保留多少字符")


def html_to_text(raw_html: str) -> str:
    """把 HTML 粗略转成纯文本。

    [P2] 正则足够应付「把正文喂给模型」这件事。
    如果后面发现抽取质量不够（正文丢失、噪音太多），再换 readability / bs4。
    """
    text = _SCRIPT_RE.sub(" ", raw_html)
    text = _COMMENT_RE.sub(" ", text)
    text = _TAG_RE.sub(" ", text)
    text = html.unescape(text)
    text = re.sub(r"[ \t]+", " ", text)
    return _BLANK_RE.sub("\n\n", text).strip()


class FetchWebpageTool(BaseTool):
    name = "fetch_webpage"
    description = (
        "抓取一个公开网页并返回正文纯文本（已去除脚本与样式）。"
        "只能访问公网 http/https 地址；URL 应来自 search_web 的结果。"
    )
    args_schema = FetchWebpageArgs
    timeout_seconds = 25.0
    # 抓取不产生第三方计费，网络抖动天然可重试（由 BaseTool 用配置做退避重试）。
    retryable = True

    def __init__(self) -> None:
        # 共享 client（带连接池）：一个 run 会抓多个 URL，复用连接避免重复握手。
        self._shared_client: httpx.AsyncClient | None = None

    @asynccontextmanager
    async def _http(self) -> AsyncIterator[httpx.AsyncClient]:
        if self._shared_client is None or self._shared_client.is_closed:
            self._shared_client = httpx.AsyncClient(
                timeout=httpx.Timeout(20.0),
                follow_redirects=False,  # 重定向是绕过 SSRF 校验的经典手法，绝不跟随
            )
        yield self._shared_client

    async def _run(self, args: BaseModel, ctx: ToolContext) -> str:
        assert isinstance(args, FetchWebpageArgs)

        # 闸门 1：SSRF 校验（内网地址会在这里被拒绝）
        url = assert_public_http_url(args.url, ctx.allowed_domains or None)

        # 闸门 2：超时 + 不跟随重定向
        # [B9] 用流式读取 + 大小上限：之前是 response.text，会把整个响应体
        # 一次性读进内存，一个几百 MB 的 URL 就能把进程撑爆。
        # [robustness] httpx 的超时/网络异常翻译成可分类的 ToolError（kind=timeout/network），
        # 否则会被兜底成 execution_error ——「站点连不上」和「代码 bug」就分不清了，
        # 也无法被上层重试。
        try:
            async with self._http() as client:
                async with client.stream(
                    "GET", url, headers={"User-Agent": _USER_AGENT}
                ) as response:
                    if response.status_code >= 400:
                        return f"[抓取失败] HTTP {response.status_code}"

                    content_type = response.headers.get("content-type", "")
                    if "html" not in content_type and "text" not in content_type:
                        return f"[跳过] 非文本内容（content-type={content_type}）"

                    raw_html = await _read_limited(response, _MAX_RESPONSE_BYTES)
        except httpx.TimeoutException as exc:
            raise ToolError(f"抓取超时：{exc}", error_kind="timeout") from exc
        except httpx.TransportError as exc:
            raise ToolError(f"无法连接目标站点：{exc}", error_kind="network") from exc

        # 闸门 3：清洗 + 截断。返回值仍会被 orchestrator 标记为不可信数据块
        return sanitize_untrusted_text(html_to_text(raw_html), args.max_chars)

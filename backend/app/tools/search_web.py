"""search_web tool.

用途：发现候选来源（标题 + URL + 摘要）。
它不读取正文 —— 读正文是 fetch_webpage 的事。职责分开，模型才不会用错。
"""

from __future__ import annotations

import json

from pydantic import BaseModel, Field

from app.tools.base import BaseTool, ToolContext
from app.tools.search_provider import get_search_provider


class SearchWebArgs(BaseModel):
    query: str = Field(min_length=2, max_length=200, description="检索关键词，用空格分隔")
    max_results: int = Field(default=5, ge=1, le=10, description="最多返回几条")


class SearchWebTool(BaseTool):
    name = "search_web"
    description = (
        "按关键词检索网页，返回标题、URL 和摘要。"
        "用于发现候选来源；需要看正文时用 fetch_webpage。"
    )
    args_schema = SearchWebArgs
    timeout_seconds = 25.0
    # 计费工具不参与工具层自动重试：Tavily 超时/网络失败时预扣**不退款**
    # （保守口径，见 search_provider.py），重试会再预扣一笔 → 一次逻辑搜索重复扣积分。
    # 瞬时失败的可恢复性由上层（research 节点）通过「重新决策 → 再检索」承担。
    retryable = False

    async def _run(self, args: BaseModel, ctx: ToolContext) -> str:
        assert isinstance(args, SearchWebArgs)
        provider = get_search_provider()
        # run_key 决定这笔预扣记在「哪一次研究」头上（search_quota_run 表）
        results = await provider.search(args.query, args.max_results, run_key=ctx.run_id)

        if not results:
            return f"没有检索到与「{args.query}」相关的内容。"

        return json.dumps(
            [item.model_dump() for item in results],
            ensure_ascii=False,
            indent=2,
        )

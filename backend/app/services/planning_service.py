"""Research planning use case.

[P0] 这个文件是「业务逻辑」，它只做三件事：
1. 组装 Prompt
2. 调 LLM（拿到结构化结果）
3. 包装成 API 响应

它不认识 FastAPI、不认识 HTTP —— 所以可以在测试里直接调用。
"""

from __future__ import annotations

import logging

from app.llm.client import LLMClient
from app.llm.errors import LLMError
from app.llm.prompts import build_planning_messages
from app.llm.schemas import LLMRequest
from app.schemas.research import PlanResponse, ResearchPlan

logger = logging.getLogger(__name__)

# 值得再来一次的失败：模型偶尔漏字段 / 输出被包了代码块，重试往往能好。
# 「truncated」不在此列 —— token 预算不够，重试多少次都一样。
_RETRYABLE_KINDS = frozenset({"parse"})


async def create_research_plan(
    client: LLMClient,
    question: str,
    max_steps: int = 6,
    min_steps: int = 3,
) -> PlanResponse:
    """调用 LLM 生成结构化研究计划。

    [P0] 所谓 Structured Output，就是这两步：
    1. 请求时要求模型输出 JSON（response_format）
    2. 拿到后立刻用 Pydantic model_validate 校验（在 complete_structured 里）

    [B7] 之前解析失败会直接冒泡成 502。tenacity 只重试传输层错误，
    而「模型输出的 JSON 不合 schema」恰恰是最常见、也最值得重试的一类失败。
    这里补一次 repair 重试，并把上一次的具体原因回灌给模型。
    """
    last_error: LLMError | None = None

    for attempt in range(2):
        request = LLMRequest(
            messages=build_planning_messages(
                question,
                min_steps=min_steps,
                max_steps=max_steps,
                repair_hint=last_error.message if last_error else None,
            ),
            response_format={"type": "json_object"},
            purpose="planning",
            metadata={"max_steps": max_steps},
        )
        try:
            result = await client.complete_structured(request, ResearchPlan)
            break
        except LLMError as exc:
            last_error = exc
            if exc.kind not in _RETRYABLE_KINDS or attempt == 1:
                raise
            logger.warning("计划生成第 %s 次失败，准备重试：%s", attempt + 1, exc.message)
    else:  # pragma: no cover - 循环只有 2 次，理论上不会走到
        raise last_error or LLMError("计划生成失败", kind="unknown", retryable=False)

    logger.info(
        "research plan generated: steps=%s tokens=%s latency_ms=%s",
        len(result.data.steps),
        result.response.usage.total_tokens,
        result.response.latency_ms,
    )

    response = PlanResponse(
        plan=result.data,
        model=result.response.model,
        provider=client.provider_name,
        mock=client.provider_name == "mock",
        usage=result.response.usage.model_dump(),
        latency_ms=result.response.latency_ms,
    )

    # [B27] 落库供「历史规划」列表回看。存储失败（如磁盘问题）不影响主流程返回。
    try:
        from app.graph.plan_store import get_plan_store  # noqa: PLC0415

        record = get_plan_store().save(
            question=question,
            plan=result.data.model_dump(),
            model=response.model,
            provider=response.provider,
            mock=response.mock,
            usage=response.usage,
            latency_ms=response.latency_ms,
        )
        response.plan_id = record["id"]
    except Exception:  # noqa: BLE001
        logger.warning("研究计划落库失败（不影响返回）", exc_info=True)

    return response

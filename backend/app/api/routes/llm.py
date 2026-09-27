"""Model layer endpoints（统一模型调用层的对外窗口）。

为什么单独开一个路由：换模型是高频操作（本地推理 ⇄ 云端 API），
排障时第一个问题永远是「现在到底在调谁、参数是什么、它通不通」。
这两个接口把这件事从「看日志猜」变成「点一下就知道」：

- `GET  /api/llm/provider` —— 当前生效的 provider / 模型 / 超时 / 兜底配置
- `POST /api/llm/stream`   —— 流式自测（SSE），顺带验证流式链路是否可用

⚠️ 两个接口都**不返回任何密钥**，只返回地址与模型名。
"""

from __future__ import annotations

import json
import logging

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from app.core.config import Settings, get_settings
from app.core.responses import ApiResponse, success_response
from app.llm.client import LLMClient, describe_llm_client, get_llm_client
from app.llm.errors import LLMError
from app.llm.schemas import ChatMessage, LLMRequest

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/llm", tags=["llm"])


class StreamProbeRequest(BaseModel):
    prompt: str = Field(min_length=1, max_length=500)
    system: str = Field(default="你是简洁的中文助手，回答控制在 60 字以内。", max_length=500)


@router.get("/provider", response_model=ApiResponse[dict], summary="当前生效的模型配置")
async def get_provider(
    settings: Settings = Depends(get_settings),
    client: LLMClient = Depends(get_llm_client),
) -> ApiResponse[dict]:
    """返回「现在在调哪个模型」的非敏感信息。

    `describe_llm_client()` 只输出 provider / 模型名 / 地址 / 超时 / 兜底，
    API Key 一律不出现（SecretStr 也不会被序列化进来）。
    """
    info = describe_llm_client(client)
    info["environment"] = settings.environment
    return success_response(info)


@router.post("/stream", summary="流式自测（SSE）")
async def stream_probe(
    body: StreamProbeRequest,
    settings: Settings = Depends(get_settings),
    client: LLMClient = Depends(get_llm_client),
):
    """把模型输出以 SSE 逐块推给前端，用于验证流式链路与体感延迟。

    用 POST + `text/event-stream`（而不是 EventSource）：
    提示词可能较长且含中文，放 query string 会被代理截断或编码出错。

    事件格式：
        event: chunk  data: {"text": "..."}     # 增量文本
        event: done   data: {"model":..., "latency_ms":..., "usage":{...}}
        event: error  data: {"message": "..."}
    """
    if not settings.llm_stream_enabled:
        raise HTTPException(status_code=403, detail="流式输出已被 LLM_STREAM_ENABLED=false 关闭")

    request = LLMRequest(
        messages=[
            ChatMessage(role="system", content=body.system),
            ChatMessage(role="user", content=body.prompt),
        ],
        purpose="stream_probe",
        temperature=settings.llm_temperature,
        max_tokens=min(settings.ollama_num_predict, 512),
        stream=True,
    )

    async def event_gen():
        try:
            async for chunk in client.stream(request):
                if chunk.done:
                    response = chunk.response
                    payload = {
                        "model": response.model if response else "",
                        "provider": response.provider if response else "",
                        "latency_ms": response.latency_ms if response else 0,
                        "usage": response.usage.model_dump() if response else {},
                    }
                    yield f"event: done\ndata: {json.dumps(payload, ensure_ascii=False)}\n\n"
                else:
                    yield (
                        "event: chunk\ndata: "
                        + json.dumps({"text": chunk.text}, ensure_ascii=False)
                        + "\n\n"
                    )
        except LLMError as exc:
            logger.warning("流式自测失败：%s", exc)
            yield (
                "event: error\ndata: "
                + json.dumps({"message": exc.message, "kind": exc.kind}, ensure_ascii=False)
                + "\n\n"
            )
        except Exception as exc:  # noqa: BLE001 - SSE 流里只能靠 error 事件回传
            logger.exception("流式自测异常")
            yield (
                "event: error\ndata: "
                + json.dumps({"message": str(exc)}, ensure_ascii=False)
                + "\n\n"
            )

    return StreamingResponse(
        event_gen(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            # 关掉 Nginx 缓冲，否则本地模型要等整段生成完才推第一块
            "X-Accel-Buffering": "no",
        },
    )


@router.get("/ping", summary="模型连通性自检")
async def ping(
    probe: str = Query(default="用一句话说明你是谁。", max_length=200),
    client: LLMClient = Depends(get_llm_client),
) -> ApiResponse[dict]:
    """发一次最小请求，确认当前模型真的能答。

    与 `/provider` 的区别：那个只报配置，这个会**真的打一次模型**，
    因此能区分「配置写对了」和「模型确实可用」。
    """
    request = LLMRequest(
        messages=[ChatMessage(role="user", content=probe)],
        purpose="ping",
        max_tokens=min(512, 512),
    )
    try:
        response = await client.complete(request)
    except LLMError as exc:
        # 模型不可用是**预期的运行态**（Ollama 没启动很常见），
        # 用 200 + status=fail 而不是 500：前端要展示它，而不是当接口故障处理。
        return success_response(
            {
                "status": "fail",
                "kind": exc.kind,
                "message": exc.message,
                **describe_llm_client(client),
            }
        )
    return success_response(
        {
            "status": "ok",
            "content": response.content[:300],
            "model": response.model,
            "provider": response.provider,
            "latency_ms": response.latency_ms,
            "usage": response.usage.model_dump(),
        }
    )

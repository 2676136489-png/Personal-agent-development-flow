"""/api/llm/* 接口测试。

这三个接口是「换模型之后的排障入口」，必须自己有测试：
- `/provider` 报配置（**且绝不泄露密钥**）
- `/ping` 真的打一次模型，区分「配对了」与「能答」
- `/stream` 验证流式链路

conftest 里 `LLM_PROVIDER=mock`，所以这里跑的是 Mock provider —— 断网也能验证接口契约。
"""

from __future__ import annotations

from fastapi.testclient import TestClient

from app.main import create_app


def test_provider_reports_config_without_secrets():
    client = TestClient(create_app())
    response = client.get("/api/llm/provider")

    assert response.status_code == 200
    body = response.json()
    assert body["success"] is True

    data = body["data"]
    assert "provider" in data
    assert "model" in data
    assert "active_provider" in data, "降级状态必须对外可见"
    assert "degraded" in data

    # 安全红线：接口绝不返回任何凭据
    raw = response.text.lower()
    for forbidden in ("api_key", "apikey", "sk-", "authorization", "bearer"):
        assert forbidden not in raw


def test_ping_reports_status_envelope():
    """/ping 真打一次模型；mock 环境下应当可答。

    注意：即使模型不可用，这个接口也返回 200 + status=fail ——
    那是**预期的运行态**（Ollama 没启动很常见），不是接口故障，
    前端要展示它而不是当错误处理。
    """
    client = TestClient(create_app())
    response = client.get("/api/llm/ping", params={"probe": "说一句话"})

    assert response.status_code == 200
    body = response.json()
    assert body["success"] is True
    assert body["data"]["status"] in ("ok", "fail")


def test_stream_returns_sse_frames():
    client = TestClient(create_app())
    with client.stream(
        "POST", "/api/llm/stream", json={"prompt": "讲一句话"}
    ) as response:
        assert response.status_code == 200
        assert "text/event-stream" in response.headers["content-type"]
        # 关掉 Nginx 缓冲，否则本地模型要等整段生成完才推第一块
        assert response.headers.get("x-accel-buffering") == "no"

        text = "".join(response.iter_text())

    assert "event: chunk" in text
    assert "event: done" in text


def test_stream_rejects_empty_prompt():
    """空提示词必须被校验拦住（422），不能走到模型层。"""
    client = TestClient(create_app())
    response = client.post("/api/llm/stream", json={"prompt": ""})
    assert response.status_code == 422

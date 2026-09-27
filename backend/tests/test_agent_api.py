"""Agent run endpoint tests."""

from __future__ import annotations

from fastapi.testclient import TestClient

from app.main import create_app

QUESTION = "研究 2026 年 AI Agent 开发岗位的主要技术要求，并说明来源。"


def test_agent_run_returns_trace():
    client = TestClient(create_app())
    response = client.post("/api/agent/run", json={"question": QUESTION, "max_steps": 4})

    assert response.status_code == 200
    body = response.json()
    data = body["data"]

    assert data["answer"]
    assert data["finished_reason"] == "final_answer"
    # Trace：每一步的工具调用都必须可审计
    assert len(data["tool_calls"]) >= 1
    call = data["tool_calls"][0]
    assert {"index", "tool", "args", "ok", "duration_ms"} <= call.keys()


def test_agent_run_rejects_short_question():
    client = TestClient(create_app())
    response = client.post("/api/agent/run", json={"question": "hi"})

    assert response.status_code == 422
    assert response.json()["error"]["code"] == "validation_error"


# ------------------------- [B39] 智能体历史记录 -------------------------


def test_agent_run_is_saved_and_listed() -> None:
    """跑成功的运行必须能在历史里看到 —— 用户要的「之前问过的问题」。"""
    client = TestClient(create_app())

    created = client.post("/api/agent/run", json={"question": QUESTION, "max_steps": 3})
    assert created.status_code == 200

    listing = client.get("/api/agent/runs")
    assert listing.status_code == 200
    runs = listing.json()["data"]
    assert runs, "跑过一次之后历史不应为空"

    latest = runs[0]
    assert latest["question"] == QUESTION
    assert latest["finished_reason"]
    assert "created_at" in latest
    # 列表是摘要：不能把完整轨迹塞进来（否则列表响应会膨胀到几十 KB）
    assert "result" not in latest


def test_agent_history_record_can_be_reopened_and_deleted() -> None:
    """回看历史要能拿到当时的完整结果，并且可以删除。"""
    client = TestClient(create_app())
    client.post("/api/agent/run", json={"question": QUESTION, "max_steps": 3})

    record_id = client.get("/api/agent/runs").json()["data"][0]["id"]

    detail = client.get(f"/api/agent/runs/{record_id}")
    assert detail.status_code == 200
    payload = detail.json()["data"]
    assert payload["question"] == QUESTION
    # 完整结果：答案与轨迹都要在，回看才不是空壳
    assert payload["result"] is not None
    assert payload["result"]["answer"]
    assert payload["result"]["steps"]

    removed = client.delete(f"/api/agent/runs/{record_id}")
    assert removed.status_code == 200
    assert client.get(f"/api/agent/runs/{record_id}").status_code == 404
    assert all(item["id"] != record_id for item in client.get("/api/agent/runs").json()["data"])


def test_agent_history_unknown_id_is_404() -> None:
    client = TestClient(create_app())
    assert client.get("/api/agent/runs/agentrun_nope").status_code == 404
    assert client.delete("/api/agent/runs/agentrun_nope").status_code == 404

"""管理员边界、启动对账与运行摘要的回归测试。"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

from fastapi.testclient import TestClient
from pydantic import SecretStr

import app.core.security as security
import app.graph.nodes as nodes_mod
import app.graph.service as service
from app.graph.run_store import RunStore
from app.main import create_app


def _fake_settings(token: str) -> SimpleNamespace:
    return SimpleNamespace(admin_token=SecretStr(token))


# ------------------------- 管理员令牌 -------------------------


def test_writes_are_disabled_when_admin_token_missing(monkeypatch):
    """未配置 ADMIN_TOKEN：公开实例默认只读，写接口必须拒绝。"""
    monkeypatch.setattr(security, "get_settings", lambda: _fake_settings(""))
    client = TestClient(create_app())

    assert client.delete("/api/graph/runs").status_code == 403
    assert client.get("/api/debug/recent-errors").status_code == 403

    status = client.get("/api/admin/status").json()["data"]
    assert status == {"configured": False, "authenticated": False}


def test_admin_token_unlocks_writes(monkeypatch):
    monkeypatch.setattr(security, "get_settings", lambda: _fake_settings("s3cret"))
    client = TestClient(create_app())

    assert client.get("/api/debug/recent-errors").status_code == 401
    assert (
        client.get(
            "/api/debug/recent-errors", headers={"X-Admin-Token": "s3cret"}
        ).status_code
        == 200
    )
    assert client.get(
        "/api/admin/status", headers={"X-Admin-Token": "s3cret"}
    ).json()["data"] == {"configured": True, "authenticated": True}


# ------------------------- 启动对账 -------------------------


def test_reconcile_marks_stale_runs_interrupted(monkeypatch, tmp_path):
    store = RunStore(tmp_path / "runs.db")
    store.upsert(
        thread_id="thread_dead",
        question="q",
        status="awaiting_approval",
        state={"status": "running", "question": "q"},
    )
    store.upsert(
        thread_id="thread_done",
        question="q2",
        status="completed",
        state={"status": "completed"},
    )
    monkeypatch.setattr(service, "get_run_store", lambda: store)

    assert service.reconcile_stale_runs() == 1
    stale = store.get("thread_dead")
    assert stale is not None
    assert stale["status"] == "interrupted"
    assert stale["state"]["finished_reason"] == "service_restarted"
    assert "重新发起" in stale["state"]["error"]

    # 终态记录不能被误改
    assert store.get("thread_done")["status"] == "completed"
    store.close()


# ------------------------- 运行摘要 -------------------------


def test_list_runs_returns_metrics_without_full_state(monkeypatch, tmp_path):
    store = RunStore(tmp_path / "runs.db")
    store.upsert(
        thread_id="thread_ok",
        question="q",
        status="completed",
        state={
            "usage": [{"total_tokens": 100}, {"total_tokens": 50}],
            "iteration": 3,
            "verify_attempts": 2,
            "finished_reason": "completed",
            "error": None,
        },
    )
    monkeypatch.setattr(service, "get_run_store", lambda: store)

    runs = service.list_runs()
    assert len(runs) == 1
    item = runs[0]
    assert item["usage_total_tokens"] == 150
    assert item["iteration"] == 3
    assert item["verify_attempts"] == 2
    assert "state" not in item
    assert item["duration_ms"] >= 0
    store.close()


# ------------------------- 报告篇幅硬检查 -------------------------


async def test_write_node_expands_short_report_once(monkeypatch):
    """首版报告过短 → 触发一次扩写；扩写达标后不再写「篇幅不足」局限。"""
    calls = {"count": 0}

    class _StubClient:
        async def complete_structured(self, request: Any, schema: type) -> Any:
            calls["count"] += 1
            if calls["count"] == 1:
                payload = schema(
                    title="短版",
                    summary="摘" * 100,
                    sections=[
                        {"heading": "一", "content": "段" * 100},
                        {"heading": "二", "content": "段" * 100},
                    ],
                    limitations=[],
                )
            else:
                payload = schema(
                    title="扩写版",
                    summary="摘" * 160,
                    sections=[
                        {"heading": f"节{index}", "content": "详" * 220}
                        for index in range(3)
                    ],
                    limitations=[],
                )
            return SimpleNamespace(
                data=payload,
                response=SimpleNamespace(
                    usage=SimpleNamespace(model_dump=lambda: {"total_tokens": 1})
                ),
            )

    monkeypatch.setattr(nodes_mod, "_deps", lambda config: (_StubClient(), None))
    update = await nodes_mod.write_node(
        {
            "question": "研究问题",
            "evidence": ["[知识库] 一段证据"],
            "sources": [],
            "analysis": {},
            "plan": {},
        },
        {"configurable": {"thread_id": "thread_write_repair"}},
    )

    report = update["report"]
    assert calls["count"] == 2
    assert report["title"] == "扩写版"
    assert not any("篇幅未完全达到" in item for item in report["limitations"])

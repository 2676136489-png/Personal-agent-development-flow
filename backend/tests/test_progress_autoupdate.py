"""[B37] 「进度自动更新」的回归测试。

背景：云端反向代理会把 `text/event-stream` 整条响应缓冲住（连响应头都不下发），
浏览器 EventSource 永远停在 CONNECTING —— 事件通道彻底不可用。
补偿手段有两条，都必须被固定下来：

1. 后端提供普通 JSON 的事件拉取接口（`GET /api/graph/runs/{id}/events?after=N`），
   任何网关都不会缓冲它；前端据此轮询。
2. 前端在运行期间定时回拉**运行快照**（步骤条 / 轮次 / tokens 的唯一来源），
   不依赖事件通道，所以 SSE 挂掉时进度依然会自己往前走。

这里覆盖第 1 条（可自动化）；第 2 条属前端行为，由 tsc + 构建校验。
"""

from __future__ import annotations

from fastapi.testclient import TestClient

from app.core.config import get_settings
from app.events.bus import emit
from app.main import create_app

QUESTION = "研究 2026 年 AI Agent 开发岗位的主要技术要求，并分析共同点。"


def test_events_endpoint_returns_events_after_id() -> None:
    """按 after 增量拉事件：这是 SSE 被网关缓冲时前端唯一的实时数据来源。"""
    client = TestClient(create_app())
    thread_id = "thread_poll_events"

    for index in range(3):
        emit(thread_id, "step_started", {"index": index})

    first = client.get(f"/api/graph/runs/{thread_id}/events")
    assert first.status_code == 200
    events = first.json()["data"]["events"]
    assert len(events) == 3
    ids = [event["id"] for event in events]
    assert ids == sorted(ids), "事件必须按 id 升序，前端靠它做增量与去重"

    # after = 第 2 条的 id → 只回最后一条（前端正是这样避免重复渲染）
    last_two = client.get(f"/api/graph/runs/{thread_id}/events?after={ids[1]}")
    assert [e["id"] for e in last_two.json()["data"]["events"]] == [ids[2]]

    # 没有新事件时返回空数组，而不是报错
    idle = client.get(f"/api/graph/runs/{thread_id}/events?after={ids[-1]}")
    body = idle.json()["data"]
    assert body["events"] == []
    assert body["last_id"] == ids[-1]


def test_events_endpoint_works_for_unknown_thread() -> None:
    """未知 thread 返回空列表而不是 404。

    前端「先订阅再启动」的顺序决定了订阅时 thread 可能还不存在；
    返回 404 会让轮询循环把「还没开始」误判成「出错」。
    """
    client = TestClient(create_app())
    response = client.get("/api/graph/runs/thread_does_not_exist/events")
    assert response.status_code == 200
    assert response.json()["data"]["events"] == []


def test_settings_point_storage_outside_repo_during_tests() -> None:
    """[B36] 测试会话的 SQLite 路径必须落在一次性临时目录里。

    这条断言守的是一个真实事故：测试曾经直接写生产库
    （storage/agent_runs.db 里 942 条记录，923 条来自 pytest），
    而部署又会把整个 backend/ 打包上传 —— 测试垃圾被原样搬到线上。
    """
    settings = get_settings()
    for path in (
        settings.agent_runs_db_path,
        settings.events_db_path,
        settings.search_quota_db_path,
        settings.knowledge_db_path,
    ):
        assert "ai-research-test-storage-" in path, (
            f"测试会话的数据库路径没有隔离：{path}；"
            "请检查 tests/conftest.py 的环境变量重定向是否被破坏"
        )

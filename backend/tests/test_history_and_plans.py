"""[B26]/[B27] 历史运行删除 与 历史规划存储 的回归测试。"""

from __future__ import annotations

import pytest

from app.events.store import EventStore
from app.graph.plan_store import PlanStore
from app.graph.run_store import RunStore


@pytest.fixture()
def stores(tmp_path):
    runs = RunStore(tmp_path / "runs.db")
    events = EventStore(tmp_path / "events.db")
    plans = PlanStore(tmp_path / "runs.db")  # 与 RunStore 同库不同表（生产形态）
    yield runs, events, plans
    runs.close()
    events.close()
    plans.close()


# ------------------------- [B26] 历史运行删除 -------------------------


def test_delete_run_removes_record(stores):
    runs, _, _ = stores
    runs.upsert(thread_id="thread_a", question="q", status="completed", state={})
    assert runs.delete("thread_a") is True
    assert runs.get("thread_a") is None
    # 再删一次：幂等返回 False（API 层据此回 404）
    assert runs.delete("thread_a") is False


def test_clear_runs_empties_table(stores):
    runs, _, _ = stores
    for i in range(3):
        runs.upsert(thread_id=f"thread_{i}", question="q", status="completed", state={})
    assert runs.delete_all() == 3
    assert runs.list_runs() == []


def test_event_store_delete_and_clear(stores):
    _, events, _ = stores
    events.append(thread_id="thread_a", type="task_started", payload={})
    events.append(thread_id="thread_a", type="task_completed", payload={})
    events.append(thread_id="thread_b", type="task_started", payload={})

    assert events.delete_for_thread("thread_a") == 2
    assert events.list_since("thread_a") == []
    assert len(events.list_since("thread_b")) == 1

    assert events.clear() == 1
    assert events.list_since("thread_b") == []


# ------------------------- [B27] 历史规划存储 -------------------------

_PLAN = {
    "goal": "厘清 X 的三类技术要求",
    "questions": ["q1", "q2", "q3", "q4"],
    "steps": [{"index": 1, "title": "t", "instruction": "i"}],
    "expected_sources": ["招聘网站"],
}


def test_plan_save_list_delete(stores):
    _, _, plans = stores
    record = plans.save(
        question="研究 X",
        plan=_PLAN,
        model="glm-4-flash",
        provider="openai-compatible",
        mock=False,
        usage={"total_tokens": 100},
        latency_ms=1234,
    )
    assert record["id"].startswith("plan_")

    listed = plans.list_plans()
    assert len(listed) == 1
    assert listed[0]["question"] == "研究 X"
    assert listed[0]["plan"]["goal"] == _PLAN["goal"]
    assert listed[0]["mock"] is False

    assert plans.delete(record["id"]) is True
    assert plans.list_plans() == []
    assert plans.delete(record["id"]) is False


def test_plan_store_shares_db_with_run_store(stores):
    """同库不同表：两张表互不干扰。"""
    runs, _, plans = stores
    runs.upsert(thread_id="thread_x", question="q", status="running", state={})
    plans.save(
        question="研究 X", plan=_PLAN, model="m", provider="p",
        mock=False, usage={}, latency_ms=1,
    )

    assert len(runs.list_runs()) == 1
    assert len(plans.list_plans()) == 1
    # 清空运行记录不影响计划表
    runs.delete_all()
    assert runs.list_runs() == []
    assert len(plans.list_plans()) == 1

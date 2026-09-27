"""Research Agent 的状态定义。

[P0] State 是什么：
它是「一次研究任务在所有节点之间流动的那一份数据」。
每个节点读它、返回一个**局部更新**，LangGraph 负责把更新合并回 State。

为什么需要 State（而不是函数之间传参）：
1. 节点之间是「图」而不是「链条」，谁执行谁由条件边决定，传参写不出来
2. 中断/恢复需要把整份状态存下来（checkpoint），没有统一的 State 就没法存
3. 累计型数据（工具调用、引用）需要 reducer 来累加，而不是覆盖
"""

from __future__ import annotations

from operator import add
from typing import Annotated, TypedDict


class ResearchState(TypedDict):
    # ---- 输入 ----
    question: str
    max_iterations: int  # research 节点最多循环几轮（防无限循环）
    max_verify_attempts: int  # verify 不通过时最多回炉几次

    # ---- 各节点的产物 ----
    understanding: dict | None  # understand_task
    plan: dict | None  # plan
    analysis: dict | None  # analyze
    verification: dict | None  # verify
    report: dict | None  # write

    # ---- 累计型数据：用 reducer 累加，节点只返回「新增的部分」 ----
    steps: Annotated[list[dict], add]  # 节点级轨迹
    tool_calls: Annotated[list[dict], add]  # 每一次工具调用
    citations: Annotated[list[dict], add]  # 引用（document_id / chunk_id / page）
    evidence: Annotated[list[str], add]  # 收集到的证据摘要
    usage: Annotated[list[dict], add]  # 每次 LLM 调用的 token
    # 供 UI 展示的「依据来源」，由 app/graph/sources.py 解析产出。
    # 为什么不复用 tool_calls[].output_preview：那是 Agent 路径专属字段，
    # 图路径没有；而且让前端去解析截断过的工具输出，是把协议解析放错了地方。
    sources: Annotated[list[dict], add]

    # ---- 控制字段 ----
    iteration: int  # research 已执行几轮
    verify_attempts: int  # verify 已判定几次
    research_done: bool  # research 主动认为信息够了
    failure_streak: int  # 连续工具失败次数（失败重试的依据）
    finished_reason: str
    error: str | None
    feedback: str | None  # 人工在中断点注入的意见
    approval_granted: bool  # [B33] 人工已批准生成报告（write 前 / 写报告期间为 True）
    status: str  # running | awaiting_approval | completed | failed | cancelled

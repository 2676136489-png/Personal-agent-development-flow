# AI Research Workspace

一个 **Evidence-first（证据优先）的 AI 研究工作台**。用户输入复杂研究任务，LangGraph 驱动的研究工作流自动理解任务、制定计划、调用工具（联网搜索 / 抓取网页 / 计算 / 查知识库）收集证据、分析、验证，在写报告前**中断等待人工确认**，最终产出带来源的研究报告。

**在线地址：<https://ai-research-workspace.app.workbuddy.host/>**

不用配任何东西就能打开看。几点先说明：模型走智谱 GLM-4-Flash 免费档，搜索走 Tavily 免费额度（每月 1000 credit），所以连续跑几次可能会提示额度已用、本次不联网；知识库目前没配真实的 embedding 模型，深度研究里它是被主动排除的（原因见 [`PROJECT.md`](PROJECT.md) 第四节）。

> 当前阶段：**Phase 5 — LangGraph 工作流**。
> 架构与完整路线见 [`docs/01-architecture.md`](docs/01-architecture.md)，协作方式见 [`docs/00-collaboration.md`](docs/00-collaboration.md)。
> 项目整体说明、关键设计取舍与提交记录见 [`PROJECT.md`](PROJECT.md)。

---

## 1. 工作流图

```
START
  ↓
understand_task   拆解研究目标与关键问题
  ↓
plan              生成研究计划
  ↓
research  ←───────────────┐   ← 条件边：证据不足 → 再来一轮（≤ max_iterations）
  ↓                       │
retrieve           查自己的知识库补证据
  ↓
analyze            从证据提炼结论 + 缺口
  ↓
verify   ─────────────────┘   ← 条件边：verdict=needs_more → 回炉（≤ max_verify_attempts）
  ↓
[中断]  等待人工批准（interrupt_before=["write"]）
  ↓
write              生成最终报告
  ↓
END
```

每个节点：读 `ResearchState` → 返回一个**局部更新** → LangGraph 合并回 State。

---

## 2. 目录说明（★ = 本阶段新增/核心）

```
backend/app/
├── graph/
│   ├── state.py    ★  # ResearchState：TypedDict + reducer（累加型字段）
│   ├── nodes.py    ★  # 7 个节点，每个只做一件事
│   ├── graph.py    ★  # 装配：add_node / add_edge / add_conditional_edges / interrupt_before
│   ├── prompts.py  ★  # 各节点 Prompt（与代码分离）
│   ├── schemas.py  ★  # 节点之间的数据契约
│   ├── service.py  ★  # 启动 / 恢复 / 查询
│   └── run_store.py ★ # agent_runs 表：产品视角的运行记录
├── tools/    search_web / fetch_webpage / calculate / search_knowledge_base
├── rag/      parsing → chunking → embeddings → vector → service → store
├── agent/    Phase 3 的手写循环（保留，用于对比）
└── tests/    57 passed
frontend/src/
└── features/workflow/ResearchWorkflow.tsx ★  # 流水线 + 人工审批 + 报告 + 来源
```

---

## 3. 启动

```powershell
cd backend
uv sync
uv run uvicorn app.main:app --reload --host 127.0.0.1 --port 8000

cd frontend   # 另开终端
npm run dev
```

打开 http://127.0.0.1:5173 → **深度研究**。

默认主模型是**本地 Ollama 的 `qwen3:8b`**（`LLM_PROVIDER=ollama`），需要本机已 `ollama serve`
且 `ollama pull qwen3:8b`。本机没有 Ollama 也不会 500：会按 `LLM_FALLBACK_PROVIDER`
回落到云端，或最终退化成离线 Mock（`LLM_PROVIDER=mock`）。
切换模型只改 `.env` 里的 `LLM_PROVIDER`，业务代码零改动，详见 `docs/llm-provider.md`。

---

## 4. API

| 方法 | 路径 | 作用 |
|---|---|---|
| POST | `/api/graph/research` | 启动一次运行（会在 write 前中断） |
| POST | `/api/graph/research/{thread_id}/resume` | 批准（`approved=true` + 可选 `feedback`）或拒绝 |
| GET | `/api/graph/research/{thread_id}` | 查询状态 |
| GET | `/api/graph/runs` | 历史运行列表 |
| GET | `/api/llm/provider` | 当前生效的模型配置（provider / 模型 / 超时 / 兜底，**不含密钥**） |
| GET | `/api/llm/ping` | 真的打一次模型，确认「配对了」且「能答」 |
| POST | `/api/llm/stream` | 流式自测（SSE，逐块返回） |
| GET | `/api/health` | 存活探针（带指标快照） |

```powershell
$r = Invoke-RestMethod -Uri "http://127.0.0.1:8000/api/graph/research" -Method Post `
  -ContentType "application/json; charset=utf-8" `
  -Body '{"question":"研究 2026 年 AI Agent 开发岗位的技术要求","max_iterations":3}'
$r.data.status          # awaiting_approval
$r.data.thread_id

Invoke-RestMethod -Uri "http://127.0.0.1:8000/api/graph/research/$($r.data.thread_id)/resume" `
  -Method Post -ContentType "application/json" -Body '{"approved":true,"feedback":"补充局限"}'
```

---

## 5. 验证

| # | 项 | 方法 | 期望 |
|---|---|---|---|
| 1 | 完整流程 | Workflow 页启动 | 流水线点亮到 verify，状态 `awaiting_approval` |
| 2 | 人工确认 | 填意见 → 批准 | 状态 `completed`，出现 Report（含 sections / limitations） |
| 3 | 拒绝 | 点「拒绝并终止」 | 状态 `cancelled`，无报告 |
| 4 | 循环 | 看 Pipeline | `Research ×N`（N ≤ max_iterations） |
| 5 | 单元测试 | `uv run pytest` | `165 passed` |
| 6 | 静态检查 | `uv run ruff check app tests` | `All checks passed!` |
| 7 | 前端类型 | `npm run typecheck` | 无输出 |

**实测结果**：`understand_task → plan → research ×3 → retrieve → analyze → verify`（中断）→ 批准 → `completed` + 报告；重启进程后仍能查到 `completed` 与报告（来自 `agent_runs` 落库）。

---

## 6. 防失控的四道闸

| 闸 | 位置 | 作用 |
|---|---|---|
| `max_iterations` | 条件边 `route_after_research` | research 循环上限 |
| `max_verify_attempts` | 条件边 `route_after_verify` | 验证回炉上限 |
| `MAX_FAILURE_STREAK` | 条件边 | 连续工具失败 2 次就不再重试 |
| `recursion_limit=50` | invoke config | LangGraph 层面最后保险 |

---

## 7. 关于中断与恢复（重要限制）

- 中断点：`interrupt_before=["write"]` —— **报告发布前必须人工确认**
- 终态不可复活：`completed` / `cancelled` / `failed` 三种终态下再调 resume 会返回 409
- checkpointer 用的是 `InMemorySaver`：
  - ✅ 同一进程内可以「中断 → 恢复」（HTTP 两次请求之间有效）
  - ❌ 进程重启后内存 checkpoint 丢失，**无法继续未完成的中断**
    （此时 resume 会明确返回 409「该运行已不可恢复」，而不是 500）
  - ✅ 但运行结果已落库（`agent_runs` 表），随时可查询/回放；
    落库时会把派生状态（如 `awaiting_approval`）一并写入，重启后查询仍能读到正确状态
- 需要跨重启恢复时：把 checkpointer 换成 `langgraph-checkpoint-sqlite`，其余代码不用改

---

## 8. 本阶段刻意不做的事

| 不做 | 原因 |
|---|---|
| Multi-Agent | 7 个节点共享同一份 State 和同一个 LLM client，它们是一个 Agent 的**阶段**，不是多个互相通信的 Agent |
| 复杂 Memory | `messages` + State 里的 evidence 列表已够用 |
| 并行子任务 | 当前没有明确瓶颈 |
| 跨重启恢复 | 见 §7，等真正需要时再换 checkpointer |

---

## 9. 接下来的阶段

Phase 6：SSE 实时推送节点与工具事件 + 任务历史页面 + Evaluation 指标（成功率 / 引用覆盖率 / 延迟 / token）。

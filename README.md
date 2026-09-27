# AI Research Workspace

一个 **Evidence-first（证据优先）的 AI 研究工作台**。用户输入复杂研究任务，LangGraph 驱动的研究工作流自动理解任务、制定计划、调用工具（联网搜索 / 抓取网页 / 计算 / 查知识库）收集证据、分析、验证，在写报告前**中断等待人工确认**，最终产出带来源的研究报告。

**在线地址：<https://ai-research-workspace.app.workbuddy.host/>**

打开就能用，无需配置任何环境：模型接智谱 GLM-4-Flash，联网检索接 Tavily。

> 当前状态：9 个模块均已可用（深度研究 / 研究规划 / 智能体 / 知识库 / 研究报告 / 效果评估 / 系统设置 / 使用教程 / 概览），后端 237 个测试通过。
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

## 2. 目录说明

```
backend/app/
├── graph/                  研究工作流（LangGraph）
│   ├── state.py            ResearchState：TypedDict + reducer（累加型字段）
│   ├── nodes/              7 个节点，每个只做一件事
│   ├── graph.py            装配：add_node / add_edge / add_conditional_edges / interrupt_before
│   ├── prompts.py          各节点 Prompt（与代码分离）
│   ├── schemas.py          节点之间的数据契约
│   ├── service.py          启动 / 恢复 / 查询（图在后台任务里跑，接口立即返回）
│   ├── run_store.py        agent_runs 表：产品视角的运行记录
│   ├── plan_store.py       研究计划历史
│   └── sources.py          工具输出 → 可展示的依据来源
├── agent/                  智能体工作台：自主工具调用循环 + 运行历史
├── llm/                    统一模型调用层（OpenAI 兼容 / Ollama / Mock / Fallback）
├── rag/                    解析 → 切块 → 向量 → 检索 → 存储
├── search/                 搜索配额记账与额度决策
├── events/                 事件总线 + 落库（可回放）
├── observability/          指标与追踪
├── tools/                  search_web / fetch_webpage / calculate / search_knowledge_base
└── tests/                  237 passed

frontend/src/
├── features/               9 个页面：概览 / 深度研究 / 研究规划 / 智能体 / 知识库 / 研究报告 / 效果评估 / 系统设置 / 使用教程
├── components/             通用组件（步骤条、时间线、证据面板、Toast…）
├── api/                    唯一 HTTP 出口（SSE 与轮询共用同一条数据链路）
└── styles/                 设计 token + 分层样式
```

---

## 3. 启动

```bash
# 后端
cd backend
python -m venv .venv && .venv/Scripts/pip install -e ".[dev]"    # macOS / Linux 用 .venv/bin/pip
cp .env.example .env.local        # 留空 Key 也能跑：会自动落到离线 Mock，全流程畅通
.venv/Scripts/python -m uvicorn app.main:app --reload --port 8000

# 前端（另开终端）
cd frontend
npm install
npm run dev                       # 127.0.0.1:5173
```

打开 http://127.0.0.1:5173 → **深度研究**。

默认主模型是**本地 Ollama 的 `qwen3:8b`**（`LLM_PROVIDER=ollama`），需要本机已 `ollama serve`
且 `ollama pull qwen3:8b`。本机没有 Ollama 也不会 500：会按 `LLM_FALLBACK_PROVIDER`
回落到云端，或最终退化成离线 Mock（`LLM_PROVIDER=mock`）。
切换模型只改 `.env` 里的 `LLM_PROVIDER`，业务代码零改动，详见 `docs/llm-provider.md`。

---

## 4. API

**深度研究（LangGraph 工作流）**

| 方法 | 路径 | 作用 |
|---|---|---|
| POST | `/api/graph/research` | 启动一次运行（会在 write 前中断，立即返回 `running`） |
| POST | `/api/graph/research/{thread_id}/resume` | 批准（`approved=true` + 可选 `feedback`）或拒绝 |
| GET | `/api/graph/research/{thread_id}` | 查询状态与结果快照 |
| GET | `/api/graph/research/{thread_id}/events` | 订阅事件流（SSE） |
| GET | `/api/graph/runs/{thread_id}/events` | 按事件 id 增量拉取（SSE 不可用时的轮询通道） |
| GET | `/api/graph/runs` | 历史运行列表 |
| DELETE | `/api/graph/runs/{thread_id}` · `/api/graph/runs` | 删除一条 / 清空 |

**智能体工作台**

| 方法 | 路径 | 作用 |
|---|---|---|
| POST | `/api/agent/run` | 跑一次自主工具调用循环，返回答案 + 完整轨迹 |
| GET | `/api/agent/runs` · `/api/agent/runs/{id}` | 历史列表（摘要）/ 单条完整结果 |
| DELETE | `/api/agent/runs/{id}` | 删除一条历史 |

**研究规划 · 知识库 · 设置 · 模型**

| 方法 | 路径 | 作用 |
|---|---|---|
| POST | `/api/research/plan` | 生成结构化研究计划 |
| GET | `/api/research/plans` · DELETE `/{plan_id}` | 历史计划列表 / 删除 |
| POST | `/api/knowledge/documents` | 上传并摄入文档（PDF / Markdown / TXT） |
| GET | `/api/knowledge/documents` · `/{id}/chunks` | 文档列表 / 查看切块 |
| POST | `/api/knowledge/search` | 检索知识库 |
| GET | `/api/llm/provider` · `/api/llm/ping` | 当前生效的模型配置（**不含密钥**）/ 真打一次模型 |
| POST | `/api/llm/stream` | 流式自测（逐块返回） |
| GET | `/api/settings` · `/api/settings/run-budget` · `/api/settings/usage` | 配置 / 当日预算 / 用量 |
| GET | `/api/health` | 存活探针（带指标快照） |

```bash
# 启动一次研究
curl -s -X POST http://127.0.0.1:8000/api/graph/research \
  -H "Content-Type: application/json" \
  -d '{"question":"研究 2026 年 AI Agent 开发岗位的技术要求","max_iterations":3}'
# → data.status = awaiting_approval，记下 data.thread_id

# 批准生成报告
curl -s -X POST http://127.0.0.1:8000/api/graph/research/<thread_id>/resume \
  -H "Content-Type: application/json" -d '{"approved":true,"feedback":"补充局限说明"}'
```

---

## 5. 验证

| # | 项 | 方法 | 期望 |
|---|---|---|---|
| 1 | 完整流程 | Workflow 页启动 | 流水线点亮到 verify，状态 `awaiting_approval` |
| 2 | 人工确认 | 填意见 → 批准 | 状态 `completed`，出现 Report（含 sections / limitations） |
| 3 | 拒绝 | 点「拒绝并终止」 | 状态 `cancelled`，无报告 |
| 4 | 循环 | 看 Pipeline | `Research ×N`（N ≤ max_iterations） |
| 5 | 单元测试 | `.venv/Scripts/python -m pytest tests` | `237 passed` |
| 6 | 静态检查 | `.venv/Scripts/python -m ruff check app tests` | `All checks passed!` |
| 7 | 前端类型 | `npm run typecheck` | 无输出 |
| 8 | 布局与跳转 | `frontend/scripts/` 下的 CDP 探针脚本 | 元素几何 / 跳转落地状态符合断言 |

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

## 7. 中断与恢复机制

- 中断点：`interrupt_before=["write"]` —— **报告发布前必须人工确认**
- 终态不可复活：`completed` / `cancelled` / `failed` 三种终态下再调 resume 返回 409
- 恢复范围：checkpointer 目前用 `InMemorySaver`，覆盖同一进程内的两次 HTTP 请求；
  运行结果与会话状态同时落库（`agent_runs` 表），跨进程照样能查询、能回放 ——
  落库时会把派生状态（如 `awaiting_approval`）一并写入，重启后读到的状态与中断时一致
- 需要跨进程恢复时切到 `langgraph-checkpoint-sqlite` 即可，业务代码不用改

---

## 8. 设计上刻意不做的选择

| 不做 | 原因 |
|---|---|
| Multi-Agent | 7 个节点共享同一份 State 和同一个 LLM client，它们是一个 Agent 的**阶段**，不是多个互相通信的 Agent |
| 复杂 Memory | `messages` + State 里的 evidence 列表已够用 |
| 并行子任务 | 当前没有明确瓶颈 |
| 跨进程恢复 | 见 §7，需要时换 checkpointer 即可，不必提前上 |

---

## 9. 可以继续扩展的方向

- 知识库接真实 embedding 模型，把检索从字面匹配升级为语义检索（相关度门槛与证据过滤规则已经就位）
- 报告导出 PDF / Word
- 引用定位到具体段落与页码
- 多用户隔离与鉴权，支持多人协作同一份研究报告

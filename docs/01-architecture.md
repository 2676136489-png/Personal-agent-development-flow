# AI Research Workspace — 架构设计与 MVP 范围定义（Stage 0）

> 本阶段目标：**冻结产品范围与架构，达成共识后再写第一行业务代码。**
> 本阶段不创建业务代码，只产出设计文档、目录骨架约定与决策清单。

---

## 0. 一句话定义与"不是什么"

**一句话定位**
一个 **Evidence-first（证据优先）的 AI 研究工作台**：把开放式复杂问题，转化为「有计划、可观察、可追溯、可复核」的结构化研究报告。

**它是什么**
- 面向「需要查证、需要引用、需要复核」的研究型任务（岗位/竞品/技术选型/政策/学术综述）
- Agent 自主执行，但**过程全透明、结论可溯源、关键节点可人工介入**

**它不是什么（用来约束后续所有需求）**
| 不是 | 理由 |
|---|---|
| ChatGPT 套壳 | 没有计划、没有证据、没有复现能力 |
| PDF 问答 | 只是 RAG 的一个子集，不是研究流程 |
| RAG Demo | RAG 是工具之一，不是产品本体 |
| Multi-Agent 技术秀 | 职责不需要拆分时不拆分 |

**产品的三个真实差异化（决定所有技术投入优先级）**
1. **Evidence-first**：报告中每条关键结论绑定 Evidence（source / url / quote / page / timestamp / relevance），可点击溯源。
2. **Trace-first**：执行过程全量结构化落库（step / tool / 入参摘要 / 结果摘要 / 耗时 / 错误 / 重试），前端实时可见。
3. **Verifiable**：交叉验证、冲突检测、人工审批、Evaluation —— 回答「能不能信」，而不是「说得多好听」。

> 判据：任何新需求，如果不同时增强以上三条之一，Stage 1–3 一律不做。

---

## 1. 用户故事

标注说明：✅ = Stage 1 必须交付；⏳ = 后续阶段；🚫 = 明确不做。

| # | 作为… | 我希望… | 以便… | 阶段 |
|---|---|---|---|---|
| US-1 | 研究者 | 输入一段自然语言研究任务 | 不必手动拆步骤 | ✅ |
| US-2 | 研究者 | 看到 Agent 自动生成的分步研究计划 | 在执行前判断方向是否正确 | ✅ |
| US-3 | 研究者 | 实时看到 Agent 当前在做什么（状态/工具/结果摘要/耗时） | 不盲等、可判断卡在哪 | ✅ |
| US-4 | 研究者 | 拿到结构化研究报告（含结论、证据、来源列表） | 直接用于决策或二次编辑 | ✅ |
| US-5 | 研究者 | 点击报告中的结论，看到原始出处与原文片段 | 验证它不是编的 | ✅ |
| US-6 | 研究者 | 在历史列表中找回上次任务与报告 | 研究是可积累的 | ✅ |
| US-7 | 研究者 | 在关键节点批准/拒绝 Agent 的动作 | 控制成本与风险 | ⏳ Stage 4 |
| US-8 | 研究者 | 上传自己的 PDF/Markdown 作为私有知识源 | 让研究基于我的资料 | ⏳ Stage 3 |
| US-9 | 研究者 | 看到不同来源之间的信息冲突 | 知道哪些结论存疑 | ⏳ Stage 4 |
| US-10 | 团队 Lead | 看到成功率、引用覆盖率、耗时、成本 | 判断系统是否值得信任与投入 | ⏳ Stage 5 |
| US-11 | 任何人 | 用一句话让 AI 替我写论文 | —— | 🚫（不做通用写作工具） |

---

## 2. MVP 功能（Stage 1：能跑通一条真实闭环）

**Stage 1 的唯一目标：一条完整闭环能在你本机跑通，并且每一步都有记录。**

### 2.1 后端能力

| 编号 | 功能 | 说明 |
|---|---|---|
| BE-1 | 项目/任务 REST API | 创建 project、创建 research task、查询任务详情与历史 |
| BE-2 | LLM 抽象层 | OpenAI 兼容协议 + Pydantic 结构化输出 + 超时/重试/token 统计 |
| BE-3 | Planner | 由任务描述生成 3–8 步结构化研究计划（Pydantic 强约束） |
| BE-4 | Agent Orchestrator | 显式状态机循环：选工具 → 执行 → 观察 → 继续/重规划/终止 |
| BE-5 | Tool 框架 | 统一 Tool 协议、超时、重试、结果截断、错误分类、入参校验 |
| BE-6 | `search_web` | 搜索 Provider 抽象；真实实现（Tavily）+ 离线实现（本地语料） |
| BE-7 | `fetch_webpage` | HTTP 抓取 → 正文抽取 → 纯文本；SSRF/大小/超时防护 |
| BE-8 | `save_evidence` | 从页面/搜索结果抽取结构化 Evidence 并落库 |
| BE-9 | Evidence 表与溯源 | 每条证据带 source / url / title / quote / timestamp / task_id |
| BE-10 | Writer（报告生成） | 基于 Plan + Tool 结果 + Evidence 生成结构化报告（JSON Schema 约束） |
| BE-11 | Budget 控制 | max_steps / max_tool_calls / max_tokens / deadline 四道闸 |
| BE-12 | Agent Trace 落库 | agent_runs / research_steps / tool_calls 全量记录 |
| BE-13 | SSE 事件流 | `GET /api/research/{id}/events` 推送全生命周期事件 |
| BE-14 | 统一错误与日志 | 统一错误响应、结构化日志、敏感信息脱敏 |
| BE-15 | 配置管理 | Pydantic Settings + `.env` + `.env.example` |

### 2.2 前端能力

| 编号 | 功能 | 说明 |
|---|---|---|
| FE-1 | 任务创建页 | 输入研究问题 → 创建任务 |
| FE-2 | Agent Workspace | 左侧任务/计划，中部实时 Trace 时间线，右侧 Evidence 流 |
| FE-3 | 报告视图 | 结构化报告渲染，结论可点击跳到 Evidence |
| FE-4 | 历史任务列表 | 复盘与回看 |
| FE-5 | 基础布局与路由 | 侧边导航占位（Dashboard/Knowledge/Reports/Evaluation/Settings 留空壳） |

### 2.3 工程能力

| 编号 | 功能 |
|---|---|
| OPS-1 | `docker-compose.yml`：Postgres（+ 后期服务占位） |
| OPS-2 | Dockerfile（backend / frontend）、`.env.example`、`.gitignore` |
| OPS-3 | README：架构说明 + 本地启动步骤 |
| OPS-4 | 最小单元测试（Planner 解析、Tool 重试、Evidence 抽取） |
| OPS-5 | Git 小步提交（约 10 次，见第 9 节） |

---

## 3. 非 MVP 功能（明确推迟，附推迟理由）

| 功能 | 推迟到 | 为什么现在不做 |
|---|---|---|
| pgvector / Embedding / Rerank | Stage 3 | 先把「解析→切块→入库→检索」链路跑通；先保证闭环，再升级检索质量 |
| 文档上传与 PDF 解析 | Stage 3 | Stage 1 只处理网页来源，避免一次性引入解析、存储、异步任务三套复杂度 |
| Human-in-the-loop 审批 | Stage 4 | 需要完整的中断/恢复机制与前端交互，先把无干预的闭环跑顺 |
| 交叉验证与冲突检测 | Stage 4 | 需要多来源 Evidence 积累，Stage 1 数据密度不足，做了也是假验证 |
| Evaluation 模块 | Stage 5 | 没有可重复的任务集与稳定链路，先评测等于先自欺 |
| Redis | 待定 | **触发条件明确**：需要多实例部署或跨进程事件广播时才引入（见 §7.3） |
| LangGraph | Stage 3/4 对比引入 | Stage 1 用显式状态机，先真正理解「状态、节点、边、中断」是什么，再上框架 |
| MCP | 待定 | 目前没有 MCP 解决的真实痛点；等出现「需要外部工具生态」需求再评估 |
| 多用户 / 登录 / 权限 | Stage 5+ | 单人本地使用场景下，鉴权是纯成本 |
| 多 Agent 协作 | 待定 | 只有当单 Agent + Tools 出现明确的职责瓶颈（如长上下文污染）才拆分 |
| Golden Dataset | Stage 5 | 依赖 Evaluation 框架 |
| CI / 在线 Demo / K8s | Stage 6 | 部署阶段再做 |

---

## 4. 系统架构（Stage 1）

```
┌──────────────────────────────────────────────────────────────┐
│                        Frontend (React + TS + Vite)           │
│  ┌────────────┐ ┌──────────────┐ ┌───────────┐ ┌──────────┐ │
│  │ Task Create│ │Agent Workspace│ │  Report   │ │ History  │ │
│  └─────┬──────┘ └──────┬───────┘ └─────┬─────┘ └────┬─────┘ │
│        │  REST         │ SSE (EventSource)  REST    REST     │
└────────┼───────────────┼──────────────────┼────────────┼─────┘
         │               │                  │            │
         ▼               ▼                  ▼            ▼
┌──────────────────────────────────────────────────────────────┐
│                     FastAPI Application                       │
│  ┌────────────────────────────────────────────────────────┐  │
│  │ API Layer        /projects  /research  /reports  /events│  │
│  ├────────────────────────────────────────────────────────┤  │
│  │ Service Layer    ResearchService  ReportService         │  │
│  ├────────────────────────────────────────────────────────┤  │
│  │ Agent Layer      Orchestrator (显式状态机)              │  │
│  │                  Planner │ Executor │ Writer            │  │
│  ├────────────────────────────────────────────────────────┤  │
│  │ Tool Layer       search_web  fetch_webpage  save_evidence│ │
│  ├────────────────────────────────────────────────────────┤  │
│  │ Infra Layer      LLMClient │ EventBus │ Repos │ Settings│  │
│  └────────────────────────────────────────────────────────┘  │
└───────────────┬──────────────────────┬───────────────────────┘
                │                      │
        ┌───────▼────────┐    ┌────────▼─────────┐
        │  PostgreSQL 16 │    │  External APIs    │
        │  (SQLAlchemy)  │    │  LLM / Search     │
        └────────────────┘    └──────────────────┘
```

**分层规则（Stage 1 就要立起来）**
- API 层只做**参数校验与序列化**，不写业务逻辑
- Service 层编排事务与用例，不直接拼 SQL、不直接调 LLM
- Agent 层不感知 HTTP、不感知数据库实现（通过 Repository 接口）
- Tool 层是纯函数式单元：输入 Pydantic 模型，输出 `ToolResult`，可单测
- Infra 层封装一切外部依赖，**这是可测试性的根**

---

## 5. Agent 架构

### 5.1 为什么 Stage 1 是「单 Agent + Tools」而不是 Multi-Agent

- 研究任务的瓶颈目前在于「工具质量 + 上下文管理」，不在于「角色数量」
- 多 Agent 会立刻引入：上下文传递、消息协议、角色间冲突仲裁、调试困难
- 单 Orchestrator 已能覆盖 Plan → Act → Observe → Synthesize 全流程
- **拆分触发条件（写死在文档里，作为未来决策依据）**：当单个 Agent 的上下文/职责出现明确瓶颈（如检索与写作互相污染、需要并行子任务）时，再按 Planner / Researcher / Writer 拆分

### 5.2 Orchestrator 状态机

```
                 ┌──────────┐
                 │ CREATED  │
                 └────┬─────┘
                      ▼
                 ┌──────────┐   plan 失败(重试1次)
                 │ PLANNING │──────────────────► FAILED
                 └────┬─────┘
                      ▼
              ┌───────────────┐
              │ WAITING_APPROVAL│  ← Stage 4 启用（计划需人工确认）
              └────┬───────────┘
                   ▼
        ┌────► ┌────────┐
        │      │ RUNNING│
        │      └───┬────┘
        │          ▼
        │   ┌─────────────┐
        │   │ SELECT_TOOL │  (LLM 决策：下一步用哪个工具、什么参数)
        │   └──────┬──────┘
        │          ▼
        │   ┌─────────────┐  超时/异常 → retry(指数退避, ≤N)
        │   │ EXECUTE_TOOL│──────────────► 记录 tool_call(failed)
        │   └──────┬──────┘                └─ 连续失败 → step 失败
        │          ▼
        │   ┌─────────────┐
        │   │  OBSERVE    │  结果截断 → 写入 Evidence → 更新步骤状态
        │   └──────┬──────┘
        │          ▼
        │   ┌─────────────┐   未完成 & budget 未超 ──┐
        │   │  DECIDE     │──────────────────────────┘
        │   └──────┬──────┘
        │          ├─ 完成 ──────► SYNTHESIZE
        │          ├─ 需要更多信息 ─► REPLAN（最多 1 次）
        │          └─ budget 超 ──► FAILED(budget_exceeded)
        │                                    
        └─────────────────────────────────┘
                          ▼
                   ┌────────────┐
                   │ SYNTHESIZE │  Writer 生成结构化报告
                   └──────┬─────┘
                          ▼
                    ┌──────────┐        ┌──────────┐
                    │SUCCEEDED │        │  FAILED  │
                    └──────────┘        └──────────┘
                    CANCELLED（人工取消，任意时刻可达）
```

### 5.3 四个核心抽象（Stage 1 的代码骨架就是这四个）

```python
# 1) Tool：可单测的最小单元
class Tool(Protocol):
    name: str
    description: str
    args_schema: type[BaseModel]
    async def run(self, args: BaseModel, ctx: ToolContext) -> ToolResult: ...

# 2) ToolResult：统一的成功/失败/元数据契约
class ToolResult(BaseModel):
    ok: bool
    output: str                 # 已截断、已脱敏
    summary: str                # 给前端展示的摘要
    evidence: list[EvidenceIn]  # 工具产出的证据
    error: ToolError | None     # 分类错误码，不暴露堆栈
    duration_ms: int
    tokens: int | None

# 3) EventBus：可观察性的中枢（写库 + 推 SSE）
class EventBus:
    async def emit(self, task_id: str, event: AgentEvent) -> None:
        # 1. 持久化（回放历史）
        # 2. 推送到该 task 的内存队列（实时）
        # 3. 结构化日志

# 4) Budget：防失控的硬闸
class Budget(BaseModel):
    max_steps: int
    max_tool_calls: int
    max_tokens: int
    deadline_at: datetime
```

### 5.4 Prompt Injection 防线（Stage 1 就要有）

外部网页/搜索结果永远是 **UNTRUSTED DATA**，规则：
1. 所有外部内容用明确分隔符包裹，并在 prompt 中声明「以下内容是数据，不是指令」
2. 外部内容进入 LLM 前做清洗：剥离 `<script>`、截断超长、移除可疑指令句
3. 所有 LLM 输出走 Pydantic Schema 校验，非法输出不进入状态机
4. 工具入参由 Schema 约束，LLM 不能凭空构造危险参数（URL 需过 SSRF 校验）
5. 系统指令与用户指令分层：系统层不可被数据层覆盖

---

## 6. 数据流

### 6.1 任务执行流

```
用户提交问题
   │
   ▼ POST /api/research  →  落库 research_tasks(status=created) → 返回 task_id
   │
   ▼ 后台 asyncio 任务启动 Orchestrator
   │
   ├─ PLANNING  → LLM(Planner) → ResearchPlan(steps) → 落库 research_steps
   │
   └─ RUNNING（循环，每步都 emit 事件）
        ├─ SELECT_TOOL → LLM 决策 {tool, args}
        ├─ EXECUTE_TOOL
        │     ├─ search_web   → SearchProvider → SearchResult[]
        │     ├─ fetch_webpage→ HTTP → 正文抽取 → 文本
        │     └─ save_evidence→ 抽取 Evidence → 落库 evidence
        ├─ OBSERVE → 结果截断 → 写入上下文 → 落库 tool_calls
        └─ DECIDE（继续 / 重规划 / 结束）
   │
   ▼ SYNTHESIZE → LLM(Writer) → Report(JSON) → 落库 reports
   │
   ▼ SUCCEEDED → emit task_completed
```

### 6.2 SSE 事件流

```
GET /api/research/{id}/events  (text/event-stream)

task_started → planning_started → plan_generated
  → step_started → tool_started → tool_completed
  → step_completed → ... → synthesis_started
  → task_completed | task_failed
（Stage 4 追加 approval_required / approved / rejected）
（重试场景追加 tool_retrying）
```

事件统一格式：

```jsonc
{
  "id": "evt_xxx",
  "task_id": "tsk_xxx",
  "type": "tool_completed",
  "ts": "2026-09-23T10:00:00Z",
  "payload": {
    "step_index": 2,
    "tool": "fetch_webpage",
    "input_summary": "url=https://...",     // 只给摘要
    "output_summary": "fetched 4123 chars",
    "duration_ms": 812,
    "error": null,
    "retry_count": 0
  }
}
```

> 明确不展示：模型的中间推理链、完整 prompt、API Key、内部堆栈。

### 6.3 关于 SSE 与 Redis（何时才需要 Redis）

Stage 1 用**进程内 `asyncio.Queue` + 单 worker（uvicorn --workers 1）**，事件同时落库用于历史回放。
**引入 Redis 的真实触发条件**（满足任一即引入，否则不引）：
1. 需要多进程/多实例部署，事件必须跨进程广播
2. 需要任务队列（任务量超过单机瞬时吞吐）
3. 需要分布式限流或跨实例幂等

---

## 7. 技术栈与选型理由

| 技术 | 用途 | 为什么用它（针对本项目） | 何时引入 |
|---|---|---|---|
| Python 3.12 | 后端语言 | LLM/数据生态最完整；类型注解成熟 | Stage 1 |
| FastAPI | Web 框架 | 原生 async（SSE 必需）+ 自动 OpenAPI + Pydantic 深度集成 | Stage 1 |
| Pydantic v2 | 数据校验 / 结构化输出 | 同时承担「API 校验」和「LLM 输出约束」，一处定义多处复用 | Stage 1 |
| SQLAlchemy 2.0 | ORM | 2.0 风格类型友好，避免裸 SQL 注入风险 | Stage 1 |
| Alembic | 数据库迁移 | 表结构演进必须可追溯，否则协作必炸 | Stage 1 |
| PostgreSQL 16 | 主库 | JSONB 存工具输出/事件；后续 pgvector 直接扩展，无需换库 | Stage 1 |
| OpenAI-compatible SDK | LLM 调用 | 一套代码适配 OpenAI/DeepSeek/通义/智谱/Moonshot，换 `base_url` 即可 | Stage 1 |
| Tavily API | 网页搜索 | 返回内容结构化、适合 Agent（含正文摘要），比通用搜索 API 更适合研究场景 | Stage 1（可用离线 Provider 替代） |
| httpx | 外部 HTTP | async 支持好，超时控制精确 | Stage 1 |
| tenacity | 重试 | 指数退避 + 异常分类，比手写 retry 可靠 | Stage 1 |
| structlog / logging | 日志 | 结构化日志，便于脱敏与检索 | Stage 1 |
| pytest | 测试 | Tool 是纯函数，天然可单测 | Stage 1 |
| React 18 + TypeScript | 前端 | 类型安全，接口契约可与后端对齐 | Stage 1 |
| Vite | 构建 | 启动快，学习成本低 | Stage 1 |
| Tailwind CSS | 样式 | 克制、专业、易统一；避免"霓虹科技风" | Stage 1 |
| TanStack Query | 数据获取 | 缓存/重试/失效管理；避免手写 loading 状态 | Stage 2（Stage 1 先用 fetch 封装） |
| pgvector + Embedding + Rerank | 语义检索 | 关键词检索撑不住研究型语义查询时升级 | Stage 3 |
| LangGraph | 工作流编排 | 当状态机分支变多、需要持久化中断/恢复时替换手写状态机 | Stage 3/4 评估 |
| Redis | 跨进程事件/队列/限流 | 见 §6.3 触发条件 | 待定 |
| Docker / Compose | 部署与环境一致性 | 一次配置，本机与服务器同构 | Stage 1（Postgres）+ Stage 6（全量） |
| GitHub Actions | CI | 保证测试与类型检查不退化 | Stage 6 |

---

## 8. 数据模型（Stage 1 最小集，8 张表）

> 原则：只建「当前功能真正读写」的表。`documents / document_chunks / users / evaluations / settings` 现在不建。

```
projects          研究项目容器（Stage 1 允许一个默认项目）
  id, name, description, created_at

research_tasks    一次研究任务
  id, project_id, title, question, status, budget_json,
  current_step_index, error_code, started_at, finished_at, created_at

research_steps    计划中的每一步
  id, task_id, index, title, instruction, status,
  result_summary, retry_count, started_at, finished_at

sources           来源（去重后的 URL/文档）
  id, task_id, url, domain, title, source_type, fetched_at, http_status

evidence          证据（产品核心资产）
  id, task_id, source_id, quote, context, page,
  relevance, extracted_by, created_at

tool_calls        每次工具调用（可观察性的原子记录）
  id, task_id, step_id, tool_name, input_json, output_summary,
  status, error_code, retry_count, duration_ms, tokens, created_at

agent_runs        一次完整运行（含模型与成本统计）
  id, task_id, status, model, prompt_tokens, completion_tokens,
  estimated_cost_usd, started_at, finished_at

reports           最终报告
  id, task_id, title, summary, sections_json, findings_json,
  limitations, status, created_at
```

**关键设计点**
- `tool_calls.input_json` 用 JSONB：工具入参多变，但都需要可审计
- `evidence.source_id` 外键到 `sources`：实现「一条来源 → 多条证据」的复用与去重
- `research_tasks.budget_json`：Budget 是可配置策略，不该写死在代码
- 所有金额/耗时字段在写入时就计算，Evaluation 阶段只需聚合

---

## 9. 第一阶段开发计划（Stage 1，约 10 次提交）

| Commit | 内容 | 你会学到 |
|---|---|---|
| 1 | `chore: init repo structure, gitignore, env example` | 项目骨架 / 环境变量管理 |
| 2 | `chore: add docker-compose with postgres` | Docker Compose / 本地依赖服务 |
| 3 | `feat: FastAPI app skeleton, settings, logging, error handling` | FastAPI 应用工厂 / Pydantic Settings |
| 4 | `feat: SQLAlchemy models + alembic migration (8 tables)` | ORM 建模 / 数据库迁移 |
| 5 | `feat: repository layer + research task CRUD API` | 分层架构 / RESTful 设计 |
| 6 | `feat: LLM client with structured output and retry` | LLM API / Structured Output / 重试 |
| 7 | `feat: tool framework (protocol, timeout, retry, result)` | Tool Calling 抽象 |
| 8 | `feat: search_web + fetch_webpage tools with SSRF guard` | 外部 API 集成 / 安全边界 |
| 9 | `feat: planner + orchestrator state machine + budget` | Agent 循环 / 状态机设计 |
| 10 | `feat: writer, evidence extraction, report persistence` | 报告生成 / 证据建模 |
| 11 | `feat: SSE event bus + event endpoint` | SSE 实时推送 |
| 12 | `feat: frontend workspace (create task, trace timeline, report)` | React/TS/SSE 消费 |
| 13 | `test: unit tests for planner, tools, orchestrator` | pytest / 可测试性 |
| 14 | `docs: README with architecture and run instructions` | 技术文档写作 |

> 每个 commit 我都会按「目标 → 为什么 → 涉及技术 → 改动文件 → 代码 → 运行命令 → 验收 → 必学知识点」的顺序推进。

---

## 10. 项目目录（Stage 1）

```
/
├── backend/
│   ├── app/
│   │   ├── main.py                 # 应用工厂、路由注册、异常处理
│   │   ├── core/
│   │   │   ├── config.py           # Pydantic Settings（读 .env）
│   │   │   ├── logging.py          # 结构化日志 + 脱敏
│   │   │   ├── errors.py           # 统一错误码与响应
│   │   │   └── security.py         # SSRF 校验、内容清洗
│   │   ├── db/
│   │   │   ├── base.py             # SQLAlchemy Base / Session
│   │   │   ├── models.py           # ORM 模型
│   │   │   └── repositories/       # 数据访问层
│   │   ├── llm/
│   │   │   ├── client.py           # LLMClient（超时/重试/token 统计）
│   │   │   └── schemas.py          # 结构化输出模型
│   │   ├── agent/
│   │   │   ├── orchestrator.py     # 状态机主循环
│   │   │   ├── planner.py          # 计划生成
│   │   │   ├── writer.py           # 报告生成
│   │   │   ├── budget.py           # 预算控制
│   │   │   ├── events.py           # AgentEvent 定义
│   │   │   └── prompts/            # Prompt 模板（与代码分离）
│   │   ├── tools/
│   │   │   ├── base.py             # Tool 协议 / ToolResult
│   │   │   ├── registry.py         # 工具注册表
│   │   │   ├── search_web.py
│   │   │   ├── fetch_webpage.py
│   │   │   └── save_evidence.py
│   │   ├── services/
│   │   │   ├── research_service.py
│   │   │   └── report_service.py
│   │   ├── api/
│   │   │   ├── deps.py
│   │   │   └── routes/             # projects / research / reports / events
│   │   └── schemas/                # API 请求/响应模型
│   ├── alembic/
│   ├── tests/
│   ├── pyproject.toml
│   └── Dockerfile
├── frontend/
│   ├── src/
│   │   ├── api/                    # 请求封装（统一 baseURL/错误）
│   │   ├── components/             # 通用组件
│   │   ├── features/
│   │   │   ├── workspace/          # Agent Workspace
│   │   │   ├── reports/
│   │   │   └── history/
│   │   ├── types/                  # 与后端对齐的 TS 类型
│   │   ├── hooks/
│   │   └── App.tsx
│   ├── index.html
│   └── package.json
├── docs/
│   ├── 01-architecture.md          # 本文档
│   └── 02-api.md                   # 后续补充
├── scripts/                        # 启动/迁移/种子脚本
├── docker-compose.yml
├── .env.example
├── .gitignore
└── README.md
```

---

## 11. Stage 1 必须掌握的知识（只学这些，学到这里为止）

| 主题 | 学到什么程度 | 为什么现在学 |
|---|---|---|
| Python 类型注解 + async/await | 能读懂并写出带类型注解的 async 函数，理解 `await` 为什么能让 SSE 与工具调用并发 | 后端全栈代码的基础语法层 |
| Pydantic v2 | 会定义模型、嵌套模型、validator；理解它为什么同时能做 API 校验和 LLM 输出约束 | 本项目类型安全的基石 |
| FastAPI 路由/DI/异常 | 会写一个带依赖注入的路由，理解 `APIRouter`、`Depends` | API 层全部依赖它 |
| SQLAlchemy 2.0 + Alembic | 会定义模型、写一次迁移、用 session 增删改查 | 数据持久化最小能力 |
| LLM API + Structured Output | 理解 messages/roles、temperature、为什么要用 JSON Schema 约束输出 | Agent 的所有"决策"都来自这里 |
| Tool Calling 抽象 | 理解「LLM 只产出工具名和参数，真正执行的是你的代码」 | Agent 的核心机制 |
| SSE | 理解为什么用 SSE 而不是 WebSocket（单向、自动重连、HTTP 原生） | 实时 Trace 的实现基础 |
| React + TS 基础 | 组件、状态、类型定义、EventSource 消费 | 前端最小能力 |

**明确暂不学**：Embedding 原理、向量数据库、Rerank 算法、LangGraph 内部机制、Redis 数据结构、K8s。
（等它们真正出现在计划里再学，否则知识是悬空的。）

---

## 12. Stage 1 验收标准（可复现、可判定）

**功能性**
1. `docker compose up -d` 后 Postgres 正常启动，Alembic 迁移成功
2. 通过 API 创建 research task，返回 `task_id`
3. 无外网/无 API Key 时，用离线 Search Provider **仍能跑完整条闭环**并产出报告
4. 配置真实 LLM Key + Tavily Key 后，能对真实问题产出带证据的报告
5. 报告中至少 3 条 findings，每条能关联到至少 1 条 Evidence
6. Evidence 记录含可点击的 url、原文 quote、抓取时间

**可观察性**
7. 前端 Trace 时间线能看到：planning → 每个 step → 每个 tool（名称/耗时/结果摘要）→ completed
8. 数据库中 `tool_calls` 记录数 ≥ 实际工具调用数，`agent_runs` 有 token 与成本估算
9. 前端不展示任何模型内部推理文本

**健壮性**
10. 断网时工具调用失败被正确捕获，状态机进入 FAILED 且前端显示可读错误（不是 500 堆栈）
11. 人为把某个工具改成必失败，重试 N 次后终止，不无限循环
12. 超过 `max_tool_calls` 时任务被 budget 终止，不产生失控费用

**工程**
13. `pytest` 通过（Planner 解析、Tool 重试、Evidence 抽取至少各 1 个用例）
14. `.env.example` 完整，代码中无硬编码密钥
15. README 能让一个陌生人按步骤启动项目
16. Git 历史是小步提交，每次提交信息语义清晰

---

## 13. 需要你拍板的 6 个决策（确认后才进入编码）

| # | 决策点 | 选项 A | 选项 B | 我的建议 |
|---|---|---|---|---|
| D1 | Stage 1 数据库 | PostgreSQL（docker-compose 起，贴近生产） | SQLite（零依赖，先跑通） | **A + 逃生舱**：主用 Postgres，但 `DATABASE_URL` 支持切 SQLite，本机没 Docker 也能跑 |
| D2 | LLM Provider | OpenAI 兼容层（换 base_url 适配多家） | 只接 OpenAI | **A**：你人在国内，兼容层能直接切 DeepSeek/通义/Moonshot，成本和学习收益都更高 |
| D3 | 搜索 Provider | Tavily（真实搜索，需 Key） | 只做离线 Mock | **A + Mock 兜底**：两个实现都写，没 Key 也能跑通闭环 |
| D4 | 是否 Stage 1 就做 RAG 向量检索 | 推迟到 Stage 3（先用关键词/全文检索） | Stage 1 就上 pgvector | **推迟**：先把闭环跑通；向量检索的价值在多文档积累后才显现 |
| D5 | 前端 UI 方案 | Tailwind + 少量自研组件（克制、可控） | Ant Design（开箱即用、信息密度高） | **A**：更贴合"专业研究工具"气质，也更能学到东西；组件量在 Stage 1 很小 |
| D6 | LangGraph 何时引入 | Stage 3/4（先手写状态机理解原理） | Stage 1 直接用 | **推迟**：先用 200 行显式状态机搞懂"状态/节点/边/中断"，再用框架才不会被框架绑架 |

---

## 14. 下一步

你确认（或调整）第 13 节的 6 个决策后，我按第 9 节的提交序列开始 **Commit 1：仓库骨架 + 配置 + Git**，并在每次提交后给出：运行命令、预期结果、测试方法、必须理解的知识点、关键代码位置、面试可讲的点。

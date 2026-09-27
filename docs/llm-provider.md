# 统一模型调用层：DeepSeek → 本地 Ollama qwen3:8b

> 代码：`backend/app/llm/client.py`、`backend/app/core/config.py`、`backend/app/api/routes/llm.py`
> 配置：`LLM_PROVIDER` / `OLLAMA_*` / `LLM_FALLBACK_PROVIDER`

---

## 1. 改了什么

| 之前 | 现在 |
| --- | --- |
| 只有一条路：`OpenAICompatibleClient` 打 DeepSeek | 注册表式多 provider：`ollama` / `openai`（兼容层）/ `mock` |
| Ollama 只能借道 OpenAI 兼容层（`/v1`），本地专属参数全丢了 | 新增 `OllamaClient`，走 Ollama **原生** `/api/chat` |
| 主模型挂掉 = 整个应用不可用 | `FallbackLLMClient`：连接/超时/5xx 才兜底，且如实标注降级 |
| 只有一次性返回 | `stream()` 进入 `LLMClient` 协议，Ollama / 兼容层都实现真流式 |

**默认主模型已切换为本地 `qwen3:8b`**（`.env.local` 与 `.env.example` 的 `LLM_PROVIDER=ollama`）。

调用点全部不变：`get_llm_client()` 依旧返回 `LLMClient` 协议对象，
LangGraph 节点、Planner、Agent 循环一行都没改 —— 这就是把差异收进 provider 的意义。

---

## 2. 请求参数的适配

OpenAI 语义与 Ollama 原生字段不是一一对应的，翻译集中在 `OllamaClient._payload()`：

| 统一层（`LLMRequest`） | Ollama 原生 | 说明 |
| --- | --- | --- |
| `max_tokens` | `options.num_predict` | **不是** `max_tokens`。8B 模型建议 ≥4096，否则 JSON 会被截断 |
| `temperature` | `options.temperature` | 同名同义 |
| `response_format={"type":"json_object"}` | `format: "json"` | schema 校验仍由本地 `parse_structured_payload` 做，不依赖上游 |
| `messages` | `messages` | 同为 `{role, content}` 列表 |
| `options` 透传 | `options.*`（`num_ctx` / `stop` / `top_p`…） | 调用点可按需覆盖，不用改 client |
| （无对应） | `keep_alive` | 模型常驻显存时长，`5m` 避免每次冷启动 |
| （无对应） | `think` | qwen3 是思考型模型，关闭可显著降低延迟与推理 token |
| （无对应） | `options.num_ctx` | 上下文窗口，默认 8192 |

⚠️ **两个坑**
1. `OLLAMA_BASE_URL` **不要写 `/v1`**：`/api/chat` 才是原生端点（代码里会自动去掉 `/v1` 后缀兜底）。
2. `keep_alive` / `think` 这类私有字段**只对 Ollama 下发**（`_is_ollama()` 判断仍在兼容层里保留），
   发给 OpenAI / DeepSeek 会被当成未知字段，轻则忽略重则 400。

---

## 3. 超时的适配

| 场景 | 云端 API | 本地 8B 模型 | 本项目的取值 |
| --- | --- | --- | --- |
| 首 token 延迟 | 0.3–1s | **2–8s**（模型还要从磁盘/显存加载） | — |
| 完整一次结构化输出 | 1–5s | 8–40s（思考开着更久） | — |
| 单次调用超时 | 30–60s 够 | 必须 ≥120s | `OLLAMA_TIMEOUT_SECONDS=120`（云端 `LLM_TIMEOUT_SECONDS=60`） |
| 重试 | 3 次 | 3 次，但**只对超时/连接/5xx** | `LLM_MAX_ATTEMPTS=3` |

配套的另外两道闸（与模型无关，但决定了最坏耗时）：

- `AGENT_TOTAL_TIMEOUT_SECONDS=120`：一次 run 的墙钟上限
- `TOOL_OUTPUT_MAX_CHARS=3000`：工具输出进上下文前的截断，防止把 `num_ctx` 撑爆

> 实测（本机 qwen3:8b）：普通问答 686ms；结构化 JSON 一次成型；流式首块 <1s。

---

## 4. 流式输出的适配

`LLMClient` 协议新增 `stream()`：

```python
async for chunk in client.stream(request):   # chunk: LLMStreamChunk
    if chunk.done:
        ...                                   # chunk.response 带 usage / latency
    else:
        print(chunk.text, end="")             # 增量文本
```

三条实现路径：

| provider | 行为 |
| --- | --- |
| `OllamaClient` | **NDJSON 逐行解析**（Ollama 不是 SSE！一行一个 JSON），收尾块的 `done:true` 带 `prompt_eval_count` / `eval_count` / `done_reason` |
| `OpenAICompatibleClient` | 标准 SSE delta；不满足流式条件时退化成一次性返回 |
| `MockLLMClient` / 其它 | 走 `BaseLLMClient.stream` 默认实现：算完一次吐出，语义一致 |

**刻意不做流式的情况**：请求 `response_format`（要结构化 JSON）时不流式 ——
半截 JSON 既不能增量解析，逐字吐出来也只是噪音。

对外接口：`POST /api/llm/stream`（SSE），前端在「系统设置 → 模型 → 流式输出自测」可以逐字看到结果。
用 POST 而非 EventSource：提示词是中文长文本，放 query string 会被代理截断。
响应头带了 `X-Accel-Buffering: no`，否则 Nginx 会缓冲到整段生成完才推第一块。

---

## 5. 兜底链（换主模型不会把功能打挂）

```env
LLM_PROVIDER=ollama          # 主模型
LLM_FALLBACK_PROVIDER=openai # 兜底（线上沙箱没有 Ollama，必须配）
```

`FallbackLLMClient` 的触发条件刻意收窄：

- ✅ 兜底：`connection`（Ollama 没启动）/ `timeout` / `server`（5xx）
- ❌ 不兜底：`invalid_request`（模型没 pull）/ 解析失败 / 业务性错误

第二条是原则问题：静默换模型去掩盖业务逻辑错误，只会把故障藏得更深。

降级会在**两个层面**留痕，绝不假装没发生：

1. 单次响应：`LLMResponse.provider` 变成 `"openai-compatible+fallback"`
2. 全局状态：`GET /api/llm/provider` 返回 `degraded: true` 与
   `active_provider`（实际作答方），设置页会显示黄色「已降级」提示条

## 两段式降级（为什么要冷却期）

主模型挂掉时若每次请求都先试一遍主模型，用户就要为**每一次调用**付出一整段超时：
线上原本是 `20s × 重试 3 次 = 60s`。因此：

1. 连续失败 `LLM_FALLBACK_THRESHOLD` 次 → 判定主模型不可用，进入冷却
2. 冷却期内（`LLM_FALLBACK_COOLDOWN_SECONDS`）**直连兜底**，不再试探主模型
3. 冷却结束后再探一次；成功则彻底恢复

线上取值：`OLLAMA_TIMEOUT_SECONDS=3`（最坏 9s）+ `LLM_FALLBACK_COOLDOWN_SECONDS=300`。

---

## 6. 怎么换回 / 换成别的模型

| 目标 | 改法 |
| --- | --- |
| 换本地模型（如 qwen3:14b） | `OLLAMA_MODEL=qwen3:14b`（先 `ollama pull`） |
| 换回 DeepSeek | `LLM_PROVIDER=openai` + `LLM_BASE_URL=https://api.deepseek.com` + `LLM_MODEL` |
| 换通义 / Moonshot / 智谱 | 同上，只改 `LLM_BASE_URL` 与 `LLM_MODEL` |
| 新增一个厂商 | 在 `app/llm/client.py` 加一个 `BaseLLMClient` 子类 + 在 `build_llm_client()` 注册一行 |
| 纯离线跑 | `LLM_PROVIDER=mock` |

排障入口：`GET /api/llm/provider`（当前配置，不含密钥）、`GET /api/llm/ping`（真的打一次模型）。

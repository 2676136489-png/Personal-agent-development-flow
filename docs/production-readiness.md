# 上线就绪审计（Production Readiness）

> 范围：FastAPI 单端口服务（同源托管 React SPA）+ `/api`。
> 目标：从「本地能跑」提升到「可对外上线」的标配项。
> 最近更新：2026-09-26

本文既记录**已修复项**，也保留**待办清单**（按 P1/P2 排序），作为后续迭代的 checklist。

---

## ✅ 本轮已修复

### 前端
| 项 | 说明 |
|---|---|
| 全局 Error Boundary | 新增 `components/ErrorBoundary.tsx`，在 `main.tsx` 最外层包裹 `App`。任一渲染异常不再白屏，落到友好兜底页（刷新 / 回首页 + 错误详情）。 |
| index.html 加固 | 加 `<noscript>` 可读回退、`color-scheme`、`theme-color`（明/暗两套）。 |
| **非 JSON 响应诊断**（`api/client.ts`） | 改为**先读文本再解析 JSON**：非 JSON 时带上 HTTP 状态、Content-Type、响应片段，并区分「网关 HTML 错误页」与「接口地址不对」；修掉同源部署下「无法连接后端（）」空括号文案。 |

### 后端
| 项 | 说明 |
|---|---|
| 安全响应头 | 新增纯 ASGI `SecurityHeadersMiddleware`：`X-Content-Type-Options`、`X-Frame-Options: DENY`、`Referrer-Policy`、`Permissions-Policy`、`Cross-Origin-Opener-Policy`、`CSP`，生产环境追加 `HSTS`。 |
| CSP | `default-src 'self'`；脚本仅同源（构建产物无内联脚本）；样式/字体放行 Google Fonts。可用 `CONTENT_SECURITY_POLICY` 覆盖或置空关闭。 |
| GZip 压缩 | 只对 `/assets` 静态挂载点启用 —— **不给全局加** `GZipMiddleware`，因为那会缓冲压缩 SSE 事件流。 |
| 静态缓存策略 | `/assets/*`（内容哈希）→ `public, max-age=31536000, immutable`；`index.html` → `no-cache`。杜绝「部署后旧 HTML 指向已删 chunk → 白屏」。 |
| 生产关闭 API 文档 | `API_DOCS_ENABLED=false` 时 `/api/docs`、`/api/openapi.json` 返回 404。 |
| 昂贵端点限流 | 新增纯 ASGI `RateLimitMiddleware`（进程内滑窗，按客户端 IP），防刷爆免费 LLM Key 与 Tavily 额度；返回统一错误信封 + `Retry-After`。默认关，生产 `.env.production` 开。 |
| 可观测性接线 | 指标真正接入工具 / 搜索 / LLM / 图运行（详见 `tests/test_observability_wiring.py`）。 |
| **`/api` 永不返回纯文本** | 新增最外层 `JsonErrorFallbackMiddleware`：外层中间件自身抛异常时也返回统一 JSON 信封（此前 Starlette 会回纯文本 `Internal Server Error`）。 |
| **结构化输出容错** | `AgentDecision` 二选一从「硬失败」改为「能救则救 + 带修复提示重试一次」（详见 `tests/test_structured_repair.py`）。 |

### 验证
- 前端 `npm run build` 通过；后端 `pytest` **181 passed**；`ruff` 改动文件全绿。
- 运行时冒烟（5 项全过）：安全头 / 文档关闭 / index `no-cache` / 资产 `immutable+gzip` / 限流 429。

---

## 🔧 待办（P1，上线前后尽快）

### 前端
- **字体来源风险**：当前从 `fonts.googleapis.com` 拉 Fraunces / Public Sans / JetBrains Mono。国内网络对该域可能不可达或不稳定，且外链 CSS **阻塞首屏渲染**。建议二选一：
  1. 自托管 woff2（放 `public/fonts/` + `@font-face`），彻底消除外链；或
  2. 反正文字栈已有系统回退（思源宋体/苹方/等宽），直接移除外链、改用系统字体。
- **深色主题首屏闪烁**：深色用户刷新时先见浅色再切深色。彻底修复需在 `<head>` 内联极小脚本读 `localStorage` —— 但会与当前严格 CSP（`script-src 'self'`）冲突，需给该脚本加 `hash`/`nonce` 或放宽 CSP。
- **无自动化可访问性 / 视觉回归**：建议接入 axe + 截图回归（可选）。

### 后端
- **长请求可能触发网关超时（重点）**：`POST /api/graph/research`、`POST /api/agent/run` 会**同步阻塞**直到整段流程跑完（研究图到「写报告前中断」为止，可能 30–120s）。若反向代理的读超时更短，代理会回一个 **HTML 错误页**（502/504）→ 前端看到「非 JSON 响应」。
  - 短期：调大网关/代理的读超时；或按环境把 `GRAPH_MAX_ITERATIONS` / `LLM_*_TIMEOUT_SECONDS` 收紧到代理超时以内。
  - 正解：把 `start_research` 改为**非阻塞**（立即返回 thread_id，图在后台跑，进度全靠已在用的 SSE 推送）—— 前端本来就是「先订阅 SSE、再发起运行」，架构上已经预留了这条路。
- **无限流外的滥用面**：限流是**进程内单 worker** 语义（与配额一致），多实例部署需换网关/Redis 级限流。另外当前**无鉴权** —— 拿到分享链接的任何人都能发起研究并消耗额度；若需限制，建议加访问口令 / 平台侧鉴权。
- **tracing 欠账**：`app/observability/` 只有 metrics，架构文档 §6.1 的 tracing 尚未落地。
- **数据层**：SQLite 无备份/迁移框架，schema 迁移是内联 `ALTER TABLE`。上线后建议加定期备份（`storage/*.db`）与正式的迁移脚本。
- **健康检查粒度**：`/api/health` 合并了 liveness 与 readiness，当前规模够用；若接入编排探针可拆分。

### 运维 / 工程
- **无 CI**：lint / test / build 未在提交时自动跑。建议加最小 CI（`ruff` + `pytest` + `npm run build`）。
- **CORS**：生产 `CORS_ORIGINS=*`；同源部署下影响有限，若未来前后端分域，应收敛到具体域名。
- **密钥轮换**：`.env.production` 含真实 Key（靠 `.gitignore` + 上传沙箱保护）。建议登记轮换预案，泄漏即吊销重建。

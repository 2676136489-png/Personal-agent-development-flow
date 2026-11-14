# 上线就绪审计（Production Readiness）

> 范围：FastAPI 单端口服务（同源托管 React SPA）+ `/api`。
> 目标：从「本地能跑」提升到「可对外上线」的标配项。
> 最近更新：2026-09-26

本文既记录**已修复项**，也保留**待办清单**（按 P1/P2 排序），作为后续迭代的 checklist。

---

## ✅ 2026-11-14 公开部署加固

| 项 | 处理 |
|---|---|
| 写操作无边界 | 新增 `ADMIN_TOKEN`：留空即只读演示；上传/删除/清空/重建向量/调试端点均要求 `X-Admin-Token`；前端设置页可解锁 |
| 重启后的僵尸运行 | 启动时把遗留的 `running` / `awaiting_approval` 收敛为 `interrupted`，前端显示「已中断，请重新发起」 |
| 报告篇幅不足 | write 节点硬检查 summary ≥150 字、≥3 节、每节 ≥200 字；一次扩写重试，仍不达标写入 limitations |
| 核查不查覆盖面 | verify 现在同时检查计划子问题是否都有结论，跑题证据不能支撑结论 |
| 效果评估数据缺失 | 运行列表返回耗时 / token / 失败原因；页面展示成功率、平均耗时、平均 token、状态分布与失败原因 |
| Google Fonts 阻塞首屏 | Poppins 改为自托管 `public/fonts`，删除外链；CSP 收紧 `font-src` / `style-src` |
| 无 CI | 新增 `.github/workflows/ci.yml`：ruff + pytest + 前端构建 |
| CORS 通配 | 生产 `.env.production` 收敛到实际站点与本地 dev 来源 |
| 个人文档暴露 | 写操作已加边界；公开实例上的示例/个人文档仍建议按需清理 |

> 仍未覆盖：正式账号体系与多用户隔离、SQLite 备份/迁移框架、多实例限流与配额。

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
| CSP | `default-src 'self'`；脚本仅同源（构建产物无内联脚本）；样式与字体均同源（字体已自托管，不再放行 Google Fonts）；`connect-src` 额外精确放行首屏玻璃立方体的 GLB 来源（`https://motionsites.org`，不写通配）。可用 `CONTENT_SECURITY_POLICY` 覆盖或置空关闭。 |
| GZip 压缩 | 只对 `/assets` 静态挂载点启用 —— **不给全局加** `GZipMiddleware`，因为那会缓冲压缩 SSE 事件流。 |
| 静态缓存策略 | `/assets/*`（内容哈希）→ `public, max-age=31536000, immutable`；`index.html` → `no-cache`。杜绝「部署后旧 HTML 指向已删 chunk → 白屏」。 |
| 生产关闭 API 文档 | `API_DOCS_ENABLED=false` 时 `/api/docs`、`/api/openapi.json` 返回 404。 |
| 昂贵端点限流 | 新增纯 ASGI `RateLimitMiddleware`（进程内滑窗，按客户端 IP），防刷爆大模型 API 与搜索额度；返回统一错误信封 + `Retry-After`。默认关，生产 `.env.production` 开。 |
| 可观测性接线 | 指标真正接入工具 / 搜索 / LLM / 图运行（详见 `tests/test_observability_wiring.py`）。 |
| **`/api` 永不返回纯文本** | 新增最外层 `JsonErrorFallbackMiddleware`：外层中间件自身抛异常时也返回统一 JSON 信封（此前 Starlette 会回纯文本 `Internal Server Error`）。 |
| **结构化输出容错** | `AgentDecision` 二选一从「硬失败」改为「能救则救 + 带修复提示重试一次」（详见 `tests/test_structured_repair.py`）。 |

### 验证
- 前端 `npm run build` 通过；后端 `pytest` **181 passed**（当轮，当前为 268 passed）；
  `ruff` 改动文件全绿。
- 运行时冒烟（5 项全过）：安全头 / 文档关闭 / index `no-cache` / 资产 `immutable+gzip` / 限流 429。

---

## 🔧 待办（P1，上线前后尽快）

### 前端
- ~~字体来源风险~~（**已解决**）：Poppins 300–800 已自托管到 `public/fonts`，
  通过 `styles/fonts.css` 的 `@font-face` 同源加载；`index.html` 的 Google Fonts
  外链已删除，首屏不再被第三方 CSS 阻塞。
- **首屏是 WebGL**：`index.html` 不含任何 3D 相关资源，three.js 只在概览页按需加载；模型加载失败或超过 8 秒会回落到程序化几何，首屏不会因此空白。若浏览器禁用 WebGL，`#scene` 保持黑底，标题与全部导航仍可用。
- **视觉回归已有工具，a11y 仍缺**：结构与契约由 `frontend/scripts/smoke-render.mjs`（46 条，含类名覆盖率与 three.js 渲染管线）守住，逐页版式由 `shoot-world.cjs` 截图人工比对；尚未接入 axe 等自动化可访问性扫描。

### 后端
- ~~长请求可能触发网关超时~~（**已解决**）：`start_research` / `resume_research` 已改为
  后台任务执行，接口立即返回；进度由 SSE + 轮询两条通道同步。
- **滥用面**：限流是**进程内单 worker** 语义（与配额一致），多实例部署需换网关/Redis 级限流。
  写操作已有 `ADMIN_TOKEN` 边界，但**仍没有多用户账号体系** —— 持链接者依然可以发起研究、
  查看共享知识库与历史记录，只是不能删除/清空/上传。若要多租户隔离，需要正式鉴权。
- **tracing 欠账**：`app/observability/` 只有 metrics，架构文档 §6.1 的 tracing 尚未落地。
- **数据层**：SQLite 无备份/迁移框架，schema 迁移是内联 `ALTER TABLE`。上线后建议加定期备份（`storage/*.db`）与正式的迁移脚本。
- **健康检查粒度**：`/api/health` 合并了 liveness 与 readiness，当前规模够用；若接入编排探针可拆分。

### 运维 / 工程
- ~~无 CI~~（**已解决**）：新增 `.github/workflows/ci.yml`，提交与 PR 自动跑
  `ruff` + `pytest` + 前端 `npm run build`。
- **CORS**：生产 `.env.production` 已收敛到实际站点与本地 dev 来源；若未来前后端分域，
  继续按域名维护白名单，不要再使用 `*`。
- **密钥轮换**：`.env.production` 含真实 Key（靠 `.gitignore` + 上传沙箱保护）。建议登记轮换预案，泄漏即吊销重建。

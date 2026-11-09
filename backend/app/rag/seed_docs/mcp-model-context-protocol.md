# MCP（Model Context Protocol）协议详解

## MCP 是什么

MCP 是一套开放协议，用来把「工具和数据源」以标准方式暴露给大模型应用。它解决的问题与 LSP（Language Server Protocol）类似：以前每接一个工具就要写一份专属适配，接 10 个工具写 10 份胶水代码；有了 MCP，工具方按协议实现一次 server，任何支持 MCP 的客户端（IDE、Agent、聊天应用）都能直接用。

角色划分很清晰：**Host** 是用户使用的应用（如 IDE、Agent 客户端），**Client** 是 Host 内部维护与单个 server 连接的组件，**Server** 是真正提供能力的轻量进程（文件系统、数据库、GitHub、内部系统网关）。

## 三类核心原语

- **Tools（工具）**：模型可主动调用的函数，带 JSON Schema 描述。对应「让模型做事」，如执行查询、创建工单。类比 function calling，但工具列表来自协议动态发现而非硬编码。
- **Resources（资源）**：供客户端读取的上下文数据，URI 标识（如 `file:///logs/app.log`、`db://orders/schema`）。对应「给模型看资料」，由应用决定何时注入，模型不直接发起。
- **Prompts（提示模板）**：server 预定义的可复用提示词模板，用户显式选用。对应「把最佳实践模板化」。

三者的调用主体不同：Tools 由模型决策，Resources 由应用决策，Prompts 由用户决策——这个划分决定了各自的能力边界和授权模型。

## 传输与生命周期

- **stdio 传输**：server 作为子进程启动，stdin/stdout 交换 JSON-RPC 消息。适合本地工具，生命周期随 Host，权限天然收敛在本地。
- **Streamable HTTP 传输**：server 独立部署为 HTTP 服务，适合共享的团队级能力（内部数据网关）。远程 server 一定要做鉴权（OAuth 2.1 已写进协议规范），否则等于把内部系统裸露给所有客户端。
- 生命周期：`initialize` 握手（协商协议版本与能力）→ `tools/list` / `resources/list` 发现 → 正常调用 → 关闭。能力协商意味着客户端可以只实现部分原语，两端按声明兼容。

## 工程实践要点

1. **工具描述即 prompt**：`description` 和参数 schema 直接影响模型调用的准确率。描述里写清楚「何时该用、何时不该用、返回什么」，比加 few-shot 更省 token。
2. **返回值按 token 预算截断**：一个返回 10 万行日志的工具会把上下文窗口打爆。分页、摘要、错误结构化（code + message + hint）都是 server 侧责任。
3. **能力不叠加信任**：Host 对每个 server 的工具单独授权（允许列表、调用前确认），一个 server 可信不代表它代理的下游系统可信。第三方 MCP server 拿到的输入可能包含不可信内容，返回结果要按数据对待，不要直接并入 system prompt。
4. **失败要可诊断**：`isError` 标记 + 结构化错误内容，让模型能基于错误信息重试或换路，而不是把异常文本当正常结果继续推理。

## 典型面试问题

- MCP 的 Tools 和 Resources 有什么区别？为什么分成两类？
- 如果一个 MCP server 返回的内容里藏了 prompt 注入指令，客户端应该在哪几层做防护？
- 设计一个「公司内部数据库」的 MCP server，你会暴露成 Tools 还是 Resources？边界怎么划？

"""Application configuration.

[P0] 这是全后端唯一的「配置来源」。
为什么需要它：把「会随环境变化的值」（端口、密钥、CORS 白名单、日志级别）
从代码里抽出来，放到环境变量 / .env 文件里。
好处：同一份代码可以在开发、测试、生产里跑，且密钥不会进 Git。
"""

from __future__ import annotations

import os
from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic import SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict

# `backend/` 的绝对路径（本文件在 backend/app/core/config.py，往上三级）。
#
# 为什么必须算出绝对路径，而不是在 env_file 里直接写 ".env"：
# pydantic-settings 按**进程当前工作目录**解析相对路径。托管沙箱启动服务时
# 工作目录是 /workspace（不是 backend/），相对路径会让所有配置静默失效 ——
# 表现为「服务能起、但 Key 全没读到、悄悄退回 Mock」，极难排查。
_BACKEND_ROOT = Path(__file__).resolve().parents[2]


def _select_env_files() -> tuple[Path, ...]:
    """决定读哪些配置文件。只读**一个**，不做多文件叠加。

    为什么要这么小心 —— 这里踩过一个很深的坑：

    托管沙箱上传时**不按 .gitignore 过滤**，`backend/` 下的所有文件原样上传，
    包括本地开发用的 `.env`。而 `.env` 里 `LLM_BASE_URL` 指向
    `http://127.0.0.1:11434/v1`（本地 Ollama），服务器上根本没有 Ollama，
    于是线上每次都「网络连接失败」。

    原来的设计是 `.env.production` 与 `.env` 同时读、靠后者优先，
    以为「本地 .env 覆盖部署配置」很方便。但只要本地 `.env` 被上传，
    它在服务器上就同样生效 —— 优先级叠加载部署场景下是个陷阱。

    现在改成**显式单文件**：
      - 部署环境（沙箱注入 PORT）：只读 `.env.production`
      - 本地开发：只读 `.env.local`
    这样两边不可能互相污染，也不依赖任何优先级规则。
    本地若想临时试线上配置，用真实环境变量覆盖即可（它的优先级永远最高）。

    文件不存在时返回空元组，pydantic-settings 会退回到字段默认值。
    """
    # 沙箱会注入 PORT；本地开发不会。用它区分部署与本地，最可靠。
    is_deployed = "PORT" in os.environ
    candidates = (
        (_BACKEND_ROOT / ".env.production",) if is_deployed else (_BACKEND_ROOT / ".env.local",)
    )
    return tuple(p for p in candidates if p.is_file())


class Settings(BaseSettings):
    """运行时配置。

    字段的取值优先级（高 → 低）：
    1. 进程真实环境变量（例如 export LLM_API_KEY=xxx）
    2. 选中的那一个配置文件（部署环境 = .env.production，本地 = .env.local）
    3. 这里写的默认值
    """

    # model_config 是 pydantic-settings 的约定写法，不是普通 pydantic 字段。
    model_config = SettingsConfigDict(
        # 用绝对路径 + 单文件；选择逻辑见 _select_env_files 的说明。
        # 注意：这里传的是「调用时求值」的元组，模块导入时 os.environ 已就绪。
        env_file=_select_env_files(),
        env_file_encoding="utf-8",
        extra="ignore",  # .env 里多写了未定义的变量时不要报错
    )

    app_name: str = "AI Research Workspace"
    environment: str = "development"  # development | staging | production
    version: str = "0.1.0"
    log_level: str = "INFO"

    # 所有接口的统一前缀，前端只需要知道这一个值
    api_prefix: str = "/api"

    # ----- LLM -----
    #
    # 统一模型调用层（app/llm/client.py）支持的 provider：
    #   ollama  = 本地 Ollama 原生 /api/chat（**默认**，模型 qwen3:8b）
    #   openai  = 任何 OpenAI 兼容端点（DeepSeek / 通义 / Moonshot / 官方 OpenAI）
    #   mock    = 离线假数据（本地开发 / CI）
    #   auto    = 先试 Ollama，不可用时按 llm_fallback_provider 兜底，都没有则 Mock
    #
    # ⚠️ 切模型只改这一个值（+ 对应的一小组参数），业务代码零改动：
    #    所有调用点拿到的都是 LLMClient 协议对象，不知道底下是谁。
    llm_provider: Literal["auto", "ollama", "openai", "openai-compatible", "mock"] = "ollama"
    # 留空则用 SDK 默认（OpenAI）；换厂商只改这两个值：
    #   DeepSeek:  https://api.deepseek.com        + deepseek-flash
    #   通义千问:  https://dashscope.aliyuncs.com/compatible-mode/v1 + qwen-plus
    llm_base_url: str = ""
    # SecretStr：打印 Settings 时会显示 '**********'，避免 Key 被日志泄露
    llm_api_key: SecretStr = SecretStr("")
    llm_model: str = "gpt-4o-mini"
    llm_timeout_seconds: float = 30.0
    llm_max_attempts: int = 3
    llm_temperature: float = 0.2
    # 单次生成上限（token），OpenAI 兼容 provider 的默认预算。
    # ⚠️ 不要低于 4096：GLM-4-Flash / qwen3 这类模型在长报告场景下，
    # 2000 会在 JSON 中途被截断（finish_reason=length），表现为报告腰斩。
    llm_max_tokens: int = 4096

    # ----- LLM：本地 Ollama（主模型 qwen3:8b）-----
    # Ollama 的原生地址（**不带 /v1**）：/api/chat 才能用到 keep_alive / think /
    # num_ctx 这些 OpenAI 兼容层没有的本地推理参数。
    ollama_base_url: str = "http://127.0.0.1:11434"
    ollama_model: str = "qwen3:8b"
    # 模型常驻显存时长："5m" = 用完再留 5 分钟；"0" = 立即卸载（省内存，下次冷启动慢）
    ollama_keep_alive: str = "5m"
    # qwen3 是思考型模型：关掉思考能显著降低首字延迟与推理 token 开销。
    # 需要模型自己推理的场景（数学 / 复杂规划）可置 true。
    ollama_think: bool = False
    # 上下文窗口（token）。8B 模型建议 8192 起；内存充裕可上调到 16384/32768。
    ollama_num_ctx: int = 8192
    # 单次生成上限（token），等价于 OpenAI 的 max_tokens。
    # 思考型模型请把推理预算也算进去，4096 是 qwen3:8b 结构化的安全下限。
    ollama_num_predict: int = 4096
    # 本地 8B 模型首 token 就要几秒，超时必须远高于云端 API
    ollama_timeout_seconds: float = 120.0
    # 主 provider 不可用时的兜底（"" = 不兜底，直接把错误抛给调用方）。
    # 线上环境没有 Ollama 时，配成 "openai" 即可无缝回落到云端模型。
    llm_fallback_provider: Literal["", "ollama", "openai", "openai-compatible", "mock"] = ""
    # 判定「主模型不可用」所需的连续失败次数。
    llm_fallback_threshold: int = 2
    # 判定降级后的冷却时长（秒）：冷却期内直连兜底，**不再**去试主模型。
    # 没有它，线上每一次请求都要先空等一整段主模型超时（20s × 3 次重试 = 60s）。
    llm_fallback_cooldown_seconds: float = 120.0
    # 是否开放流式输出（/api/llm/stream）。本地模型建议开启以改善体感延迟。
    llm_stream_enabled: bool = True

    # ----- Agent / Tools -----
    # 离线/真实搜索的选择：auto = 有 Tavily Key 走真实联网，没 Key 回退离线语料
    search_provider: str = "auto"
    # 联网搜索服务的 Key（当前接入 Tavily）。留空则用离线示例语料。
    tavily_api_key: SecretStr = SecretStr("")
    # 一个 Agent run 最多走几步（含工具调用与最终回答）
    agent_max_steps: int = 6
    # 整个 run 的墙钟时间上限（秒）。这是防失控的最后一道闸。
    agent_total_timeout_seconds: float = 120.0
    # 工具输出进入上下文前的最大字符数（防止把上下文撑爆）
    tool_output_max_chars: int = 3000
    # 抓取网页时的域名白名单，留空 = 不限制（仍禁止内网地址）
    fetch_allowed_domains: str = ""

    # ----- Search quota -----
    #
    # ⚠️ 单 worker 语义。判据已实测修正，别再写成「多 worker 会各记各账/超支」：
    # 防超支由 quota.py reserve() 那条 UPSERT 的 WHERE 子句保证，SQLite 写事务
    # 跨进程天然串行，实测无超支。真实理由是 WAL + 长连接在多进程写入下会
    # 永久退化为只读，而 get_search_quota() 的 lru_cache 单例没有重连路径。
    # 请勿用 --workers>1 启动；/api/health 会暴露 quota_mode: single-worker。
    # 详见 app/search/quota.py 顶部 docstring 与架构文档 §2.3.2。
    #
    # 计费口径（Tavily）：basic = 1 credit/次，advanced = 2 credits/次。
    search_quota_enabled: bool = True
    search_quota_db_path: str = "storage/search_quota.db"
    # Tavily free tier = 1000 credits/月
    search_quota_monthly_credits: int = 1000
    search_quota_warn_ratios: str = "0.5,0.75,0.9"
    # degrade_annotate = 额度耗尽仍出报告但明说（默认）；hard_stop = 拒绝新建 run
    search_quota_policy: str = "degrade_annotate"
    search_quota_soft_cap_ratio: float = 0.9
    # 单次 run 的搜索次数硬顶，防止一条 run 疯狂烧积分
    search_quota_per_run_cap: int = 12
    # 默认 basic（1 credit/次）：1000 credits 的免费额度因此可以撑满 1000 次搜索
    # （advanced 只够约 500 次）。检索质量让位于「额度够用」——改成 advanced
    # 只需把这里（或 .env 的 SEARCH_DEPTH）换成 "advanced"，单价表两种档位都在。
    # 设置页需明示「advanced = 2 credits / basic = 1 credits」。
    #
    # 用 Literal 而不是裸 str：非法值（如拼错的 "advaned"）必须**启动即报错**。
    # 否则用户以为在用 advanced（2 credits/次），实际被静默回落到 basic，
    # 或反之——两种方向都是「看不见的钱包问题」，fail-fast 才是对的。
    search_depth: Literal["basic", "advanced"] = "basic"

    # ----- Tool retry -----
    tool_max_attempts: int = 2
    tool_retry_backoff_min: float = 0.5
    tool_retry_backoff_max: float = 4.0
    retryable_tool_kinds: str = "timeout,network,upstream_5xx,rate_limit"

    # ----- Observability -----
    log_format: str = "json"  # json | plain

    # ----- Knowledge base (RAG) -----
    # SQLite 数据库文件与上传文件的存放位置（相对 backend/ 目录）
    knowledge_db_path: str = "storage/knowledge.db"
    storage_dir: str = "storage/documents"
    # Agent 运行记录（LangGraph 之外的产品视角记录）
    agent_runs_db_path: str = "storage/agent_runs.db"
    # Agent 事件流（SSE 回放 + 前端刷新恢复）
    events_db_path: str = "storage/events.db"
    # SSE 心跳间隔（秒）。必须小于常见代理的空闲超时（通常 60s）。
    sse_heartbeat_seconds: float = 15.0
    # Research Graph 的默认循环上限。
    # 每轮 research = 一次「LLM 决策 + 一个工具调用」，深度研究需要覆盖
    # 计划里的多个子问题，3 轮往往只够搜一两次；5 轮是质量与成本（搜索配额 12 次/run）的平衡点。
    graph_max_iterations: int = 5
    graph_max_verify_attempts: int = 2
    # 切块参数：size 太小会丢上下文，太大则检索不精准；overlap 用于避免句子被切断
    chunk_size: int = 800
    chunk_overlap: int = 120
    # 一次检索返回几条
    retrieval_top_k: int = 5
    # 上传文件大小上限（字节）。必须限制，否则一个 2GB 文件就能打满内存。
    upload_max_bytes: int = 10 * 1024 * 1024

    # ----- Embedding -----
    # auto = 有 Key 用真实 embedding API，没有则用本地哈希向量（仅保证链路可跑）
    embedding_provider: str = "auto"
    embedding_base_url: str = ""
    embedding_api_key: SecretStr = SecretStr("")
    embedding_model: str = "text-embedding-3-small"
    # 本地哈希向量的维度（真实模型时不生效，以模型返回为准）
    embedding_dimension: int = 256
    embedding_timeout_seconds: float = 30.0
    # [B38] 深度研究是否要求知识库检索具备**语义**能力才肯采用。
    #
    # 默认 True。哈希兜底向量只有字面匹配、分数分布重叠（0.47 的无关内容
    # 能压过 0.44 的相关内容），拿它当依据必然把无关片段写进结论与引用 ——
    # 用户看到的「引用与研究内容驴唇不对马嘴」就是这么来的。
    # 关掉它只应在「明确接受检索噪声」时使用（例如本地调试检索链路）。
    rag_semantic_required: bool = True

    # CORS 白名单：允许哪些「浏览器来源」访问后端。用逗号分隔的字符串而不是 list，
    # 因为环境变量天然是字符串，直接解析 list 容易踩坑（需要写 JSON 数组）。
    cors_origins: str = "http://localhost:5173,http://127.0.0.1:5173"

    # ----- 前端静态产物（单端口部署用）-----
    # 由后端托管前端构建产物时，指定 dist 目录。空 = 走默认查找顺序
    # （`backend/frontend_dist` → `backend/../frontend/dist`）。
    #
    # 为什么必须在这里声明成 Settings 字段，而不是在代码里直接读 os.environ：
    # pydantic-settings 读取 .env 文件后**不会**把未知的键注入 os.environ，
    # 所以「写进 .env 但没在 Settings 里声明」的配置项会被静默忽略 ——
    # 表现为「明明配了却不生效」。声明成字段后，它才能被 .env 文件真正驱动。
    frontend_dist: str = ""

    # ----- 生产加固：安全响应头 -----
    # 统一给所有响应补上安全头（nosniff / X-Frame-Options / Referrer-Policy /
    # Permissions-Policy / COOP，生产环境再加 HSTS）。默认开启。
    security_headers_enabled: bool = True
    # HSTS 只在 HTTPS 下有意义；本地 HTTP 下发会污染浏览器（强制 https 访问 localhost）。
    # 因此按环境自动判定：environment == "production" 才下发。
    # CSP：以「同源 + Google Fonts」为基线。脚本只允许同源（构建产物无内联脚本，
    # 因此不需要 unsafe-inline —— 见前端 index.html 的红线注释）。
    # 置空字符串可整体关闭 CSP。
    content_security_policy: str = (
        "default-src 'self'; "
        "script-src 'self'; "
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "
        "font-src 'self' https://fonts.gstatic.com data:; "
        "img-src 'self' data:; "
        "connect-src 'self'; "
        "base-uri 'self'; "
        "form-action 'self'; "
        "frame-ancestors 'none'"
    )

    # ----- 生产加固：API 文档开关 -----
    # /api/docs 与 /api/openapi.json 会暴露全部接口结构，生产环境应关闭。
    # 显式开关（而不是只看 environment），便于灰度或临时排障时打开。
    api_docs_enabled: bool = True

    # ----- 生产加固：静态资源缓存 -----
    # /assets 下的文件名带内容哈希 → 可长缓存（immutable）；index.html 必须 no-cache，
    # 否则浏览器缓存旧 HTML，部署后仍指向已删除的旧 chunk → 白屏。
    static_assets_immutable: bool = True
    static_assets_max_age: int = 31536000  # 1 年

    # ----- 生产加固：基础限流（防额度滥用）-----
    # 对昂贵的端点（LLM / 研究 / 图 / Agent）按客户端 IP 做进程内滑窗限流，
    # 避免公开链接被刷爆免费 LLM Key 与 Tavily 搜索额度。
    # 默认关闭（本地开发/测试不受影响），生产 .env.production 打开。
    # ⚠️ 进程内实现，仅单 worker 语义正确（与配额一致，勿 --workers>1）。
    rate_limit_enabled: bool = False
    rate_limit_requests_per_minute: int = 30
    # 逗号分隔的路径前缀；只对这些前缀限流（静态资源与 /api/health 不限）。
    rate_limit_paths: str = "/api/llm,/api/research,/api/graph,/api/agent"

    # ----- 生产加固：每日运行预算（防额度滥用）-----
    # 和限流的互补关系：限流拦「短时间高频」，预算拦「不紧不慢刷一整天」
    # （30 次/分钟 × 24h ≈ 4.3 万次调用，足以烧穿免费 LLM / Tavily 额度）。
    # 按客户端 IP 统计**新建运行**的次数，超限返回 429（error.code = daily_budget_exceeded），
    # 自然日自动归零；只统计创建运行的端点，「继续/恢复已有运行」不计数。
    # 默认关闭（本地开发/测试不受影响），生产 .env.production 打开。
    daily_run_budget_enabled: bool = False
    daily_run_budget_per_ip: int = 10
    # 逗号分隔的路径，**精确匹配**（不是前缀）：
    # 这样 /api/graph/research/{thread_id}/resume 不会被误算成新建运行。
    daily_run_budget_paths: str = "/api/graph/research,/api/agent/run"

    @property
    def daily_run_budget_path_list(self) -> list[str]:
        return [p.strip() for p in self.daily_run_budget_paths.split(",") if p.strip()]

    @property
    def rate_limit_path_list(self) -> list[str]:
        return [p.strip() for p in self.rate_limit_paths.split(",") if p.strip()]

    @property
    def is_production(self) -> bool:
        return self.environment.strip().lower() == "production"

    @property
    def cors_origins_list(self) -> list[str]:
        """把 "a,b,c" 解析成 ["a", "b", "c"]，并容忍多余的空格与空值。"""
        return [origin.strip() for origin in self.cors_origins.split(",") if origin.strip()]

    @property
    def fetch_allowed_domains_list(self) -> list[str]:
        return [
            domain.strip() for domain in self.fetch_allowed_domains.split(",") if domain.strip()
        ]

    @property
    def search_quota_warn_ratios_list(self) -> list[float]:
        """把 "0.5,0.75,0.9" 解析成 [0.5, 0.75, 0.9]（排序由 store 负责）。"""
        return [float(ratio) for ratio in self.search_quota_warn_ratios.split(",") if ratio.strip()]

    @property
    def retryable_tool_kinds_set(self) -> frozenset[str]:
        return frozenset(
            kind.strip() for kind in self.retryable_tool_kinds.split(",") if kind.strip()
        )


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """返回全局唯一的 Settings 实例。

    为什么用 lru_cache：Settings() 每次都会读一遍 .env 并做校验。
    配置在一个进程内不会变，缓存一次即可（这是「单例 + 依赖注入」的轻量写法）。
    """
    return Settings()

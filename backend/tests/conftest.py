"""测试环境统一配置。

[P0] 这里在「导入任何 app 模块之前」改写进程环境变量，
让整个测试会话都走「离线 Mock」：

- LLM_PROVIDER=mock：所有 LLM 调用走 MockLLMClient，不产生真实模型调用，
  也不依赖外部付费服务（TestClient 下真实 AsyncOpenAI 还会触发 event-loop 问题）。
- 清空 TAVILY_API_KEY：联网搜索回退到内置离线语料（含 example.com 等示例），
  既免费又稳定，且能命中 test_tools 的离线断言。
- [B36] 全部 SQLite 存储路径重定向到一次性临时目录：此前测试会话直接读写
  真实的 storage/agent_runs.db（run_store / events / quota / knowledge 全中），
  每跑一次 pytest 就往里写几十条运行记录。这些记录随后又被**原样打包部署**
  到线上 —— 用户「就点了一次」，历史列表里却躺着几百条相同问题的记录，
  其中 923 条是测试写的。测试必须与真实数据物理隔离。

这样跑 `uv run pytest` 完全离线、可重复，不会因为缺 Key / 限流 / 计费而红，
也不会污染任何真实数据。

注意：必须在 import app 之前设置，因为 get_settings() 是用 lru_cache 缓存的。
"""

from __future__ import annotations

import os
import tempfile

_TEST_STORAGE = tempfile.mkdtemp(prefix="ai-research-test-storage-")

os.environ["LLM_PROVIDER"] = "mock"
os.environ.pop("LLM_API_KEY", None)
os.environ["LLM_API_KEY"] = ""
os.environ.pop("TAVILY_API_KEY", None)
os.environ["TAVILY_API_KEY"] = ""
os.environ["EMBEDDING_PROVIDER"] = "hash"

# [B36] 四个 SQLite 库 + 上传文件目录，全部指到会话级临时目录。
# 字段名与 app/core/config.py 一一对应（pydantic-settings 无前缀，直接大写）。
os.environ["AGENT_RUNS_DB_PATH"] = os.path.join(_TEST_STORAGE, "agent_runs.db")
os.environ["EVENTS_DB_PATH"] = os.path.join(_TEST_STORAGE, "events.db")
os.environ["SEARCH_QUOTA_DB_PATH"] = os.path.join(_TEST_STORAGE, "search_quota.db")
os.environ["KNOWLEDGE_DB_PATH"] = os.path.join(_TEST_STORAGE, "knowledge.db")
os.environ["STORAGE_DIR"] = os.path.join(_TEST_STORAGE, "documents")

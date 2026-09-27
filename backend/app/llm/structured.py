"""把 LLM 返回的文本解析成 Pydantic 对象。

[P0] 这里是「Structured Output」真正落地的地方。
模型输出的是字符串，我们的程序要的是对象；这个转换必须：
1) 容错（模型经常在 JSON 外面包一层 ```json 代码块）
2) 严格（不符合 schema 就抛错，让上层决定重试还是报错）
"""

from __future__ import annotations

import json
from typing import TypeVar

from pydantic import BaseModel, ValidationError

from app.llm.errors import LLMError

T = TypeVar("T", bound=BaseModel)


def _strip_code_fence(text: str) -> str:
    """去掉模型常用的 ```json ... ``` 包裹。"""
    stripped = text.strip()
    if not stripped.startswith("```"):
        return stripped
    lines = stripped.splitlines()
    if lines and lines[0].startswith("```"):
        lines = lines[1:]
    if lines and lines[-1].strip() == "```":
        lines = lines[:-1]
    return "\n".join(lines).strip()


def _maybe_unwrap(payload: object, schema: type[T]) -> object:
    """模型偶尔把 JSON 再包一层，例如 {"description": {"findings": [...]}}。

    实测 qwen3 会把 JSON Schema 顶层的 "description" 当成要输出的字段名，
    真正的结构被塞进内层，于是校验拿到的是一个没有目标字段的对象
    —— 表现为「模型什么都没输出」，非常难排查。

    规则：外层只有一个键、值是 dict、且这个键不是 schema 的字段 → 解包。
    """
    if not isinstance(payload, dict) or len(payload) != 1:
        return payload
    key, value = next(iter(payload.items()))
    if isinstance(value, dict) and key not in schema.model_fields:
        return value
    return payload


def _restore_escaped_newlines(payload: object) -> object:
    """把字符串里「字面 \\n / \\t」（反斜杠+n 两个字符）恢复成真实换行/制表符。

    [B20] GLM-4-Flash 等小模型在 JSON 模式下经常把换行**双重转义**：
    模型本想输出 "第一行\n第二行"（JSON 转义写法，解析后是真换行），
    实际输出的却是 "第一行\\n第二行"（双重转义，解析后是字面 \n 两字符）。
    这些字面符号会被前端原样渲染成 "\n"，报告里满屏反斜杠。

    在 json.loads 之后、schema 校验之前统一递归清理，一处修复覆盖
    报告 / 计划 / 分析 / 智能体决策等全部结构化输出。
    注意：不能动 json.loads 之前的原始文本 —— 那会破坏合法 JSON 的转义结构。
    """
    if isinstance(payload, str):
        # 只有确实存在字面序列时才替换，避免无谓的字符串拷贝
        if "\\n" in payload or "\\t" in payload:
            return payload.replace("\\n", "\n").replace("\\t", "\t")
        return payload
    if isinstance(payload, dict):
        return {key: _restore_escaped_newlines(value) for key, value in payload.items()}
    if isinstance(payload, list):
        return [_restore_escaped_newlines(item) for item in payload]
    return payload


def parse_structured_payload(content: str, schema: type[T]) -> T:
    """把模型输出解析为 schema 实例。失败时抛出可重试的 LLMError。"""
    cleaned = _strip_code_fence(content)

    try:
        payload = json.loads(cleaned)
    except json.JSONDecodeError:
        # 兜底：模型可能在 JSON 前后加了说明文字，截取第一个 { 到最后一个 }
        start = cleaned.find("{")
        end = cleaned.rfind("}")
        if start == -1 or end <= start:
            raise LLMError(
                f"模型输出不是 JSON（前 200 字符）：{content[:200]}",
                kind="parse",
                retryable=True,
            ) from None
        try:
            payload = json.loads(cleaned[start : end + 1])
        except json.JSONDecodeError as exc:
            raise LLMError(f"模型输出 JSON 解析失败：{exc}", kind="parse", retryable=True) from exc

    try:
        return schema.model_validate(
            _restore_escaped_newlines(_maybe_unwrap(payload, schema))
        )
    except ValidationError as exc:
        # 字段缺失或类型不对：把「哪个字段错了」写进日志友好的 message。
        # 注意：model 级 validator（如「二选一」）的 loc 为空，此时不要再拼 ": " 前缀，
        # 否则会得到 "…schema：: Value error…" 这种双冒号的难看输出。
        problems = "; ".join(
            f"{'.'.join(str(p) for p in err['loc'])}: {err['msg']}" if err["loc"] else err["msg"]
            for err in exc.errors()[:5]
        )
        raise LLMError(
            f"模型输出不符合 schema：{problems}",
            kind="parse",
            retryable=True,
        ) from exc

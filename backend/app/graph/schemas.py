"""各节点的结构化输出 schema（节点之间的数据契约）。"""

from __future__ import annotations

from pydantic import BaseModel, Field, field_validator, model_validator

# ----------------------------- 通用工具函数 -----------------------------


def _coerce_str(value: object, fallback: str = "") -> str:
    """确保输出是字符串；空值用 fallback 兜底。"""
    if value is None:
        return fallback
    text = str(value).strip()
    return text if text else fallback


def _stringify(item: object) -> str:
    """把单个元素变成人能读的字符串。

    [B8] 之前对所有非字符串元素统一 `str(item)`，模型返回对象数组时
    会把 Python repr（`{'k': 'v'}`）原样渲染到研究报告里。
    这里改成"键: 值"的可读形式，至少不会把程序内部结构暴露给用户。
    """
    if isinstance(item, str):
        return item.strip()
    if isinstance(item, dict):
        parts = [
            f"{key}: {value}"
            for key, value in item.items()
            if value not in (None, "") and isinstance(key, str)
        ]
        return "；".join(parts)
    if isinstance(item, list):
        return "、".join(_stringify(sub) for sub in item)
    if item is None:
        return ""
    return str(item)


def _coerce_str_list(value: object) -> list[str]:
    """让 LLM 输出的「字符串」或「null」也能被当 list 接受。

    DeepSeek / 一些模型在 JSON 模式下，经常把空列表写成 null，
    或把只有一条的内容写成普通字符串。严schema 会报错，
    这里做宽松兜底：字符串→[字符串]，null/None→[]，list 保持原样。
    """
    if value is None:
        return []
    if isinstance(value, str):
        if not value.strip():
            return []
        return [value]
    if isinstance(value, list):
        # 过滤掉 None，把数字等转成 str（防御性）
        return [text for text in (_stringify(item) for item in value) if text]
    return []


# ----------------------------- 节点输出 schema -----------------------------


class TaskUnderstanding(BaseModel):
    """understand_task 节点：先把「用户到底要什么」搞清楚。"""

    goal: str = Field(default="", description="这项研究要达成的目标")
    key_questions: list[str] = Field(default_factory=list, description="需要回答的关键子问题")
    scope: str = Field(default="", description="边界：时间范围、对象范围、不研究什么")

    @field_validator("goal", "scope", mode="before")
    @classmethod
    def _normalize_text(cls, value: object) -> str:
        return _coerce_str(value)

    @field_validator("key_questions", mode="before")
    @classmethod
    def _normalize_key_questions(cls, value: object) -> list[str]:
        return _coerce_str_list(value)


class AnalysisResult(BaseModel):
    """analyze 节点：从证据中提炼结论。"""

    findings: list[str] = Field(
        default_factory=list,
        description="基于证据得出的结论，每条都必须能被证据支撑",
    )
    gaps: list[str] = Field(default_factory=list, description="证据不足、无法下结论的部分")

    @field_validator("findings", "gaps", mode="before")
    @classmethod
    def _normalize_str_lists(cls, value: object) -> list[str]:
        return _coerce_str_list(value)


class VerificationResult(BaseModel):
    """verify 节点：判断证据够不够支撑结论。"""

    verdict: str = Field(
        default="needs_more",
        description="pass = 证据充分；needs_more = 需要补充研究",
    )
    reasons: list[str] = Field(default_factory=list, description="给出这个判断的理由")
    missing: list[str] = Field(default_factory=list, description="还缺什么信息")

    @field_validator("verdict", mode="before")
    @classmethod
    def _normalize_verdict(cls, value: object) -> str:
        return _coerce_str(value, "needs_more")

    @field_validator("reasons", "missing", mode="before")
    @classmethod
    def _normalize_str_lists(cls, value: object) -> list[str]:
        return _coerce_str_list(value)


class ReportSection(BaseModel):
    heading: str = Field(default="")
    content: str = Field(default="")

    @field_validator("heading", "content", mode="before")
    @classmethod
    def _normalize_text(cls, value: object) -> str:
        return _coerce_str(value)


class ResearchReport(BaseModel):
    """write 节点：最终报告。"""

    title: str = Field(default="")
    summary: str = Field(default="")
    sections: list[ReportSection] = Field(default_factory=list)
    limitations: list[str] = Field(default_factory=list, description="本次研究的局限")

    @field_validator("title", "summary", mode="before")
    @classmethod
    def _normalize_text(cls, value: object) -> str:
        return _coerce_str(value)

    @field_validator("sections", mode="before")
    @classmethod
    def _normalize_sections(cls, value: object) -> list[ReportSection]:
        if value is None:
            return []
        if isinstance(value, list):
            # 过滤掉不是 dict 的元素，并把缺失字段的 dict 补齐
            cleaned: list[ReportSection] = []
            for item in value:
                if isinstance(item, dict):
                    heading = str(item.get("heading", ""))
                    content = str(item.get("content", ""))
                    if heading or content:
                        cleaned.append(ReportSection(heading=heading, content=content))
            return cleaned
        return []

    @field_validator("limitations", mode="before")
    @classmethod
    def _normalize_limitations(cls, value: object) -> list[str]:
        return _coerce_str_list(value)

    @model_validator(mode="after")
    def _report_must_have_substance(self) -> ResearchReport:
        """[B21] 空报告直接判为不合规，交给上层的 repair 重试。

        GLM-4-Flash 在 prompt 没有硬性篇幅要求时，经常产出
        「一句话 summary + 空 sections」的 skeleton 报告 —— 校验能过，
        但用户看到的就是"报告怎么这么短"。这里把它变成校验失败，
        complete_structured 的 repair 循环会把具体原因回灌给模型重来一次。
        """
        total = len(self.summary) + sum(len(section.content) for section in self.sections)
        if not self.sections and len(self.summary) < 100:
            raise ValueError(
                "报告内容过少：sections 为空且 summary 过短。"
                "请输出 3~6 个小节，每节不少于 200 字，summary 不少于 150 字。"
            )
        if total < 300:
            raise ValueError(
                f"报告内容过少（全文约 {total} 字）：请把每个小节展开到 200 字以上，"
                "结合证据编号 [证据N] 展开叙述。"
            )
        return self

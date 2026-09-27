"""[B20-B23] 用生产同款 GLM-4-Flash 实测内容质量修复效果。

加载 .env.production 的配置（仅本机调用，密钥不出本机），逐项验证：
1. 研究计划：questions/steps 必须非空（B22）
2. 智能体答案：必须是结构化 Markdown、有实质篇幅（B23）
3. 报告素材：结构化输出里不得残留字面 \\n（B20）

用法：.venv/Scripts/python.exe scripts/smoke_glm_quality.py
"""

from __future__ import annotations

import asyncio
import os
import sys
import time

# 让 config 读取生产 env 文件（config.py 的规则：环境里有 PORT 变量即选
# .env.production，否则选 .env.local）。这只是在本机借用生产 GLM 配置做验证，
# 密钥不出本机，也不会改动任何配置文件。
os.environ.setdefault("PORT", "1")

# 脚本从 backend/ 根目录以外的地方启动时，也要能 import app 包
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.core.config import get_settings  # noqa: E402
from app.llm.client import get_llm_client  # noqa: E402
from app.services.planning_service import create_research_plan  # noqa: E402


def _check(name: str, ok: bool, detail: str) -> bool:
    mark = "PASS" if ok else "FAIL"
    print(f"[{mark}] {name}: {detail}")
    return ok


async def main() -> int:
    settings = get_settings()
    print(f"provider={settings.llm_provider} model={settings.llm_model}")
    client = get_llm_client()
    print(f"provider_name={client.provider_name}\n")

    results: list[bool] = []

    # ---------- 1. 研究计划（B22：不允许空计划） ----------
    t0 = time.perf_counter()
    plan_resp = await create_research_plan(
        client,
        "研究 2026 年中国新能源汽车出口欧洲的主要挑战，并分析头部车企的应对策略。",
        max_steps=5,
    )
    plan = plan_resp.plan
    print(f"--- plan: goal={plan.goal[:60]}...")
    print(f"    questions={len(plan.questions)} steps={len(plan.steps)} "
          f"sources={len(plan.expected_sources)} "
          f"tokens={plan_resp.usage['total_tokens']} "
          f"latency={int((time.perf_counter() - t0) * 1000)}ms")
    for i, step in enumerate(plan.steps[:3], 1):
        print(f"    step{i}: {step.title} | {step.instruction[:50]}")
    results.append(_check("plan 非空", bool(plan.questions) and bool(plan.steps),
                          f"questions={len(plan.questions)}, steps={len(plan.steps)}"))
    joined = plan.goal + "".join(plan.questions)
    results.append(_check("plan 无字面 \\n", "\\n" not in joined, "OK" if "\\n" not in joined else "发现字面 \\n"))

    # ---------- 2. 结构化输出无字面 \n（B20）+ 报告篇幅（B21，走 graph prompt） ----------
    from app.graph import prompts as graph_prompts
    from app.graph.schemas import ResearchReport
    from app.llm.schemas import LLMRequest

    analysis = {
        "findings": [
            "欧盟对中国电动车加征反补贴关税，税率因企业而异",
            "头部车企通过在欧洲本地建厂规避关税壁垒",
            "物流成本与认证周期是中小车企的主要门槛",
        ],
        "gaps": ["缺少 2026 年最新关税实施细则"],
    }
    evidence = [
        "[证据1] 欧盟委员会 2024 年公告：对中国产纯电动车加征 17%-35.3% 反补贴关税，比亚迪 17%、吉利 18.8%、上汽 35.3%，为期五年。",
        "[证据2] 比亚迪宣布在匈牙利塞格德建设乘用车工厂，规划年产能 15 万辆，预计 2025 年底投产；奇瑞通过合资模式落地西班牙巴塞罗那工厂。",
        "[证据3] 行业分析：欧洲整车认证（WVTA）周期通常 12-18 个月，单车认证与物流成本合计约 2000-3000 欧元，对年销量低于 5 万辆的车企构成显著压力。",
    ]
    plan_dict = {"goal": "分析中国新能源汽车出口欧洲的挑战与应对", "questions": analysis["findings"][:2], "steps": []}
    messages = graph_prompts.write_messages(
        "研究 2026 年中国新能源汽车出口欧洲的主要挑战",
        analysis,
        evidence,
        None,
        plan=plan_dict,
    )
    t0 = time.perf_counter()
    result = await client.complete_structured(
        LLMRequest(messages=messages, response_format={"type": "json_object"}, purpose="write"),
        ResearchReport,
    )
    report = result.data
    total_chars = len(report.summary) + sum(len(s.content) for s in report.sections)
    print(f"\n--- report: title={report.title[:50]}")
    print(f"    summary={len(report.summary)}字 sections={len(report.sections)} "
          f"total={total_chars}字 latency={int((time.perf_counter() - t0) * 1000)}ms")
    for s in report.sections[:4]:
        print(f"    [{s.heading}] {len(s.content)}字: {s.content[:40].strip()}...")
    # GLM-4-Flash 是小模型，对「每节 200 字」的遵守率有限；实测基线：
    # 修复前典型输出 <150 字（一句话 summary + 短语堆砌），修复后稳定在 400+。
    # 硬校验（schema 层）守 300 字底线，这里用 400 作为质量预期。
    results.append(_check("report 篇幅", total_chars >= 400, f"total={total_chars}字"))
    all_text = report.summary + "".join(s.content for s in report.sections)
    results.append(_check("report 无字面 \\n", "\\n" not in all_text,
                          "OK" if "\\n" not in all_text else "发现字面 \\n"))
    results.append(_check("report 有真实换行", "\n" in all_text, "OK"))

    # ---------- 3. 智能体答案（B23：结构化、有篇幅） ----------
    from app.agent.orchestrator import run_agent
    from app.tools.registry import build_default_registry

    registry = build_default_registry()
    t0 = time.perf_counter()
    agent_result = await run_agent(
        question="向量数据库有哪些主流选择？各自适用场景是什么？",
        client=client,
        registry=registry,
        max_steps=4,
    )
    answer = agent_result.answer
    print(f"\n--- agent: finished={agent_result.finished_reason} "
          f"tools={len(agent_result.tool_calls)} answer={len(answer)}字 "
          f"latency={int((time.perf_counter() - t0) * 1000)}ms")
    print(f"    answer 开头: {answer[:120].strip()}...")
    results.append(_check("agent 答案篇幅", len(answer) >= 200, f"{len(answer)}字"))
    import re

    has_structure = bool(
        "##" in answer or re.search(r"\n\s*[-*] ", answer) or re.search(r"\n\s*\d+\. ", answer)
    )
    results.append(_check("agent 答案含结构", has_structure,
                          "含 Markdown 结构" if has_structure else "无明显结构"))
    results.append(_check("agent 无字面 \\n", "\\n" not in answer,
                          "OK" if "\\n" not in answer else "发现字面 \\n"))

    print(f"\n===== 结果：{sum(results)}/{len(results)} 通过 =====")
    return 0 if all(results) else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))

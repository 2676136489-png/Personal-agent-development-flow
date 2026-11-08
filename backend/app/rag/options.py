"""RAG 参数元数据：切块与检索共用的参数说明（前端控件的唯一数据源）。

为什么单独一个文件：这些参数是「配置界面」的契约 ——
前端按 type/min/max 渲染滑杆，后端用它给默认值。散在 chunking / retrieval 里
会变成两边各写一份，改一个忘一个。
"""

from __future__ import annotations

PARAM_OPTIONS: dict[str, dict] = {
    "chunk_size": {
        "label": "块大小（字符）",
        "type": "int",
        "min": 150,
        "max": 2000,
        "step": 50,
        "default": 400,
        "hint": "越小检索越准但上下文越碎；中文 400–800 是常见区间",
    },
    "overlap": {
        "label": "重叠（字符）",
        "type": "int",
        "min": 0,
        "max": 400,
        "step": 20,
        "default": 80,
        "hint": "避免跨边界的句子丢失；计入块大小预算，起点会吸附到句首",
    },
    "min_chunk": {
        "label": "最小块（字符）",
        "type": "int",
        "min": 0,
        "max": 300,
        "step": 10,
        "default": 60,
        "hint": "短于这个长度的碎片并入相邻块",
    },
    "keep_heading": {
        "label": "块内保留标题",
        "type": "bool",
        "default": True,
        "hint": "把标题一起切进块里，检索时更容易命中章节主题",
    },
    "breakpoint_percentile": {
        "label": "断点分位",
        "type": "float",
        "min": 0.5,
        "max": 0.98,
        "step": 0.02,
        "default": 0.9,
        "hint": "只在跌幅最大的那一小撮边界断开；调低 = 切得更碎",
    },
    "top_k": {
        "label": "返回条数 top_k",
        "type": "int",
        "min": 1,
        "max": 12,
        "step": 1,
        "default": 5,
        "hint": "最终进入 prompt 的块数",
    },
    "candidate_k": {
        "label": "候选池 candidate_k",
        "type": "int",
        "min": 3,
        "max": 60,
        "step": 1,
        "default": 20,
        "hint": "先粗排多少条，再从中精选或重排",
    },
    "rrf_k": {
        "label": "RRF 常数 k",
        "type": "int",
        "min": 10,
        "max": 120,
        "step": 5,
        "default": 60,
        "hint": "论文默认 60；越大越弱化头部名次的优势",
    },
    "alpha": {
        "label": "稠密权重 alpha",
        "type": "float",
        "min": 0,
        "max": 1,
        "step": 0.05,
        "default": 0.6,
        "hint": "alpha=1 纯向量，alpha=0 纯关键词",
    },
    "mmr_lambda": {
        "label": "相关性 λ",
        "type": "float",
        "min": 0,
        "max": 1,
        "step": 0.05,
        "default": 0.7,
        "hint": "λ=1 只看相关性，越小越强调多样性",
    },
    "min_score": {
        "label": "最低相似度",
        "type": "float",
        "min": 0,
        "max": 0.9,
        "step": 0.05,
        "default": 0,
        "hint": "低于它直接丢弃；0 = 不过滤",
    },
}

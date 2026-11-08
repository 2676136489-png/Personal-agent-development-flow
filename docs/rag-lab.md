# RAG 实验台：把一条检索链路拆成五步看

知识库页面回答「我有什么」，这一页回答「检索为什么没召回」。同一份语料，换一种切法、换一种检索方式，中间结果直接摊在下面：切块边界、向量热力图、块在二维平面上的分布、每个候选的两个排名。

页面是 [`frontend/src/features/rag/RagLab.tsx`](../frontend/src/features/rag/RagLab.tsx)，后端在 [`backend/app/rag/lab.py`](../backend/app/rag/lab.py)。

## 一次运行做了什么

| 阶段 | 产出 | 关键字段 |
|---|---|---|
| parse | 把语料统一成一段文本 | `chars` / `paragraphs` / `sentences` / `pages` / `preview` |
| chunk | 按选定策略切块 | `chunks[]`（内容、字数、字符区间、页码、标题路径）/ `overlaps[]` |
| embed | 每块一条向量 | `model` / `dims` / `heatmap`（前 40 块 × 16 维）/ `projection`（二维点）/ `query_point` |
| retrieve | 候选与两份排名 | `candidates[]`（`dense` / `bm25` / 各自名次 / 是否入选）/ `meta` |
| assemble | 最终 prompt | `text` / `chars` / `tokens` / `entries[]` |

`overlaps[]` 是相邻块共享的字符区间，前端据此在色带上盖斜纹——「这两块有 63 字是重复的」比在文字里写一遍参数直观。

## 切块的五种方法

都在卡片上标了出处，点开是官方文档：

| 策略 | 做法 | 出处 |
|---|---|---|
| `recursive` | 段落 → 句子 → 硬切，逐级下切到不超限，再贪心合并 | LangChain · RecursiveCharacterTextSplitter |
| `fixed` | 固定字数，只在句号/换行处做一次软断句 | LangChain · CharacterTextSplitter |
| `sentence` | 以整句为最小单位装满一块，边界永远在句号后 | LlamaIndex · SentenceWindowNodeParser |
| `markdown` | 按 `#/##/###` 层级切，块上带「一级 › 二级」路径 | LangChain · MarkdownHeaderTextSplitter |
| `semantic` | 算相邻句向量相似度，跌幅超过分位阈值就断开 | LangChain · SemanticChunker |

### 重叠的语义

重叠不是「每块后面多贴一段」。它计在 `chunk_size` 预算里：下一块从上一块尾部 `overlap` 字处起算，再往后装新内容，装满 `chunk_size` 为止。于是两个约束同时成立——块不超过设定大小，相邻块又真的有共享区。

起点还会向前吸附到句首：一个 300 字的段落配 80 字重叠，不会把段落拦腰截成半句开头。代价是实际重叠量略小于设定值（示例语料里设 80，实测 63 字），换来的是每块开头都读得通。

只有 `fixed` 例外：它的定位就是「字数可预测」，重叠直接按字符回退，不做吸附。

`semantic` 不用重叠——断点本来就落在语义边界上，再加重叠是把同一段话算两遍。

示例语料 868 字，`recursive` + 400/80：切 3 块，平均 331 字，2 处重叠各 63 字。换成知识库里的示例文档（1309 字）是 5 块、4 处重叠，52–71 字不等——重叠量随句子长度浮动，但从不越界。

## 检索的五种方法

| 方法 | 打分 | 参数 |
|---|---|---|
| `dense` | 余弦相似度 | `top_k` / `candidate_k` / `min_score` |
| `bm25` | Okapi BM25（k1=1.5，b=0.75，中文按字二元组切） | `top_k` |
| `hybrid_rrf` | `Σ 1/(k + 名次)`，k 默认 60 | `top_k` / `candidate_k` / `rrf_k` |
| `hybrid_weighted` | 两路归一化后按 `alpha` 加权 | `top_k` / `alpha` / `min_score` |
| `mmr` | 相关性 − λ·与已选块的最大相似度 | `top_k` / `candidate_k` / `mmr_lambda` |

中文 BM25 没有词典可分，这里用字二元组（「召回率」→ 召回 / 回率），比按空格切稳得多，代价是索引项多一倍——在万级块以内无所谓。

检索结果里每条都带两路名次，所以「为什么这条排第一」是能看出来的：向量第 3、BM25 第 1，融合后总分最高。

## 向量从哪来

`discover_embedders()` 按顺序试，第一个能用的生效：

1. `EMBEDDING_*` 显式配置的 OpenAI 兼容端点
2. 复用 LLM 的端点与 Key（同一家厂商的 embedding 与 chat 通常同源，智谱 `embedding-3` 与 GLM 就是同一个 Key）
3. 本地 Ollama（socket 探活，0.4s 超时）
4. 哈希伪向量兜底（`semantic=false`，只做字面匹配）

每一步都带 `semantic` 标记与降级原因，`/api/knowledge/status` 会把它连同「待重建文档数」一起返回。哈希向量能跑通链路，但检索质量是字面级的——所以知识库页在 `semantic=false` 时会显示一条提示，而不是假装一切正常。

**模型一致性**：`documents.embedding_model` 存的是 `spec.id`（如 `bigmodel:embedding-3`）。检索只认当前模型算出来的向量，换了模型旧向量直接不参与；启动时的后台任务 `reindex_stale()` 会把它们按新模型重算一遍。不同模型的向量混在一个索引里，余弦相似度是没有意义的。

## 四张图怎么画的

都是手写 SVG / CSS，没有引图表库——四个图本质都是「把比例映射成位置」，引库既要适配明暗主题，又要多几十 KB 依赖。

- **切块色带**：按字符位置百分比绝对定位，重叠区盖斜纹；悬停联动下方块卡片
- **向量热力图**：前 40 块 × 前 16 维的彩色网格，正负值分色，全局最大绝对值归一
- **二维散点**：把 2048 维向量用 SVD 压到 2 维（PCA），问题向量单独标出，能看出「问题落在哪一簇附近」
- **打分条**：带底轨的横向条，长度按分数占最大值的比例——没有底轨时 0.03 和 0.09 看起来一样长

## 接口

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/api/rag/options` | 切块 / 检索 / 向量后端 / 参数元数据（前端控件的唯一数据源） |
| POST | `/api/rag/pipeline` | 跑一次完整链路，返回五阶段明细 |
| GET | `/api/knowledge/status` | 当前向量后端、维度、是否语义、待重建文档数 |
| POST | `/api/knowledge/reindex?force=` | 按当前模型重建索引 |

`/api/rag/pipeline` 的语料可以是粘贴文本，也可以是知识库里的文档 id。超过 6 万字直接 413——实验台是给人看中间结果的，不是批处理入口。

## 怎么验的

- `backend/tests/test_rag_lab.py`：五种切法的边界行为、BM25 精确命中、RRF/MMR/`min_score`、五阶段齐全、空文本 422、重叠既存在又不越界。全量 `pytest` 256 passed。
- `frontend/scripts/probe-rag-page.cjs`：真浏览器里跑两条链路（语义切分 + 递归切分），断言 5 张图、色带段数 = 块卡片数、斜纹数 > 0、热力格数、散点数、命中行数、prompt 字数、无横向溢出、深色主题生效、控制台无报错。
- 实测：语义切分 + RRF，2048 维真向量，整条链路 1.6s 左右；递归切分同一份文档 0.44s——差距全在 embedding 调用上，切块与检索本身是毫秒级。

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ApiClientError } from '../../api/client'
import { listDocuments } from '../../api/knowledge'
import { fetchRagOptions, runRagPipeline } from '../../api/rag'
import { PageHeader } from '../../components/PageHeader'
import { EmptyState } from '../../components/EmptyState'
import { ErrorState } from '../../components/ErrorState'
import { LoadingState } from '../../components/LoadingState'
import type { Document } from '../../types/knowledge'
import type {
  RagChunk,
  RagEmbedDetail,
  RagMethodOption,
  RagOptions,
  RagParamDef,
  RagPromptDetail,
  RagRetrieveDetail,
  RagRunResult,
} from '../../types/rag'
import { ChunkRuler, HitList, StatRow, VectorHeatmap, VectorScatter } from './RagVisuals'

/* ------------------------------------------------------------------ 默认值 */

const DEFAULT_CHUNKING: ChunkSettings = {
  strategy: 'recursive',
  chunk_size: 400,
  overlap: 80,
  min_chunk: 60,
  keep_heading: true,
  breakpoint_percentile: 0.9,
}

const DEFAULT_RETRIEVAL: RetrievalSettings = {
  method: 'hybrid_rrf',
  top_k: 5,
  candidate_k: 20,
  rrf_k: 60,
  alpha: 0.6,
  mmr_lambda: 0.7,
  min_score: 0,
}

interface ChunkSettings {
  strategy: string
  chunk_size: number
  overlap: number
  min_chunk: number
  keep_heading: boolean
  breakpoint_percentile: number
}

interface RetrievalSettings {
  method: string
  top_k: number
  candidate_k: number
  rrf_k: number
  alpha: number
  mmr_lambda: number
  min_score: number
}

const STORAGE_KEY = 'arw-rag-config'

/** 示例语料：本身就在讲 RAG，用户不传文档也能看懂每一步在做什么。 */
const SAMPLE_TEXT = `# RAG 检索质量手册

## 一、切块为什么决定上限
检索的最小单位是块，不是文档。块太大，一个向量要代表太多主题，任何问题都只能命中一个模糊的
折中答案；块太小，一句话被切走上下文，模型拿到也读不懂。经验区间是中文 300 到 800 字，
重叠取块大小的百分之十到二十，让跨边界的句子在两侧都出现。

## 二、向量化的取舍
稠密向量擅长语义泛化：用户问「怎么提升召回率」，也能命中写「优化检索效果」的段落。
但它对型号、错误码、数字不敏感。BM25 恰好相反，精确词命中很强，换个说法就失效。
所以生产系统默认是混合检索，用 RRF 把两份排名合起来，而不是二选一。

## 三、索引与规模
向量检索的暴力做法是把问题向量与库里每一条做余弦相似度，几万条以内完全够用。
再往上就要建近似最近邻索引：HNSW 用图结构换速度，召回损失小、内存占用高；
IVF-PQ 先聚类再量化，内存省得多，但需要训练且召回会掉。选型时先看数据量级与预算，
别一上来就上分布式向量库。

## 四、重排与多样性
召回阶段追求不漏，重排阶段追求精准。MMR 解决的问题不太一样：当同一段话在文档里反复出现，
top5 很容易是同一段的五个副本。MMR 在相关性之外惩罚与已选块过于相似的候选，
用 lambda 控制这个惩罚的强度，代价是偶尔会把真正最相关的那条挤下去。

## 五、评估方式
别只看单次演示效果。用标注好的问题与段落对，算 recall@k 与 MRR：
recall@k 衡量该找到的有没有进候选，MRR 衡量第一条正确结果排得多靠前。
两个指标一起看，才能区分「召回不够」和「排序不好」。线上还要看回答的引用命中率，
它比单一检索指标更贴近用户实际感受。

## 六、三个常见误区
第一，把知识库当聊天记录用：同一个问题反复上传同一份文件，库里堆满重复块，
检索结果全是近重复项。第二，只看 top1：召回本来就会抖，评估要看前五条里有没有正确答案。
第三，把切块参数当成一次定终身的配置：文档类型变了，合适的块大小也会变。`

const SAMPLE_QUERY = '向量检索召回率不高，应该怎么调'

/* ------------------------------------------------------------------- 页面 */

export function RagLab() {
  const [options, setOptions] = useState<RagOptions | null>(null)
  const [documents, setDocuments] = useState<Document[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)

  const [corpusKind, setCorpusKind] = useState<'text' | 'document'>('text')
  const [documentId, setDocumentId] = useState('')
  const [text, setText] = useState(SAMPLE_TEXT)
  const [query, setQuery] = useState(SAMPLE_QUERY)

  const [chunking, setChunking] = useState<ChunkSettings>(DEFAULT_CHUNKING)
  const [retrieval, setRetrieval] = useState<RetrievalSettings>(DEFAULT_RETRIEVAL)
  const [embedderId, setEmbedderId] = useState<string | null>(null)

  const [running, setRunning] = useState(false)
  const [runError, setRunError] = useState<string | null>(null)
  const [result, setResult] = useState<RagRunResult | null>(null)
  const [focusChunk, setFocusChunk] = useState<number | null>(null)
  const resultsRef = useRef<HTMLDivElement>(null)

  // 首次加载：方法清单 + 知识库文档列表（并行，任一失败都能单独降级）
  useEffect(() => {
    let alive = true
    async function boot() {
      try {
        const [opts, docs] = await Promise.all([fetchRagOptions(), listDocuments()])
        if (!alive) return
        setOptions(opts)
        setDocuments(docs)
        const stored = readStored()
        if (stored) {
          setChunking({ ...DEFAULT_CHUNKING, ...stored.chunking })
          setRetrieval({ ...DEFAULT_RETRIEVAL, ...stored.retrieval })
          if (stored.embedderId) setEmbedderId(stored.embedderId)
        }
        setEmbedderId((current) => current ?? pickDefaultEmbedder(opts))
      } catch (error) {
        if (!alive) return
        setLoadError(error instanceof ApiClientError ? error.message : '加载 RAG 配置失败')
      } finally {
        if (alive) setLoading(false)
      }
    }
    void boot()
    return () => {
      alive = false
    }
  }, [])

  // 记住上次的选择：调参是反复试的过程，刷新一次就清零很折磨人
  useEffect(() => {
    if (loading) return
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ chunking, retrieval, embedderId }))
    } catch {
      // 隐私模式下写不进去，忽略
    }
  }, [chunking, retrieval, embedderId, loading])

  const activeChunker = useMemo(
    () => options?.chunkers.find((item) => item.id === chunking.strategy),
    [options, chunking.strategy],
  )
  const activeRetriever = useMemo(
    () => options?.retrievers.find((item) => item.id === retrieval.method),
    [options, retrieval.method],
  )
  const activeEmbedder = useMemo(
    () => options?.embedders.find((item) => item.id === embedderId),
    [options, embedderId],
  )

  /* 底部回显：四步各选了什么，用一句话说清，不用回头再翻上面的选项 */
  const chosenDocument = documents.find((doc) => doc.id === documentId)
  const corpusLabel =
    corpusKind === 'document'
      ? (chosenDocument?.filename ?? '未选择文档')
      : `粘贴文本 · ${text.trim().length.toLocaleString()} 字`
  const chunkLabel = `${activeChunker?.label ?? chunking.strategy} · ${chunking.chunk_size} 字${
    activeChunker?.params.includes('overlap') ? ` / 重叠 ${chunking.overlap}` : ''
  }`
  const embedLabel = `${activeEmbedder?.model ?? '—'}${
    activeEmbedder?.dims ? ` · ${activeEmbedder.dims} 维` : ''
  }`
  const retrievalLabel = `${activeRetriever?.label ?? retrieval.method} · top ${retrieval.top_k}`

  /* 第 1 列底部的语料体检：粘贴文本时按当前切块参数估一个块数，
     选文档时直接用库里的元数据。四列等高，这一块也顺手把左列的空档填上。 */
  const corpusFacts =
    corpusKind === 'document'
      ? [
          { label: '已切片', value: chosenDocument ? `${chosenDocument.chunk_count} 块` : '—' },
          {
            label: '文件大小',
            value: chosenDocument
              ? `${Math.max(1, Math.round(chosenDocument.size_bytes / 1024))} KB`
              : '—',
          },
          {
            label: '向量模型',
            /* 库里的 id 形如 bigmodel:embedding-3，格子窄，只留模型名 */
            value: chosenDocument?.embedding_model?.split(':').pop() ?? '未向量化',
          },
        ]
      : (() => {
          const chars = text.trim().length
          const paras = text.split(/\n{2,}/).filter((part) => part.trim().length > 0).length
          const step = Math.max(1, chunking.chunk_size - chunking.overlap)
          const chunks = chars === 0 ? 0 : Math.max(1, Math.ceil((chars - chunking.overlap) / step))
          return [
            { label: '字符', value: chars.toLocaleString() },
            { label: '段落', value: String(paras) },
            { label: '预计块', value: `约 ${chunks}` },
          ]
        })()

  const handleRun = useCallback(async () => {
    if (query.trim().length < 2) {
      setRunError('先写一个至少 2 个字的问题')
      return
    }
    if (corpusKind === 'document' && !documentId) {
      setRunError('先在知识库里选一份文档')
      return
    }
    if (corpusKind === 'text' && text.trim().length < 20) {
      setRunError('粘贴的文本太短了，至少 20 字才切得动')
      return
    }

    setRunning(true)
    setRunError(null)
    try {
      const response = await runRagPipeline({
        query: query.trim(),
        corpus:
          corpusKind === 'document'
            ? { kind: 'document', document_id: documentId }
            : { kind: 'text', text: text.trim(), title: '粘贴的文本' },
        chunking,
        embedding: { spec_id: embedderId },
        retrieval,
      })
      setResult(response)
      window.requestAnimationFrame(() => {
        resultsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      })
    } catch (error) {
      setResult(null)
      setRunError(error instanceof ApiClientError ? error.message : '运行失败，请查看浏览器控制台')
    } finally {
      setRunning(false)
    }
  }, [chunking, corpusKind, documentId, embedderId, query, retrieval, text])

  if (loading) {
    return (
      <section className="panel">
        <PageHeader
          eyebrow="RAG 实验台"
          title="把 RAG 的五步摊开看"
          lede="正在读取可用的切块、向量化与检索方法…"
        />
        <LoadingState variant="card" rows={4} label="正在加载 RAG 配置…" />
      </section>
    )
  }

  if (loadError || !options) {
    return (
      <section className="panel">
        <PageHeader eyebrow="RAG 实验台" title="把 RAG 的五步摊开看" lede="配置没能加载出来。" />
        <ErrorState message={loadError ?? '未知错误'} onRetry={() => window.location.reload()} />
      </section>
    )
  }

  return (
    <section className="panel rag-lab">
      <PageHeader
        eyebrow="RAG 实验台"
        title="把 RAG 的五步摊开看"
        lede="选一套方法，跑一遍真实的 RAG：解析、切块、向量化、检索、组装上下文。每一步的中间结果都摊在下面，包括切块边界、向量热力图和两种召回各自的排名。"
        notes={[
          { term: '怎么用', desc: '按 ①②③④ 依次选好方法 → 下面确认一遍 → 开始 RAG。' },
          { term: '看什么', desc: '重点看「同一份材料换一种切法」和「BM25 与向量的排名差在哪里」。' },
          { term: '注意', desc: '这里只做演示，不写入知识库；写库请用知识库页面的上传。' },
        ]}
      />

      <div className="rag-flow" aria-label="RAG 方法配置">
        <StepColumn
          step="1"
          title="语料"
          desc="喂给 RAG 的材料"
          options={
            <div className="rag-switch" role="tablist" aria-label="语料来源">
              <button
                type="button"
                role="tab"
                aria-selected={corpusKind === 'text'}
                className="rag-switch__btn"
                data-active={corpusKind === 'text'}
                onClick={() => setCorpusKind('text')}
              >
                粘贴文本
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={corpusKind === 'document'}
                className="rag-switch__btn"
                data-active={corpusKind === 'document'}
                onClick={() => setCorpusKind('document')}
              >
                知识库（{documents.length}）
              </button>
            </div>
          }
        >
          {corpusKind === 'text' ? (
            <>
              <textarea
                className="input rag-textarea"
                rows={7}
                value={text}
                onChange={(event) => setText(event.target.value)}
                placeholder="粘贴一段要检索的中文材料…"
              />
              <div className="rag-inline">
                <span className="hint">{text.length.toLocaleString()} 字</span>
                <button type="button" className="rag-linkbtn" onClick={() => setText(SAMPLE_TEXT)}>
                  恢复示例
                </button>
              </div>
            </>
          ) : documents.length === 0 ? (
            <p className="hint">知识库还是空的。先去「知识库」页上传一份文档，再回来选它。</p>
          ) : (
            <label className="field">
              <span className="field__label">选择文档</span>
              <select
                className="input"
                value={documentId}
                onChange={(event) => setDocumentId(event.target.value)}
              >
                <option value="">请选择…</option>
                {documents.map((doc) => (
                  <option key={doc.id} value={doc.id}>
                    {doc.filename}（{doc.chunk_count} 块）
                  </option>
                ))}
              </select>
            </label>
          )}

          <div className="rag-corpus-row">
            <div className="rag-corpus">
              <div className="rag-corpus__grid">
                {corpusFacts.map((item) => (
                  <div className="rag-corpus__cell" key={item.label}>
                    <span className="rag-corpus__value">{item.value}</span>
                    <span className="rag-corpus__label">{item.label}</span>
                  </div>
                ))}
              </div>
              <p className="rag-corpus__note">
                {corpusKind === 'document'
                  ? '块按库里的切片走；想换切法，用左边「粘贴文本」跑一遍对比。'
                  : `块数按 ${chunking.chunk_size} 字 / 重叠 ${chunking.overlap} 估算，实际以运行结果为准。`}
              </p>
            </div>

            <label className="field">
              <span className="field__label">要检索的问题</span>
              <input
                className="input"
                value={query}
                maxLength={200}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="例如：向量检索召回率怎么提升"
              />
            </label>
          </div>
        </StepColumn>

        <StepColumn
          step="2"
          title="切块"
          desc="决定检索的最小单位"
          options={
            <MethodList
              name="切块方法"
              options={options.chunkers}
              value={chunking.strategy}
              onChange={(id) => setChunking((prev) => ({ ...prev, strategy: id }))}
            />
          }
        >
          <MethodDetail
            option={activeChunker}
            note={
              activeChunker?.needs_embedding
                ? '这一步会先调用向量模型算句向量，耗时比其他切法高。'
                : undefined
            }
          />
          <div className="rag-params">
            {(activeChunker?.params ?? []).map((name) => (
              <ParamField
                key={name}
                def={options.params[name]}
                value={chunking[name as keyof ChunkSettings] as number | boolean}
                onChange={(value) =>
                  setChunking((prev) => ({ ...prev, [name]: value }) as ChunkSettings)
                }
              />
            ))}
          </div>
        </StepColumn>

        <StepColumn
          step="3"
          title="向量化"
          desc="把块变成向量"
          options={
            <div className="rag-methods" role="radiogroup" aria-label="向量后端">
              {options.embedders.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  role="radio"
                  aria-checked={embedderId === item.id}
                  className="rag-method rag-method--block"
                  data-active={embedderId === item.id}
                  disabled={!item.available}
                  onClick={() => setEmbedderId(item.id)}
                >
                  <span className="rag-method__label">{item.label}</span>
                  <span className="rag-method__meta">
                    {[
                      item.label.includes(item.model) ? null : item.model,
                      item.dims ? `${item.dims} 维` : null,
                      item.semantic ? '语义' : '仅字面',
                      item.available ? null : '不可用',
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                </button>
              ))}
            </div>
          }
        >
          {activeEmbedder && (
            <>
              <div className="rag-method-detail">
                <div className="rag-method-detail__head">
                  <h4 className="rag-method-detail__title">{activeEmbedder.label}</h4>
                  {activeEmbedder.doc_url && (
                    <a
                      className="rag-method-detail__doc"
                      href={activeEmbedder.doc_url}
                      target="_blank"
                      rel="noreferrer noopener"
                    >
                      {activeEmbedder.doc_label} ↗
                    </a>
                  )}
                </div>
                <p className="rag-method-detail__text">
                  {[
                    `模型 ${activeEmbedder.model}`,
                    activeEmbedder.dims ? `${activeEmbedder.dims} 维` : null,
                    activeEmbedder.endpoint ? `端点 ${activeEmbedder.endpoint}` : null,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </p>
                {activeEmbedder.note && (
                  <p className="rag-method-detail__text">{activeEmbedder.note}</p>
                )}
              </div>

              <dl className="rag-facts">
                <div className="rag-facts__row">
                  <dt>维度</dt>
                  <dd>{activeEmbedder.dims ? `${activeEmbedder.dims} 维` : '—'}</dd>
                </div>
                <div className="rag-facts__row">
                  <dt>相似度</dt>
                  <dd>余弦 · 归一化</dd>
                </div>
                <div className="rag-facts__row">
                  <dt>换后端</dt>
                  <dd>旧向量退出</dd>
                </div>
              </dl>

              <p className="rag-note">
                语义切分也调这个模型找断点，所以换后端会连带改变切法；一步里只算一遍，块越多越慢。
              </p>
            </>
          )}
        </StepColumn>

        <StepColumn
          step="4"
          title="检索"
          desc="从所有块里挑出这几条"
          options={
            <MethodList
              name="检索方法"
              options={options.retrievers}
              value={retrieval.method}
              onChange={(id) => setRetrieval((prev) => ({ ...prev, method: id }))}
            />
          }
        >
          <MethodDetail option={activeRetriever} />
          <div className="rag-params">
            {(activeRetriever?.params ?? []).map((name) => (
              <ParamField
                key={name}
                def={options.params[name]}
                value={retrieval[name as keyof RetrievalSettings] as number | boolean}
                onChange={(value) =>
                  setRetrieval((prev) => ({ ...prev, [name]: value }) as RetrievalSettings)
                }
              />
            ))}
          </div>
        </StepColumn>
      </div>

      <div className="rag-recap">
        <div className="rag-recap__items">
          <RecapItem step="1" label="语料" value={corpusLabel} />
          <RecapItem step="2" label="切块" value={chunkLabel} />
          <RecapItem step="3" label="向量" value={embedLabel} />
          <RecapItem step="4" label="检索" value={retrievalLabel} />
        </div>
        <div className="rag-recap__run">
          <button
            type="button"
            className="button button--primary rag-run__btn"
            disabled={running}
            onClick={() => void handleRun()}
          >
            {running ? '正在跑整条链路…' : '开始 RAG'}
          </button>
          <p className="hint">真实调用向量模型，块越多越慢</p>
        </div>
      </div>

      {runError && <div className="alert alert--error rag-alert">{runError}</div>}

      <div className="rag-results" ref={resultsRef}>
        {!result ? (
          <EmptyState
            title="还没有运行结果"
            description="上面四步选好方法，点「开始 RAG」，这里会按顺序摊开五步的真实产物：切块边界、向量、排名与最终上下文。"
          />
        ) : (
          <ResultView
            result={result}
            options={options}
            focusChunk={focusChunk}
            onFocus={setFocusChunk}
          />
        )}
      </div>
    </section>
  )
}

/* --------------------------------------------------------------- 结果视图 */

function ResultView({
  result,
  options,
  focusChunk,
  onFocus,
}: {
  result: RagRunResult
  options: RagOptions
  focusChunk: number | null
  onFocus: (index: number | null) => void
}) {
  const stage = (key: string) => result.stages.find((item) => item.key === key)
  const parse = stage('parse')?.detail
  const chunk = stage('chunk')
  const embed = stage('embed')
  const retrieveStage = stage('retrieve')
  const assemble = stage('assemble')

  const chunkDetail = chunk?.detail
  const embedDetail = embed?.detail as RagEmbedDetail | undefined
  const retrieveDetail = retrieveStage?.detail as RagRetrieveDetail | undefined
  const promptDetail = assemble?.detail as RagPromptDetail | undefined

  const chunkerMeta = options.chunkers.find((item) => item.id === chunkDetail?.strategy)
  const retrieverMeta = options.retrievers.find((item) => item.id === retrieveDetail?.method)

  const chunks: RagChunk[] = chunkDetail?.chunks ?? []
  const selectedIndexes = (retrieveDetail?.selected ?? []).map((hit) => hit.index)

  return (
    <div className="rag-report">
      <div className="rag-runbar">
        <div className="rag-runbar__stages">
          {result.stages.map((item, index) => (
            <div className="rag-runbar__stage" key={item.key}>
              <span className="rag-runbar__no">{index + 1}</span>
              <span className="rag-runbar__label">{item.label}</span>
              <span className="rag-runbar__ms">{item.ms} ms</span>
            </div>
          ))}
        </div>
        <div className="rag-runbar__total">
          共 <b>{result.total_ms} ms</b> · {result.title}
        </div>
      </div>

      {result.warnings.length > 0 && (
        <div className="alert rag-alert rag-alert--warn">
          {result.warnings.map((warning) => (
            <div key={warning}>{warning}</div>
          ))}
        </div>
      )}

      <Figure
        no="1"
        title="解析"
        meta={parse?.chars ? `${parse.chars.toLocaleString()} 字` : ''}
      >
        {parse && (
          <>
            <StatRow
              items={[
                { label: '字符', value: (parse.chars ?? 0).toLocaleString() },
                { label: '段落', value: String(parse.paragraphs ?? 0) },
                { label: '句子', value: String(parse.sentences ?? 0) },
                { label: '页数', value: parse.pages ? String(parse.pages) : '—' },
              ]}
            />
            <pre className="rag-preview">{parse.preview ?? ''}</pre>
            {parse.truncated && <p className="rag-figure__note">预览已截断，切块仍按全文计算。</p>}
          </>
        )}
      </Figure>

      <Figure
        no="2"
        title="切块"
        meta={chunkerMeta ? `${chunkerMeta.label} · ${chunk?.summary}` : chunk?.summary}
        doc={chunkerMeta}
      >
        <StatRow
          items={[
            { label: '块数', value: String(chunks.length) },
            { label: '平均字数', value: String(chunkDetail?.avg_chars ?? '—') },
            { label: '平均 tokens', value: String(chunkDetail?.avg_tokens ?? '—') },
            { label: '重叠对数', value: String(chunkDetail?.overlaps?.length ?? 0) },
          ]}
        />
        <ChunkRuler
          chunks={chunks}
          overlaps={chunkDetail?.overlaps ?? []}
          totalChars={parse?.chars ?? 0}
          focus={focusChunk}
          onFocus={onFocus}
        />
        <p className="rag-figure__note">
          色带按字符比例画：每段是一个块，斜纹是相邻块的重叠区。悬停可对齐下面的卡片。
        </p>
        <div className="rag-chunks">
          {chunks.map((item) => (
            <article
              className="rag-chunk"
              key={item.index}
              data-focus={focusChunk === item.index}
              onMouseEnter={() => onFocus(item.index)}
              onMouseLeave={() => onFocus(null)}
            >
              <header className="rag-chunk__head">
                <span className="rag-chunk__no">#{item.index}</span>
                <span className="rag-chunk__meta">
                  {item.chars} 字 · {item.tokens} tk · {item.char_start}–{item.char_end}
                  {item.page ? ` · 第 ${item.page} 页` : ''}
                </span>
              </header>
              {item.heading && <p className="rag-chunk__heading">{item.heading}</p>}
              <p className="rag-chunk__text">{item.content}</p>
            </article>
          ))}
        </div>
      </Figure>

      <Figure
        no="3"
        title="向量化"
        meta={embedDetail ? `${embedDetail.model} · ${embedDetail.dims} 维 · ${embed?.summary}` : embed?.summary}
      >
        {embedDetail && (
          <>
            <StatRow
              items={[
                { label: '向量数', value: String(embedDetail.count) },
                { label: '维度', value: String(embedDetail.dims) },
                { label: '模长均值', value: String(embedDetail.stats.norm_mean) },
                { label: '取值范围', value: `${embedDetail.stats.value_min} ~ ${embedDetail.stats.value_max}` },
              ]}
            />
            <p className="rag-figure__note">
              {embedDetail.semantic
                ? `${embedDetail.label} 具备语义能力：换一种说法也能命中同一段内容。`
                : `${embedDetail.label} 只做字面匹配：「提升召回率」和「优化检索效果」在它看来毫无关系。`}
            </p>
            <div className="rag-vector-grid">
              <VectorHeatmap detail={embedDetail} />
              <div className="rag-figure__sub">
                <h4>块与问题在二维平面上的位置</h4>
                <VectorScatter
                  points={embedDetail.projection}
                  queryPoint={embedDetail.query_point}
                  selectedIndexes={selectedIndexes}
                  focus={focusChunk}
                  onFocus={onFocus}
                />
                <p className="rag-figure__note">
                  主成分分析把 {embedDetail.dims} 维压到 2 维。亮圈是问题向量，实心大点是进入上下文的块。
                </p>
              </div>
            </div>
          </>
        )}
      </Figure>

      <Figure
        no="4"
        title="检索"
        meta={retrieverMeta ? `${retrieverMeta.label} · ${retrieveStage?.summary}` : retrieveStage?.summary}
        doc={retrieverMeta}
      >
        {retrieveDetail && (
          <>
            <StatRow
              items={[
                { label: '语料块数', value: String(retrieveDetail.meta.corpus_size ?? chunks.length) },
                { label: '候选池', value: String(retrieveDetail.meta.pool ?? '—') },
                { label: '进入上下文', value: String(retrieveDetail.selected.length) },
                {
                  label: '向量分数区间',
                  value: Array.isArray(retrieveDetail.meta.dense_range)
                    ? retrieveDetail.meta.dense_range.join(' ~ ')
                    : '—',
                },
              ]}
            />
            <div className="rag-bars-legend">
              <span><i className="rag-bars-legend__dot rag-bars-legend__dot--fused" />最终得分</span>
              <span><i className="rag-bars-legend__dot rag-bars-legend__dot--dense" />向量相似度</span>
              <span><i className="rag-bars-legend__dot rag-bars-legend__dot--bm25" />BM25</span>
            </div>
            <HitList hits={retrieveDetail.candidates} focus={focusChunk} onFocus={onFocus} />
            {retrieveDetail.selected.length === 0 && (
              <p className="rag-figure__note">没有块达到阈值，试着调低「最低相似度」。</p>
            )}
          </>
        )}
      </Figure>

      <Figure
        no="5"
        title="组装上下文"
        meta={promptDetail ? `${(promptDetail.chars ?? 0).toLocaleString()} 字 · 约 ${(promptDetail.tokens ?? 0).toLocaleString()} tokens` : ''}
      >
        {promptDetail && (
          <>
            <StatRow
              items={[
                { label: '引用块数', value: String(promptDetail.entries?.length ?? 0) },
                { label: '上下文原文字数', value: (promptDetail.context_chars ?? 0).toLocaleString() },
                { label: '整段 prompt', value: (promptDetail.chars ?? 0).toLocaleString() },
                { label: '估算 tokens', value: (promptDetail.tokens ?? 0).toLocaleString() },
              ]}
            />
            <div className="rag-citations">
              {(promptDetail.entries ?? []).map((entry) => (
                <span className="rag-citation" key={entry.n}>
                  [{entry.n}] 块 #{entry.index} · {entry.chars} 字
                </span>
              ))}
            </div>
            <pre className="rag-prompt">{promptDetail.text ?? ''}</pre>
          </>
        )}
      </Figure>
    </div>
  )
}

/* --------------------------------------------------------------- 小组件 */

/** 一步 = 一条横区：标题占一行，下面左边竖排选项、右边放选中项的详情。
 *
 *  为什么横过来：四步并排时每步只有 ~260px，选项和说明只能上下叠，
 *  说明被挤成十来个字一行；语料的原文更是只能看见两三行。
 *  改成横区之后语料有整行宽度，选项仍然是竖排的一列，视线只需左右跳一次。 */
function StepColumn({
  step,
  title,
  desc,
  options,
  children,
}: {
  step: string
  title: string
  desc: string
  options?: ReactNode
  children: ReactNode
}) {
  return (
    <section className="rag-step">
      <header className="rag-step__head">
        <span className="rag-step__no">{step}</span>
        <h3 className="rag-step__title">{title}</h3>
        <span className="rag-step__desc">{desc}</span>
      </header>
      <div className="rag-step__body">
        {options && <div className="rag-step__options">{options}</div>}
        <div className="rag-step__pane">{children}</div>
      </div>
    </section>
  )
}

/** 底部回显的一项：第几步 + 选了什么 */
function RecapItem({ step, label, value }: { step: string; label: string; value: string }) {
  return (
    <div className="rag-recap__item">
      <span className="rag-recap__label">
        {step} · {label}
      </span>
      <span className="rag-recap__value" title={value}>
        {value}
      </span>
    </div>
  )
}

/** 方法选择：一列单选行，只放名字 —— 说明放到右边的详情区，
 *  这样左边扫一眼就能比完五个方法，不用在选项之间滚动。 */
function MethodList({
  name,
  options,
  value,
  onChange,
}: {
  name: string
  options: RagMethodOption[]
  value: string
  onChange: (id: string) => void
}) {
  return (
    <div className="rag-methods" role="radiogroup" aria-label={name}>
      {options.map((item) => (
        <button
          key={item.id}
          type="button"
          role="radio"
          aria-checked={value === item.id}
          className="rag-method"
          data-active={value === item.id}
          onClick={() => onChange(item.id)}
        >
          <span className="rag-method__label">{item.label}</span>
        </button>
      ))}
    </div>
  )
}

/** 选中项的详情：名称 + 官方文档链接 + 摘要 + 适用场景。 */
function MethodDetail({ option, note }: { option?: RagMethodOption; note?: string }) {
  if (!option) return null
  return (
    <div className="rag-method-detail">
      <div className="rag-method-detail__head">
        <h4 className="rag-method-detail__title">{option.label}</h4>
        {option.doc_url && (
          <a
            className="rag-method-detail__doc"
            href={option.doc_url}
            target="_blank"
            rel="noreferrer noopener"
          >
            {option.doc_label} ↗
          </a>
        )}
      </div>
      <p className="rag-method-detail__text">{option.summary}</p>
      {option.best_for && <p className="rag-bestfor">适合：{option.best_for}</p>}
      {note && <p className="rag-note">{note}</p>}
    </div>
  )
}

function ParamField({
  def,
  value,
  onChange,
}: {
  def: RagParamDef | undefined
  value: number | boolean | undefined
  onChange: (value: number | boolean) => void
}) {
  if (!def) return null

  if (def.type === 'bool') {
    return (
      <label className="rag-param rag-param--bool">
        <input
          type="checkbox"
          checked={Boolean(value)}
          onChange={(event) => onChange(event.target.checked)}
        />
        <span>{def.label}</span>
        {def.hint && <em className="rag-param__hint">{def.hint}</em>}
      </label>
    )
  }

  const numeric = typeof value === 'number' ? value : Number(def.default)
  const digits = def.type === 'float' ? 2 : 0
  return (
    <label className="rag-param">
      <span className="rag-param__row">
        <span>{def.label}</span>
        <b>{numeric.toFixed(digits)}</b>
      </span>
      <input
        type="range"
        min={def.min ?? 0}
        max={def.max ?? 100}
        step={def.step ?? 1}
        value={numeric}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      {def.hint && <em className="rag-param__hint">{def.hint}</em>}
    </label>
  )
}

function Figure({
  no,
  title,
  meta,
  doc,
  children,
}: {
  no: string
  title: string
  meta?: string
  doc?: RagMethodOption
  children: ReactNode
}) {
  return (
    <section className="rag-figure">
      <header className="rag-figure__head">
        <span className="rag-figure__no">{no}</span>
        <h3 className="rag-figure__title">{title}</h3>
        <span className="rag-figure__meta">{meta}</span>
        {doc && (
          <a className="rag-figure__doc" href={doc.doc_url} target="_blank" rel="noreferrer noopener">
            方法说明 ↗
          </a>
        )}
      </header>
      {children}
    </section>
  )
}

/* ------------------------------------------------------------------ 工具 */

function pickDefaultEmbedder(options: RagOptions): string | null {
  const preferred = options.embedders.find((item) => item.available && item.semantic)
  if (preferred) return preferred.id
  const fallback = options.embedders.find((item) => item.available)
  return fallback?.id ?? null
}

function readStored(): {
  chunking?: Partial<ChunkSettings>
  retrieval?: Partial<RetrievalSettings>
  embedderId?: string
} | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    return JSON.parse(raw) as {
      chunking?: Partial<ChunkSettings>
      retrieval?: Partial<RetrievalSettings>
      embedderId?: string
    }
  } catch {
    return null
  }
}

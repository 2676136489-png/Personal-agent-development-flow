import { useCallback, useEffect, useRef, useState } from 'react'
import {
  fetchDocumentChunks,
  fetchKnowledgeStatus,
  listDocuments,
  reindexDocument,
  reindexStaleDocuments,
  searchKnowledge,
  uploadDocument,
} from '../../api/knowledge'
import { ApiClientError } from '../../api/client'
import { StatusBadge } from '../../components/StatusBadge'
import { PageHeader } from '../../components/PageHeader'
import { EmptyState } from '../../components/EmptyState'
import { LoadingState } from '../../components/LoadingState'
import { ErrorState } from '../../components/ErrorState'
import type { Document, DocumentChunk, RetrievedChunk } from '../../types/knowledge'
import type { KnowledgeStatus } from '../../types/rag'

const DOC_STATUS: Record<string, { label: string; variant: 'ok' | 'info' | 'error' }> = {
  ready: { label: '就绪', variant: 'ok' },
  processing: { label: '处理中', variant: 'info' },
  failed: { label: '失败', variant: 'error' },
}

interface KnowledgeBaseProps {
  onNavigate?: (key: string) => void
}

export function KnowledgeBase({ onNavigate }: KnowledgeBaseProps) {
  const [documents, setDocuments] = useState<Document[]>([])
  const [status, setStatus] = useState<KnowledgeStatus | null>(null)
  const [uploading, setUploading] = useState(false)
  // 首屏即为 loading：修复「首屏无态 → 误显示『还没有文档』」的误导（P1）
  const [listLoading, setListLoading] = useState(true)
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)
  const [listError, setListError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)

  const refresh = useCallback(async () => {
    // [F3] 之前没有 catch：后端不可用时首屏加载直接抛未捕获 rejection，
    // 文档列表空空如也却毫无提示；同时缺 loading 态，首屏会误导为「没有文档」。
    setListLoading(true)
    try {
      const [docs, state] = await Promise.all([listDocuments(), fetchKnowledgeStatus()])
      setDocuments(docs)
      setStatus(state)
      setListError(null)
    } catch (err) {
      setListError(err instanceof ApiClientError ? err.message : '加载文档列表失败')
    } finally {
      setListLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  async function handleFile(file: File) {
    setUploading(true)
    setMessage(null)
    try {
      const doc = await uploadDocument(file)
      setMessage({ kind: 'ok', text: `已摄入：${doc.filename}（${doc.chunk_count} 个 chunk）` })
      await refresh()
    } catch (error) {
      const text =
        error instanceof ApiClientError ? error.message : '上传失败，请查看浏览器控制台'
      setMessage({ kind: 'error', text })
    } finally {
      setUploading(false)
      if (fileInput.current) fileInput.current.value = ''
    }
  }

  async function handleReindex(documentId: string) {
    setBusyId(documentId)
    setMessage(null)
    try {
      const updated = await reindexDocument(documentId)
      setMessage({
        kind: 'ok',
        text: `已用 ${updated.embedding_model} 重算：${updated.filename}（${updated.chunk_count} 块）`,
      })
      await refresh()
    } catch (error) {
      setMessage({
        kind: 'error',
        text: error instanceof ApiClientError ? error.message : '重建向量失败',
      })
    } finally {
      setBusyId(null)
    }
  }

  async function handleReindexAll() {
    setBusyId('__all__')
    setMessage(null)
    try {
      const result = await reindexStaleDocuments()
      setMessage({
        kind: 'ok',
        text: `向量对齐完成：模型 ${result.model}，重算 ${result.done}/${result.total} 篇${
          result.failed ? `，失败 ${result.failed} 篇` : ''
        }`,
      })
      await refresh()
    } catch (error) {
      setMessage({
        kind: 'error',
        text: error instanceof ApiClientError ? error.message : '批量重建失败',
      })
    } finally {
      setBusyId(null)
    }
  }

  return (
    <section className="panel">
      <PageHeader
        eyebrow="知识库"
        title="喂一份资料，它就能引用"
        lede="上传 PDF / Markdown / TXT，系统自动解析、切块、向量化，供研究检索时引用，让结论有据可依。"
        notes={[
          { term: '能做什么', desc: '把私有文档变成可被检索、可被引用、带页码出处的证据源。' },
          { term: '怎么用', desc: '上传文件 → 等解析完成 → 展开「片段」能看到它被切成了什么。' },
          { term: '检索原理', desc: '向量模型决定能不能「换个说法也找到」，哈希兜底只有字面匹配。' },
        ]}
        actions={
          <button className="button" onClick={() => void refresh()} disabled={listLoading}>
            {listLoading ? '刷新中…' : '刷新列表'}
          </button>
        }
      />

      {status && <EmbeddingBanner status={status} onReindexAll={handleReindexAll} busy={busyId === '__all__'} />}

      <div className="panel__notes">
        <div>
          <b>适用场景</b>
          <span>研究需要引用你的私有 / 内部资料，而非仅依赖公开网络内容。</span>
        </div>
        <div>
          <b>看切片</b>
          <span>每份文档都能展开看真实切块，切法不同会直接改变检索效果。</span>
        </div>
      </div>

      <div className="upload">
        {/* 原生 file 控件样式化：藏进可聚焦的 label，键盘仍可 Tab 到并回车触发 */}
        <label className="file-field" data-busy={uploading ? 'true' : 'false'}>
          <span>{uploading ? '处理中（解析 / 切块 / 向量化）…' : '选择文件上传'}</span>
          <input
            ref={fileInput}
            className="file-field__input"
            type="file"
            accept=".pdf,.md,.markdown,.txt"
            disabled={uploading}
            onChange={(event) => {
              const file = event.target.files?.[0]
              if (file) void handleFile(file)
            }}
          />
        </label>
        <span className="hint">支持 .pdf .md .txt，单文件 ≤ 10MB</span>
      </div>

      {message && (
        <div className={`alert ${message.kind === 'error' ? 'alert--error' : 'alert--ok'}`}>
          {message.text}
        </div>
      )}

      <h3 className="plan__heading">文档列表（{documents.length}）</h3>

      {listLoading && documents.length === 0 && (
        <LoadingState variant="list" rows={3} label="正在加载文档…" />
      )}

      {listError && <ErrorState message={listError} onRetry={() => void refresh()} />}

      {!listLoading && !listError && documents.length === 0 && (
        <EmptyState
          title="还没有文档"
          description="上传一份 Markdown / PDF / TXT，系统会自动解析、切块、向量化，供研究检索时引用。"
        />
      )}

      {documents.length > 0 && (
        <ul className="doc-list">
          {documents.map((doc) => (
            <DocumentRow
              key={doc.id}
              doc={doc}
              activeModel={status?.active_model ?? null}
              busy={busyId === doc.id}
              onReindex={() => void handleReindex(doc.id)}
            />
          ))}
        </ul>
      )}

      {onNavigate && (
        <p className="hint kb-crosslink">
          想看清楚「切块 / 向量 / 检索」每一步到底发生了什么？
          <button type="button" className="rag-linkbtn" onClick={() => onNavigate('rag')}>
            打开 RAG 流程页
          </button>
        </p>
      )}

      <SearchBox />
    </section>
  )
}

/* ------------------------------------------------------------- 向量状态 */

function EmbeddingBanner({
  status,
  onReindexAll,
  busy,
}: {
  status: KnowledgeStatus
  onReindexAll: () => void
  busy: boolean
}) {
  const active = status.active
  return (
    <div className={`kb-status ${status.semantic ? '' : 'kb-status--warn'}`}>
      <div className="kb-status__main">
        <span className="kb-status__dot" data-ok={status.semantic ? 'true' : 'false'} />
        <div>
          <p className="kb-status__title">
            {status.semantic ? '语义向量已启用' : '当前只有字面匹配'}
            <span className="kb-status__model">
              {active.label}
              {active.dims ? ` · ${active.dims} 维` : ''}
            </span>
          </p>
          <p className="kb-status__desc">
            {status.semantic
              ? `「换个说法也能找到」依赖这个模型。共 ${status.documents} 篇文档、${status.chunks} 个片段；切块方式 ${status.chunk_strategy}（${status.chunk_size} 字 / 重叠 ${status.chunk_overlap}）。`
              : (status.degraded_reason ??
                '没有可用的向量模型，检索退化成关键词重合度匹配。')}
          </p>
        </div>
      </div>
      {status.stale_documents > 0 && (
        <button
          type="button"
          className="button button--primary kb-status__action"
          disabled={busy}
          onClick={onReindexAll}
        >
          {busy ? '重建中…' : `重建 ${status.stale_documents} 篇文档的向量`}
        </button>
      )}
    </div>
  )
}

/* ------------------------------------------------------------- 文档行 */

function DocumentRow({
  doc,
  activeModel,
  busy,
  onReindex,
}: {
  doc: Document
  activeModel: string | null
  busy: boolean
  onReindex: () => void
}) {
  const [open, setOpen] = useState(false)
  const [chunks, setChunks] = useState<DocumentChunk[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const stale = activeModel !== null && doc.embedding_model !== activeModel

  async function toggle() {
    const next = !open
    setOpen(next)
    if (!next || chunks !== null) return
    try {
      setChunks(await fetchDocumentChunks(doc.id))
      setError(null)
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : '读取片段失败')
    }
  }

  return (
    <li className="doc doc--stack">
      <div className="doc__row">
        <div className="doc__main">
          <span className="doc__name">{doc.filename}</span>
          <span className="hint">
            {doc.mime_type} · {doc.chunk_count} 个片段
            {doc.page_count ? ` · ${doc.page_count} 页` : ''} · {doc.embedding_model ?? '未向量化'}
            {stale ? ' · 模型已变更' : ''}
          </span>
        </div>
        <div className="doc__actions">
          <button type="button" className="button" onClick={() => void toggle()}>
            {open ? '收起片段' : '查看片段'}
          </button>
          <button type="button" className="button" disabled={busy} onClick={onReindex}>
            {busy ? '重算中…' : '重建向量'}
          </button>
          <StatusBadge variant={DOC_STATUS[doc.status]?.variant ?? 'neutral'}>
            {DOC_STATUS[doc.status]?.label ?? doc.status}
          </StatusBadge>
        </div>
      </div>

      {doc.error && <div className="alert alert--error doc__error">{doc.error}</div>}

      {open && (
        <div className="doc__chunks">
          {error && <ErrorState message={error} onRetry={() => void toggle()} />}
          {!error && chunks === null && <LoadingState variant="list" rows={3} label="正在读取片段…" />}
          {!error && chunks !== null && chunks.length === 0 && (
            <p className="hint">这份文档没有可展示的片段。</p>
          )}
          {!error &&
            chunks?.map((chunk) => (
              <article className="kb-chunk" key={chunk.id}>
                <header className="kb-chunk__head">
                  <span className="kb-chunk__no">#{chunk.chunk_index}</span>
                  <span className="kb-chunk__meta">
                    {chunk.content.length} 字 · {chunk.token_estimate} tk
                    {chunk.char_start !== null ? ` · ${chunk.char_start}–${chunk.char_end}` : ''}
                    {chunk.page ? ` · 第 ${chunk.page} 页` : ''}
                  </span>
                </header>
                <p className="kb-chunk__text">{chunk.content}</p>
              </article>
            ))}
        </div>
      )}
    </li>
  )
}

/* ------------------------------------------------------------- 检索测试 */

function SearchBox() {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<RetrievedChunk[] | null>(null)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSearch() {
    setRunning(true)
    setError(null)
    // [F3] 补 catch：检索失败（后端 500 / 断网）此前会被静默吞掉
    try {
      setResults(await searchKnowledge(query, 5))
    } catch (err) {
      setResults(null)
      setError(err instanceof ApiClientError ? err.message : '检索失败')
    } finally {
      setRunning(false)
    }
  }

  return (
    <>
      <h3 className="plan__heading">检索测试</h3>
      <div className="field">
        <input
          className="input"
          value={query}
          placeholder="例如：向量数据库如何选型"
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>
      <button
        className="button button--primary"
        disabled={query.trim().length < 2 || running}
        onClick={() => void handleSearch()}
      >
        {running ? '检索中…' : '检索知识库'}
      </button>

      {error && (
        <div className="stack-gap-sm">
          <ErrorState message={error} onRetry={() => void handleSearch()} />
        </div>
      )}

      {results && results.length === 0 && (
        <div className="stack-gap-sm">
          <EmptyState
            title="没有命中任何片段"
            description="换个更贴近文档内容的关键词，或确认目标文档已处于「就绪」状态。"
          />
        </div>
      )}

      {results && results.length > 0 && (
        <div className="data-list data-list--gap stack-gap-sm">
          {results.map((hit) => (
            <div key={hit.chunk_id} className="citation">
              <div className="citation__head">
                <span className="citation__file">
                  {hit.filename}
                  {hit.page ? ` · 第 ${hit.page} 页` : ''}
                </span>
                <span className="citation__meta">相关度 {hit.score.toFixed(3)} · 片段 #{hit.chunk_index}</span>
              </div>
              <p className="citation__quote">{hit.content}</p>
            </div>
          ))}
        </div>
      )}
    </>
  )
}

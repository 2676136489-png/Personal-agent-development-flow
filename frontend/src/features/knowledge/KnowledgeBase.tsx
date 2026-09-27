import { useCallback, useEffect, useRef, useState } from 'react'
import { listDocuments, searchKnowledge, uploadDocument } from '../../api/knowledge'
import { ApiClientError } from '../../api/client'
import { StatusBadge } from '../../components/StatusBadge'
import { PageHeader } from '../../components/PageHeader'
import { EmptyState } from '../../components/EmptyState'
import { LoadingState } from '../../components/LoadingState'
import { ErrorState } from '../../components/ErrorState'
import type { Document, RetrievedChunk } from '../../types/knowledge'

const DOC_STATUS: Record<string, { label: string; variant: 'ok' | 'info' | 'error' }> = {
  ready: { label: '就绪', variant: 'ok' },
  processing: { label: '处理中', variant: 'info' },
  failed: { label: '失败', variant: 'error' },
}

export function KnowledgeBase() {
  const [documents, setDocuments] = useState<Document[]>([])
  const [uploading, setUploading] = useState(false)
  // 首屏即为 loading：修复「首屏无态 → 误显示『还没有文档』」的误导（P1）
  const [listLoading, setListLoading] = useState(true)
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)
  const [listError, setListError] = useState<string | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)

  const refresh = useCallback(async () => {
    // [F3] 之前没有 catch：后端不可用时首屏加载直接抛未捕获 rejection，
    // 文档列表空空如也却毫无提示；同时缺 loading 态，首屏会误导为「没有文档」。
    setListLoading(true)
    try {
      setDocuments(await listDocuments())
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

  return (
    <section className="panel">
      <PageHeader
        eyebrow="知识库"
        title="喂一份资料，它就能引用"
        lede="上传 PDF / Markdown / TXT，系统自动解析、切块、向量化，供研究智能体在检索时引用，让结论有据可依。"
        notes={[
          { term: '能做什么', desc: '把私有文档变成可被检索、可被引用、带页码出处的证据源。' },
          { term: '怎么用', desc: '上传文件 → 等解析完成 → 研究时它会自动参与检索并在报告里标注出处。' },
          { term: '注意', desc: '单文件上限 10MB；解析期间该文件不会立刻可被检索。' },
        ]}
        actions={
          <button className="button" onClick={() => void refresh()} disabled={listLoading}>
            {listLoading ? '刷新中…' : '刷新列表'}
          </button>
        }
      />

      <div className="panel__notes">
        <div>
          <b>适用场景</b>
          <span>研究需要引用你的私有 / 内部资料，而非仅依赖公开网络内容。</span>
        </div>
        <div>
          <b>怎么用</b>
          <span>上传文档 → 等待「就绪」→ 用「检索测试」输入问题，验证可被命中引用。</span>
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
            <li key={doc.id} className="doc">
              <div className="doc__main">
                <span className="doc__name">{doc.filename}</span>
                <span className="hint">
                  {doc.mime_type} · {doc.chunk_count} 个片段
                  {doc.page_count ? ` · ${doc.page_count} 页` : ''} · {doc.embedding_model}
                </span>
              </div>
              <StatusBadge variant={DOC_STATUS[doc.status]?.variant ?? 'neutral'}>
                {DOC_STATUS[doc.status]?.label ?? doc.status}
              </StatusBadge>
            </li>
          ))}
        </ul>
      )}

      <SearchBox />
    </section>
  )
}

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
                <span className="citation__meta">相关度 {hit.score.toFixed(3)} · 片段 {hit.chunk_id}</span>
              </div>
              <p className="citation__quote">{hit.content}</p>
            </div>
          ))}
        </div>
      )}
    </>
  )
}

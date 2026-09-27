import { useCallback, useEffect, useState } from 'react'
import { formatRelativeTime } from '../../lib/time'
import { clearRuns, deleteRun, listRuns } from '../../api/graph'
import { ApiClientError } from '../../api/client'
import { StatusBadge } from '../../components/StatusBadge'
import { EmptyState } from '../../components/EmptyState'
import { LoadingState } from '../../components/LoadingState'
import { ErrorState } from '../../components/ErrorState'
import { notify } from '../../components/Toast'
import type { ResearchRunSummary } from '../../types/graph'

export interface RunHistoryProps {
  onSelect?: (threadId: string) => void
  limit?: number
  status?: ResearchRunSummary['status']
}

const STATUS_LABEL: Record<string, string> = {
  completed: '已完成',
  awaiting_approval: '待确认',
  running: '运行中',
  failed: '失败',
  cancelled: '已取消',
}

const STATUS_VARIANT: Record<string, 'ok' | 'warn' | 'error' | 'info' | 'running'> = {
  completed: 'ok',
  awaiting_approval: 'warn',
  running: 'running',
  failed: 'error',
  cancelled: 'warn',
}

function truncate(text: string, max = 80): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

export function RunHistory({ onSelect, limit = 10, status }: RunHistoryProps) {
  const [runs, setRuns] = useState<ResearchRunSummary[]>([])
  // 首屏即为 loading：避免数据到达前误显示「还没有运行记录」的空态闪烁
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  // 清空需要二次确认：误点一次就全删太狠了
  const [confirmingClear, setConfirmingClear] = useState(false)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    // [F3] 之前只有 try/finally 没有 catch：请求失败被静默吞掉，
    // 界面显示"还没有运行记录"，用户会以为真的没有数据。
    try {
      setRuns(await listRuns(status))
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : '加载历史运行失败')
    } finally {
      setLoading(false)
    }
  }, [status])

  useEffect(() => {
    void refresh()
  }, [refresh])

  async function handleDelete(threadId: string) {
    try {
      await deleteRun(threadId)
      setRuns((prev) => prev.filter((run) => run.thread_id !== threadId))
      notify({ tone: 'ok', title: '已删除这条记录' })
    } catch (err) {
      notify({
        tone: 'error',
        title: '删除失败',
        desc: err instanceof ApiClientError ? err.message : '请稍后重试',
      })
    }
  }

  async function handleClear() {
    if (!confirmingClear) {
      setConfirmingClear(true)
      return
    }
    setConfirmingClear(false)
    try {
      const result = await clearRuns()
      setRuns([])
      notify({ tone: 'ok', title: '历史已清空', desc: `删除了 ${result.runs_deleted} 条运行记录` })
    } catch (err) {
      notify({
        tone: 'error',
        title: '清空失败',
        desc: err instanceof ApiClientError ? err.message : '请稍后重试',
      })
    }
  }

  return (
    <section className="activity">
      <div className="activity__head">
        <h3 className="plan__heading text-flush">历史运行</h3>
        <button className="link-button" onClick={() => void refresh()} disabled={loading}>
          {loading ? '刷新中…' : '刷新'}
        </button>
        {runs.length > 0 && (
          <button
            className={`link-button ${confirmingClear ? 'link-button--danger' : ''}`.trim()}
            onClick={() => void handleClear()}
            onBlur={() => setConfirmingClear(false)}
          >
            {confirmingClear ? '再点一次确认清空' : '清空历史'}
          </button>
        )}
      </div>

      {loading && runs.length === 0 && <LoadingState variant="list" rows={3} />}

      {error && <ErrorState message={error} onRetry={() => void refresh()} />}

      {!loading && !error && runs.length === 0 && (
        <EmptyState title="还没有运行记录" description="启动一次研究后，这里会列出历史运行，可点击加载。" />
      )}

      {runs.length > 0 && (
        <ul className="run-list">
          {runs.slice(0, limit).map((run) => (
            <li key={run.thread_id} className="run-list__item">
              <button
                className="run-list__btn"
                onClick={() => onSelect?.(run.thread_id)}
                disabled={!onSelect}
                title={onSelect ? '点击加载这次运行' : run.question}
              >
                <StatusBadge variant={STATUS_VARIANT[run.status] ?? 'info'}>{STATUS_LABEL[run.status] ?? run.status}</StatusBadge>
                <span className="run-list__q">{truncate(run.question)}</span>
                <span className="hint">{formatRelativeTime(run.updated_at)}</span>
              </button>
              <button
                className="run-list__delete"
                aria-label="删除这条记录"
                title="删除这条记录"
                onClick={() => void handleDelete(run.thread_id)}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

import { useCallback, useEffect, useMemo, useState } from 'react'
import { listRuns } from '../../api/graph'
import { ApiClientError } from '../../api/client'
import { StatusBadge } from '../../components/StatusBadge'
import { PageHeader } from '../../components/PageHeader'
import { EmptyState } from '../../components/EmptyState'
import { LoadingState } from '../../components/LoadingState'
import { ErrorState } from '../../components/ErrorState'
import type { NavigateFn } from '../../App'
import type { ResearchRunSummary } from '../../types/graph'

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

/**
 * [F11] 一条运行记录该跳到哪去。
 *
 * 已完成的去看「研究报告」（点开即展开全文与依据来源）；
 * 其余（待确认 / 运行中 / 失败 / 取消）去「深度研究」，那里能继续批准、
 * 看到中断点或失败原因 —— 在评估页只能看到一个状态词，什么也做不了。
 */
function targetPageOf(status: string): string {
  return status === 'completed' ? 'reports' : 'workflow'
}

function formatTime(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleString()
}

export interface EvaluationProps {
  /** 点击最近运行后跳到对应页面并打开该次运行 */
  onNavigate?: NavigateFn
}

export function Evaluation({ onNavigate }: EvaluationProps) {
  const [runs, setRuns] = useState<ResearchRunSummary[]>([])
  // 首屏即为 loading：避免数据到达前误显示「暂无运行记录」的空态闪烁
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      // [F6] 显式要一个足够大的 limit，否则统计只覆盖默认条数
      setRuns(await listRuns(undefined, 500))
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : '加载失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const stats = useMemo(() => {
    const total = runs.length
    const completed = runs.filter((r) => r.status === 'completed').length
    const failed = runs.filter((r) => r.status === 'failed').length
    const cancelled = runs.filter((r) => r.status === 'cancelled').length
    const awaiting = runs.filter((r) => r.status === 'awaiting_approval').length
    return { total, completed, failed, cancelled, awaiting }
  }, [runs])

  return (
    <section className="panel">
      <PageHeader
        eyebrow="效果评估"
        title="运行效果一览"
        lede="统计深度研究的运行情况与分布：成功率、耗时、token 消耗与失败原因，用来判断整体可用性与瓶颈。"
        notes={[
          { term: '能做什么', desc: '把「跑了多少次、成了多少、慢在哪、花在哪」量化出来。' },
          { term: '怎么用', desc: '先看成功率与耗时分布，再看失败原因归类，定位要优化的节点。' },
          { term: '面向谁', desc: '偏开发者视角；只关心结论的话看「研究报告」即可。' },
        ]}
      />

      {error && <ErrorState message={error} onRetry={() => void load()} />}

      {loading && runs.length === 0 && <LoadingState variant="table" rows={5} />}

      {!loading && (
        <>
          <div className="stat-grid">
            <div className="card card--stat">
              <span className="stat-card__value">{stats.total}</span>
              <span className="stat-card__label">总运行次数</span>
            </div>
            <div className="card card--stat">
              <span className="stat-card__value stat-card__value--ok">{stats.completed}</span>
              <span className="stat-card__label">已完成</span>
            </div>
            <div className="card card--stat">
              <span className="stat-card__value stat-card__value--warn">{stats.awaiting}</span>
              <span className="stat-card__label">待确认</span>
            </div>
            <div className="card card--stat">
              <span className="stat-card__value stat-card__value--error">{stats.failed + stats.cancelled}</span>
              <span className="stat-card__label">失败 / 取消</span>
            </div>
          </div>

          <section className="activity">
            <div className="activity__head">
              <h3 className="plan__heading text-flush">最近运行</h3>
              <button className="link-button" onClick={() => void load()} disabled={loading}>
                {loading ? '刷新中…' : '刷新'}
              </button>
            </div>
            {runs.length === 0 ? (
              <EmptyState title="暂无运行记录" description="启动一次研究后，这里会出现统计数据与最近运行。" />
            ) : (
              <ul className="run-list">
                {runs.slice(0, 15).map((run) => (
                  <li key={run.thread_id} className="run-list__item">
                    {/* [F11] 可点：跳到「研究报告」或「深度研究」并直接打开这一次运行。
                        用 .run-list__btn（不是 __row）——交互态与 cursor 只挂在它上面 */}
                    <button
                      className="run-list__btn"
                      onClick={() => onNavigate?.(targetPageOf(run.status), run.thread_id)}
                      title={`打开这一次运行：${run.question}`}
                    >
                      <StatusBadge variant={STATUS_VARIANT[run.status] ?? 'info'}>
                        {STATUS_LABEL[run.status] ?? run.status}
                      </StatusBadge>
                      <span className="run-list__q">{run.question}</span>
                      <span className="hint">{formatTime(run.updated_at)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </section>
  )
}

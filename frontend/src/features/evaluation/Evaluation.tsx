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
  interrupted: '已中断',
}

const STATUS_VARIANT: Record<string, 'ok' | 'warn' | 'error' | 'info' | 'running'> = {
  completed: 'ok',
  awaiting_approval: 'warn',
  running: 'running',
  failed: 'error',
  cancelled: 'warn',
  interrupted: 'error',
}

/**
 * 一条运行记录该跳到哪去。
 *
 * 已完成的去看「研究报告」（点开即展开全文与依据来源）；
 * 其余（待确认 / 运行中 / 失败 / 已中断）去「深度研究」，那里能继续批准、
 * 看到中断点或失败原因 —— 在评估页只能看到一个状态词，什么也做不了。
 */
function targetPageOf(status: string): string {
  return status === 'completed' ? 'reports' : 'workflow'
}

function formatTime(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString()
}

function formatDuration(ms: number): string {
  if (!ms) return '—'
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds} 秒`
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  return rest ? `${minutes} 分 ${rest} 秒` : `${minutes} 分钟`
}

function formatTokens(tokens: number): string {
  if (!tokens) return '—'
  return tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens)
}

function average(values: number[]): number {
  if (values.length === 0) return 0
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length)
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
      // 显式要一个足够大的 limit，否则统计只覆盖默认条数
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
    const completed = runs.filter((run) => run.status === 'completed').length
    const failed = runs.filter((run) => run.status === 'failed').length
    const cancelled = runs.filter((run) => run.status === 'cancelled').length
    const awaiting = runs.filter((run) => run.status === 'awaiting_approval').length
    const interrupted = runs.filter((run) => run.status === 'interrupted').length
    const running = runs.filter((run) => run.status === 'running').length
    // interrupted 也算异常终态：把它排除在分母外会虚高成功率
    const terminal = completed + failed + cancelled + interrupted
    const successRate = terminal > 0 ? Math.round((completed / terminal) * 100) : null

    const completedRuns = runs.filter((run) => run.status === 'completed')
    const avgDuration = average(completedRuns.map((run) => run.duration_ms).filter(Boolean))
    const avgTokens = average(completedRuns.map((run) => run.usage_total_tokens).filter(Boolean))

    const reasonCounts = new Map<string, number>()
    for (const run of runs) {
      if (run.status !== 'failed' && run.status !== 'interrupted') continue
      const reason = (run.error || run.finished_reason || '未记录原因').trim().slice(0, 160)
      reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + 1)
    }
    const failureReasons = [...reasonCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)

    return {
      total,
      completed,
      failed,
      cancelled,
      awaiting,
      interrupted,
      running,
      successRate,
      avgDuration,
      avgTokens,
      failureReasons,
    }
  }, [runs])

  return (
    <section className="panel">
      <PageHeader
        eyebrow="效果评估"
        title="运行效果一览"
        lede="用真实运行记录统计成功率、耗时、token 消耗与失败原因，判断这套流程稳不稳、慢在哪、花在哪。"
        notes={[
          { term: '能做什么', desc: '把「跑了多少次、成了多少、慢在哪、花在哪」量化出来。' },
          { term: '怎么用', desc: '先看成功率与平均耗时，再看失败原因，定位要优化的节点。' },
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
              <span className="stat-card__value stat-card__value--ok">
                {stats.successRate === null ? '—' : `${stats.successRate}%`}
              </span>
              <span className="stat-card__label">成功率（已完成 {stats.completed} 次）</span>
            </div>
            <div className="card card--stat">
              <span className="stat-card__value">{formatDuration(stats.avgDuration)}</span>
              <span className="stat-card__label">平均耗时（已完成运行）</span>
            </div>
            <div className="card card--stat">
              <span className="stat-card__value">{formatTokens(stats.avgTokens)}</span>
              <span className="stat-card__label">平均 token（已完成运行）</span>
            </div>
          </div>

          <section className="activity">
            <div className="activity__head">
              <h3 className="plan__heading text-flush">状态分布</h3>
            </div>
            <div className="settings-table">
              <div className="settings-row">
                <span className="settings-row__label">已完成</span>
                <span className="settings-row__value">{stats.completed}</span>
              </div>
              <div className="settings-row">
                <span className="settings-row__label">运行中</span>
                <span className="settings-row__value">{stats.running}</span>
              </div>
              <div className="settings-row">
                <span className="settings-row__label">待确认</span>
                <span className="settings-row__value">{stats.awaiting}</span>
              </div>
              <div className="settings-row">
                <span className="settings-row__label">已中断</span>
                <span className="settings-row__value">{stats.interrupted}</span>
              </div>
              <div className="settings-row">
                <span className="settings-row__label">失败 / 取消</span>
                <span className="settings-row__value">{stats.failed + stats.cancelled}</span>
              </div>
            </div>
          </section>

          {stats.failureReasons.length > 0 && (
            <section className="activity">
              <div className="activity__head">
                <h3 className="plan__heading text-flush">失败原因</h3>
              </div>
              <div className="settings-table">
                {stats.failureReasons.map(([reason, count]) => (
                  <div className="settings-row" key={reason}>
                    <span className="settings-row__label">{count} 次</span>
                    <span className="settings-row__value">{reason}</span>
                  </div>
                ))}
              </div>
            </section>
          )}

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

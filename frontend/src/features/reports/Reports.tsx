import { useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { formatRelativeTime } from '../../lib/time'
import { getResearch, listRuns } from '../../api/graph'
import { ApiClientError } from '../../api/client'
import { CloseIcon } from '../../components/icons'
import { DownloadReportButton } from '../../components/DownloadReportButton'
import { Markdown } from '../../components/Markdown'
import { StatusBadge } from '../../components/StatusBadge'
import { PageHeader } from '../../components/PageHeader'
import { EvidencePanel, collectSources } from '../../components/EvidencePanel'
import { EmptyState } from '../../components/EmptyState'
import { LoadingState } from '../../components/LoadingState'
import { ErrorState } from '../../components/ErrorState'
import type { ResearchRun, ResearchRunSummary } from '../../types/graph'

const STATUS_LABEL: Record<string, string> = {
  completed: '已完成',
  awaiting_approval: '待确认',
  running: '运行中',
  failed: '失败',
  cancelled: '已取消',
}

function ReportView({ run }: { run: ResearchRun }) {
  const report = run.report
  if (!report) return <p className="hint">本次运行没有生成报告。</p>
  return (
    <article className="report-panel">
      <div className="report-panel__head">
        <h3 className="report-panel__title">{report.title || run.question}</h3>
        {/* [B28] 报告可带走：PDF / Word / Markdown 三种格式 */}
        <DownloadReportButton
          report={report}
          meta={{ question: run.question, sources: collectSources(run) }}
        />
      </div>
      <div className="report-panel__summary">
        <Markdown>{report.summary}</Markdown>
      </div>
      {report.sections.map((section) => (
        <section key={section.heading} className="report-panel__section">
          <h4>{section.heading}</h4>
          <Markdown>{section.content}</Markdown>
        </section>
      ))}
      {report.limitations.length > 0 && (
        <div className="report-panel__limitations">
          <strong>局限</strong>
          <Markdown>{report.limitations.map((item, i) => `${i + 1}. ${item}`).join('\n')}</Markdown>
        </div>
      )}

      {/* 依据来源区：复用深度研究页的 EvidencePanel，让结论可溯源。
          报告详情里正文很长，把"结论 + 证据缺口 + 来源"集中到末段，便于核对。 */}
      <EvidencePanel
        findings={run.analysis?.findings ?? []}
        gaps={run.analysis?.gaps ?? []}
        sources={collectSources(run)}
      />
    </article>
  )
}

export interface ReportsProps {
  /**
   * [F11] 深链目标：`#/reports?thread=xxx`。
   * 有值时自动打开这一份报告 —— 效果评估页点「最近运行」就是靠它跳过来的。
   */
  focusThread?: string | null
  /** 目标已处理完毕的通知（用于清掉 URL 里的 thread 参数） */
  onFocusConsumed?: () => void
  /** 打开某一份报告：外层据此把 URL 同步成 `#/reports?thread=xxx` */
  onOpenReport?: (threadId: string) => void
}

export function Reports({ focusThread, onFocusConsumed, onOpenReport }: ReportsProps) {
  const [runs, setRuns] = useState<ResearchRunSummary[]>([])
  // 首屏即为 loading：避免数据到达前误显示「还没有报告」的空态闪烁
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState<ResearchRun | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setRuns(await listRuns('completed'))
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : '加载失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  /**
   * [F11] 深链：直接按 thread_id 打开报告。
   *
   * 不复用列表数据来查找 —— 目标可能不在当前列表页里（例如它刚生成、
   * 或列表还没加载完），直接按 id 取才可靠。
   */
  useEffect(() => {
    if (!focusThread) return
    // 已经打开的就是目标（例如刚点了列表里的卡片，只是同步 URL）→ 不再重复请求
    if (selected?.thread_id === focusThread) return
    let cancelled = false
    void (async () => {
      try {
        const run = await getResearch(focusThread)
        if (!cancelled && run) setSelected(run)
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof ApiClientError ? err.message : '加载报告失败')
          // 取不到就立刻清掉 URL 参数，别留一个点不开的死链
          onFocusConsumed?.()
        }
      }
    })()
    return () => {
      cancelled = true
    }
    // selected.thread_id 只用于「是否已打开」的判定；关闭时 focusThread 也一并被清，
    // 因此不会出现「关掉又被这个依赖重新弹开」的回环。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusThread, onFocusConsumed, selected?.thread_id])

  /**
   * 关闭弹窗：**同时清掉 URL 里的 thread 参数**。
   *
   * 为什么不在「打开成功」时就清：那样 URL 会退化成 `#/reports`，
   * 刷新或把链接发给别人就丢掉了「在看哪一份报告」这个状态。
   * 也不该一直留着：关掉弹窗后参数还挂着，用户再点别的报告时 URL 会指向旧的，
   * 刷新又弹回上一份。所以精确地在「关闭」这一刻清。
   */
  const closeModal = useCallback(() => {
    setSelected(null)
    onFocusConsumed?.()
  }, [onFocusConsumed])

  async function openRun(threadId: string) {
    setError(null)
    try {
      const run = await getResearch(threadId)
      if (run) {
        setSelected(run)
        // [F11] 让 URL 也指向这一份：刷新/分享都能回到同一报告
        onOpenReport?.(threadId)
      }
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : '加载详情失败')
    }
  }

  return (
    <section className="panel">
      <PageHeader
        eyebrow="研究报告"
        title="已生成的研究报告"
        lede="在这里查看所有已完成的研究报告，点击条目可阅读全文、结论与依据来源。"
        notes={[
          { term: '能做什么', desc: '集中阅读历史报告，含摘要、分节正文、局限说明与引用来源。' },
          { term: '怎么用', desc: '点左侧条目 → 右侧展开全文 → 依据来源可点开原始链接核对。' },
          { term: '注意', desc: '报告中的"局限"一栏会写明本次研究的证据缺口，请一并阅读。' },
        ]}
      />

      {error && <ErrorState message={error} onRetry={() => void load()} />}

      {loading && runs.length === 0 && <LoadingState variant="list" rows={4} label="正在加载报告列表…" />}

      {!loading && !error && runs.length === 0 && (
        <EmptyState
          title="还没有已完成的研究报告"
          description="到「深度研究」启动一次研究并批准生成报告后，这里会自动出现。"
        />
      )}

      {!loading && runs.length > 0 && (
        <div className="report-list">
          {runs.map((run) => (
            <button
              key={run.thread_id}
              className="card card--interactive report-card"
              onClick={() => void openRun(run.thread_id)}
            >
              <div className="report-card__head">
                <StatusBadge variant="ok">{STATUS_LABEL[run.status] ?? run.status}</StatusBadge>
                <span className="hint">{formatRelativeTime(run.updated_at)}</span>
              </div>
              <p className="report-card__title">{run.question}</p>
            </button>
          ))}
        </div>
      )}

      {/*
        [F10] 弹窗走 portal 挂到 body 上，而不是留在页面容器里。
        原因：任何祖先元素只要有 transform（哪怕值等于 none 的恒等矩阵）/
        filter / backdrop-filter / will-change，都会成为 position: fixed 的
        包含块，弹窗就不再相对视口居中 —— 报告弹窗此前正是被 <main> 的页面
        转场动画（fill-mode: both）钉在导航栏下方。挂在 body 上从结构上免疫。
      */}
      {selected &&
        createPortal(
          <div className="modal-backdrop" onClick={closeModal}>
            <div className="modal" onClick={(e) => e.stopPropagation()}>
              <div className="modal__head">
                <h3 className="panel__title text-flush">报告详情</h3>
                <button className="nav-icon" aria-label="关闭" onClick={closeModal}>
                  <CloseIcon size={18} />
                </button>
              </div>
              <ReportView run={selected} />
            </div>
          </div>,
          document.body,
        )}
    </section>
  )
}

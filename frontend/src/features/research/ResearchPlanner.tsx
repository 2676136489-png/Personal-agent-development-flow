import { useCallback, useEffect, useState } from 'react'
import { formatRelativeTime } from '../../lib/time'
import { createResearchPlan, deletePlan, listPlans } from '../../api/research'
import { ApiClientError } from '../../api/client'
import type { PlanRecord, PlanResponse, ResearchPlan } from '../../types/research'
import { ChevronRightIcon } from '../../components/icons'
import { StatusBadge } from '../../components/StatusBadge'
import { PageHeader } from '../../components/PageHeader'
import { CollapsibleCard } from '../../components/CollapsibleCard'
import { EmptyState } from '../../components/EmptyState'
import { LoadingState } from '../../components/LoadingState'
import { ErrorState } from '../../components/ErrorState'
import { notify } from '../../components/Toast'
import { writePrefillQuestion } from '../workflow/prefill'

const EXAMPLE_QUESTION =
  '研究 2026 年 AI Agent 开发岗位的核心技术要求，并分析不同公司的岗位要求有什么共同点。'

type PlanState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ok'; data: PlanResponse }
  | { status: 'error'; message: string; code: string }

/**
 * 把研究计划组装成一段可以直接拿去跑「深度研究」的任务描述。
 * 目标 + 关键子问题 + 执行步骤 —— 比只带 goal 更能保住计划的原意。
 */
function planToResearchTask(plan: ResearchPlan): string {
  const lines: string[] = [`研究目标：${plan.goal}`]
  if (plan.questions.length > 0) {
    lines.push('', '需要回答的关键问题：')
    plan.questions.forEach((q, i) => lines.push(`${i + 1}. ${q}`))
  }
  if (plan.steps.length > 0) {
    lines.push('', '建议的研究步骤：')
    plan.steps.forEach((s) => lines.push(`${s.index}. ${s.title}：${s.instruction}`))
  }
  return lines.join('\n')
}

export function ResearchPlanner({ onNavigate }: { onNavigate?: (key: string) => void }) {
  const [question, setQuestion] = useState('')
  const [maxSteps, setMaxSteps] = useState(6)
  const [state, setState] = useState<PlanState>({ status: 'idle' })

  // [B27] 历史规划：与深度研究的 RunHistory 对齐，生成成功的计划都能回看
  const [history, setHistory] = useState<PlanRecord[]>([])
  const [historyLoading, setHistoryLoading] = useState(true)

  const refreshHistory = useCallback(async () => {
    setHistoryLoading(true)
    try {
      setHistory(await listPlans())
    } catch {
      // 历史列表加载失败不阻塞主流程，静默降级为空列表
    } finally {
      setHistoryLoading(false)
    }
  }, [])

  useEffect(() => {
    void refreshHistory()
  }, [refreshHistory])

  async function handleSubmit() {
    setState({ status: 'loading' })
    try {
      const data = await createResearchPlan({ question, maxSteps })
      setState({ status: 'ok', data })
      void refreshHistory()
    } catch (error) {
      if (error instanceof ApiClientError) {
        setState({ status: 'error', message: error.message, code: error.code })
      } else {
        setState({
          status: 'error',
          message: '未知错误，请查看浏览器控制台',
          code: 'unknown',
        })
      }
    }
  }

  /** 从历史记录回看一份计划：组装成与新生成一致的 PlanResponse 结构 */
  function handleLoadHistory(record: PlanRecord) {
    setQuestion(record.question)
    setState({
      status: 'ok',
      data: {
        plan: record.plan,
        model: record.model,
        provider: record.provider,
        mock: record.mock,
        usage: record.usage,
        latency_ms: record.latency_ms,
        plan_id: record.id,
      },
    })
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  async function handleDeleteHistory(planId: string) {
    try {
      await deletePlan(planId)
      setHistory((prev) => prev.filter((item) => item.id !== planId))
      notify({ tone: 'ok', title: '已删除这条规划' })
    } catch {
      notify({ tone: 'error', title: '删除失败', desc: '请稍后重试' })
    }
  }

  const canSubmit = question.trim().length >= 8 && state.status !== 'loading'

  return (
    <section className="page">
      <PageHeader
        eyebrow="研究规划"
        title="先规划，再行动"
        lede="输入一个研究问题，智能体先产出结构化计划——研究目标、关键子问题、执行步骤与预期来源；方向确认后再跑完整研究。"
        notes={[
          { term: '能做什么', desc: '在真正开跑之前，先把研究目标和拆解步骤摊开给你看。' },
          { term: '怎么用', desc: '输入问题 → 生成计划 → 觉得不对就改问题重生成 → 拿去跑深度研究。' },
          { term: '什么时候用', desc: '问题比较宽泛、怕跑偏时，先花 10 秒对齐方向更划算。' },
        ]}
      />

      {/* ============ 主操作区（首屏必达） ============ */}
      <section className="page__primary">
        <div className="input-card">
          <div className="field">
            <label className="field__label" htmlFor="question">
              研究问题
            </label>
            <textarea
              id="question"
              className="textarea"
              rows={3}
              value={question}
              placeholder="例如：研究 2026 年 AI Agent 开发岗位的主要技术要求…"
              onChange={(event) => setQuestion(event.target.value)}
            />
            <div className="field__footer">
              <button className="link-button" onClick={() => setQuestion(EXAMPLE_QUESTION)}>
                填入示例
              </button>
              <span className="hint">
                {question.trim().length < 8 ? '至少 8 个字' : `${question.trim().length} 字`}
              </span>
            </div>
          </div>

          <div className="field">
            <label className="field__label" htmlFor="steps">
              最多步骤数：{maxSteps}
            </label>
            <input
              id="steps"
              type="range"
              min={3}
              max={10}
              value={maxSteps}
              onChange={(event) => setMaxSteps(Number(event.target.value))}
            />
          </div>

          <button className="button button--primary" onClick={handleSubmit} disabled={!canSubmit}>
            {state.status === 'loading' ? '生成中…' : '生成研究计划'}
          </button>

          <p className="tip">
            <span className="tip__label">提示</span>
            <span>点「生成研究计划」后，会先产出研究目标与关键子问题；确认方向无误，再到「深度研究」跑完整研究。</span>
          </p>
        </div>

        {state.status === 'error' && (
          <div className="stack-gap">
            <ErrorState code={state.code} message={state.message} onRetry={() => void handleSubmit()} />
          </div>
        )}
      </section>

      {/* ============ 内容区：加载 / 结果 / 空态 ============ */}
      <section className="page__content">
        {state.status === 'loading' && <LoadingState variant="card" label="正在生成研究计划…" />}

        {state.status === 'ok' && <PlanView data={state.data} onNavigate={onNavigate} />}

        {state.status === 'idle' && (
          <EmptyState
            title="还没有研究计划"
            description="在上方输入研究问题并点「生成研究计划」，这里会显示研究目标、关键子问题与执行步骤。"
            actionLabel="填入示例"
            onAction={() => setQuestion(EXAMPLE_QUESTION)}
          />
        )}
      </section>

      {/* ============ 折叠说明区（沉底，默认收起） ============ */}
      <section className="page__aside">
        <details className="fold card--fold">
          <summary className="fold__summary">
            <ChevronRightIcon size={14} />
            <span>这个模块能做什么？</span>
          </summary>
          <div className="fold__body">
            <div className="module-section__body">
              <p>
                「研究规划」是研究的<strong>起点和骨架</strong>。它不负责直接给出最终答案，而是先把你的研究问题拆成清晰的子问题、执行步骤和预期来源。
                这样你可以在执行前判断方向是否正确、范围是否合理，避免后续检索跑题或重复劳动。
              </p>
            </div>
            <div className="module-section__grid">
              <div className="module-card">
                <h4 className="module-card__title">研究目标</h4>
                <p className="module-card__text">一句话定义这次研究要回答的核心问题，作为后续所有步骤的北极星。</p>
              </div>
              <div className="module-card">
                <h4 className="module-card__title">关键问题</h4>
                <p className="module-card__text">把大问题拆成 3-7 个可独立回答的子问题，覆盖不同维度和潜在争议点。</p>
              </div>
              <div className="module-card">
                <h4 className="module-card__title">研究步骤</h4>
                <p className="module-card__text">按优先级排列的执行计划，每步说明要查什么、怎么查、预期得到什么证据。</p>
              </div>
              <div className="module-card">
                <h4 className="module-card__title">预期来源</h4>
                <p className="module-card__text">建议检索的信息源类型（如招聘站、论文库、行业报告），帮助后续检索少走弯路。</p>
              </div>
            </div>
          </div>
        </details>

        <details className="fold card--fold">
          <summary className="fold__summary">
            <ChevronRightIcon size={14} />
            <span>使用方式</span>
          </summary>
          <div className="fold__body">
            <div className="panel__notes">
              <div>
                <b>适用场景</b>
                <span>动手前先把研究方向和问题想清楚，避免研究跑偏或遗漏关键子问题。</span>
              </div>
              <div>
                <b>操作路径</b>
                <span>输入研究问题 → 设定最多步骤数 → 生成计划 → 检查目标/子问题/步骤/来源。</span>
              </div>
            </div>
          </div>
        </details>
      </section>

      {/* ============ 状态区：历史规划（与深度研究的历史运行对齐） ============ */}
      <section className="page__status">
        <section className="activity">
          <div className="activity__head">
            <h3 className="plan__heading text-flush">历史规划</h3>
            <button className="link-button" onClick={() => void refreshHistory()} disabled={historyLoading}>
              {historyLoading ? '刷新中…' : '刷新'}
            </button>
          </div>

          {historyLoading && history.length === 0 && <LoadingState variant="list" rows={3} />}

          {!historyLoading && history.length === 0 && (
            <EmptyState
              title="还没有历史规划"
              description="生成成功的研究计划会自动保存在这里，可点击回看或拿去跑深度研究。"
            />
          )}

          {history.length > 0 && (
            <ul className="run-list">
              {history.map((record) => (
                <li key={record.id} className="run-list__item">
                  <button
                    className="run-list__btn"
                    onClick={() => handleLoadHistory(record)}
                    title="点击加载这份规划"
                  >
                    <StatusBadge variant={record.mock ? 'warn' : 'ok'}>
                      {record.mock ? 'Mock' : `${record.plan.steps.length} 步`}
                    </StatusBadge>
                    <span className="run-list__q">{record.question}</span>
                    <span className="hint">{formatRelativeTime(record.created_at)}</span>
                  </button>
                  <button
                    className="run-list__delete"
                    aria-label="删除这条规划"
                    title="删除这条规划"
                    onClick={() => void handleDeleteHistory(record.id)}
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </section>
    </section>
  )
}

function PlanView({
  data,
  onNavigate,
}: {
  data: PlanResponse
  onNavigate?: (key: string) => void
}) {
  const { plan } = data
  // [B22] 防御：后端已对空计划做 repair 重试，但万一仍拿到空内容，
  // 要明确告诉用户"这次没生成成功"，而不是渲染一堆空卡片让人以为功能坏了。
  const hasContent =
    Boolean(plan.goal.trim()) || plan.questions.length > 0 || plan.steps.length > 0

  function handleSendToWorkflow() {
    const task = planToResearchTask(plan)
    if (!writePrefillQuestion(task)) {
      notify({ tone: 'warn', title: '无法写入预填内容', desc: '浏览器存储不可用，请手动复制。' })
      return
    }
    notify({ tone: 'ok', title: '已带入深度研究', desc: '研究任务已预填，确认后点「启动深度研究」。' })
    onNavigate?.('workflow')
  }

  if (!hasContent) {
    return (
      <EmptyState
        title="这次没有生成有效的计划内容"
        description="模型返回了空计划。请换个问法或重试一次；若反复出现，请到「系统设置」检查模型配置。"
      />
    )
  }

  return (
    <div className="result-stack">
      <div className="card card--interactive">
        <div className="run-card__head">
          <h3 className="run-card__title">计划概览</h3>
          <div className="badge-row">
            <StatusBadge variant={data.mock ? 'warn' : 'ok'}>
              {data.mock ? 'Mock 数据' : '真实模型'}
            </StatusBadge>
          </div>
        </div>
        <div className="run-card__meta">
          <span>{data.provider}</span>
          <span>{data.model}</span>
          <span>{data.usage.total_tokens.toLocaleString()} tokens</span>
          <span>{data.latency_ms} ms</span>
        </div>
        {/* 主行动点：计划确认无误后，一键带入深度研究跑完整流水线 */}
        {onNavigate && (
          <div className="run-card__actions">
            <button className="button button--primary" onClick={handleSendToWorkflow}>
              拿去跑深度研究 →
            </button>
            <span className="hint">计划内容会自动填入深度研究的研究任务框</span>
          </div>
        )}
      </div>

      <CollapsibleCard title="研究目标" defaultOpen>
        <p className="plan__goal text-flush">{plan.goal}</p>
      </CollapsibleCard>

      {plan.questions.length > 0 && (
        <CollapsibleCard title="关键问题" badge={<span className="hint">{plan.questions.length} 个</span>} defaultOpen>
          <ol className="data-list text-flush">
            {plan.questions.map((item, index) => (
              <li key={index} className="data-list__item">
                <span className="data-list__bullet" />
                <span className="data-list__text">{item}</span>
              </li>
            ))}
          </ol>
        </CollapsibleCard>
      )}

      <CollapsibleCard title="研究步骤" badge={<span className="hint">{plan.steps.length} 步</span>} defaultOpen>
        <div className="data-list data-list--gap text-flush">
          {plan.steps.map((step) => (
            <div key={step.index} className="step-card">
              <span className="step-card__no">{step.index}</span>
              <div>
                <div className="step-card__title">{step.title}</div>
                <div className="step-card__desc">{step.instruction}</div>
              </div>
            </div>
          ))}
        </div>
      </CollapsibleCard>

      {plan.expected_sources.length > 0 && (
        <CollapsibleCard title="预期来源" badge={<span className="hint">{plan.expected_sources.length} 个</span>}>
          <ol className="data-list text-flush">
            {plan.expected_sources.map((source, index) => (
              <li key={index} className="data-list__item">
                <span className="data-list__bullet" />
                <span className="data-list__text">{source}</span>
              </li>
            ))}
          </ol>
        </CollapsibleCard>
      )}
    </div>
  )
}

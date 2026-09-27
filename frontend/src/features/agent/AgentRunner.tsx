import { useCallback, useEffect, useState } from 'react'
import { deleteAgentRun, getAgentRun, listAgentRuns, runAgent } from '../../api/agent'
import { ApiClientError } from '../../api/client'
import { formatRelativeTime } from '../../lib/time'
import { ChevronRightIcon } from '../../components/icons'
import { StatusBadge } from '../../components/StatusBadge'
import { PageHeader } from '../../components/PageHeader'
import { CollapsibleCard } from '../../components/CollapsibleCard'
import { Markdown } from '../../components/Markdown'
import { ProcessTimeline, type ProcessTimelineItem } from '../../components/ProcessTimeline'
import { Stepper, type StepItem } from '../../components/Stepper'
import { ToolCallCard } from '../../components/ToolCallCard'
import { EmptyState } from '../../components/EmptyState'
import { LoadingState } from '../../components/LoadingState'
import { ErrorState } from '../../components/ErrorState'
import { notify } from '../../components/Toast'
import type {
  AgentRunResult,
  AgentRunSummary,
  AgentStepRecord,
  ToolCallRecord,
} from '../../types/agent'

const EXAMPLE_QUESTION = '向量数据库有哪些主流选择？各自适用场景是什么？'

// [F4] 键名必须与后端 app/agent/schemas.py 的 finished_reason 实际取值一致：
// final_answer | max_steps_reached | timeout | llm_error。
// 之前写的是 completed / max_steps / tool_error / cancelled —— 一个都对不上，
// 界面永远显示英文原始值 + 中性样式。
const FINISH_REASON_LABEL: Record<string, string> = {
  final_answer: '已给出结论',
  max_steps_reached: '已达最大步数',
  timeout: '已超时',
  llm_error: '模型调用失败',
}

const FINISH_VARIANT: Record<string, 'ok' | 'warn' | 'error'> = {
  final_answer: 'ok',
  max_steps_reached: 'warn',
  timeout: 'warn',
  llm_error: 'error',
}

type RunState =
  | { status: 'idle' }
  | { status: 'running' }
  | { status: 'ok'; data: AgentRunResult }
  | { status: 'error'; message: string; code: string }

export function AgentRunner() {
  const [question, setQuestion] = useState('')
  const [maxSteps, setMaxSteps] = useState(6)
  const [state, setState] = useState<RunState>({ status: 'idle' })
  // [B39] 历史记录：用户之前问过的问题（与深度研究 / 研究规划的历史对齐）
  const [history, setHistory] = useState<AgentRunSummary[]>([])
  const [historyLoading, setHistoryLoading] = useState(true)
  const [openId, setOpenId] = useState<string | null>(null)

  const refreshHistory = useCallback(async () => {
    setHistoryLoading(true)
    try {
      setHistory(await listAgentRuns())
    } catch {
      // 历史列表是辅助读路径，拉取失败不阻塞主流程（与后端降级策略一致）
      setHistory([])
    } finally {
      setHistoryLoading(false)
    }
  }, [])

  useEffect(() => {
    void refreshHistory()
  }, [refreshHistory])

  async function handleRun() {
    setState({ status: 'running' })
    setOpenId(null)
    try {
      const data = await runAgent({ question, maxSteps })
      setState({ status: 'ok', data })
      void refreshHistory()
    } catch (error) {
      if (error instanceof ApiClientError) {
        setState({ status: 'error', message: error.message, code: error.code })
      } else {
        setState({ status: 'error', message: '未知错误，请查看浏览器控制台', code: 'unknown' })
      }
    }
  }

  /** 回看一条历史记录：直接还原当时的答案与轨迹，不重新跑一次 */
  async function handleOpenHistory(record: AgentRunSummary) {
    setOpenId(record.id)
    try {
      const full = await getAgentRun(record.id)
      if (!full.result) {
        notify({ tone: 'error', title: '记录内容已损坏', desc: '这条记录读不出有效结果，可删除它。' })
        return
      }
      setQuestion(full.question)
      setState({ status: 'ok', data: full.result })
    } catch (error) {
      const message = error instanceof ApiClientError ? error.message : '读取失败'
      notify({ tone: 'error', title: '打开历史失败', desc: message })
    }
  }

  async function handleDeleteHistory(recordId: string) {
    try {
      await deleteAgentRun(recordId)
      setHistory((prev) => prev.filter((item) => item.id !== recordId))
      if (openId === recordId) setOpenId(null)
    } catch (error) {
      const message = error instanceof ApiClientError ? error.message : '删除失败'
      notify({ tone: 'error', title: '删除失败', desc: message })
    }
  }

  const canRun = question.trim().length >= 8 && state.status !== 'running'

  return (
    <section className="page">
      <PageHeader
        eyebrow="智能体工作台"
        title="让智能体自己跑研究"
        lede="输入一个研究任务，智能体自主决定调用哪些工具——联网搜索、抓取网页、计算，并把每一条结论都附上来源。"
        notes={[
          { term: '能做什么', desc: '一次问答内自主决定"要不要搜、搜什么、要不要读正文"，直接给带引用的答案。' },
          { term: '怎么用', desc: '输入任务 → 看它逐步调用工具 → 拿到最终答案与引用。' },
          { term: '与深度研究的区别', desc: '这里一路跑到出答案，不会中途等你确认；想要把关请用「深度研究」。' },
        ]}
      />

      {/* ============ 主操作区（首屏必达） ============ */}
      <section className="page__primary">
        <div className="input-card">
          <div className="field">
            <label className="field__label" htmlFor="agent-question">
              研究任务
            </label>
            <textarea
              id="agent-question"
              className="textarea"
              rows={3}
              value={question}
              placeholder="例如：向量数据库有哪些主流选择？各自适用场景是什么？"
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

          <div className="field field--inline">
            <label className="field__label" htmlFor="agent-steps">
              最大步数：{maxSteps}
            </label>
            <input
              id="agent-steps"
              type="range"
              min={1}
              max={12}
              value={maxSteps}
              onChange={(event) => setMaxSteps(Number(event.target.value))}
            />
          </div>

          <button className="button button--primary" onClick={handleRun} disabled={!canRun}>
            {state.status === 'running' ? 'Agent 执行中…' : '运行 Agent'}
          </button>

          <p className="tip">
            <span className="tip__label">提示</span>
            <span>Agent 会自己决定搜索与抓取，达到足够证据后给出带引用的答案。</span>
          </p>
        </div>

        {state.status === 'error' && (
          <div className="stack-gap">
            <ErrorState code={state.code} message={state.message} onRetry={() => void handleRun()} />
          </div>
        )}
      </section>

      {/* ============ 内容区：加载 / 结果 / 空态 ============ */}
      <section className="page__content">
        {state.status === 'running' && <LoadingState variant="list" label="Agent 正在执行…" />}

        {state.status === 'ok' && <RunView data={state.data} />}

        {state.status === 'idle' && (
          <EmptyState
            title="还没有运行 Agent"
            description="在上方输入研究任务并点「运行 Agent」，这里会显示最终答案、引用来源与执行轨迹。"
            actionLabel="填入示例"
            onAction={() => setQuestion(EXAMPLE_QUESTION)}
          />
        )}
      </section>

      {/* ============ 历史记录：用户之前问过的问题（与深度研究 / 研究规划对齐） ============ */}
      <section className="page__status">
        <section className="activity">
          <div className="activity__head">
            <h3 className="activity__title">历史记录</h3>
            <button
              className="link-button"
              onClick={() => void refreshHistory()}
              disabled={historyLoading}
            >
              {historyLoading ? '刷新中…' : '刷新'}
            </button>
          </div>

          {historyLoading && history.length === 0 && <LoadingState variant="list" rows={3} />}

          {!historyLoading && history.length === 0 && (
            <EmptyState
              title="还没有历史记录"
              description="跑成功的 Agent 会自动保存在这里，点一条即可回看当时的答案与执行轨迹。"
            />
          )}

          {history.length > 0 && (
            <ul className="run-list">
              {history.map((record) => (
                <li key={record.id} className="run-list__item">
                  <button
                    className="run-list__btn"
                    data-active={openId === record.id || undefined}
                    onClick={() => void handleOpenHistory(record)}
                    title="点击回看这一次运行"
                  >
                    <StatusBadge variant={FINISH_VARIANT[record.finished_reason] ?? 'info'}>
                      {FINISH_REASON_LABEL[record.finished_reason] ?? record.finished_reason}
                    </StatusBadge>
                    <span className="run-list__q">{record.question}</span>
                    <span className="hint">{formatRelativeTime(record.created_at)}</span>
                  </button>
                  <button
                    className="run-list__delete"
                    aria-label="删除这条记录"
                    title="删除这条记录"
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
                「智能体」是一个<strong>端到端的自主研究执行器</strong>。你只需给出一个研究任务，智能体会自己决定什么时候搜索、抓取网页、调用什么工具，
                并在达到足够证据后给出带引用来源的最终答案。它适合希望一次性拿到结论、同时保留可追溯执行过程的场合。
              </p>
              <p>
                <strong>为什么联网搜索走 Tavily 而不是让大模型"自己上网"？</strong>
                模型自带的联网能力是一个黑盒：搜了什么、看了哪些网页、结论依据哪条来源，外部都无从核对。
                这里把搜索交给独立的 Tavily 检索服务，每一步调用都会留下结构化记录（查询词、命中的标题/链接/摘要、耗时），
                结论才能逐条溯源，检索配额也可度量、可控制——这是"可审计的研究"和"凭感觉回答"的区别。
              </p>
            </div>
            <div className="module-section__grid">
              <div className="module-card">
                <h4 className="module-card__title">自主决策</h4>
                <p className="module-card__text">模型根据当前证据决定下一步动作，不需要你手动指定每一步。</p>
              </div>
              <div className="module-card">
                <h4 className="module-card__title">工具调用</h4>
                <p className="module-card__text">内置联网搜索、网页抓取等工具，每次调用都会记录参数、结果和耗时。</p>
              </div>
              <div className="module-card">
                <h4 className="module-card__title">可溯源结论</h4>
                <p className="module-card__text">最终答案会附带引用片段，方便你核对结论是否有证据支撑。</p>
              </div>
              <div className="module-card">
                <h4 className="module-card__title">执行轨迹</h4>
                <p className="module-card__text">完整展示智能体每一步的思考、工具调用与结果，便于排查和审计。</p>
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
                <span>想快速拿到一个可溯源的研究结论，或观察智能体如何自主决策与调用工具。</span>
              </div>
              <div>
                <b>操作路径</b>
                <span>输入任务 → 设定最大步数 → 运行 Agent → 查看最终答案、引用来源与执行轨迹。</span>
              </div>
            </div>
          </div>
        </details>
      </section>
    </section>
  )
}

function RunView({ data }: { data: AgentRunResult }) {
  const timelineItems: ProcessTimelineItem[] = data.steps.map((step) => buildStepItem(step))

  // 三阶段骨架：与「深度研究」的 Stepper 视觉同源，但固定为 理解 → 执行工具 → 给出答案
  // （Agent 循环没有固定阶段数，硬套七步会宽度乱跳）。下方仍保留逐步执行轨迹。
  const answerStage: StepItem['status'] =
    data.finished_reason === 'final_answer' || data.finished_reason === 'max_steps_reached'
      ? 'done'
      : 'error'
  const stageItems: StepItem[] = [
    { key: 'understand', label: '理解任务', status: 'done' },
    {
      key: 'tools',
      label: '执行工具',
      status: 'done',
      count: data.tool_calls.length || undefined,
    },
    { key: 'answer', label: '给出答案', status: answerStage },
  ]
  const stageCaption =
    data.finished_reason === 'final_answer'
      ? '智能体已给出带引用的结论。'
      : data.finished_reason === 'llm_error'
        ? '模型调用失败，未能生成最终答案。'
        : data.finished_reason === 'timeout'
          ? '执行超时，未跑完即停止。'
          : '已达到最大步数，下面是当前已有结论。'

  return (
    <div className="result-stack">
      <div className="card card--pad">
        <div className="plan__heading">执行概览</div>
        <Stepper
          items={stageItems}
          caption={stageCaption}
          captionBadge={FINISH_REASON_LABEL[data.finished_reason] ?? data.finished_reason}
        />
      </div>

      <div className="card card--interactive">
        <div className="run-card__head">
          <h3 className="run-card__title">运行结果</h3>
          <div className="badge-row">
            <StatusBadge variant={data.mock ? 'warn' : 'ok'}>
              {data.mock ? 'Mock 数据' : '真实模型'}
            </StatusBadge>
            <StatusBadge variant={FINISH_VARIANT[data.finished_reason] ?? 'info'}>
              {FINISH_REASON_LABEL[data.finished_reason] ?? data.finished_reason}
            </StatusBadge>
          </div>
        </div>

        <div className="run-card__metrics">
          <div className="run-metric">
            <span className="run-metric__value">{data.steps.length}</span>
            <span className="run-metric__label">执行步数</span>
          </div>
          <div className="run-metric">
            <span className="run-metric__value">{data.tool_calls.length}</span>
            <span className="run-metric__label">工具调用</span>
          </div>
          <div className="run-metric">
            <span className="run-metric__value">{data.usage.total_tokens.toLocaleString()}</span>
            <span className="run-metric__label">总 Tokens</span>
          </div>
          <div className="run-metric">
            <span className="run-metric__value">{formatDuration(data.latency_ms)}</span>
            <span className="run-metric__label">耗时</span>
          </div>
        </div>
      </div>

      <CollapsibleCard title="最终答案" defaultOpen>
        {/* [B23] 答案必须走 Markdown：模型按契约输出小节/列表/加粗，
            纯文本渲染会把格式糊成一坨、换行也丢失 —— 这就是"答案太简单"观感的来源之一。 */}
        <div className="answer-card">
          <Markdown>{data.answer}</Markdown>
        </div>
      </CollapsibleCard>

      {data.citations.length > 0 && (
        <CollapsibleCard title="引用来源" badge={<span className="hint">{data.citations.length} 条</span>}>
          <div className="data-list data-list--gap">
            {data.citations.map((citation) => (
              <div key={citation.chunk_id} className="citation">
                <div className="citation__head">
                  <span className="citation__file">
                    {citation.filename}
                    {citation.page ? ` · 第 ${citation.page} 页` : ''}
                  </span>
                  <span className="citation__meta">片段 {citation.chunk_id}</span>
                </div>
                <p className="citation__quote">{citation.quote}</p>
              </div>
            ))}
          </div>
        </CollapsibleCard>
      )}

      <CollapsibleCard title="执行轨迹" badge={<span className="hint">{data.steps.length} 步</span>} defaultOpen>
        <ProcessTimeline items={timelineItems} />
      </CollapsibleCard>
    </div>
  )
}

function buildStepItem(step: AgentStepRecord): ProcessTimelineItem {
  if (step.tool_call) {
    return {
      id: step.index,
      title: `调用 ${step.tool_call.tool}`,
      body: step.reason,
      detail: <ToolCallDetail call={step.tool_call} />,
      status: step.tool_call.ok ? 'done' : 'error',
    }
  }

  if (step.final_answer) {
    return {
      id: step.index,
      title: '给出最终答案',
      body: '智能体认为已有足够证据，生成最终结论。',
      status: 'done',
    }
  }

  return {
    id: step.index,
    title: `步骤 ${step.index}`,
    body: step.reason ?? '正在决策…',
    status: 'done',
  }
}

function ToolCallDetail({ call }: { call: ToolCallRecord }) {
  return (
    <div className="stack-gap-xs">
      <ToolCallCard call={call} />
    </div>
  )
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`
  return `${(ms / 1000).toFixed(1)} s`
}

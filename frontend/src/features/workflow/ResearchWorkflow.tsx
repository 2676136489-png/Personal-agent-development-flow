import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { getResearch, getRunBudget, resumeResearch, startResearch } from '../../api/graph'
import type { RunBudgetSnapshot } from '../../api/graph'
import { ApiClientError, formatResetMoment } from '../../api/client'
import {
  AlertIcon,
  BeakerIcon,
  BulbIcon,
  CheckIcon,
  ListIcon,
  ChevronRightIcon,
  DotIcon,
  FileIcon,
  PauseIcon,
  PencilIcon,
  PlayIcon,
  SearchIcon,
  WrenchIcon,
  XIcon,
} from '../../components/icons'
import type { IconProps } from '../../components/icons'
import type { ComponentType } from 'react'
import { Markdown } from '../../components/Markdown'
import { DownloadReportButton } from '../../components/DownloadReportButton'
import { FlowOverview } from './FlowOverview'
import { PageHeader } from '../../components/PageHeader'
import { Stepper, type StepItem } from '../../components/Stepper'
import { EvidencePanel, collectSources } from '../../components/EvidencePanel'
import { LoadingState } from '../../components/LoadingState'
import { notify } from '../../components/Toast'
import { StatusBadge } from '../../components/StatusBadge'
import { CollapsibleCard } from '../../components/CollapsibleCard'
import { ProcessTimeline, type ProcessTimelineItem } from '../../components/ProcessTimeline'
import { ToolCallCard } from '../../components/ToolCallCard'
import type { ResearchRun, RunStep } from '../../types/graph'
import type { RunEvent } from '../../types/events'
import { useRunEvents, type StreamStatus } from './useRunEvents'
import { RunHistory } from './RunHistory'
import { EmptyState } from '../../components/EmptyState'
import { ErrorState } from '../../components/ErrorState'
import type { RunStatus } from '../../types/graph'
import { normalizeMaxIterations, type CurrentRun } from './currentRun'
import { takePrefillQuestion } from './prefill'

const EXAMPLE_QUESTION =
  '研究 2026 年 AI Agent 开发岗位的核心技术要求，并分析不同公司的岗位要求有什么共同点。'

/** 终态集合（与 types/graph.ts:5 的 RunStatus 同源）。非终态 = 本次 run 仍在进行中。 */
const TERMINAL_STATUSES = new Set<RunStatus>(['completed', 'cancelled', 'failed'])

/**
 * [OBS-1] 跨页 UI 自动恢复：把最近一次启动的 thread_id 落到 sessionStorage，
 * 组件重新挂载（切页返回）时据此自动恢复运行与进度，兑现 tip「切到其他页面进度不中断」。
 * sessionStorage 在隐私模式可能被禁用 → 读写失败一律静默忽略，绝不影响研究主流程。
 */
const LAST_THREAD_KEY = 'arw-last-thread'

function readLastThread(): string | null {
  try {
    return sessionStorage.getItem(LAST_THREAD_KEY)
  } catch {
    return null
  }
}

function writeLastThread(threadId: string): void {
  try {
    sessionStorage.setItem(LAST_THREAD_KEY, threadId)
  } catch {
    /* 忽略：持久化失败不应影响研究流程 */
  }
}

function clearLastThread(): void {
  try {
    sessionStorage.removeItem(LAST_THREAD_KEY)
  } catch {
    /* 忽略 */
  }
}

const NODE_LABELS: { key: string; label: string }[] = [
  { key: 'understand_task', label: '理解' },
  { key: 'plan', label: '计划' },
  { key: 'research', label: '研究' },
  { key: 'retrieve', label: '检索' },
  { key: 'analyze', label: '分析' },
  { key: 'verify', label: '验证' },
  { key: 'write', label: '报告' },
]

/** 步骤条用的完整节点名（进度轨用短名 `NODE_LABELS`，步骤条要能自解释） */
const STEP_DEFS: { key: string; label: string; hint: string }[] = [
  { key: 'understand_task', label: '理解任务', hint: '拆解问题、界定范围' },
  { key: 'plan', label: '制定计划', hint: '生成研究步骤与预期来源' },
  { key: 'research', label: '研究检索', hint: '调用工具联网检索与读正文' },
  { key: 'retrieve', label: '抽取证据', hint: '从来源中抽取可引用的片段' },
  { key: 'analyze', label: '分析归纳', hint: '归纳结论并标出证据缺口' },
  { key: 'verify', label: '核对验证', hint: '判断证据是否足够支撑结论' },
  { key: 'write', label: '撰写报告', hint: '汇总成结构化报告' },
]

/**
 * 把一次运行映射成步骤条状态。
 *
 * 「已完成」的判据是**节点在 steps 里出现过**；研究循环与验证回炉会让同一节点
 * 出现多次，所以额外带上 `count` 显示 ×N —— 用户能直观看到「这一步回炉过」。
 */
function buildStepItems(run: ResearchRun | null): StepItem[] {
  const executed = new Map<string, number>()
  for (const step of run?.steps ?? []) {
    executed.set(step.node, (executed.get(step.node) ?? 0) + 1)
  }

  const activeNode =
    run?.status === 'awaiting_approval'
      ? 'write'
      : run && run.steps.length > 0
        ? run.steps[run.steps.length - 1].node
        : null
  const failed = run?.status === 'failed' || run?.status === 'cancelled'
  const finished = run?.status === 'completed'

  // 已完成的最后一步下标：中间节点即便没在 steps 里出现，
  // 只要它后面有节点跑过，也说明它已经过去了（steps 只记关键跳跃）
  const lastDoneIndex = STEP_DEFS.reduce(
    (last, def, index) => (executed.has(def.key) ? index : last),
    -1,
  )

  return STEP_DEFS.map((def, index) => {
    const count = executed.get(def.key) ?? 0
    if (finished) {
      return { key: def.key, label: def.label, status: 'done' as const, count }
    }
    if (activeNode === def.key) {
      return {
        key: def.key,
        label: def.label,
        status: failed ? ('error' as const) : ('active' as const),
        count,
      }
    }
    if (count > 0 || index < lastDoneIndex) {
      return { key: def.key, label: def.label, status: 'done' as const, count }
    }
    return { key: def.key, label: def.label, status: 'pending' as const, count }
  })
}

/** 步骤条下方那句「现在在做什么」—— 优先用最后一个 step 的摘要 */
function currentStepCaption(run: ResearchRun | null, items: StepItem[]): string | undefined {
  if (!run) return undefined
  // 确认闸门单独说清楚「等你做什么」：此时最后一步的摘要往往还停在验证阶段，
  // 直接展示会让用户以为还在跑。
  if (run.status === 'awaiting_approval') {
    return '证据已核对完毕，等待你确认后开始撰写报告。'
  }
  const active = items.find((item) => item.status === 'active')
  if (!active) {
    if (run.status === 'completed') return '研究已完成，报告已生成。'
    if (run.status === 'failed') return run.error ?? '研究失败。'
    if (run.status === 'cancelled') return '已终止。'
    return undefined
  }
  const def = STEP_DEFS.find((d) => d.key === active.key)
  const lastSummary = run.steps.length > 0 ? run.steps[run.steps.length - 1].summary : ''
  return lastSummary ? `${def?.label}：${lastSummary}` : def?.hint
}

/**
 * 回炉说明：把 iteration / verify_attempts 这两个后端指标翻译成一句人话。
 *
 * 为什么需要它：步骤条上的 ×N 只说明「这一步重复执行过」，但没解释为什么重复 ——
 * 用户看到「核对验证 ×2」会怀疑是不是出错了。这里明说「验证未通过 → 自动补检索」。
 * 只在真的发生过回炉（轮次 > 1 或核对 > 1）时返回，不多说废话。
 */
function reworkCaption(run: ResearchRun | null): string | undefined {
  if (!run) return undefined
  if (run.iteration <= 1 && run.verify_attempts <= 1) return undefined
  const scope = `${run.iteration} 轮研究检索、${run.verify_attempts} 次证据核对`
  if (TERMINAL_STATUSES.has(run.status)) {
    return `本次共完成 ${scope}；数字大于 1 即表示经历过「验证未通过 → 自动回炉补检索」。`
  }
  return `验证未一次通过，已回炉：当前为第 ${scope}。`
}

const STREAM_STATUS_LABEL: Record<StreamStatus, string> = {
  idle: '未连接',
  connecting: '连接中…',
  open: '实时',
  error: '连接中断',
  closed: '已结束',
}

/** [B37] 快照轮询间隔：够快到「进度自己会走」，又不至于把接口打爆 */
const SNAPSHOT_POLL_INTERVAL_MS = 3000

/** 只有这两个状态还会变化；终态（completed/failed/cancelled）不需要再轮询 */
const POLLABLE_STATUSES = new Set(['running', 'awaiting_approval'])

const STATUS_VARIANT: Record<string, 'ok' | 'warn' | 'error' | 'info' | 'running'> = {
  completed: 'ok',
  awaiting_approval: 'warn',
  running: 'running',
  cancelled: 'warn',
  failed: 'error',
}

const STATUS_NAME: Record<string, string> = {
  completed: '已完成',
  awaiting_approval: '等待确认',
  running: '运行中',
  cancelled: '已取消',
  failed: '失败',
}

/**
 * B3：事件类型 → 线图标组件（原 emoji 映射已删除，§5.1 / AC9）。
 * 未登记的类型落 DotIcon，不再用字符兜底。
 */
const EVENT_ICON: Record<string, ComponentType<IconProps>> = {
  task_started: PlayIcon,
  planning: BulbIcon,
  plan_created: ListIcon,
  retrieval_started: SearchIcon,
  retrieval_completed: FileIcon,
  analysis_started: BeakerIcon,
  analysis_completed: CheckIcon,
  verification_started: SearchIcon,
  verification_completed: CheckIcon,
  tool_started: WrenchIcon,
  tool_completed: WrenchIcon,
  report_started: PencilIcon,
  approval_required: PauseIcon,
  task_completed: CheckIcon,
  task_failed: AlertIcon,
  task_cancelled: XIcon,
}

/**
 * 时间线里图标的渲染尺寸：容器是 22px 的格子，13px 线图标视觉最稳。
 * 未登记的事件类型落 DotIcon —— 不能让 `<undefined />` 把整条时间线打崩。
 */
function renderEventIcon(type: string): JSX.Element {
  const Icon = EVENT_ICON[type] ?? DotIcon
  return <Icon size={13} />
}

function newThreadId(): string {
  // [B14] 后端要求 thread_<12 位十六进制>。crypto.randomUUID 去掉连字符后是 32 位十六进制，
  // 直接取前 12 位即可；降级路径也必须产出十六进制（Math.random().toString(36) 会含 g~z，
  // 会被后端的格式校验拒掉），所以这里用 getRandomValues 拼十六进制。
  const cryptoObj = globalThis.crypto
  if (cryptoObj?.randomUUID) {
    return `thread_${cryptoObj.randomUUID().replace(/-/g, '').slice(0, 12)}`
  }
  const bytes = new Uint8Array(6)
  if (cryptoObj?.getRandomValues) {
    cryptoObj.getRandomValues(bytes)
  } else {
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256)
  }
  return `thread_${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`
}

function describeEvent(event: RunEvent): string {
  const p = event.payload
  switch (event.type) {
    case 'task_started':
      return `任务开始 · 最大 ${String(p.max_iterations ?? '-')} 轮`
    case 'planning':
    case 'retrieval_started':
    case 'analysis_started':
    case 'verification_started':
      return `${String(p.node ?? event.type)} · ${String(p.summary ?? p.query ?? '进行中')}`
    case 'plan_created':
      return `计划完成 · ${String(p.steps ?? '?')} 步`
    case 'tool_started':
      return `调用 ${String(p.tool)} · ${String(p.reason ?? '')}`
    case 'tool_completed':
      return `${String(p.tool)} ${p.ok ? '成功' : `失败(${String(p.error_kind ?? '')})`} · ${String(p.duration_ms ?? 0)}ms`
    case 'retrieval_completed':
      return `检索完成 · 命中 ${String(p.hits ?? 0)} 条`
    case 'analysis_completed':
      return `分析完成 · ${String(p.findings ?? 0)} 条结论 / ${String(p.gaps ?? 0)} 处缺口`
    case 'verification_completed':
      return `验证判定 · ${String(p.verdict ?? '')}`
    case 'report_started':
      return '开始撰写报告…'
    case 'approval_required':
      return '等待人工确认（写报告前）'
    case 'task_completed':
      return `任务完成 · ${String(p.title ?? '')}`
    case 'task_failed':
      return `任务失败 · ${String(p.error ?? '')}`
    case 'task_cancelled':
      return `任务已终止 · ${String(p.reason ?? '')}`
    default:
      return event.type
  }
}

/** 把原始 SSE 事件聚合为「阶段时间线」的友好摘要。 */
function buildPhaseTimeline(events: RunEvent[]): ProcessTimelineItem[] {
  const phases = new Map<string, ProcessTimelineItem>()

  for (const event of events) {
    const p = event.payload
    switch (event.type) {
      case 'task_started':
        phases.set('start', {
          id: 'start',
          title: '启动深度研究',
          body: `最多循环 ${String(p.max_iterations ?? '-')} 轮`,
          status: 'done',
          time: new Date(event.ts).toLocaleTimeString(),
        })
        break
      case 'planning':
        phases.set('plan', {
          id: 'plan',
          title: '制定研究计划',
          body: String(p.summary ?? '正在拆解问题…'),
          status: 'active',
        })
        break
      case 'plan_created':
        phases.set('plan', {
          id: 'plan',
          title: '制定研究计划',
          body: `计划已生成，共 ${String(p.steps ?? '-')} 个步骤`,
          status: 'done',
        })
        break
      case 'retrieval_started': {
        // [P1] 检索现在会覆盖多个子问题：事件里带上 queries 数组，多于一条时如实展示
        const queryCount = Array.isArray(p.queries) ? p.queries.length : 1
        phases.set('retrieve', {
          id: 'retrieve',
          title: '检索与获取资料',
          body:
            queryCount > 1
              ? `正在检索 ${queryCount} 个子问题…`
              : String(p.summary ?? p.query ?? '正在检索…'),
          status: 'active',
        })
        break
      }
      case 'retrieval_completed': {
        const existing = phases.get('retrieve')
        const queryCount = Array.isArray(p.queries) ? p.queries.length : 0
        const coverage = queryCount > 0 ? `覆盖 ${queryCount} 个子问题 · ` : ''
        phases.set('retrieve', {
          id: 'retrieve',
          title: '检索与获取资料',
          body: `检索完成，${coverage}累计命中 ${String(p.hits ?? 0)} 条证据`,
          status: 'done',
          time: existing?.time,
        })
        break
      }
      case 'analysis_started':
        phases.set('analyze', {
          id: 'analyze',
          title: '分析证据',
          body: '正在归纳核心结论…',
          status: 'active',
        })
        break
      case 'analysis_completed':
        phases.set('analyze', {
          id: 'analyze',
          title: '分析证据',
          body: `提炼出 ${String(p.findings ?? 0)} 条结论，发现 ${String(p.gaps ?? 0)} 处证据缺口`,
          status: 'done',
        })
        break
      case 'verification_started':
        phases.set('verify', {
          id: 'verify',
          title: '验证结论',
          body: '正在核对证据充分性…',
          status: 'active',
        })
        break
      case 'verification_completed':
        phases.set('verify', {
          id: 'verify',
          title: '验证结论',
          body: `验证结果：${String(p.verdict ?? '-')}`,
          status: p.verdict === 'pass' ? 'done' : 'error',
        })
        break
      case 'report_started':
        phases.set('report', {
          id: 'report',
          title: '撰写报告',
          body: '正在汇总结构化报告…',
          status: 'active',
        })
        break
      case 'approval_required':
        phases.set('approval', {
          id: 'approval',
          title: '等待人工确认',
          body: '证据已整理完毕，需要你确认后再生成最终报告',
          status: 'error',
        })
        break
      case 'task_completed':
        phases.set('finish', {
          id: 'finish',
          title: '研究完成',
          body: String(p.title ?? '最终报告已生成'),
          status: 'done',
          time: new Date(event.ts).toLocaleTimeString(),
        })
        break
      case 'task_failed':
        phases.set('finish', {
          id: 'finish',
          title: '研究失败',
          body: String(p.error ?? '未知错误'),
          status: 'error',
        })
        break
      case 'task_cancelled':
        phases.set('finish', {
          id: 'finish',
          title: '已终止',
          body: String(p.reason ?? '任务被手动终止'),
          status: 'error',
        })
        break
      default:
        break
    }
  }

  const order = ['start', 'plan', 'retrieve', 'analyze', 'verify', 'report', 'approval', 'finish']
  return order.map((key) => phases.get(key)).filter(Boolean) as ProcessTimelineItem[]
}

export interface ResearchWorkflowProps {
  /**
   * [F11] 深链目标：`#/workflow?thread=xxx`。
   * 效果评估页点一条「待确认 / 失败 / 运行中」的运行会跳到这里并直接加载它 ——
   * 评估页只能看到一个状态词，真正要处理（批准、看失败原因）得到这个页面来。
   */
  focusThread?: string | null
}

export function ResearchWorkflow({ focusThread }: ResearchWorkflowProps) {
  const [question, setQuestion] = useState('')
  const [maxIterations, setMaxIterations] = useState(3)
  const [run, setRun] = useState<ResearchRun | null>(null)
  /**
   * [P1 根治] 本次运行的启动期快照。`maxRunIterations` 是**进度条唯一的分母来源**。
   * ⚠️ 不要把它换成 `maxIterations`（滑杆 state）——那会让「拖滑杆」直接改动量到进度几何，
   *    表现为进度条在运行中途突然倒退（分母 13→18）或假满格（分母 18→6）。
   *    详见 `currentRun.ts` 的三条不变量。
   */
  const [currentRun, setCurrentRun] = useState<CurrentRun | null>(null)
  const [running, setRunning] = useState(false)
  const [feedback, setFeedback] = useState('')
  const [error, setError] = useState<string | null>(null)
  /** 今日额度快照：后端每日预算的「可见额度」视图（未启用/接口不可用时为 null） */
  const [budget, setBudget] = useState<RunBudgetSnapshot | null>(null)
  const { events, status: streamStatus, transport, subscribe } = useRunEvents()
  const timelineRef = useRef<HTMLOListElement | null>(null)
  const questionRef = useRef<HTMLTextAreaElement | null>(null)
  // [OBS-1] 守卫「挂载时自动恢复」只触发一次（React 18 StrictMode 开发态会双跑 effect）
  const restoredRef = useRef(false)

  useEffect(() => {
    const el = timelineRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [events])

  /**
   * 今日额度：把后端的「每日预算」从隐形拦截变成可见额度。
   * 失败时静默保留上一次的值 —— 额度提示属锦上添花，不该打断研究主流程。
   */
  const refreshBudget = useCallback(() => {
    getRunBudget()
      .then((snapshot) => setBudget(snapshot))
      .catch(() => {
        /* 接口不可用时整行不显示即可 */
      })
  }, [])

  useEffect(() => {
    refreshBudget()
  }, [refreshBudget])

  // [B25] 后端已改为「接口立即返回 running + 图在后台执行」：
  // run 的状态迁移（running → awaiting_approval / completed / failed）发生在请求之外，
  // 必须由 SSE 事件驱动回拉。否则审批面板永远不出现、报告永远不上屏 ——
  // startResearch 拿到的快照永远停在 running。
  // 注意两个里程碑各只处理一次：approval_required（出现审批面板）与终态（报告/失败上屏）。
  const approvalHandledRef = useRef(false)
  const terminalHandledRef = useRef(false)
  useEffect(() => {
    const approval = events.find((event) => event.type === 'approval_required')
    const terminal = events.find(
      (event) =>
        event.type === 'task_completed' ||
        event.type === 'task_failed' ||
        event.type === 'task_cancelled',
    )
    const milestone = terminal && !terminalHandledRef.current ? terminal
      : approval && !approvalHandledRef.current ? approval
      : null
    if (!milestone) return
    if (milestone.type === 'approval_required') approvalHandledRef.current = true
    else terminalHandledRef.current = true
    if (run) {
      // 回拉最新状态（报告 / 审批面板 / 失败原因都靠这一次刷新上屏）
      void getResearch(run.thread_id)
        .then((fresh) => {
          if (fresh) setRun(fresh)
        })
        .catch(() => {
          /* 回拉失败不致命：用户可手动点「刷新状态」 */
        })
    }
    if (milestone.type === 'approval_required') {
      notify({ tone: 'warn', title: '等待确认', desc: '证据已整理完毕，请确认是否生成报告。' })
    } else if (milestone.type === 'task_completed') {
      notify({ tone: 'ok', title: '研究完成', desc: String(milestone.payload.title ?? '') })
    } else if (milestone.type === 'task_failed') {
      notify({ tone: 'error', title: '研究失败', desc: String(milestone.payload.error ?? '') })
    } else {
      notify({ tone: 'warn', title: '研究已终止', desc: String(milestone.payload.reason ?? '') })
    }
    // run 只需读当前值，不作为依赖（否则每次 setRun 都会重跑本 effect）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [events])

  /**
   * [B37] 运行期间定时回拉快照 —— 让「执行进度」自动走到当前这一步。
   *
   * 为什么必须有：步骤条、轮次、tokens、证据条数全部读 `run`（快照），
   * 而快照只有两条更新路径 —— 事件触发回拉，或用户手点「刷新状态」。
   * 云端网关会缓冲 SSE（响应头都不下发），事件通道一旦不可用，
   * 整个页面就再也不动了，用户只能自己点刷新。
   * 这里按固定节奏回拉，不依赖任何事件通道，所以它在哪都能工作。
   *
   * 只在该运行「还可能变化」的状态下轮询：终态一到就停，不做无谓请求。
   */
  useEffect(() => {
    const threadId = run?.thread_id
    if (!threadId || !POLLABLE_STATUSES.has(run.status)) return
    let cancelled = false
    const timer = window.setInterval(() => {
      void getResearch(threadId)
        .then((fresh) => {
          if (!cancelled && fresh) setRun(fresh)
        })
        .catch(() => {
          /* 单次回拉失败不致命：下一次 tick 会重试 */
        })
    }, SNAPSHOT_POLL_INTERVAL_MS)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [run?.thread_id, run?.status])

  async function handleStart() {
    setRunning(true)
    setError(null)
    setRun(null)
    approvalHandledRef.current = false
    terminalHandledRef.current = false
    const threadId = newThreadId()
    subscribe(threadId)
    // [P1 根治] 在发出请求的同一步把 maxIterations 快照下来。
    // 放在 setRun 之前是刻意的：即便 startResearch 抛错，快照也已随本次尝试建立，
    // 进度条不会在「已 subscribe 但 run 还没回来」的窗口里读到上一次的快照。
    setCurrentRun({
      threadId,
      question,
      startedAt: Date.now(),
      phaseLabel: '启动',
      maxIterations,
    })
    try {
      setRun(await startResearch({ question, maxIterations, threadId }))
      // [OBS-1] 启动成功即记录 thread_id，供切页返回时自动恢复
      writeLastThread(threadId)
      notify({ tone: 'ok', title: '研究已启动', desc: '可以切到其他页面，进度不会中断。' })
    } catch (err) {
      const message = err instanceof ApiClientError ? err.message : '启动失败'
      setError(message)
      notify({ tone: 'error', title: '启动失败', desc: message })
    } finally {
      setRunning(false)
      // 无论成败都回读一次额度：成功要减去一次，429 后要把「已用完」说明白
      refreshBudget()
    }
  }

  async function handleResume(approved: boolean) {
    if (!run) return
    setRunning(true)
    setError(null)
    try {
      setRun(await resumeResearch(run.thread_id, approved, feedback))
      notify(
        approved
          ? { tone: 'ok', title: '已批准', desc: '正在生成最终报告，稍后可在下方查看。' }
          : { tone: 'warn', title: '已终止', desc: '本次研究不会生成报告。' },
      )
    } catch (err) {
      const message = err instanceof ApiClientError ? err.message : '恢复失败'
      setError(message)
      notify({ tone: 'error', title: '操作失败', desc: message })
    } finally {
      setRunning(false)
    }
  }

  async function handleRefresh() {
    if (!run) return
    setError(null)
    // [F2] 之前这里完全没有 try/catch：后端 500 或断网时会产生未捕获的
    // Promise rejection，用户点了"刷新状态"却看不到任何反馈。
    try {
      setRun(await getResearch(run.thread_id))
      notify({ tone: 'ok', title: '状态已刷新' })
    } catch (err) {
      const message = err instanceof ApiClientError ? err.message : '刷新状态失败'
      setError(message)
      notify({ tone: 'error', title: '刷新失败', desc: message })
    }
  }

  /**
   * 加载一次运行 —— 历史列表点击与 [OBS-1] 挂载自动恢复共用同一份逻辑与 API。
   * @param options.silent 静默模式：失败时不设置 error（供自动恢复使用，避免打扰用户）
   * @returns 是否成功加载到运行
   */
  async function handleLoadFromHistory(
    threadId: string,
    options?: { silent?: boolean },
  ): Promise<boolean> {
    if (!options?.silent) setError(null)
    try {
      const loaded = await getResearch(threadId)
      if (loaded) {
        setRun(loaded)
        setQuestion(loaded.question)
        subscribe(threadId)
        // [P1 根治] 历史运行没有本地快照（别的会话/别的页面实例启动的）→ 无法还原启动时的轮数。
        // ⚠️ 这里**不能**回落到滑杆 state `maxIterations`：那会让「看历史」和「拖滑杆」意外耦合，
        //    用户在历史里看到的分母会随他手上的滑杆乱跳。
        //    回落值走 normalizeMaxIterations，取与后端一致的保守默认（详见 currentRun.ts 不变量 C）。
        setCurrentRun({
          threadId,
          question: loaded.question,
          startedAt: Date.now(),
          phaseLabel: '历史',
          maxIterations: normalizeMaxIterations(
            (loaded as { max_iterations?: unknown }).max_iterations,
          ),
        })
        // [OBS-1] 手动从历史加载也算"当前正在看的运行"，切页返回应恢复到它
        if (!options?.silent) writeLastThread(threadId)
        return true
      }
      return false
    } catch (err) {
      if (!options?.silent) {
        setError(err instanceof ApiClientError ? err.message : '加载历史运行失败')
      }
      return false
    }
  }

  // [OBS-1] 挂载时自动恢复最近一次运行：读 sessionStorage → 复用 handleLoadFromHistory。
  // 仅执行一次（restoredRef 守卫）；threadId 已失效（后端 404）→ 静默清除并回落正常空态。
  //
  // [F11] 深链优先：`#/workflow?thread=xxx`（从效果评估页点过来）明确指定了要打开哪一条，
  // 不能被「本会话上次运行」盖掉 —— 否则用户点了 A 却看到 B。深链不静默：
  // 加载失败要让用户看到原因，而不是默默显示空态。
  useEffect(() => {
    if (focusThread) {
      restoredRef.current = true
      void handleLoadFromHistory(focusThread)
      return
    }
    if (restoredRef.current) return
    restoredRef.current = true
    // [B22] 「研究规划 → 拿去跑深度研究」的一键带入：预填内容优先于历史运行恢复，
    // 消费后聚焦输入框，用户确认无误即可直接启动。
    const prefill = takePrefillQuestion()
    if (prefill) {
      setQuestion(prefill)
      window.setTimeout(() => questionRef.current?.focus(), 50)
      return
    }
    const threadId = readLastThread()
    if (!threadId) return
    void (async () => {
      const ok = await handleLoadFromHistory(threadId, { silent: true })
      if (!ok) clearLastThread()
    })()
    // 仅挂载执行一次；handleLoadFromHistory 为组件内声明，无需入依赖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusThread])

  const hasStream = streamStatus !== 'idle' || events.length > 0
  // 轮数滑杆的门控：本次 run 是否还在进行中。
  // ⚠️ 不能用 hasStream：终态事件把 streamStatus 置成 'closed'（useRunEvents.ts:119），
  // 而 'closed' !== 'idle' 恒真；events 也只在下次 subscribe 时才清空。
  // 两条都是粘性的 —— 用 hasStream 会让滑杆在跑完之后永久锁死，用户再也改不了下一轮的轮数。
  // 判据用 run.status：非终态即进行中（running / awaiting_approval），覆盖刷新后的降级态；
  // 终态则解锁，这是用户唯一能改轮数去跑下一次的时机。
  const isRunActive = run !== null && !TERMINAL_STATUSES.has(run.status)
  /**
   * [P1 根治] 进度条分母的唯一来源 —— 启动期快照，不是滑杆 state `maxIterations`。
   * `currentRun` 为 null（还没启动过任何运行）时回落到 `normalizeMaxIterations(undefined)`
   * = `DEFAULT_MAX_ITERATIONS`（与后端默认一致的保守值），**不是**滑杆值。
   */
  const progressMaxIterations = normalizeMaxIterations(currentRun?.maxIterations)
  const phaseItems = useMemo(() => buildPhaseTimeline(events), [events])
  const stepItems = useMemo(() => buildStepItems(run), [run])
  const stepCaption = currentStepCaption(run, stepItems)
  const stepRework = reworkCaption(run)

  return (
    <section className="page page--flush">
      <PageHeader
        eyebrow="深度研究"
        title="跑一次完整的研究"
        lede="基于 LangGraph 的七步流水线：理解任务 → 制定计划 → 研究检索 → 抽取证据 → 分析归纳 → 核对验证 → 撰写报告。检索与验证会循环回炉，直到证据足够；写最终报告前会停下来等你确认。"
        notes={[
          { term: '能做什么', desc: '产出一份结构化、每条结论都能溯源到原始来源的研究报告。' },
          { term: '怎么用', desc: '输入问题 → 设定轮数 → 启动 → 跟随步骤条 → 在确认闸门把关 → 取走报告。' },
          { term: '回炉是什么', desc: '验证判定证据不足时，会自动退回补充检索再核对，直到通过或达到上限。' },
          { term: '与智能体的区别', desc: '这里在写报告前会人工把关；智能体则一路跑到出答案。' },
        ]}
      />

      {/* ============ 主操作区（首屏必达）：输入 + 轮数 + 主按钮 + tip ============ */}
      <section className="page__primary">
        <div className="input-card">
          <div className="field">
            <label className="field__label" htmlFor="wf-question">
              研究任务
            </label>
            <textarea
              id="wf-question"
              ref={questionRef}
              className="textarea"
              rows={3}
              value={question}
              onChange={(event) => setQuestion(event.target.value)}
              placeholder="例如：研究 2026 年 AI Agent 开发岗位的主要技术要求…"
            />
            <div className="field__footer">
              <button className="link-button" onClick={() => setQuestion(EXAMPLE_QUESTION)}>
                填入示例
              </button>
              <span className="hint">{question.trim().length < 8 ? '至少 8 个字' : `${question.trim().length} 字`}</span>
            </div>
          </div>

          <div className="field field--inline">
            <label className="field__label" htmlFor="wf-iter">
              研究最大循环轮数：{maxIterations}
              {/* 运行中锁定时用文字说明，不只靠置灰 —— 置灰对色盲用户与截图不可读 */}
              {(running || isRunActive) && '（运行中不可改）'}
            </label>
            <input
              id="wf-iter"
              type="range"
              min={1}
              max={8}
              value={maxIterations}
              disabled={running || isRunActive}
              onChange={(event) => setMaxIterations(Number(event.target.value))}
            />
          </div>

          <button
            className={`button button--primary ${running ? 'button--busy' : ''}`.trim()}
            disabled={question.trim().length < 8 || running}
            onClick={() => void handleStart()}
          >
            {running ? '正在启动…' : '启动深度研究'}
          </button>

          <p className="tip">
            <span className="tip__label">提示</span>
            <span>启动后可以切到其他页面，进度不会中断；写报告前会停下来等你确认。</span>
          </p>

          {/* 今日额度：把后端「每日预算」的拦截提前说清（未启用时不出现这一行） */}
          {budget?.enabled && (
            <p className="tip">
              <span className="tip__label">额度</span>
              <span>
                {budget.remaining > 0
                  ? `今日还剩 ${budget.remaining} 次深度研究（每位访客每天 ${budget.limit} 次），次日自动恢复。`
                  : `今日 ${budget.limit} 次额度已用完，${formatResetMoment(budget.reset_at_ms)}恢复。`}
              </span>
            </p>
          )}
        </div>

        {error && (
          <div className="stack-gap">
            <ErrorState message={error} />
          </div>
        )}
      </section>

      {/* ============ 内容区：步骤条 / 实时进度 / 结果 / 人工确认 / 空态 ============ */}
      <section className="page__content">
        {/* 运行一开始就用步骤条把「走到第几步」摊开，用户不用读日志 */}
        {(run || hasStream) && (
          <div className="card card--pad stack-bottom-md">
            <div className="run-card__head stack-bottom-md">
              <h3 className="run-card__title">执行进度</h3>
              {run && (
                <StatusBadge variant={STATUS_VARIANT[run.status] ?? 'info'}>
                  {STATUS_NAME[run.status] ?? run.status}
                </StatusBadge>
              )}
            </div>
            <Stepper
              items={stepItems}
              caption={stepCaption}
              captionBadge={
                run
                  ? `${stepItems.filter((s) => s.status === 'done').length}/${stepItems.length} 步`
                  : '启动中'
              }
            />
            {/* 回炉说明：只在真的发生过「验证未通过 → 自动补检索」时出现 */}
            {stepRework && <p className="hint note-line stack-top-sm">{stepRework}</p>}
          </div>
        )}

        {/* 还没拿到 run 但已经在启动：给骨架而不是空白，避免"点了没反应" */}
        {!run && running && <LoadingState variant="card" rows={3} label="正在启动研究…" />}

        {hasStream && (
          <section className="activity">
            <div className="activity__head">
              <h3 className="activity__title">实时进度</h3>
              <StatusBadge variant={streamStatus === 'open' ? 'running' : streamStatus === 'error' ? 'error' : 'info'}>
                {streamStatus === 'open' && transport === 'polling'
                  ? '轮询同步'
                  : STREAM_STATUS_LABEL[streamStatus]}
              </StatusBadge>
              <span className="activity__count">{events.length} 条事件</span>
            </div>

            {phaseItems.length > 0 && (
              <div className="stack-gap">
                <ProcessTimeline items={phaseItems} />
              </div>
            )}

            {events.length === 0 ? (
              <p className="hint">等待事件…</p>
            ) : (
              <details className="fold">
                <summary className="fold__summary">
                  <ChevronRightIcon size={14} />
                  <span>查看原始事件流</span>
                </summary>
                <ol className="timeline timeline--compact" ref={timelineRef}>
                  {events.map((event) => (
                    <li key={event.id} className="timeline__item">
                      <span className="timeline__icon">
                        {renderEventIcon(event.type)}
                      </span>
                      <span className="timeline__text">{describeEvent(event)}</span>
                    </li>
                  ))}
                </ol>
              </details>
            )}
          </section>
        )}

        {run && (
          <RunView
            run={run}
            maxIterations={progressMaxIterations}
            onRefresh={() => void handleRefresh()}
          />
        )}

        {run?.status === 'awaiting_approval' && (
          <div className="approval">
            <h3 className="approval__title">人工确认</h3>
            <p className="approval__desc">
              证据已整理完毕。批准后会立即撰写并生成最终报告；填写补充意见可让模型按你的侧重调整后再落笔；
              终止则不生成报告，本次研究到此为止（已收集的结论与来源仍会保留在本页）。
            </p>
            <textarea
              className="textarea"
              rows={2}
              value={feedback}
              placeholder="可选：补充意见（例如「侧重应用场景，少写薪资」），会写进报告的写作要求"
              onChange={(event) => setFeedback(event.target.value)}
            />
            <div className="approval__actions">
              <button className="button button--primary" disabled={running} onClick={() => void handleResume(true)}>
                批准并生成报告
              </button>
              <button className="button" disabled={running} onClick={() => void handleResume(false)}>
                终止任务
              </button>
            </div>
            {/* [B33] 回应「刷新后进度丢失、要重新批准」的顾虑：批准状态在后端持久化 */}
            <p className="hint">
              批准后即使刷新页面，进度也会自动恢复；报告生成完毕会自动出现在下方，无需重新批准。
            </p>
          </div>
        )}

        {!run && !hasStream && !running && (
          <EmptyState
            title="还没开始研究"
            description="还没有运行记录，点击上方按钮开始第一次研究。"
            actionLabel="开始研究"
            onAction={() => questionRef.current?.focus()}
          />
        )}
      </section>

      {/* ============ 折叠说明区（沉底，默认收起，遵 PRD Q7 不删除） ============ */}
      <section className="page__aside">
        <details className="fold card--fold">
          <summary className="fold__summary">
            <ChevronRightIcon size={14} />
            <span>这个模块能做什么？</span>
          </summary>
          <div className="fold__body">
            <div className="module-section__body">
              <p>
                「深度研究」是<strong>完整的研究流水线</strong>，基于 LangGraph 把理解、计划、研究/检索循环、分析、验证、报告串起来。
                与「智能体」的端到端自动运行不同，工作流会在撰写最终报告前<strong>主动中断</strong>，让你确认方向、补充要求或终止任务，避免模型擅自生成你不满意的报告。
              </p>
              <p>
                它适合对研究质量要求更高、需要在关键节点人工介入的场景，例如行业分析、竞品调研、岗位需求研究等。
              </p>
              <p>
                <strong>联网检索为什么用 Tavily？</strong>
                大模型自带的联网能力是黑盒，无法核对它看了什么；Tavily 是独立的检索服务，
                返回结构化的标题/链接/摘要，每条证据都会留痕并进入「依据来源」面板，
                报告结论才能逐条溯源，检索配额也可度量可控。
              </p>
            </div>
            <FlowOverview />
          </div>
        </details>

        <details className="fold card--fold">
          <summary className="fold__summary">
            <ChevronRightIcon size={14} />
            <span>使用方式</span>
          </summary>
          <div className="fold__body">
            <div className="panel__notes panel__notes--inline">
              <div>
                <b>适用场景</b>
                <span>想拿到一份结构化、有出处、可在生成前把关的研究报告。</span>
              </div>
              <div>
                <b>操作路径</b>
                <span>输入问题 → 设定最大循环轮数 → 启动 → 实时看进度 → 中断点确认/修改 → 获取最终报告。</span>
              </div>
            </div>
          </div>
        </details>
      </section>

      {/* ============ 状态区：历史运行 ============ */}
      <section className="page__status">
        <RunHistory onSelect={(id) => void handleLoadFromHistory(id)} limit={10} />
      </section>
    </section>
  )
}

function RunView({
  run,
  maxIterations,
  onRefresh,
}: {
  run: ResearchRun
  /** [P1 根治] 启动期快照的轮数（进度条分母入参）。**不是**滑杆的当前值。 */
  maxIterations: number
  onRefresh: () => void
}) {
  const executed = useMemo(() => {
    const map = new Map<string, number>()
    for (const step of run.steps) {
      map.set(step.node, (map.get(step.node) ?? 0) + 1)
    }
    return map
  }, [run.steps])

  const activeNode = run.status === 'awaiting_approval' ? 'write' : getCurrentNode(run.steps)

  return (
    <div className="result-stack">
      <div className="card card--interactive">
        <div className="run-card__head">
          <h3 className="run-card__title">运行状态</h3>
          <StatusBadge variant={STATUS_VARIANT[run.status] ?? 'info'}>
            {STATUS_NAME[run.status] ?? run.status}
          </StatusBadge>
        </div>

        <ProgressTrack
          executed={executed}
          activeNode={activeNode}
          maxIterations={maxIterations}
        />

        <div className="run-card__metrics">
          <div className="run-metric">
            <span className="run-metric__value">{run.evidence_count}</span>
            <span className="run-metric__label">证据条数</span>
          </div>
          <div className="run-metric">
            <span className="run-metric__value">{run.iteration}</span>
            <span className="run-metric__label">研究轮次</span>
          </div>
          <div className="run-metric">
            <span className="run-metric__value">{run.verify_attempts}</span>
            <span className="run-metric__label">核对次数</span>
          </div>
          <div className="run-metric">
            <span className="run-metric__value">{run.usage_total_tokens.toLocaleString()}</span>
            <span className="run-metric__label">累计 Tokens</span>
          </div>
        </div>
        <p className="hint note-line stack-top-sm">
          研究轮次＝检索循环跑了几圈；核对次数大于 1 表示验证后回炉补搜过；证据条数＝可引用的证据片段总数。
        </p>

        <div className="run-card__meta run-card__meta--end">
          <button className="link-button" onClick={onRefresh}>
            刷新状态
          </button>
        </div>
      </div>

      {run.understanding && (
        <CollapsibleCard title="任务理解" badge={<span className="hint">{run.understanding.key_questions.length} 个子问题</span>}>
          <p className="plan__goal text-flush">{run.understanding.goal}</p>
          {run.understanding.scope && (
            <p className="hint stack-gap-xs">范围：{run.understanding.scope}</p>
          )}
          {run.understanding.key_questions.length > 0 && (
            <ol className="data-list stack-gap-sm">
              {run.understanding.key_questions.map((q, i) => (
                <li key={i} className="data-list__item">
                  <span className="data-list__bullet" />
                  <span className="data-list__text">{q}</span>
                </li>
              ))}
            </ol>
          )}
        </CollapsibleCard>
      )}

      {run.plan && (
        <CollapsibleCard title="研究计划" badge={<span className="hint">{run.plan.steps.length} 步</span>} defaultOpen>
          <p className="plan__goal text-flush">{run.plan.goal}</p>
          <ol className="steps steps--compact stack-gap-sm">
            {run.plan.steps.map((step) => (
              <li key={step.index} className="step">
                <span className="step__index">{step.index}</span>
                <div>
                  <div className="step__title">{step.title}</div>
                  <div className="step__instruction">{step.instruction}</div>
                </div>
              </li>
            ))}
          </ol>
          {run.plan.expected_sources.length > 0 && (
            <>
              <div className="plan__heading stack-gap">预期来源</div>
              <ul className="data-list">
                {run.plan.expected_sources.map((source, i) => (
                  <li key={i} className="data-list__item">
                    <span className="data-list__bullet" />
                    <span className="data-list__text">{source}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </CollapsibleCard>
      )}

      {/* 内容分析 + 依据来源：结论与证据放在同一屏，逐条可点开核对 */}
      {(run.analysis || run.citations.length > 0) && (
        <EvidencePanel
          findings={run.analysis?.findings ?? []}
          gaps={run.analysis?.gaps ?? []}
          sources={collectSources(run)}
        />
      )}

      {run.verification && (
        <div className="card card--pad-sm">
          <div className="alert__row">
            <StatusBadge variant={run.verification.verdict === 'pass' ? 'ok' : 'warn'}>
              {run.verification.verdict === 'pass' ? '验证通过' : '需要补充'}
            </StatusBadge>
            <span className="hint note-line">证据核对结果</span>
          </div>
          {run.verification.reasons.length > 0 && (
            <ul className="data-list stack-top-sm">
              {run.verification.reasons.map((reason, i) => (
                <li key={i} className="data-list__item">
                  <span className="data-list__bullet" />
                  <span className="data-list__text">{reason}</span>
                </li>
              ))}
            </ul>
          )}
          {run.verification.missing.length > 0 && (
            <>
              <div className="plan__heading stack-top-md">
                仍未补齐的证据（{run.verification.missing.length}）
              </div>
              <p className="hint note-line">
                {run.status === 'completed'
                  ? '这些点一直没有被证据覆盖，报告的相关结论会因此受限。'
                  : '这些点会被退回「研究检索」自动补搜，再重新分析、核对。'}
              </p>
              <ul className="data-list">
                {run.verification.missing.map((item, i) => (
                  <li key={i} className="data-list__item">
                    <span className="data-list__bullet" />
                    <span className="data-list__text">{item}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}

      {run.tool_calls.length > 0 && (
        <CollapsibleCard title="工具调用" badge={<span className="hint">{run.tool_calls.length} 次</span>}>
          <div className="data-list data-list--gap">
            {run.tool_calls.map((call, index) => (
              <ToolCallCard key={index} call={call} />
            ))}
          </div>
        </CollapsibleCard>
      )}

      {run.report && (
        <CollapsibleCard title="研究报告" defaultOpen>
          <article className="report">
            <div className="report-panel__head">
              <h4 className="report__title">{run.report.title}</h4>
              {/* [B28] 报告可带走：PDF / Word / Markdown */}
              <DownloadReportButton
                report={run.report}
                meta={{ question: run.question, sources: collectSources(run) }}
              />
            </div>
            <div className="report__summary">
              <Markdown>{run.report.summary}</Markdown>
            </div>
            {run.report.sections.map((section) => (
              <div key={section.heading} className="report__section">
                <h5>{section.heading}</h5>
                <Markdown>{section.content}</Markdown>
              </div>
            ))}
            {run.report.limitations.length > 0 && (
              <div className="report__limitations">
                <strong>局限</strong>
                <Markdown>{run.report.limitations.map((item, i) => `${i + 1}. ${item}`).join('\n')}</Markdown>
              </div>
            )}
          </article>
        </CollapsibleCard>
      )}

      {run.citations.length > 0 && (
        <CollapsibleCard title="引用来源" badge={<span className="hint">{run.citations.length} 条</span>}>
          <div className="data-list data-list--gap">
            {run.citations.map((citation) => (
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
    </div>
  )
}

function getCurrentNode(steps: RunStep[]): string | null {
  if (steps.length === 0) return null
  return steps[steps.length - 1].node
}

function ProgressTrack({
  executed,
  activeNode,
  maxIterations,
}: {
  executed: Map<string, number>
  activeNode: string | null
  /**
   * [T04 预留] 启动期快照的轮数。**当前刻意未消费**，见下方注释。
   * ⚠️ 不要在 T01 闸门（后端 `current_step` / `estimated_total_steps` 落位）通过前消费它。
   */
  maxIterations: number
}) {
  // [T04 预留] 这里本该有 `computeRunFill(len(run.steps), maxIterations)` 来计算进度条宽度。
  // ⚠️ 刻意不接：分母 `maxIterations` 已就绪（P1 已根治），但**分子还没就绪**——
  //    后端 `current_step` / `estimated_total_steps` 尚未落位（T01 闸门未过，已 grep 确认零命中）。
  //    此刻若接上，分子会被迫用 `len(run.steps)`，而那是**另一种单位**（累计重跑步数，
  //    含 research 自环与 verify 回炉的重复计数），与 `current_step`（阶段序号 1..7）不可比。
  //    这正是 [IC-1 单位混用]，也是 §12.2b「顺手关掉别人」的温床。
  // 闸门通过后的改动清单（T04）另行下发；此处只留参数与这条说明，不预埋半成品算式。
  void maxIterations

  const lastDoneIndex = NODE_LABELS.reduce((last, node, index) => {
    return executed.has(node.key) ? index : last
  }, -1)

  return (
    <div className="progress-track">
      {NODE_LABELS.map((node, index) => {
        const count = executed.get(node.key) ?? 0
        const isDone = count > 0 || index < lastDoneIndex
        const isActive = activeNode === node.key
        const cls = isActive ? 'progress-node--active' : isDone ? 'progress-node--done' : ''
        return (
          <span key={node.key} className={`progress-node ${cls}`.trim()}>
            <span className="progress-node__no">{index + 1}</span>
            {node.label}
            {count > 1 ? ` ×${count}` : ''}
          </span>
        )
      })}
    </div>
  )
}

import { apiDelete, apiGet, apiPost } from './client'
import type { ResearchRun, ResearchRunSummary } from '../types/graph'

export interface StartResearchInput {
  question: string
  maxIterations?: number
  maxVerifyAttempts?: number
  threadId?: string
}

export function startResearch(input: StartResearchInput): Promise<ResearchRun> {
  return apiPost<ResearchRun>('/api/graph/research', {
    question: input.question,
    max_iterations: input.maxIterations ?? 3,
    max_verify_attempts: input.maxVerifyAttempts ?? 2,
    thread_id: input.threadId,
  })
}

export function resumeResearch(
  threadId: string,
  approved: boolean,
  feedback?: string,
): Promise<ResearchRun> {
  return apiPost<ResearchRun>(`/api/graph/research/${threadId}/resume`, {
    approved,
    feedback: feedback || null,
  })
}

export function getResearch(threadId: string): Promise<ResearchRun> {
  return apiGet<ResearchRun>(`/api/graph/research/${threadId}`)
}

export function listRuns(
  status?: ResearchRunSummary['status'],
  limit?: number,
): Promise<ResearchRunSummary[]> {
  // [F6] 后端 limit 现在可传（默认 50）。「效果评估」页要统计全量，
  // 之前只能拿到写死的 20 条，"总运行次数"这类指标是失真的。
  const params = new URLSearchParams()
  if (status) params.set('status', status)
  if (limit) params.set('limit', String(limit))
  const qs = params.toString() ? `?${params.toString()}` : ''
  return apiGet<ResearchRunSummary[]>(`/api/graph/runs${qs}`)
}

export function getSettings(): Promise<Record<string, unknown>> {
  return apiGet<Record<string, unknown>>('/api/settings')
}

/** 今日深度研究额度快照（GET /api/settings/run-budget）。 */
export interface RunBudgetSnapshot {
  /** 每日预算是否启用（关闭时其余数值全为 0） */
  enabled: boolean
  /** 每位访客每天的运行次数上限 */
  limit: number
  /** 当前访客今日已用次数 */
  used: number
  /** 当前访客今日剩余次数 */
  remaining: number
  /** 额度重置时刻（epoch 毫秒），由前端渲染成本地时间 */
  reset_at_ms: number
}

/**
 * 今日额度：把后端「每日运行预算」的拦截变成用户可见的额度。
 * 调用方约定：失败时静默降级（额度提示属锦上添花，不该打断主流程）。
 */
export function getRunBudget(): Promise<RunBudgetSnapshot> {
  return apiGet<RunBudgetSnapshot>('/api/settings/run-budget')
}

/** 删除一条历史运行（后端会连同事件一起删） */
export function deleteRun(threadId: string): Promise<{ deleted: boolean; thread_id: string }> {
  return apiDelete(`/api/graph/runs/${threadId}`)
}

/** 清空全部历史运行 */
export function clearRuns(): Promise<{ runs_deleted: number; events_deleted: number }> {
  return apiDelete('/api/graph/runs')
}

import { apiDelete, apiGet, apiPost } from './client'
import type { AgentRunRecord, AgentRunResult, AgentRunSummary } from '../types/agent'

export interface RunAgentInput {
  question: string
  maxSteps?: number
}

/** 运行一次最小 Agent 循环，返回答案 + 完整工具调用轨迹 */
export function runAgent(input: RunAgentInput): Promise<AgentRunResult> {
  return apiPost<AgentRunResult>('/api/agent/run', {
    question: input.question,
    max_steps: input.maxSteps ?? 6,
  })
}

/**
 * [B39] 历史运行 —— 用户之前问过的问题。
 *
 * 与研究规划 / 深度研究的历史对齐：成功跑过的运行会自动落库，可回看、可删除。
 */
export function listAgentRuns(limit = 20): Promise<AgentRunSummary[]> {
  return apiGet<AgentRunSummary[]>(`/api/agent/runs?limit=${limit}`)
}

/** 取一条历史运行的完整结果（含当时给出的答案与执行轨迹） */
export function getAgentRun(recordId: string): Promise<AgentRunRecord> {
  return apiGet<AgentRunRecord>(`/api/agent/runs/${recordId}`)
}

export function deleteAgentRun(recordId: string): Promise<{ deleted: boolean }> {
  return apiDelete<{ deleted: boolean }>(`/api/agent/runs/${recordId}`)
}

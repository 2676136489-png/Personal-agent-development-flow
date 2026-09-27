/** 与后端 app/agent/schemas.py 对应的前端类型。 */
import type { Citation } from './knowledge'

export interface ToolCallRecord {
  index: number
  tool: string
  args: Record<string, unknown>
  ok: boolean
  error: string | null
  error_kind: string | null
  output_preview: string
  duration_ms: number
}

export interface AgentStepRecord {
  index: number
  reason: string | null
  tool_call: ToolCallRecord | null
  final_answer: string | null
}

export interface AgentRunResult {
  question: string
  answer: string
  steps: AgentStepRecord[]
  tool_calls: ToolCallRecord[]
  finished_reason: string
  citations: Citation[]
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number }
  latency_ms: number
  mock: boolean
}

/**
 * [B39] 历史记录列表项 —— 只是**摘要**。
 *
 * 后端刻意不在列表里返回完整轨迹：一次运行的 steps + tool_calls 可达数十 KB，
 * 列表只负责「让用户认得出是哪一次」，内容按 id 单独取。
 */
export interface AgentRunSummary {
  id: string
  question: string
  finished_reason: string
  provider: string
  model: string
  mock: boolean
  latency_ms: number
  created_at: string
}

/** 一条历史记录的完整内容（含当时的答案与轨迹）。 */
export interface AgentRunRecord {
  id: string
  question: string
  result: AgentRunResult | null
  created_at: string
}

/** 与后端 app/schemas/graph.py + app/graph/schemas.py 对应。 */
import type { Citation } from './knowledge'
import type { ResearchPlan } from './research'

export type RunStatus =
  | 'running'
  | 'awaiting_approval'
  | 'completed'
  | 'cancelled'
  | 'failed'
  /** 服务进程重启后内存中断点丢失，无法继续；需要重新发起 */
  | 'interrupted'

export interface TaskUnderstanding {
  goal: string
  key_questions: string[]
  scope: string
}

export interface AnalysisResult {
  findings: string[]
  gaps: string[]
}

export interface VerificationResult {
  verdict: string
  reasons: string[]
  missing: string[]
}

export interface ReportSection {
  heading: string
  content: string
}

export interface ResearchReport {
  title: string
  summary: string
  sections: ReportSection[]
  limitations: string[]
}

export interface RunStep {
  node: string
  summary: string
  /** verify 节点专有：pass = 通过；needs_more = 判定证据不足、回炉补研究 */
  verdict?: string
}

/** 后端解析好的一条依据来源（app/graph/sources.py）。前端只渲染，不解析。 */
export interface RunSource {
  /** web = 联网搜索；knowledge = 知识库文档 */
  origin: 'web' | 'knowledge'
  title: string
  /** 知识库来源没有 URL，为空字符串 */
  url: string
  snippet: string
  /** 附加说明：检索源 / 页码+片段+相关度 */
  source?: string | null
}

export interface ResearchRun {
  thread_id: string
  status: RunStatus
  question: string
  understanding: TaskUnderstanding | null
  plan: ResearchPlan | null
  analysis: AnalysisResult | null
  verification: VerificationResult | null
  report: ResearchReport | null
  steps: RunStep[]
  tool_calls: {
    tool: string
    args: Record<string, unknown>
    ok: boolean
    error: string | null
    error_kind: string | null
    duration_ms: number
  }[]
  citations: Citation[]
  /** 依据来源（后端结构化产出，可能为空数组） */
  sources: RunSource[]
  evidence_count: number
  iteration: number
  verify_attempts: number
  usage_total_tokens: number
  error: string | null
  finished_reason: string
}

/** GET /api/graph/runs 返回的轻量摘要（不含完整 state） */
export interface ResearchRunSummary {
  id: string
  thread_id: string
  question: string
  status: RunStatus
  created_at: string
  updated_at: string
  /** 墙钟耗时（毫秒），用于效果评估的耗时分布 */
  duration_ms: number
  /** 本次运行所有 LLM 调用的 token 总数 */
  usage_total_tokens: number
  iteration: number
  verify_attempts: number
  error: string | null
  finished_reason: string
}

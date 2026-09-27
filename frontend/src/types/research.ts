/** 与后端 app/schemas/research.py 一一对应的前端类型。 */

export interface PlanStep {
  index: number
  title: string
  instruction: string
}

export interface ResearchPlan {
  goal: string
  questions: string[]
  steps: PlanStep[]
  expected_sources: string[]
}

export interface TokenUsage {
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
}

export interface PlanResponse {
  plan: ResearchPlan
  model: string
  provider: string
  /** true 表示这是离线假数据，不是真实模型输出 */
  mock: boolean
  usage: TokenUsage
  latency_ms: number
  /** 落库后的记录 id（历史规划列表用）；落库失败时为空 */
  plan_id?: string | null
}

/** 历史规划记录（GET /api/research/plans 的条目） */
export interface PlanRecord {
  id: string
  question: string
  plan: ResearchPlan
  model: string
  provider: string
  mock: boolean
  usage: TokenUsage
  latency_ms: number
  created_at: string
}

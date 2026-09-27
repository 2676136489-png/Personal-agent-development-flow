import { apiDelete, apiGet, apiPost } from './client'
import type { PlanRecord, PlanResponse } from '../types/research'

export interface CreatePlanInput {
  question: string
  maxSteps?: number
}

/** 提交研究问题，后端调用 LLM 返回结构化研究计划 */
export function createResearchPlan(input: CreatePlanInput): Promise<PlanResponse> {
  return apiPost<PlanResponse>('/api/research/plan', {
    question: input.question,
    max_steps: input.maxSteps ?? 6,
  })
}

/** 历史研究计划列表（每次成功生成的计划都会落库） */
export function listPlans(limit = 20): Promise<PlanRecord[]> {
  return apiGet<PlanRecord[]>(`/api/research/plans?limit=${limit}`)
}

/** 删除一条历史研究计划 */
export function deletePlan(planId: string): Promise<{ deleted: boolean; plan_id: string }> {
  return apiDelete(`/api/research/plans/${planId}`)
}

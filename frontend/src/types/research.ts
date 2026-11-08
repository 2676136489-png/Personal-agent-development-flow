/** 与后端 app/schemas/research.py 一一对应的前端类型。
 *  这里只留研究工作流真正用到的两份；规划页下线后，历史规划记录的类型也一起删了。 */

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

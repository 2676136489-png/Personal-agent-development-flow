/**
 * 「一键带入」跨页传递：研究规划页把生成的计划组装成研究任务文本，
 * 写入 sessionStorage 后跳转到深度研究页；深度研究页挂载时读出并预填输入框。
 *
 * 与 currentRun.ts 的 LAST_THREAD_KEY 同一套防御约定：
 * sessionStorage 在隐私模式可能不可用 → 读写失败一律静默忽略，绝不影响主流程。
 */
const PREFILL_QUESTION_KEY = 'arw-prefill-question'

export function writePrefillQuestion(text: string): boolean {
  try {
    sessionStorage.setItem(PREFILL_QUESTION_KEY, text)
    return true
  } catch {
    return false
  }
}

/** 读取并立即清除 —— 一次性消费，避免刷新页面后旧内容又冒回输入框 */
export function takePrefillQuestion(): string | null {
  try {
    const value = sessionStorage.getItem(PREFILL_QUESTION_KEY)
    if (value) sessionStorage.removeItem(PREFILL_QUESTION_KEY)
    return value
  } catch {
    return null
  }
}

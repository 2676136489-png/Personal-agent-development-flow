/**
 * 时间展示工具。
 *
 * 为什么单独抽出来：`formatRelativeTime` 曾在 ResearchPlanner / Reports /
 * RunHistory 里各写了一份**完全相同**的实现。历史列表本来就会越来越多
 * （深度研究、研究规划、智能体工作台…），再复制第四份只会让「改一处、
 * 漏两处」变成必然。
 */

/** ISO 时间 → 「刚刚 / 3 分钟前 / 2 小时前 / 5 天前 / 2026/9/1」 */
export function formatRelativeTime(iso: string): string {
  const d = new Date(iso)
  const now = new Date()
  const diff = Math.max(0, Math.floor((now.getTime() - d.getTime()) / 1000))
  if (diff < 60) return '刚刚'
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`
  if (diff < 604800) return `${Math.floor(diff / 86400)} 天前`
  return d.toLocaleDateString()
}

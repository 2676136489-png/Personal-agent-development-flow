/**
 * Stepper —— 任务执行步骤条。
 *
 * 为什么要它：研究流水线是「理解 → 计划 → 研究 → 检索 → 分析 → 验证 → 报告」七步，
 * 且中间会循环（验证不过要回炉重跑）。纯文字日志看不出「现在在第几步、
 * 前面几步过了、还剩几步」，步骤条把这件事变成一眼可读的图形。
 *
 * 状态语义：
 *   done    已完成（可能重复执行过，用 `count` 标 ×N）
 *   active  正在执行（呼吸动画 + 朱红实心）
 *   error   该步失败 / 需要人工介入
 *   pending 还没轮到（虚位以待，让用户知道后面还有几步）
 */

export type StepStatus = 'done' | 'active' | 'error' | 'pending'

export interface StepItem {
  key: string
  label: string
  status: StepStatus
  /** 该步被执行的次数（>1 时显示 ×N，对应研究循环 / 验证回炉） */
  count?: number
}

interface StepperProps {
  items: StepItem[]
  /** 当前步骤的一句话说明，显示在步骤条下方 */
  caption?: string
  /** caption 左侧的状态点文案，如「运行中」 */
  captionBadge?: string
}

/** 连接线的填充比例：已完成 = 满，进行中 = 半，未开始 = 0 */
const FILL: Record<StepStatus, number> = {
  done: 1,
  active: 0.5,
  error: 1,
  pending: 0,
}

const STATUS_TEXT: Record<StepStatus, string> = {
  done: '已完成',
  active: '进行中',
  error: '需处理',
  pending: '待执行',
}

export function Stepper({ items, caption, captionBadge }: StepperProps) {
  const activeIndex = items.findIndex((item) => item.status === 'active')
  const doneCount = items.filter((item) => item.status === 'done').length

  return (
    <div>
      <ol className="stepper" aria-label="任务执行步骤">
        {items.map((item, index) => (
          <li
            key={item.key}
            className={`stepper__item stepper__item--${item.status}`}
            style={{ ['--fill' as string]: FILL[item.status] }}
            aria-current={item.status === 'active' ? 'step' : undefined}
          >
            <span className="stepper__dot" aria-hidden="true">
              {item.status === 'done' ? '✓' : item.status === 'error' ? '!' : index + 1}
            </span>
            <span className="stepper__label">{item.label}</span>
            <span className="stepper__count">
              {item.count && item.count > 1 ? `×${item.count}` : STATUS_TEXT[item.status]}
            </span>
          </li>
        ))}
      </ol>

      {caption && (
        <p className="stepper-caption">
          <span className="eyebrow eyebrow--flush">
            {captionBadge ?? (activeIndex >= 0 ? `第 ${activeIndex + 1} 步` : `${doneCount}/${items.length}`)}
          </span>
          <span>{caption}</span>
        </p>
      )}
    </div>
  )
}

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
 *   rework  执行过但判定未通过、等回炉重验（虚线青圈 + 「待重验」，不打勾）
 *   error   该步失败 / 需要人工介入
 *   pending 还没轮到（虚位以待，让用户知道后面还有几步）
 */

export type StepStatus = 'done' | 'active' | 'rework' | 'error' | 'pending'

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

/** 连接线的填充比例：已完成 = 满，进行中/待重验 = 半（回炉在路上），未开始 = 0 */
const FILL: Record<StepStatus, number> = {
  done: 1,
  active: 0.5,
  rework: 0.5,
  error: 1,
  pending: 0,
}

const STATUS_TEXT: Record<StepStatus, string> = {
  done: '已完成',
  active: '进行中',
  rework: '待重验',
  error: '需处理',
  pending: '待执行',
}

export function Stepper({ items, caption, captionBadge }: StepperProps) {
  const activeIndex = items.findIndex((item) => item.status === 'active')
  const doneCount = items.filter((item) => item.status === 'done').length

  // 回炉有向边：待重验节点（核对验证）→ 当前节点（研究检索）。
  // 底部的文字说明解释了「为什么回炉」，这条弧线解释「回到哪」——
  // 逆向跳转只在文字里说，用户扫一眼步骤条仍然以为流程是纯线性的。
  const reworkIndex = items.findIndex((item) => item.status === 'rework')
  const showArc = reworkIndex > activeIndex && activeIndex >= 0
  const n = items.length
  // 每个节点圆点在自己的格子水平中心：left = (i + 0.5) / n
  const arcLeft = ((activeIndex + 0.5) / n) * 100
  const arcWidth = ((reworkIndex - activeIndex) / n) * 100

  return (
    <div>
      {/* ol 的合法子元素只有 li，弧线作为绝对定位覆盖层放在外层容器上 */}
      <div className="stepper-wrap">
        {showArc && (
          <div
            className="stepper__rework-arc"
            style={{ left: `${arcLeft}%`, width: `${arcWidth}%` }}
            aria-hidden="true"
          >
            <span className="stepper__rework-arc-label">回炉补充研究</span>
          </div>
        )}
        <ol className={`stepper${showArc ? ' stepper--rework' : ''}`} aria-label="任务执行步骤">
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
      </div>

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

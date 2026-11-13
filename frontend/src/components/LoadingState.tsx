/**
 * LoadingState —— 全站统一「加载态」：三环旋转（改编自 Uiverse.io, MIT）。
 *
 * 视觉决策：局部加载大多只有几百毫秒到两秒，一块带进度叙事的面板反而
 * 喧宾夺主；三环 1s/2s/3s 异速旋转体量小、纯 border + transform 无 rAF
 * 开销，环色走 --accent 与全站电光蓝同源。组件见 TripleRingSpinner.tsx，
 * 样式见 styles/loading.css。
 *
 * 占位高度仍按 variant / rows 计算，让加载态高度逼近真实内容高度，
 * 内容到达时的布局跳动（CLS）最小。
 *
 * 兼容性说明：保留原类名（.state-loading / .state-loading__label）——
 * smoke-render 与 qa 探针对这些类名有源码与运行时断言，换动画不动接口。
 * 无障碍：role="status" / aria-live / aria-busy 保留；spinner 是装饰
 * （aria-hidden），真实信息走 aria-label 与可见的中文 label。
 */
import { TripleRingSpinner } from './TripleRingSpinner'

type LoadingVariant = 'card' | 'list' | 'table' | 'inline'

/** 各变体的默认占位行数 */
const DEFAULT_ROWS: Record<LoadingVariant, number> = {
  card: 3,
  list: 4,
  table: 5,
  inline: 1,
}

interface LoadingStateProps {
  /** 形态，决定占位块高度；默认 card */
  variant?: LoadingVariant
  /** 行数参与占位高度计算 */
  rows?: number
  /** 加载文案（屏幕阅读器与视觉同时可见） */
  label?: string
}

/** 各变体占位高度：行数越多占位越高 */
function blockHeight(variant: Exclude<LoadingVariant, 'inline'>, rows?: number): number {
  const n = Math.max(1, Math.floor(rows ?? DEFAULT_ROWS[variant]))
  if (variant === 'card') return 128 + Math.max(0, n - 3) * 24
  if (variant === 'list') return 120 + n * 34
  return 96 + n * 30
}

export function LoadingState({ variant = 'card', rows, label }: LoadingStateProps) {
  const text = label ?? '加载中'

  if (variant === 'inline') {
    return (
      <span
        className="state state-loading state-loading--inline"
        role="status"
        aria-live="polite"
        aria-busy="true"
        aria-label={text}
      >
        <TripleRingSpinner size={22} />
        <span className="state-loading__label">{text}</span>
      </span>
    )
  }

  return (
    <div
      className={`state state-loading state-loading--${variant}`}
      role="status"
      aria-live="polite"
      aria-busy="true"
      aria-label={text}
    >
      <div className="loading-block" style={{ height: blockHeight(variant, rows) }}>
        <TripleRingSpinner size={56} />
        <span className="state-loading__label">{text}</span>
      </div>
    </div>
  )
}

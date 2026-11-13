/**
 * TripleRingSpinner —— 全站统一加载动画：三环同轴异速旋转。
 *
 * 改编自 Uiverse.io（MIT License, Copyright (c) 2023），
 * Component by AqFox: https://uiverse.io/AqFox/little-skunk-97
 *
 * 原组件把 #004dff 硬编码在 CSS 里，这里改走全站令牌（--accent /
 * --loading-stage-ring），浅深两套主题都成立。三环 1s/2s/3s 异速旋转，
 * 「转速差」比单环多一层机械感，贴合全站数据终端的语言。
 *
 * 实现：纯 border + transform，无 rAF、无 JS 驱动，挂载多少个都不费电。
 * prefers-reduced-motion：停止旋转，只做透明度呼吸，明确「仍在工作」。
 */
import type { CSSProperties } from 'react'

export function TripleRingSpinner({
  size = 56,
  className = '',
}: {
  /** 外环直径（px）；环宽随直径按比例缩放 */
  size?: number
  className?: string
}) {
  return (
    <span
      className={`triple-ring${className ? ` ${className}` : ''}`}
      style={{ '--ring-size': `${size}px` } as CSSProperties}
      aria-hidden="true"
    />
  )
}

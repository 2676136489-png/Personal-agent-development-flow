import { m, useReducedMotion } from 'motion/react'
import type { ReactNode } from 'react'

/**
 * 交错入场（stagger）容器与子项。
 *
 * iGEM 那类获奖 wiki 的"高级感"很大一部分来自：**一组元素不是同时出现，
 * 而是依次醒来**。这里把它做成可复用的一对组件，页面上任何列表/卡片组
 * 都能一行套上。
 *
 * 用法：
 *   <Stagger>
 *     <StaggerItem>…</StaggerItem>
 *     <StaggerItem>…</StaggerItem>
 *   </Stagger>
 */
const CONTAINER = {
  hidden: {},
  show: {
    transition: { staggerChildren: 0.08, delayChildren: 0.04 },
  },
}

const ITEM = {
  hidden: { opacity: 0, y: 16 },
  show: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.45, ease: [0.16, 1, 0.3, 1] as const },
  },
}

export function Stagger({
  children,
  className,
  as = 'div',
}: {
  children: ReactNode
  className?: string
  as?: 'div' | 'section'
}) {
  const reduced = useReducedMotion()
  if (reduced) {
    const Plain = as as 'div' | 'section'
    return <Plain className={className}>{children}</Plain>
  }
  // 非 reduced：用 motion 版本做交错入场
  const MotionTag = as === 'section' ? m.section : m.div
  return (
    <MotionTag className={className} variants={CONTAINER} initial="hidden" animate="show">
      {children}
    </MotionTag>
  )
}

export function StaggerItem({
  children,
  className,
}: {
  children: ReactNode
  className?: string
}) {
  const reduced = useReducedMotion()
  if (reduced) return <div className={className}>{children}</div>
  return (
    <m.div className={className} variants={ITEM}>
      {children}
    </m.div>
  )
}

/**
 * 滚动触发揭示：进入视口时淡入上移，只触发一次。
 * 这是旧 `Reveal` 组件的 motion 版本 —— 行为一致，但交给了统一动画引擎，
 * 不再单独维护一套 IntersectionObserver。
 */
export function RevealOnScroll({
  children,
  className,
  delay = 0,
}: {
  children: ReactNode
  className?: string
  delay?: number
}) {
  const reduced = useReducedMotion()
  if (reduced) return <div className={className}>{children}</div>
  return (
    <m.div
      className={className}
      initial={{ opacity: 0, y: 20 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '0px 0px -8% 0px' }}
      transition={{ duration: 0.55, delay, ease: [0.16, 1, 0.3, 1] }}
    >
      {children}
    </m.div>
  )
}

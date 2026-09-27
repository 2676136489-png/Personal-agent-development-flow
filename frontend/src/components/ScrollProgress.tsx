import { m, useReducedMotion, useScroll, useSpring } from 'motion/react'

/**
 * 顶部滚动进度条（长文档阅读的位置感）。
 *
 * 为什么需要：报告 / 教程这类页面可以滚很久，没有进度指示时
 * 用户不知道「还剩多少、我在哪」。这是文档型站点（iGEM wiki 亦然）
 * 最廉价也最有效的导航辅助。
 *
 * 实现要点：
 * - `useScroll` 读的是**整页**滚动进度（0→1），不是某个容器
 * - `useSpring` 做一点阻尼，避免滚动时进度条抖得生硬
 * - `useReducedMotion` 为 true 时直接不渲染（降级）
 */
export function ScrollProgress() {
  const { scrollYProgress } = useScroll()
  const reduced = useReducedMotion()
  const scaleX = useSpring(scrollYProgress, {
    stiffness: 220,
    damping: 40,
    restDelta: 0.001,
  })

  if (reduced) return null

  return (
    <m.div
      className="scroll-progress"
      style={{ scaleX }}
      aria-hidden="true"
    />
  )
}

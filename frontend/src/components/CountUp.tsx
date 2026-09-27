import { useEffect, useRef, useState } from 'react'
import { animate, useInView, useReducedMotion } from 'motion/react'

/**
 * 数字滚动计数（count-up）。
 *
 * iGEM 获奖 wiki 的「高级感」里很常见的一招：关键指标不是冷冰冰地杵在那，
 * 而是从 0 滚到目标值，配合缓动，给「这个产品在生长」的暗示。
 *
 * 触发：进入视口才开数（首屏的 hero 一挂载就在视口里，立即开数）；
 * 尊重 prefers-reduced-motion —— 开了就直接显示终值，不滚动。
 */
export function CountUp({
  value,
  duration = 1.2,
  decimals = 0,
}: {
  value: number
  duration?: number
  decimals?: number
}) {
  const ref = useRef<HTMLSpanElement>(null)
  const reduced = useReducedMotion()
  const inView = useInView(ref, { once: true, margin: '0px 0px -10% 0px' })
  const [display, setDisplay] = useState(reduced ? value : 0)

  useEffect(() => {
    if (!inView) return
    if (reduced) {
      setDisplay(value)
      return
    }
    const controls = animate(0, value, {
      duration,
      ease: [0.16, 1, 0.3, 1],
      onUpdate: (latest) => setDisplay(latest),
    })
    return () => controls.stop()
  }, [inView, reduced, value, duration])

  const text = decimals > 0 ? display.toFixed(decimals) : Math.round(display).toString()
  return (
    <span ref={ref} aria-label={value.toString()}>
      {text}
    </span>
  )
}

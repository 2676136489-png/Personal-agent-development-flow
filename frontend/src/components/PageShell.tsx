import { m, useReducedMotion } from 'motion/react'
import type { ReactNode } from 'react'

/**
 * 页面容器：统一的入场 / 离场动画。
 *
 * 为什么不直接在 App 里写 motion.div：切页动画要跟 `AnimatePresence`
 配对，而"动画参数"和"降级策略"应该只有一处定义。
 *
 * 降级：`prefers-reduced-motion` 下不做位移，只保留极短的淡入（甚至不淡入），
 * 避免给前庭敏感用户造成不适。
 */
export function PageShell({ children }: { children: ReactNode }) {
  const reduced = useReducedMotion()

  if (reduced) {
    return <div className="page-swap">{children}</div>
  }

  return (
    <m.div
      className="page-swap"
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -6 }}
      transition={{
        duration: 0.32,
        // 出场缓动：快起慢收，跟 redesign.css 的 --ease-out-expo 一致
        ease: [0.16, 1, 0.3, 1],
      }}
    >
      {children}
    </m.div>
  )
}

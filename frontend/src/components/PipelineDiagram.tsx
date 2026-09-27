import { m, useReducedMotion } from 'motion/react'

/**
 * 自绘 SVG 研究流水线（hero 视觉）。
 *
 * 参考 iGEM Best Wiki 里常见的一招：流程图不是一张静态贴图，而是**自己画出来**的 ——
 * 连线像被笔一笔描出来，节点依次点亮，循环那段再补一个回环箭头。
 * 全部用 motion 的 SVG pathLength / scale 动画实现，零额外依赖。
 *
 * 7 个节点对应 FlowOverview 的真实阶段；决策 ⇄ 检索 之间画一个回环，
 * 把「会反复检索直到证据足够」这件事直接画进图里。
 */
const NODES = [
  { label: '理解', sub: '任务' },
  { label: '计划', sub: '拆解' },
  { label: '决策', sub: '下一步' },
  { label: '检索', sub: '取证' },
  { label: '分析', sub: '归纳' },
  { label: '验证', sub: '核对' },
  { label: '报告', sub: '产出' },
] as const

const W = 760
const H = 132
const Y = 72
const MARGIN = 58
const STEP = (W - MARGIN * 2) / (NODES.length - 1)
const xAt = (i: number) => MARGIN + i * STEP

export function PipelineDiagram() {
  const reduced = useReducedMotion()
  // 进入动画的总时长；节点按位置错峰点亮
  const DRAW = 1.8

  return (
    <svg
      className="pipeline"
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      aria-label="研究流水线：理解 → 计划 → 决策 ⇄ 检索 → 分析 → 验证 → 报告"
      preserveAspectRatio="xMidYMid meet"
    >
      <defs>
        <marker
          id="pipeline-arrow"
          viewBox="0 0 10 10"
          refX="8"
          refY="5"
          markerWidth="6"
          markerHeight="6"
          orient="auto-start-reverse"
        >
          <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--accent)" />
        </marker>
      </defs>

      {/* 底线：永远在，作为「轨道」 */}
      <line
        x1={xAt(0)}
        y1={Y}
        x2={xAt(NODES.length - 1)}
        y2={Y}
        className="pipeline__track"
      />

      {/* 动态描线：pathLength 0→1 */}
      <m.line
        x1={xAt(0)}
        y1={Y}
        x2={xAt(NODES.length - 1)}
        y2={Y}
        className="pipeline__line"
        initial={reduced ? { pathLength: 1 } : { pathLength: 0 }}
        animate={{ pathLength: 1 }}
        transition={{ duration: DRAW, ease: 'easeInOut' }}
      />

      {/* 决策 ⇄ 检索 的回环（迭代检索） */}
      <m.path
        d={`M ${xAt(3)} ${Y - 26} C ${xAt(3)} ${Y - 64}, ${xAt(2)} ${Y - 64}, ${xAt(2)} ${Y - 26}`}
        className="pipeline__loop"
        markerEnd="url(#pipeline-arrow)"
        fill="none"
        initial={reduced ? { pathLength: 1, opacity: 1 } : { pathLength: 0, opacity: 0 }}
        animate={{ pathLength: 1, opacity: 1 }}
        transition={{ duration: 0.9, delay: DRAW * 0.62, ease: 'easeInOut' }}
      />
      <text x={(xAt(2) + xAt(3)) / 2} y={Y - 70} className="pipeline__loop-label">
        循环补充证据
      </text>

      {/* 节点：依次点亮 */}
      {NODES.map((node, i) => {
        const cx = xAt(i)
        return (
          <m.g
            key={node.label}
            initial={reduced ? { opacity: 1, scale: 1 } : { opacity: 0, scale: 0.3 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{
              delay: reduced ? 0 : 0.15 + i * 0.22,
              type: 'spring',
              stiffness: 260,
              damping: 18,
            }}
            style={{ transformBox: 'fill-box', transformOrigin: 'center' }}
          >
            <circle cx={cx} cy={Y} r={22} className="pipeline__node" />
            <text x={cx} y={Y + 1} className="pipeline__node-no">
              {i + 1}
            </text>
            <text x={cx} y={Y + 40} className="pipeline__node-label">
              {node.label}
            </text>
            <text x={cx} y={Y + 53} className="pipeline__node-sub">
              {node.sub}
            </text>
          </m.g>
        )
      })}
    </svg>
  )
}

import { m, useInView, useReducedMotion } from 'motion/react'
import { useEffect, useRef, useState } from 'react'

/**
 * 自绘 SVG 研究流水线（首页首屏之下的主视觉）——按有向图来画，不是一条横线串到底。
 *
 * 真实的执行结构里有两个「不是直线」的地方：决策 ⇄ 检索 会循环（证据不够就
 * 再检索一轮），检索完才进入分析。所以布局用蛇形两行：上排 理解→计划→决策→检索，
 * 在右端拐下来，下排 分析→验证→报告 反向走。每条边都带箭头（有向、无权），
 * 回环单独走上方一条虚线 —— 「会反复检索」这件事在图上一眼可见。
 *
 * 动画是**一步一步点亮的**，不是一次全出现：滚到图进入视口后，从「理解」开始，
 * 每 430ms 推进一个节点 —— 先画出指向它的那条边，再让节点反白，走完 7 步后
 * 全部落回「已完成」的描边态。这样读者是跟着一条研究路径看下来的，
 * 而不是面对一张静态拓扑图自己找起点。
 *
 * 为什么用 step 状态而不是给每个元素写 delay：步骤之间要能被打断/重放，
 * 一个整数状态比十来个错峰 delay 更好推理，也方便 prefers-reduced-motion
 * 直接跳到终态。
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
const H = 218
const ROW1 = 70
const ROW2 = 182
const NODE_W = 96
const NODE_H = 36
const R = NODE_H / 2

/** 蛇形两行的节点坐标：上排从左到右 1-4，右端拐下，下排从右到左 5-7 */
const POS = [
  { x: 92, y: ROW1 },
  { x: 300, y: ROW1 },
  { x: 484, y: ROW1 },
  { x: 668, y: ROW1 },
  { x: 668, y: ROW2 },
  { x: 380, y: ROW2 },
  { x: 92, y: ROW2 },
] as const

/** 有向边（from → to）。节点的序号 = to + 1，边跟着目标节点一起出现。 */
const EDGES: { from: number; to: number }[] = [
  { from: 0, to: 1 },
  { from: 1, to: 2 },
  { from: 2, to: 3 },
  { from: 3, to: 4 },
  { from: 4, to: 5 },
  { from: 5, to: 6 },
]

const STEP_MS = 430
/** 7 个节点 + 1，走完后停在「全部完成」的终态 */
const FINAL_STEP = NODES.length + 1

function edgePath(from: number, to: number): string {
  const a = POS[from]
  const b = POS[to]
  if (a.y === b.y) {
    // 同一行的横向边：留出节点和箭头的位置
    const dir = b.x > a.x ? 1 : -1
    const x1 = a.x + dir * (NODE_W / 2 + 8)
    const x2 = b.x - dir * (NODE_W / 2 + 12)
    return `M ${x1} ${a.y} L ${x2} ${b.y}`
  }
  // 拐弯处的纵向边：从上排节点底边到下排节点顶边
  return `M ${a.x} ${a.y + R + 6} L ${b.x} ${b.y - R - 10}`
}

export function PipelineDiagram() {
  const ref = useRef<SVGSVGElement>(null)
  const reduced = useReducedMotion()
  const inView = useInView(ref, { once: true, amount: 0.35 })
  const [step, setStep] = useState(reduced ? FINAL_STEP : 0)

  useEffect(() => {
    if (!inView || reduced || step >= FINAL_STEP) return
    // 最后一个节点多留一会儿再收尾，否则「报告」刚亮就被抹平
    const timer = window.setTimeout(
      () => setStep((value) => value + 1),
      step === 0 ? 240 : step >= NODES.length ? 900 : STEP_MS,
    )
    return () => window.clearTimeout(timer)
  }, [inView, reduced, step])

  const loop = POS[3]
  const loopTarget = POS[2]
  const loopPath = `M ${loop.x} ${loop.y - R - 6} C ${loop.x} 18, ${loopTarget.x} 18, ${loopTarget.x} ${loopTarget.y - R - 6}`
  const loopDrawn = step > 3

  /** pending → 未轮到；active → 正在执行（反白）；done → 已走过（描边） */
  const stateOf = (index: number): 'pending' | 'active' | 'done' => {
    if (step === index + 1) return 'active'
    if (step > index + 1) return 'done'
    return 'pending'
  }

  return (
    <svg
      ref={ref}
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
          markerWidth="6.5"
          markerHeight="6.5"
          orient="auto-start-reverse"
        >
          <path d="M 0 0 L 10 5 L 0 10 z" fill="rgba(255,255,255,.75)" />
        </marker>
        <marker
          id="pipeline-arrow-loop"
          viewBox="0 0 10 10"
          refX="8"
          refY="5"
          markerWidth="6.5"
          markerHeight="6.5"
          orient="auto-start-reverse"
        >
          <path d="M 0 0 L 10 5 L 0 10 z" fill="rgba(255,255,255,.45)" />
        </marker>
      </defs>

      {EDGES.map((edge) => {
        const drawn = step > edge.to
        return (
          <m.path
            key={`edge-${edge.from}-${edge.to}`}
            d={edgePath(edge.from, edge.to)}
            className="pipeline__edge"
            fill="none"
            /* 未画出来时连箭头一起去掉：pathLength=0 只隐藏描边，
               末端 marker 仍会单独画出来，表现为一个没有线的孤立箭头 */
            markerEnd={drawn ? 'url(#pipeline-arrow)' : 'none'}
            initial={false}
            animate={{ pathLength: drawn ? 1 : 0, opacity: drawn ? 1 : 0 }}
            transition={{ duration: 0.34, ease: 'easeInOut' }}
          />
        )
      })}

      {/* 回环边：检索 → 决策，走上方虚线；检索一出现它就跟着出现 */}
      <m.path
        d={loopPath}
        className="pipeline__loop"
        fill="none"
        markerEnd={loopDrawn ? 'url(#pipeline-arrow-loop)' : 'none'}
        initial={false}
        animate={{ pathLength: loopDrawn ? 1 : 0, opacity: loopDrawn ? 1 : 0 }}
        transition={{ duration: 0.5, ease: 'easeInOut' }}
      />
      <m.text
        x={(loop.x + loopTarget.x) / 2}
        y={12}
        className="pipeline__loop-label"
        initial={false}
        animate={{ opacity: loopDrawn ? 1 : 0 }}
        transition={{ duration: 0.4, delay: loopDrawn ? 0.25 : 0 }}
      >
        循环补充证据
      </m.text>

      {NODES.map((node, i) => {
        const p = POS[i]
        const state = stateOf(i)
        return (
          <m.g
            key={node.label}
            data-state={state}
            className="pipeline__group"
            initial={false}
            animate={{ opacity: state === 'pending' ? 0.18 : 1, scale: state === 'pending' ? 0.94 : 1 }}
            transition={{ type: 'spring', stiffness: 280, damping: 22 }}
            style={{ transformBox: 'fill-box', transformOrigin: 'center' }}
          >
            <rect
              x={p.x - NODE_W / 2}
              y={p.y - NODE_H / 2}
              width={NODE_W}
              height={NODE_H}
              rx={R}
              className="pipeline__node"
            />
            <text x={p.x} y={p.y + 1} className="pipeline__node-label">
              {node.label}
              <tspan dx={7} className="pipeline__node-sub">
                {node.sub}
              </tspan>
            </text>
            <g className="pipeline__badge">
              <circle cx={p.x - NODE_W / 2 + 2} cy={p.y - NODE_H / 2} r={9} />
              <text x={p.x - NODE_W / 2 + 2} y={p.y - NODE_H / 2} className="pipeline__badge-no">
                {i + 1}
              </text>
            </g>
          </m.g>
        )
      })}
    </svg>
  )
}

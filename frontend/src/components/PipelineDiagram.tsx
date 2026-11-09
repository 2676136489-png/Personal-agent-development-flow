import { m, useReducedMotion } from 'motion/react'

/**
 * 自绘 SVG 研究流水线（hero 视觉）——按有向图来画，不是一条横线串到底。
 *
 * 真实的执行结构里有两个「不是直线」的地方：决策 ⇄ 检索 会循环（证据不够就
 * 再检索一轮），检索完才进入分析。所以布局用蛇形两行：上排 理解→计划→决策→检索，
 * 在右端拐下来，下排 分析→验证→报告 反向走。每条边都带箭头（有向、无权），
 * 回环单独走上方一条虚线 —— 「会反复检索」这件事在图上一眼可见。
 *
 * 全部用 motion 的 SVG pathLength / scale 动画实现，零额外依赖。
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
const NODE_W = 92
const NODE_H = 34
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

/** 有向边（from → to），delay 是描线动画的出场时刻，按拓扑顺序错峰 */
const EDGES: { from: number; to: number; delay: number; loop?: boolean }[] = [
  { from: 0, to: 1, delay: 0.2 },
  { from: 1, to: 2, delay: 0.55 },
  { from: 2, to: 3, delay: 0.9 },
  { from: 3, to: 2, delay: 1.3, loop: true },
  { from: 3, to: 4, delay: 1.7 },
  { from: 4, to: 5, delay: 2.05 },
  { from: 5, to: 6, delay: 2.4 },
]

const NODE_DELAY = [0.1, 0.5, 0.85, 1.2, 1.68, 2.03, 2.38]
const DRAW = 0.32

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
  const reduced = useReducedMotion()
  const loop = POS[3]
  const loopTarget = POS[2]
  const loopPath = `M ${loop.x} ${loop.y - R - 6} C ${loop.x} 18, ${loopTarget.x} 18, ${loopTarget.x} ${loopTarget.y - R - 6}`

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
          markerWidth="6.5"
          markerHeight="6.5"
          orient="auto-start-reverse"
        >
          <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--accent)" />
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
          <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--accent-2)" />
        </marker>
      </defs>

      {EDGES.map((edge) => {
        const common = {
          fill: 'none',
          markerEnd: edge.loop ? 'url(#pipeline-arrow-loop)' : 'url(#pipeline-arrow)',
          initial: reduced ? { pathLength: 1, opacity: 1 } : { pathLength: 0, opacity: edge.loop ? 0 : 1 },
          animate: { pathLength: 1, opacity: 1 },
          transition: { duration: edge.loop ? 0.5 : DRAW, delay: edge.delay, ease: 'easeInOut' as const },
        }
        return edge.loop ? (
          // 回环边：检索 → 决策，走上方虚线
          <m.path key={`loop-${edge.from}-${edge.to}`} d={loopPath} className="pipeline__loop" {...common} />
        ) : (
          <m.path key={`edge-${edge.from}-${edge.to}`} d={edgePath(edge.from, edge.to)} className="pipeline__edge" {...common} />
        )
      })}

      <text x={(loop.x + loopTarget.x) / 2} y={12} className="pipeline__loop-label">
        循环补充证据
      </text>

      {NODES.map((node, i) => {
        const p = POS[i]
        return (
          <m.g
            key={node.label}
            initial={reduced ? { opacity: 1, scale: 1 } : { opacity: 0, scale: 0.4 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{
              delay: reduced ? 0 : NODE_DELAY[i],
              type: 'spring',
              stiffness: 260,
              damping: 18,
            }}
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

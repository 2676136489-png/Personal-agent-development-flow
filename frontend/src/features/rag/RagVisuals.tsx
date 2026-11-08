/**
 * RAG 页的四个可视化：切块色带 / 向量热力图 / 向量空间散点 / 检索打分条。
 *
 * 为什么手写 SVG 与 CSS 而不是引图表库：
 * 这些图的坐标与配色都要跟设计令牌对齐，引一个库既要适配主题、又要为四个小图
 * 多加几十 KB 依赖；而它们本质都是「把比例映射成位置」，用 SVG 反而更直接。
 */

import { useMemo, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react'

import type { RagChunk, RagEmbedDetail, RagHit, RagOverlap, RagPoint } from '../../types/rag'

const SEGMENT_TONES = 6

/* ---------------------------------------------------------------- 切块色带 */

interface ChunkRulerProps {
  chunks: RagChunk[]
  overlaps: RagOverlap[]
  totalChars: number
  focus: number | null
  onFocus: (index: number | null) => void
}

/**
 * 一条按字符比例画出所有块位置的色带。
 *
 * 它能一眼回答两个问题：块大小是不是均匀、相邻块重叠了多少。
 * 重叠区单独用斜纹叠在色带上，比在文字里写「重叠 80 字」直观得多。
 */
export function ChunkRuler({ chunks, overlaps, totalChars, focus, onFocus }: ChunkRulerProps) {
  const total = totalChars || 1
  return (
    <div className="rag-ruler">
      {chunks.map((chunk) => {
        const start = chunk.char_start ?? 0
        const end = chunk.char_end ?? start + chunk.chars
        const left = Math.max(0, (start / total) * 100)
        const width = Math.max(0.4, ((end - start) / total) * 100)
        return (
          <button
            key={chunk.index}
            type="button"
            className={`rag-ruler__seg rag-seg--${chunk.index % SEGMENT_TONES}`}
            data-focus={focus === chunk.index ? 'true' : 'false'}
            style={{ left: `${left}%`, width: `${width}%` }}
            title={`#${chunk.index} · ${chunk.chars} 字 · ${chunk.char_start}–${chunk.char_end}`}
            onMouseEnter={() => onFocus(chunk.index)}
            onMouseLeave={() => onFocus(null)}
            onFocus={() => onFocus(chunk.index)}
            onBlur={() => onFocus(null)}
          >
            <span>{chunk.index}</span>
          </button>
        )
      })}
      {overlaps.map((overlap) => {
        const left = (overlap.start / total) * 100
        const width = Math.max(0.2, (overlap.chars / total) * 100)
        return (
          <span
            key={`${overlap.left}-${overlap.right}`}
            className="rag-ruler__overlap"
            style={{ left: `${left}%`, width: `${width}%` }}
            title={`块 #${overlap.left} 与 #${overlap.right} 重叠 ${overlap.chars} 字`}
          />
        )
      })}
    </div>
  )
}

/* -------------------------------------------------------------- 向量热力图 */

export function VectorHeatmap({ detail }: { detail: RagEmbedDetail }) {
  const { heatmap } = detail
  const cell = (value: number) => {
    const alpha = Math.min(1, Math.abs(value))
    // 正数用电光蓝、负数用青蓝：两端都是主题里的强调色，明暗主题下都能看清
    return value >= 0
      ? `rgba(37, 99, 235, ${0.06 + alpha * 0.9})`
      : `rgba(14, 116, 144, ${0.06 + alpha * 0.9})`
  }
  return (
    <div className="rag-heatmap-wrap">
      <div
        className="rag-heatmap"
        style={{ gridTemplateColumns: `repeat(${heatmap.cols}, minmax(0, 1fr))` }}
      >
        {heatmap.values.map((row, rowIndex) =>
          row.map((value, colIndex) => (
            <span
              key={`${rowIndex}-${colIndex}`}
              className="rag-heatmap__cell"
              style={{ background: cell(value) }}
              title={`块 #${rowIndex} · 第 ${colIndex} 维 = ${value}`}
            />
          )),
        )}
      </div>
      <p className="rag-figure__note rag-heatmap__note">
        每行一个块，取前 {heatmap.cols} 维（共 {detail.dims} 维，绝对值上限 {heatmap.scale}）。
        蓝 = 正值，青 = 负值，越深越远离 0。
        {heatmap.total_chunks > heatmap.rows && ` 只画了前 ${heatmap.rows} 块。`}
      </p>
    </div>
  )
}

/* ------------------------------------------------------------ 向量空间（3D） */

interface VectorScatterProps {
  points: RagPoint[]
  queryPoint: { x: number; y: number; z: number } | null
  selectedIndexes: number[]
  focus: number | null
  onFocus: (index: number | null) => void
  explained?: number[]
}

const VIEW_W = 440
const VIEW_H = 330
const CENTER_X = VIEW_W / 2
const CENTER_Y = VIEW_H / 2
/** 立方体半边长在屏幕上的像素基准；配合透视系数保证旋转到任何角度都不出框。 */
const RADIUS = 82
const CAMERA = 3.4
const PERSPECTIVE = 0.55
const DEFAULT_YAW = -0.62
const DEFAULT_PITCH = 0.36
const PITCH_LIMIT = 1.2

type Vec3 = { x: number; y: number; z: number }

interface ScreenPoint {
  sx: number
  sy: number
  k: number
  depth: number
}

/** 立方体的 8 个角与 12 条棱，用来画那个「空间框」。 */
const CUBE_CORNERS: Vec3[] = [
  { x: -1, y: -1, z: -1 },
  { x: 1, y: -1, z: -1 },
  { x: 1, y: 1, z: -1 },
  { x: -1, y: 1, z: -1 },
  { x: -1, y: -1, z: 1 },
  { x: 1, y: -1, z: 1 },
  { x: 1, y: 1, z: 1 },
  { x: -1, y: 1, z: 1 },
]
const CUBE_EDGES: [number, number][] = [
  [0, 1],
  [1, 2],
  [2, 3],
  [3, 0],
  [4, 5],
  [5, 6],
  [6, 7],
  [7, 4],
  [0, 4],
  [1, 5],
  [2, 6],
  [3, 7],
]

/** 先绕竖直轴转 yaw，再绕水平轴转 pitch —— 就是拖动时手上那个「转球」的感觉。 */
function rotatePoint(point: Vec3, yaw: number, pitch: number): Vec3 {
  const cosYaw = Math.cos(yaw)
  const sinYaw = Math.sin(yaw)
  const cosPitch = Math.cos(pitch)
  const sinPitch = Math.sin(pitch)
  const x = point.x * cosYaw + point.z * sinYaw
  const z = point.z * cosYaw - point.x * sinYaw
  return { x, y: point.y * cosPitch - z * sinPitch, z: point.y * sinPitch + z * cosPitch }
}

/** 弱透视投影：靠镜头的一侧稍微放大，纵深才看得出来；除得太狠会失真。 */
function toScreen(point: Vec3): ScreenPoint {
  const k = CAMERA / (CAMERA - point.z * PERSPECTIVE)
  return {
    sx: CENTER_X + point.x * RADIUS * k,
    sy: CENTER_Y - point.y * RADIUS * k,
    k,
    depth: point.z,
  }
}

/** 深度 → 不透明度：远处淡、近处实，转起来才有前后关系。 */
function depthOpacity(depth: number): number {
  const t = Math.max(0, Math.min(1, (depth + 1.2) / 2.4))
  return 0.34 + t * 0.62
}

const AXIS_ENDS: { vector: Vec3; label: string }[] = [
  { vector: { x: 1, y: 0, z: 0 }, label: 'PC1' },
  { vector: { x: 0, y: 1, z: 0 }, label: 'PC2' },
  { vector: { x: 0, y: 0, z: 1 }, label: 'PC3' },
]

/**
 * 块与问题在向量空间中的位置，可拖动旋转。
 *
 * 为什么值得画：余弦相似度是 2048 维里的事，数字看不出「为什么这条排第一」。
 * 降维到三个主成分之后，「问题点落在哪一簇块附近」是肉眼可判断的 —— 这正是
 * 向量检索在做的事。取三维而不是二维，是因为二维投影会把前后两块压到一起，
 * 拖一下才发现它们其实离得很远。
 */
export function VectorScatter({
  points,
  queryPoint,
  selectedIndexes,
  focus,
  onFocus,
  explained,
}: VectorScatterProps) {
  const [yaw, setYaw] = useState(DEFAULT_YAW)
  const [pitch, setPitch] = useState(DEFAULT_PITCH)
  const [dragging, setDragging] = useState(false)
  const dragRef = useRef<{ x: number; y: number; yaw: number; pitch: number } | null>(null)

  // 用全局最大绝对值做归一化：三个轴之间的比例保持不变（PC3 确实比 PC1 扁），
  // 同时所有点都落在立方体里，转到任何角度都不会跑出画面。
  const unit = useMemo(() => {
    let max = 0
    for (const point of points) {
      max = Math.max(max, Math.abs(point.x), Math.abs(point.y), Math.abs(point.z))
    }
    if (queryPoint) {
      max = Math.max(max, Math.abs(queryPoint.x), Math.abs(queryPoint.y), Math.abs(queryPoint.z))
    }
    return max > 0 ? 1 / (max * 1.06) : 1
  }, [points, queryPoint])

  const corners = useMemo(
    () => CUBE_CORNERS.map((corner) => toScreen(rotatePoint(corner, yaw, pitch))),
    [yaw, pitch],
  )

  const axes = useMemo(
    () =>
      AXIS_ENDS.map(({ vector, label }) => {
        const near = toScreen(rotatePoint({ x: -vector.x, y: -vector.y, z: -vector.z }, yaw, pitch))
        const far = toScreen(rotatePoint(vector, yaw, pitch))
        const tip = toScreen(
          rotatePoint({ x: vector.x * 1.16, y: vector.y * 1.16, z: vector.z * 1.16 }, yaw, pitch),
        )
        return { label, near, far, tip }
      }),
    [yaw, pitch],
  )

  const dots = useMemo(
    () =>
      points
        .map((point) => {
          const screen = toScreen(
            rotatePoint({ x: point.x * unit, y: point.y * unit, z: point.z * unit }, yaw, pitch),
          )
          return {
            point,
            screen,
            selected: selectedIndexes.includes(point.index),
            active: focus === point.index,
          }
        })
        // 先画远处的，后画近处的；命中块永远压在最后，免得被别的点盖住
        .sort((a, b) => {
          if (a.selected !== b.selected) return a.selected ? 1 : -1
          return a.screen.depth - b.screen.depth
        }),
    [points, unit, yaw, pitch, selectedIndexes, focus],
  )

  const query = queryPoint
    ? toScreen(rotatePoint({ x: queryPoint.x * unit, y: queryPoint.y * unit, z: queryPoint.z * unit }, yaw, pitch))
    : null

  const moved = Math.abs(yaw - DEFAULT_YAW) > 1e-3 || Math.abs(pitch - DEFAULT_PITCH) > 1e-3

  const reset = () => {
    setYaw(DEFAULT_YAW)
    setPitch(DEFAULT_PITCH)
  }

  const onPointerDown = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (event.button !== 0) return
    event.currentTarget.setPointerCapture(event.pointerId)
    dragRef.current = { x: event.clientX, y: event.clientY, yaw, pitch }
    setDragging(true)
  }

  const onPointerMove = (event: ReactPointerEvent<SVGSVGElement>) => {
    const start = dragRef.current
    if (!start) return
    const nextPitch = start.pitch + (event.clientY - start.y) * 0.006
    setYaw(start.yaw + (event.clientX - start.x) * 0.008)
    setPitch(Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, nextPitch)))
  }

  const endDrag = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (!dragRef.current) return
    dragRef.current = null
    setDragging(false)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

  const onKeyDown = (event: ReactKeyboardEvent<SVGSVGElement>) => {
    const step = 0.12
    if (event.key === 'ArrowLeft') setYaw((value) => value - step)
    else if (event.key === 'ArrowRight') setYaw((value) => value + step)
    else if (event.key === 'ArrowUp') setPitch((value) => Math.max(-PITCH_LIMIT, value - step))
    else if (event.key === 'ArrowDown') setPitch((value) => Math.min(PITCH_LIMIT, value + step))
    else return
    event.preventDefault()
  }

  return (
    <div className="rag-scatter-wrap">
      <svg
        className="rag-scatter"
        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        role="img"
        aria-label="块与问题在三维向量空间中的投影，可拖动或按方向键旋转"
        tabIndex={0}
        data-dragging={dragging ? 'true' : 'false'}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onKeyDown={onKeyDown}
        onDoubleClick={reset}
      >
        <g className="rag-scatter__frame">
          {CUBE_EDGES.map(([from, to]) => {
            const a = corners[from]
            const b = corners[to]
            const opacity = 0.16 + 0.3 * ((a.depth + b.depth) / 2 + 1.2) / 2.4
            return (
              <line
                key={`${from}-${to}`}
                x1={a.sx}
                y1={a.sy}
                x2={b.sx}
                y2={b.sy}
                className="rag-scatter__edge"
                style={{ opacity: Math.max(0.12, Math.min(0.48, opacity)) }}
              />
            )
          })}
        </g>

        <g className="rag-scatter__axes">
          {axes.map(({ label, near, far, tip }) => {
            const anchor = tip.sx > CENTER_X + 6 ? 'start' : tip.sx < CENTER_X - 6 ? 'end' : 'middle'
            return (
              <g key={label}>
                <line
                  x1={near.sx}
                  y1={near.sy}
                  x2={far.sx}
                  y2={far.sy}
                  className="rag-scatter__axis"
                />
                <text
                  x={tip.sx}
                  y={tip.sy + 3}
                  className="rag-scatter__axis-label"
                  textAnchor={anchor}
                >
                  {label}
                </text>
              </g>
            )
          })}
        </g>

        {dots.map(({ point, screen, selected, active }) => {
          const opacity = selected || active ? 1 : depthOpacity(screen.depth)
          const radius = (selected ? 5.6 : 3.4) * screen.k * (active && !selected ? 1.5 : 1)
          // 标签一律往画面外侧摆：中间是点最密的地方，写在那里必然互相压
          const outward = screen.sx > CENTER_X
          const labelX = outward ? screen.sx - radius - 4 : screen.sx + radius + 4
          return (
            <g key={point.index}>
              {selected && (
                <circle
                  cx={screen.sx}
                  cy={screen.sy}
                  r={radius + 2.8}
                  className="rag-scatter__halo"
                  style={{ opacity: opacity * 0.42 }}
                />
              )}
              <circle
                cx={screen.sx}
                cy={screen.sy}
                r={radius}
                className={[
                  'rag-scatter__dot',
                  selected ? 'rag-scatter__dot--hit' : '',
                  active && !selected ? 'rag-scatter__dot--active' : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
                style={{ opacity }}
                data-focus={active ? 'true' : 'false'}
                onMouseEnter={() => onFocus(point.index)}
                onMouseLeave={() => onFocus(null)}
              >
                <title>{`块 #${point.index}`}</title>
              </circle>
              {selected && (
                <text
                  x={labelX}
                  y={screen.sy + 3}
                  className="rag-scatter__label"
                  textAnchor={outward ? 'end' : 'start'}
                  style={{ opacity }}
                >
                  {point.index}
                </text>
              )}
            </g>
          )
        })}

        {query && (
          <g>
            <circle
              cx={query.sx}
              cy={query.sy}
              r={8.2 * query.k}
              className="rag-scatter__query-ring"
            />
            <circle cx={query.sx} cy={query.sy} r={3.4 * query.k} className="rag-scatter__query-dot" />
            {/* 问题点多数时候就压在头名块上，标签往上让，别和块的编号抢位置 */}
            <text
              x={query.sx}
              y={query.sy - 8.2 * query.k - 4}
              className="rag-scatter__label rag-scatter__label--query"
              textAnchor="middle"
            >
              问题
            </text>
          </g>
        )}
      </svg>

      <div className="rag-scatter__readout">
        {explained && explained.length === 3 && (
          <ul className="rag-scatter__pc" aria-label="三个主成分解释的方差占比">
            {explained.map((ratio, index) => (
              <li key={index} title={`主成分 ${index + 1} 解释 ${(ratio * 100).toFixed(1)}% 的方差`}>
                <span>PC{index + 1}</span>
                <span className="rag-scatter__pc-track">
                  <i
                    style={{
                      width: `${Math.max(3, (ratio / (explained[0] || 1)) * 100)}%`,
                      opacity: 1 - index * 0.28,
                    }}
                  />
                </span>
                <b>{(ratio * 100).toFixed(1)}%</b>
              </li>
            ))}
          </ul>
        )}
        <span className="rag-scatter__hint">{dragging ? '松开停住' : '拖动旋转'}</span>
        {moved && (
          <button type="button" className="rag-scatter__reset" onClick={reset}>
            复位
          </button>
        )}
      </div>
    </div>
  )
}

/* -------------------------------------------------------------- 检索打分条 */

interface HitListProps {
  hits: RagHit[]
  focus: number | null
  onFocus: (index: number | null) => void
}

export function HitList({ hits, focus, onFocus }: HitListProps) {
  const maxScore = Math.max(...hits.map((hit) => hit.score), 0.0001)
  const maxBm25 = Math.max(...hits.map((hit) => hit.bm25), 0.0001)

  return (
    <ol className="rag-hits">
      {hits.map((hit) => (
        <li
          key={`${hit.index}-${hit.selected ? 'y' : 'n'}`}
          className="rag-hit"
          data-selected={hit.selected ? 'true' : 'false'}
          data-focus={focus === hit.index ? 'true' : 'false'}
          onMouseEnter={() => onFocus(hit.index)}
          onMouseLeave={() => onFocus(null)}
        >
          <span className="rag-hit__index">#{hit.index}</span>
          <div className="rag-hit__body">
            <div className="rag-hit__meta">
              <span className="rag-hit__score">{hit.score}</span>
              <span className="rag-hit__sep">·</span>
              <span>向量 {hit.dense}（第 {hit.dense_rank} 名）</span>
              <span className="rag-hit__sep">·</span>
              <span>BM25 {hit.bm25}（第 {hit.bm25_rank} 名）</span>
              {hit.selected && <span className="rag-hit__badge">进入上下文</span>}
            </div>
            <div className="rag-hit__bars">
              <span className="rag-hit__track" title={`最终得分 ${hit.score}`}>
                <i className="rag-hit__bar rag-hit__bar--fused" style={{ width: `${(hit.score / maxScore) * 100}%` }} />
              </span>
              <span className="rag-hit__track" title={`向量相似度 ${hit.dense}`}>
                <i className="rag-hit__bar rag-hit__bar--dense" style={{ width: `${hit.dense * 100}%` }} />
              </span>
              <span className="rag-hit__track" title={`BM25 ${hit.bm25}`}>
                <i className="rag-hit__bar rag-hit__bar--bm25" style={{ width: `${(hit.bm25 / maxBm25) * 100}%` }} />
              </span>
            </div>
            <p className="rag-hit__text">{hit.preview}</p>
          </div>
        </li>
      ))}
    </ol>
  )
}

/* ------------------------------------------------------------------ 小部件 */

export function StatRow({ items }: { items: { label: string; value: string }[] }) {
  return (
    <dl className="rag-stats">
      {items.map((item) => (
        <div className="rag-stats__item" key={item.label}>
          <dt>{item.label}</dt>
          <dd>{item.value}</dd>
        </div>
      ))}
    </dl>
  )
}

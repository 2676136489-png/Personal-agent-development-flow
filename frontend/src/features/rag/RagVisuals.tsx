/**
 * RAG 页的四个可视化：切块色带 / 向量热力图 / 向量空间散点 / 检索打分条。
 *
 * 为什么手写 SVG 与 CSS 而不是引图表库：
 * 这些图的坐标与配色都要跟设计令牌对齐，引一个库既要适配主题、又要为四个小图
 * 多加几十 KB 依赖；而它们本质都是「把比例映射成位置」，用 SVG 反而更直接。
 */

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
      <p className="rag-figure__note">
        每行一个块，取前 {heatmap.cols} 维（共 {detail.dims} 维，绝对值上限 {heatmap.scale}）。
        蓝 = 正值，青 = 负值，越深越远离 0。
        {heatmap.total_chunks > heatmap.rows && ` 只画了前 ${heatmap.rows} 块。`}
      </p>
    </div>
  )
}

/* -------------------------------------------------------------- 向量散点图 */

interface VectorScatterProps {
  points: RagPoint[]
  queryPoint: { x: number; y: number } | null
  selectedIndexes: number[]
  focus: number | null
  onFocus: (index: number | null) => void
}

/**
 * PCA 降到二维后的分布。
 *
 * 为什么值得画：余弦相似度是 2048 维里的事，数字看不出「为什么这条排第一」。
 * 投到二维之后，「问题点落在哪一簇块附近」是肉眼可判断的 —— 这也正是
 * 向量检索在做的事。
 */
export function VectorScatter({
  points,
  queryPoint,
  selectedIndexes,
  focus,
  onFocus,
}: VectorScatterProps) {
  const width = 420
  const height = 260
  const pad = 26

  const xs = [...points.map((p) => p.x), ...(queryPoint ? [queryPoint.x] : [])]
  const ys = [...points.map((p) => p.y), ...(queryPoint ? [queryPoint.y] : [])]
  const minX = Math.min(...xs, 0)
  const maxX = Math.max(...xs, 0)
  const minY = Math.min(...ys, 0)
  const maxY = Math.max(...ys, 0)
  const spanX = maxX - minX || 1
  const spanY = maxY - minY || 1

  const sx = (x: number) => pad + ((x - minX) / spanX) * (width - pad * 2)
  const sy = (y: number) => height - pad - ((y - minY) / spanY) * (height - pad * 2)

  return (
    <svg
      className="rag-scatter"
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label="块与问题在向量空间中的二维投影"
    >
      {[0.25, 0.5, 0.75].map((ratio) => (
        <line
          key={`h-${ratio}`}
          x1={pad}
          x2={width - pad}
          y1={pad + ratio * (height - pad * 2)}
          y2={pad + ratio * (height - pad * 2)}
          className="rag-scatter__grid"
        />
      ))}
      {[0.25, 0.5, 0.75].map((ratio) => (
        <line
          key={`v-${ratio}`}
          y1={pad}
          y2={height - pad}
          x1={pad + ratio * (width - pad * 2)}
          x2={pad + ratio * (width - pad * 2)}
          className="rag-scatter__grid"
        />
      ))}

      {points.map((point) => {
        const selected = selectedIndexes.includes(point.index)
        return (
          <g key={point.index}>
            <circle
              cx={sx(point.x)}
              cy={sy(point.y)}
              r={selected ? 6.5 : 4}
              className={selected ? 'rag-scatter__dot rag-scatter__dot--hit' : 'rag-scatter__dot'}
              data-focus={focus === point.index ? 'true' : 'false'}
              onMouseEnter={() => onFocus(point.index)}
              onMouseLeave={() => onFocus(null)}
            >
              <title>{`块 #${point.index}`}</title>
            </circle>
            {selected && (
              <text x={sx(point.x) + 9} y={sy(point.y) + 4} className="rag-scatter__label">
                {point.index}
              </text>
            )}
          </g>
        )
      })}

      {queryPoint && (
        <g>
          <circle cx={sx(queryPoint.x)} cy={sy(queryPoint.y)} r={9} className="rag-scatter__query-ring" />
          <circle cx={sx(queryPoint.x)} cy={sy(queryPoint.y)} r={3.5} className="rag-scatter__query-dot" />
          <text x={sx(queryPoint.x) + 13} y={sy(queryPoint.y) + 4} className="rag-scatter__label rag-scatter__label--query">
            问题
          </text>
        </g>
      )}

      <text x={width - pad} y={height - 6} className="rag-scatter__axis" textAnchor="end">
        主成分 1
      </text>
      <text x={6} y={pad - 8} className="rag-scatter__axis">
        主成分 2
      </text>
    </svg>
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

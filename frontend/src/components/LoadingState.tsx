/**
 * LoadingState —— 全站统一「加载态」：Uplink 终端面板（紧凑移植版）。
 *
 * 视觉来自 Uplink Loader（ThreeUI Community, MIT）——把无信息量的灰条骨架
 * 换成一块「数据终端」面板：进度刻度条 + 百分比读数 + 阶段文案 + 角标 +
 * 扫描线，与全站深空蓝控制台语言一致。面板是自包含的暗色磷光屏，
 * 明暗两套主题下都成立。
 *
 * 实现是纯 DOM + CSS + 单个 rAF（rAF 直接改 DOM，不走 setState，
 * 一次最多挂载 1~2 个面板，开销可忽略）；完整电影版（iframe）只用于
 * 模块级 Suspense 兜底，见 shaders/uplink-loader/。
 *
 * 进度是模拟时间轴（源自 Uplink 原版 KF 关键帧）：加载本身无法预知
 * 百分比，但「冲一段、歇一下」的不匀速推进比转圈更能传达"仍在工作"。
 *
 * 无障碍：role="status" / aria-live / aria-busy 保留；面板内部数字与
 * 英文阶段文案是装饰，一律 aria-hidden，真实信息走 aria-label 与可见
 * 的中文 label。prefers-reduced-motion 时定格在中间进度、不跑 rAF。
 *
 * 兼容性说明：保留原类名（.state-loading / .state-loading__label）——
 * smoke-render 与 qa 探针对这些类名有源码与运行时断言，换皮肤不动接口。
 */
import { useEffect, useRef } from 'react'

type LoadingVariant = 'card' | 'list' | 'table' | 'inline'

/** 各变体的默认占位行数 */
const DEFAULT_ROWS: Record<LoadingVariant, number> = {
  card: 3,
  list: 4,
  table: 5,
  inline: 1,
}

interface LoadingStateProps {
  /** 骨架形态，决定终端面板的高度；默认 card */
  variant?: LoadingVariant
  /** 行数仍参与面板高度计算，让占位高度逼近真实内容高度 */
  rows?: number
  /** 加载文案（屏幕阅读器与视觉同时可见） */
  label?: string
}

/* ---- 进度时间轴（移植自 Uplink Loader 原版） ---- */
const TICKS = 44
const MARK_EVERY = 8

const KF: Array<[number, number]> = [
  [0, 0], [0.045, 9], [0.115, 9.6], [0.16, 22], [0.205, 23], [0.3, 38], [0.345, 39.5],
  [0.4, 53], [0.475, 54], [0.545, 68], [0.6, 69], [0.665, 81], [0.735, 82],
  [0.8, 92], [0.855, 93], [0.925, 99], [0.985, 99.4], [1.0, 100],
]
/* 局部加载多为秒级：把原版 8.6s 的单程压到 5.2s，播到 100% 停 1.1s 后循环 */
const RUN = 5200
const HOLD = 1100
const BLANK = 380
const LOOP = RUN + HOLD + BLANK

const PHASES: Array<[number, string]> = [
  [0, 'INITIALIZING CORE SYSTEMS'],
  [24, 'ESTABLISHING SECURE UPLINK'],
  [52, 'SYNCHRONIZING NODE ARRAY'],
  [78, 'DECRYPTING PAYLOAD STREAM'],
  [100, 'UPLINK ESTABLISHED'],
]

const phaseFor = (p: number) => {
  let t = PHASES[0][1]
  for (const [k, v] of PHASES) if (p >= k) t = v
  return t
}

const easeOut = (x: number) => 1 - Math.pow(1 - x, 2.1)

const valueAt = (u: number) => {
  if (u >= 1) return 100
  for (let i = 0; i < KF.length - 1; i++) {
    const [t0, v0] = KF[i]
    const [t1, v1] = KF[i + 1]
    if (u <= t1) return v0 + (v1 - v0) * easeOut((u - t0) / (t1 - t0))
  }
  return 100
}

/** 各变体面板高度：行数越多占位越高，内容到达时的跳动最小 */
function panelHeight(variant: Exclude<LoadingVariant, 'inline'>, rows?: number): number {
  const n = Math.max(1, Math.floor(rows ?? DEFAULT_ROWS[variant]))
  if (variant === 'card') return 128 + Math.max(0, n - 3) * 24
  if (variant === 'list') return 120 + n * 34
  return 96 + n * 30
}

/* ---- 紧凑终端面板 ---- */

function UplinkPanel({ label, height }: { label: string; height: number }) {
  const numRef = useRef<HTMLSpanElement>(null)
  const readoutRef = useRef<HTMLSpanElement>(null)
  const phaseRef = useRef<HTMLSpanElement>(null)
  const dotsRef = useRef<HTMLSpanElement>(null)
  const tickRefs = useRef<Array<HTMLSpanElement | null>>([])

  useEffect(() => {
    /* 减少动态：定格中间进度，只保留静态文案 */
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      if (numRef.current) numRef.current.textContent = '57'
      if (phaseRef.current) phaseRef.current.textContent = 'ESTABLISHING SECURE UPLINK'
      if (dotsRef.current) dotsRef.current.textContent = '...'
      const lit = Math.round(0.57 * TICKS)
      for (let i = 0; i < TICKS; i++) tickRefs.current[i]?.classList.toggle('on', i < lit)
      return
    }

    let raf = 0
    const start = performance.now()
    let lastLit = -1
    let lastPct = -1
    let lastPhase = ''
    let lastDots = -1

    const frame = (now: number) => {
      const e = (now - start) % LOOP
      let pct: number
      let visible = true
      if (e < RUN) pct = valueAt(e / RUN)
      else if (e < RUN + HOLD) pct = 100
      else {
        pct = 0
        visible = (e - RUN - HOLD) % 220 < 130
      }

      const shown = Math.round(pct)
      if (shown !== lastPct) {
        if (numRef.current) numRef.current.textContent = String(shown)
        lastPct = shown
        const ph = phaseFor(shown)
        if (ph !== lastPhase) {
          if (phaseRef.current) phaseRef.current.textContent = ph
          lastPhase = ph
        }
      }
      if (readoutRef.current) readoutRef.current.style.opacity = visible ? '' : '0.25'

      const lit = Math.round((pct / 100) * TICKS)
      if (lit !== lastLit) {
        for (let i = 0; i < TICKS; i++) tickRefs.current[i]?.classList.toggle('on', i < lit)
        if (lit > lastLit && lastLit >= 0 && lit > 0) {
          const el = tickRefs.current[lit - 1]
          if (el) {
            el.classList.remove('flash')
            void el.offsetWidth
            el.classList.add('flash')
          }
        }
        lastLit = lit
      }

      const d = shown >= 100 ? 0 : Math.floor(((now - start) / 380) % 4)
      if (d !== lastDots && dotsRef.current) {
        dotsRef.current.textContent = '...'.slice(0, d)
        lastDots = d
      }

      raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(raf)
  }, [])

  const ticks = Array.from({ length: TICKS }, (_, i) => (
    <span
      key={i}
      ref={(el) => {
        tickRefs.current[i] = el
      }}
      className={`uplink-tick${(i + 1) % MARK_EVERY === 0 ? ' uplink-tick--mk' : ''}`}
    />
  ))

  return (
    <div className="uplink-panel" style={{ height }}>
      <i className="uplink-corner" data-c="tl" />
      <i className="uplink-corner" data-c="tr" />
      <i className="uplink-corner" data-c="bl" />
      <i className="uplink-corner" data-c="br" />
      <div className="uplink-panel__scan" />
      <div className="uplink-panel__content">
        <div className="uplink-panel__top">
          <span className="state-loading__label uplink-panel__label">{label}</span>
          <span className="uplink-panel__readout" ref={readoutRef} aria-hidden="true">
            <b ref={numRef}>0</b>
            <u>%</u>
          </span>
        </div>
        <div className="uplink-panel__bar" aria-hidden="true">
          {ticks}
        </div>
        <div className="uplink-panel__phase" aria-hidden="true">
          <span ref={phaseRef}>INITIALIZING CORE SYSTEMS</span>
          <span className="uplink-dots" ref={dotsRef}>...</span>
        </div>
      </div>
    </div>
  )
}

/* ---- inline 变体：一行 LED 波（纯 CSS，无 rAF） ---- */

function UplinkInline({ label }: { label: string }) {
  return (
    <span className="uplink-inline" aria-hidden="true">
      <span className="uplink-inline__ticks">
        {Array.from({ length: 12 }, (_, i) => (
          <i key={i} style={{ animationDelay: `${(i * 0.12).toFixed(2)}s` }} />
        ))}
      </span>
      <span className="uplink-inline__label">{label}</span>
    </span>
  )
}

export function LoadingState({ variant = 'card', rows, label }: LoadingStateProps) {
  const text = label ?? '加载中'

  if (variant === 'inline') {
    return (
      <span
        className="state state-loading state-loading--inline"
        role="status"
        aria-live="polite"
        aria-busy="true"
        aria-label={text}
      >
        <UplinkInline label={text} />
      </span>
    )
  }

  return (
    <div
      className={`state state-loading state-loading--${variant} uplink-panel-host`}
      role="status"
      aria-live="polite"
      aria-busy="true"
      aria-label={text}
    >
      <UplinkPanel label={text} height={panelHeight(variant, rows)} />
    </div>
  )
}

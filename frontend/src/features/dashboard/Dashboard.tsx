import { useCallback, useEffect, useState } from 'react'
import { fetchHealth } from '../../api/health'
import { fetchLlmProvider, type LlmProviderInfo } from '../../api/llm'
import { ApiClientError } from '../../api/client'
import type { HealthData } from '../../types/api'
import { Reveal } from '../../components/Reveal'
import { PipelineDiagram } from '../../components/PipelineDiagram'
import { BookIcon, DocIcon, FlaskIcon } from '../../components/icons'
import type { IconProps } from '../../components/icons'
import type { ComponentType } from 'react'
import { FlowOverview } from '../workflow/FlowOverview'
import { StatusBadge } from '../../components/StatusBadge'
import { GlassHero } from '../hero/GlassHero'

type NavigateFn = (key: string) => void

type HealthState =
  | { status: 'loading' }
  | { status: 'ok'; data: HealthData; latencyMs: number; checkedAt: Date }
  | { status: 'error'; message: string; code: string }

/** 3 张核心入口卡（1 主 2 次） */
const ENTRY_CARDS: {
  key: string
  icon: ComponentType<IconProps>
  title: string
  desc: string
  primary?: boolean
}[] = [
  { key: 'workflow', icon: FlaskIcon, title: '深度研究', desc: '跑一遍完整研究，写报告前可先确认方向。', primary: true },
  { key: 'knowledge', icon: BookIcon, title: '知识库', desc: '上传自己的资料，让研究能引用内部文档。' },
  { key: 'reports', icon: DocIcon, title: '研究报告', desc: '查看已完成的研究报告，支持全文阅读。' },
]

const ENTRY_LINKS: { key: string; label: string }[] = [
  { key: 'rag', label: 'RAG 流程' },
  { key: 'evaluation', label: '效果评估' },
  { key: 'settings', label: '系统设置' },
  { key: 'tutorial', label: '教程' },
]

/**
 * 概览页（入口页）：
 *   ① 全屏 hero —— 玻璃立方体折射背景标题，是全站唯一的「纯视觉」区块
 *   ② 状态条 —— 后端连接 + 当前模型，两枚可点的细条
 *   ③ 三个核心入口 + 次级文字链
 *   ④ 研究流程（七步）
 *
 * hero 之下才是功能内容：首屏负责定调，往下滚动才进入控制台，
 * 这样既保留了「一眼看懂这是什么产品」的视觉冲击，又不牺牲可操作性。
 */
export function Dashboard({ onNavigate }: { onNavigate?: NavigateFn }) {
  const [state, setState] = useState<HealthState>({ status: 'loading' })
  const [llm, setLlm] = useState<LlmProviderInfo | null>(null)

  const check = useCallback(async () => {
    setState({ status: 'loading' })
    const startedAt = performance.now()
    try {
      const data = await fetchHealth()
      setState({
        status: 'ok',
        data,
        latencyMs: Math.round(performance.now() - startedAt),
        checkedAt: new Date(),
      })
    } catch (error) {
      if (error instanceof ApiClientError) {
        setState({ status: 'error', message: error.message, code: error.code })
      } else {
        setState({
          status: 'error',
          message: '无法连接后端。请确认 backend 已启动，且地址与 VITE_API_BASE_URL 一致。',
          code: 'network_error',
        })
      }
    }
  }, [])

  useEffect(() => {
    void check()
  }, [check])

  // 模型信息是「增强项」：拿不到就让那一块不显示，绝不影响首屏其余内容
  useEffect(() => {
    let cancelled = false
    void fetchLlmProvider()
      .then((info) => {
        if (!cancelled) setLlm(info)
      })
      .catch(() => {
        /* 静默：首屏不因模型接口失败而报错 */
      })
    return () => {
      cancelled = true
    }
  }, [])

  const connected = state.status === 'ok'
  const failed = state.status === 'error'
  const statusVariant = failed ? 'error' : connected ? 'ok' : 'info'
  const statusText = failed ? '后端未连接，点此排查' : connected ? '后端已连接' : '正在检测后端…'

  return (
    <>
      <GlassHero onExplore={() => onNavigate?.('workflow')} />

      <div className="home-body">
        {/* 状态条：连接与模型，各占一枚细条，点进系统设置 */}
        <div className="hero-status">
          <button
            className="status-line"
            type="button"
            onClick={() => onNavigate?.('settings')}
            title={failed ? state.message : '前往「系统设置」查看连接明细'}
          >
            <StatusBadge variant={statusVariant}>{statusText}</StatusBadge>
          </button>
          {llm && (
            <button
              className="status-line"
              type="button"
              onClick={() => onNavigate?.('settings')}
              title={
                llm.fallback
                  ? `主模型不可用时回落到：${llm.fallback}`
                  : '当前作答的模型，可在「系统设置」里切换'
              }
            >
              <span className="badge badge--info">
                模型 · {llm.label} {llm.model}
              </span>
            </button>
          )}
        </div>

        {/* 三个核心入口 + 次级文字链 */}
        <section className="section section--entry">
          <Reveal className="section-head">
            <p className="eyebrow">从这里开始</p>
            <h2>一次研究的完整生命周期，三个入口。</h2>
            <p className="section-lede">
              不知道从哪开始就用「深度研究」；有自己的资料先传进「知识库」，结论才会引用它。
            </p>
          </Reveal>

          <div className="entry-grid">
            {ENTRY_CARDS.map((card) => {
              const Icon = card.icon
              return (
                <button
                  key={card.key}
                  type="button"
                  className={`card card--interactive card--entry ${card.primary ? 'card--primary' : ''}`}
                  onClick={() => onNavigate?.(card.key)}
                >
                  <span className="card__icon">
                    <Icon size={20} />
                  </span>
                  <h3 className="card__title">{card.title}</h3>
                  <p className="card__desc">{card.desc}</p>
                  {card.primary && <span className="badge badge--info card__badge">推荐</span>}
                </button>
              )
            })}
          </div>

          <div className="entry-links">
            {ENTRY_LINKS.map((link) => (
              <button key={link.key} type="button" className="link-button" onClick={() => onNavigate?.(link.key)}>
                {link.label}
              </button>
            ))}
          </div>
        </section>

        {/* 研究流程 */}
        <section className="section">
          <Reveal className="section-head">
            <p className="eyebrow">研究流程</p>
            <h2>七步流水线，每一步都看得见。</h2>
            <p className="section-lede">
              从理解问题到产出报告，流程按固定节奏推进；检索与分析会循环迭代，直到证据足够。
            </p>
          </Reveal>
          <FlowOverview />
        </section>

        {/* 流水线结构图：放在最末，作为整页的收束 */}
        <div className="hero-visual" aria-hidden="true">
          <PipelineDiagram />
        </div>
      </div>
    </>
  )
}

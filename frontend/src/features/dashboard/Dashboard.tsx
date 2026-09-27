import { useCallback, useEffect, useState } from 'react'
import { fetchHealth } from '../../api/health'
import { fetchLlmProvider, type LlmProviderInfo } from '../../api/llm'
import { ApiClientError } from '../../api/client'
import type { HealthData } from '../../types/api'
import { Reveal } from '../../components/Reveal'
import { Stagger, StaggerItem } from '../../components/Stagger'
import { CountUp } from '../../components/CountUp'
import { PipelineDiagram } from '../../components/PipelineDiagram'
import { BotIcon, BookIcon, DocIcon, FlaskIcon } from '../../components/icons'
import type { IconProps } from '../../components/icons'
import type { ComponentType } from 'react'
import { FlowOverview } from '../workflow/FlowOverview'
import { StatusBadge } from '../../components/StatusBadge'

type NavigateFn = (key: string) => void

type HealthState =
  | { status: 'loading' }
  | { status: 'ok'; data: HealthData; latencyMs: number; checkedAt: Date }
  | { status: 'error'; message: string; code: string }

/** 4 张核心入口卡（1 主 3 次）；B4：icon 由汉字改为线图标组件 */
const ENTRY_CARDS: {
  key: string
  icon: ComponentType<IconProps>
  title: string
  desc: string
  primary?: boolean
}[] = [
  { key: 'workflow', icon: FlaskIcon, title: '深度研究', desc: '跑一遍完整研究，写报告前可先确认方向。', primary: true },
  { key: 'agent', icon: BotIcon, title: '智能体', desc: '给个任务，自动查资料并给出带引用的答案。' },
  { key: 'knowledge', icon: BookIcon, title: '知识库', desc: '上传自己的资料，让研究能引用内部文档。' },
  { key: 'reports', icon: DocIcon, title: '研究报告', desc: '查看已完成的研究报告，支持全文阅读。' },
]

const ENTRY_LINKS: { key: string; label: string }[] = [
  { key: 'research', label: '研究规划' },
  { key: 'evaluation', label: '效果评估' },
  { key: 'settings', label: '系统设置' },
  { key: 'tutorial', label: '教程' },
]

/**
 * 概览页（入口页）：3 个区块 —— Hero / 4 张核心入口卡 / 研究流程。
 * 连接状态仅保留一个轻量状态点；技术明细已迁移到 Settings 的「系统连接」分组。
 */
export function Dashboard({ onNavigate }: { onNavigate?: NavigateFn }) {
  const [state, setState] = useState<HealthState>({ status: 'loading' })
  // 「现在在调哪个模型」—— 换模型是这个项目的高频操作，放在首屏最显眼处
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
      {/* ============ ① 首屏：一句话 + 主按钮 + 轻量状态点 ============ */}
      <Stagger as="section" className="hero hero--compact">
        <StaggerItem>
          <p className="hero-welcome">AI 研究工作台</p>
        </StaggerItem>
        <StaggerItem>
          <h1>提一个问题，拿到一份有出处的研究报告。</h1>
        </StaggerItem>
        <StaggerItem>
          <p className="hero-lede">
            输入一个研究问题，智能体自动完成「理解 → 规划 → 检索 → 分析 → 核对 → 写报告」，
            过程实时可见，写报告前会停下来等你确认，每条结论都标了来源。
          </p>
        </StaggerItem>
        <StaggerItem>
          <div className="hero-actions">
            <button className="button button--primary" onClick={() => onNavigate?.('workflow')}>
              开始研究
            </button>
            <button className="button" onClick={() => onNavigate?.('tutorial')}>
              3 分钟上手教程
            </button>
          </div>
        </StaggerItem>

        <StaggerItem>
          {/* ⚠️ 数字与标签必须用**专属类名**，不能用 `.hero-facts span` 这种宽泛选择器：
              否则会误伤 CountUp 内部渲染的数字 <span>，把「7」变成独立一行的灰色小字。 */}
          <div className="hero-facts">
            <div className="hero-fact">
              <strong className="hero-fact__value">
                <CountUp value={7} />
                步
              </strong>
              <span className="hero-fact__label">研究流水线</span>
            </div>
            <div className="hero-fact">
              <strong className="hero-fact__value">实时</strong>
              <span className="hero-fact__label">事件流进度</span>
            </div>
            <div className="hero-fact">
              <strong className="hero-fact__value">可中断</strong>
              <span className="hero-fact__label">写报告前确认</span>
            </div>
            <div className="hero-fact">
              <strong className="hero-fact__value">可溯源</strong>
              <span className="hero-fact__label">结论带引用</span>
            </div>
          </div>
        </StaggerItem>

        <StaggerItem>
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
        </StaggerItem>

        <StaggerItem>
          <div className="hero-visual">
            <PipelineDiagram />
          </div>
        </StaggerItem>
      </Stagger>

      {/* ============ ② 4 张核心入口卡（1 主 3 次）+ 次级文字链 ============ */}
      <section className="section section--entry">
        <Reveal className="section-head">
          <p className="eyebrow">从这里开始</p>
          <h2>四个入口，覆盖一次研究的完整生命周期。</h2>
          <p className="section-lede">
            不知道从哪开始就用「深度研究」；只想快速问一句用「智能体」；
            有自己的资料先传进「知识库」，结论才会引用它。
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
                <span className="card__icon"><Icon size={20} /></span>
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

      {/* ============ ③ 研究流程 ============ */}
      <section className="section">
        <Reveal className="section-head">
          <p className="eyebrow">研究流程</p>
          <h2>七步流水线，每一步都看得见。</h2>
          <p className="section-lede">
            从理解问题到产出报告，智能体按固定节奏推进；检索与分析会循环迭代，直到证据足够。
          </p>
        </Reveal>
        <FlowOverview />
      </section>
    </>
  )
}

import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { getRunBudget, getSettings } from '../../api/graph'
import type { RunBudgetSnapshot } from '../../api/graph'
import { fetchHealth } from '../../api/health'
import { ApiClientError, apiBaseUrlForDisplay, formatResetMoment } from '../../api/client'
import type { HealthData } from '../../types/api'
import { StatusBadge } from '../../components/StatusBadge'
import { LoadingState } from '../../components/LoadingState'
import { ErrorState } from '../../components/ErrorState'
import { PageHeader } from '../../components/PageHeader'
import { ModelPanel } from './ModelPanel'

// 不再自己拼一份 `import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:8000'`：
// 那是同一份配置的第二个副本，线上同源部署时它会指向错误的 localhost。
// 统一从 client.ts 取，保证「请求用的地址」和「界面上显示的地址」永远一致。
const API_BASE_URL = apiBaseUrlForDisplay()

const STATUS_LABEL: Record<string, string> = { ok: '正常', degraded: '降级', error: '异常' }
const ENV_LABEL: Record<string, string> = { development: '开发', production: '生产', test: '测试' }

type HealthState =
  | { status: 'loading' }
  | { status: 'ok'; data: HealthData; latencyMs: number; checkedAt: Date }
  | { status: 'error'; message: string; code: string }

interface ConfigRow {
  label: string
  value: ReactNode
}

interface ConfigGroup {
  title: string
  rows: ConfigRow[]
}

/**
 * 「今日已用」的展示：进度条 + 数字。
 *
 * 为什么用进度条而不是纯文案：额度本质上是一个「剩余量」，
 * 条形比「还剩 N 次」更快被扫读；文案同步保留，照顾读屏与精确值。
 * 额度未启用 / 接口不可用（null）时回落成 '-'。
 */
function budgetBar(budget: RunBudgetSnapshot | null): ReactNode {
  if (!budget?.enabled) return '-'
  const ratio = budget.limit > 0 ? Math.min(1, budget.used / budget.limit) : 0
  const exhausted = budget.remaining <= 0
  return (
    <span className="quota">
      <span
        className="quota__track"
        role="img"
        aria-label={`今日已用 ${budget.used} / ${budget.limit} 次`}
      >
        <span
          className={`quota__fill${exhausted ? ' quota__fill--empty' : ''}`}
          style={{ width: `${Math.round(ratio * 100)}%` }}
        />
      </span>
      <span className="quota__text">
        {exhausted
          ? `${budget.used}/${budget.limit} 次（已用完）`
          : `${budget.used}/${budget.limit} 次`}
      </span>
    </span>
  )
}

/** 把后端配置按用途分为 8 组，避免 20 行挤在一起（P1-5） */
function buildGroups(
  config: Record<string, unknown>,
  budget: RunBudgetSnapshot | null,
): ConfigGroup[] {
  return [
    {
      title: '应用',
      rows: [
        { label: '应用名称', value: String(config.app_name ?? '-') },
        { label: '环境', value: String(config.environment ?? '-') },
        { label: '版本', value: String(config.version ?? '-') },
      ],
    },
    {
      title: 'LLM',
      rows: [
        { label: '供应方', value: String(config.llm_provider ?? '-') },
        { label: '模型', value: String(config.llm_model ?? '-') },
        { label: 'Base URL', value: String(config.llm_base_url ?? '-') },
        { label: '超时', value: `${String(config.llm_timeout_seconds ?? '-')} 秒` },
        { label: '重试次数', value: String(config.llm_max_attempts ?? '-') },
        { label: '温度', value: String(config.llm_temperature ?? '-') },
        { label: 'Max Tokens', value: String(config.llm_max_tokens ?? '-') },
        { label: 'API Key', value: config.has_llm_key ? '已配置' : '未配置' },
      ],
    },
    {
      title: '搜索',
      rows: [
        { label: '供应方', value: String(config.search_provider ?? '-') },
        { label: 'Tavily Key', value: config.has_tavily_key ? '已配置' : '未配置' },
      ],
    },
    {
      title: 'Agent',
      rows: [
        { label: '最大步数', value: String(config.agent_max_steps ?? '-') },
        { label: '总超时', value: `${String(config.agent_total_timeout_seconds ?? '-')} 秒` },
      ],
    },
    {
      title: '深度研究',
      rows: [
        { label: '最大轮数', value: String(config.graph_max_iterations ?? '-') },
        { label: '验证最大次数', value: String(config.graph_max_verify_attempts ?? '-') },
      ],
    },
    {
      title: 'Embedding',
      rows: [
        { label: '供应方', value: String(config.embedding_provider ?? '-') },
        { label: '模型', value: String(config.embedding_model ?? '-') },
      ],
    },
    {
      title: '访问与额度',
      rows: [
        {
          label: '访问限流',
          value: config.rate_limit_enabled
            ? `开启（每 IP ${String(config.rate_limit_requests_per_minute ?? '-')} 次/分钟）`
            : '关闭',
        },
        {
          label: '每日深度研究额度',
          value: config.daily_run_budget_enabled
            ? `每位访客 ${String(config.daily_run_budget_per_ip ?? '-')} 次/天`
            : '未开启',
        },
        { label: '今日已用（本机）', value: budgetBar(budget) },
        {
          label: '额度恢复',
          value:
            budget?.enabled && budget.reset_at_ms > 0
              ? formatResetMoment(budget.reset_at_ms)
              : '-',
        },
      ],
    },
    {
      title: '安全（CORS）',
      rows: [
        { label: 'CORS 来源', value: (config.cors_origins as string[] | undefined)?.join(', ') ?? '-' },
      ],
    },
  ]
}

/**
 * 系统设置：顶部「系统连接」分组承接原概览页的技术明细（环境/版本/延迟/UTC + 重新检测 + 排查提示），
 * 下方按用途分 8 组展示后端运行配置。
 */
export function Settings() {
  const [config, setConfig] = useState<Record<string, unknown> | null>(null)
  /** 今日额度快照：接口不可用时为 null，仅「访问与额度」组显示 '-' */
  const [budget, setBudget] = useState<RunBudgetSnapshot | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [health, setHealth] = useState<HealthState>({ status: 'loading' })

  const checkHealth = useCallback(async () => {
    setHealth({ status: 'loading' })
    const startedAt = performance.now()
    try {
      const data = await fetchHealth()
      setHealth({
        status: 'ok',
        data,
        latencyMs: Math.round(performance.now() - startedAt),
        checkedAt: new Date(),
      })
    } catch (err) {
      if (err instanceof ApiClientError) {
        setHealth({ status: 'error', message: err.message, code: err.code })
      } else {
        setHealth({
          status: 'error',
          message: '无法连接后端。请确认 backend 已启动，且地址与 VITE_API_BASE_URL 一致。',
          code: 'network_error',
        })
      }
    }
  }, [])

  const loadConfig = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setConfig(await getSettings())
      // 今日额度单独拉取：接口不可用时只影响这一组的显示，不阻塞配置展示
      setBudget(await getRunBudget().catch(() => null))
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : '加载失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadConfig()
  }, [loadConfig])

  useEffect(() => {
    void checkHealth()
  }, [checkHealth])

  const groups = config ? buildGroups(config, budget) : []

  return (
    <section className="panel">
      <PageHeader
        eyebrow="系统设置"
        title="运行配置与连接"
        lede="后端连接自检、模型与搜索配置、运行参数与依赖状态。敏感字段仅显示是否配置，不会暴露明文。"
        notes={[
          { term: '能做什么', desc: '确认「现在连的是谁、用的是哪个模型、额度还剩多少」。' },
          { term: '怎么用', desc: '先看模型自检结果，再看「访问与额度」，其余为只读的运行参数。' },
          { term: '注意', desc: '改配置要改后端 .env 并重启，页面上不能直接写。' },
        ]}
      />
      <ModelPanel />

      {error && <ErrorState message={error} onRetry={() => void loadConfig()} />}

      {/* 系统连接分组（承接原概览页技术明细） */}
      <section className="module-section">
        <h3 className="module-section__title">系统连接</h3>

        {health.status === 'loading' && <p className="hint">正在请求后端…</p>}

        {health.status === 'error' && (
          <div className="alert alert--error">
            <div className="alert__row">
              <StatusBadge variant="error">未连接</StatusBadge>
              <code className="alert__code">{health.code}</code>
              <button className="button push-right" onClick={() => void checkHealth()}>
                重新检测
              </button>
            </div>
            <p className="alert__message">{health.message}</p>
            <ul className="alert__tips">
              <li>
                后端是否在 <code>{API_BASE_URL}</code> 上运行？直接浏览器打开{' '}
                <a href={`${API_BASE_URL}/api/health`} target="_blank" rel="noreferrer">
                  {API_BASE_URL}/api/health
                </a>{' '}
                试试。
              </li>
              <li>
                如果浏览器控制台报 CORS 错误，检查 <code>backend/.env</code> 的{' '}
                <code>CORS_ORIGINS</code> 是否包含当前前端来源。
              </li>
            </ul>
          </div>
        )}

        {health.status === 'ok' && (
          <>
            <div className="alert__row">
              <StatusBadge variant="ok">已连接</StatusBadge>
              <span className="hint">
                {health.data.app_name} · {ENV_LABEL[health.data.environment] ?? health.data.environment} ·{' '}
                {STATUS_LABEL[health.data.status] ?? health.data.status}
              </span>
              <button className="button push-right" onClick={() => void checkHealth()}>
                重新检测
              </button>
            </div>

            <dl className="metrics">
              <Metric label="运行环境" value={health.data.environment} />
              <Metric label="版本" value={health.data.version} />
              <Metric label="API 地址" value={API_BASE_URL} />
              <Metric label="延迟" value={`${health.latencyMs} ms`} />
              <Metric label="服务器时间（UTC）" value={new Date(health.data.timestamp).toUTCString()} />
              <Metric label="最近检测" value={health.checkedAt.toLocaleTimeString()} />
            </dl>
          </>
        )}
      </section>

      {loading && <LoadingState variant="table" rows={7} label="正在加载运行配置…" />}

      {!loading &&
        groups.map((group) => (
          <section className="module-section" key={group.title}>
            <h3 className="module-section__title">{group.title}</h3>
            <div className="settings-table">
              {group.rows.map((row) => (
                <div key={row.label} className="settings-row">
                  <span className="settings-row__label">{row.label}</span>
                  <span className="settings-row__value">{row.value}</span>
                </div>
              ))}
            </div>
          </section>
        ))}
    </section>
  )
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="card card--metric">
      <dt className="metric__label">{label}</dt>
      <dd className="metric__value">{value}</dd>
    </div>
  )
}

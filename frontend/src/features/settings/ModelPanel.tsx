import { useCallback, useEffect, useRef, useState } from 'react'
import { fetchLlmProvider, pingLlm, streamProbe, type LlmProviderInfo } from '../../api/llm'
import { notify } from '../../components/Toast'
import { StatusBadge } from '../../components/StatusBadge'

/**
 * ModelPanel —— 「现在在调哪个模型」+ 一键自检。
 *
 * 为什么把它放在设置页最上面：换模型（本地 qwen3:8b ⇄ 云端）之后，
 * 排障的第一个问题永远是「到底生效了没有、通不通」。
 * 这里把配置（provider / 模型 / 超时 / 兜底）与实测（ping / 流式）放在一起，
 * 「配置写对了」和「模型确实能答」是两件不同的事，必须分别验证。
 */

const DEFAULT_PROBE = '用一句话说明你是谁，以及你现在跑在哪台机器上。'

export function ModelPanel() {
  const [info, setInfo] = useState<LlmProviderInfo | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  const [pinging, setPinging] = useState(false)
  const [pingResult, setPingResult] = useState<{
    status: 'ok' | 'fail'
    text: string
    latency?: number
  } | null>(null)

  const [streaming, setStreaming] = useState(false)
  const [streamText, setStreamText] = useState('')
  const abortRef = useRef<AbortController | null>(null)

  const load = useCallback(async () => {
    try {
      setInfo(await fetchLlmProvider())
      setLoadError(null)
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : '读取模型配置失败')
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  async function handlePing() {
    setPinging(true)
    setPingResult(null)
    try {
      const result = await pingLlm(DEFAULT_PROBE)
      setPingResult({
        status: result.status,
        text:
          result.status === 'ok'
            ? (result.content ?? '')
            : `${result.message ?? '模型不可用'}（${result.kind ?? 'unknown'}）`,
        latency: result.latency_ms,
      })
    } catch (error) {
      setPingResult({ status: 'fail', text: error instanceof Error ? error.message : '自检失败' })
    } finally {
      setPinging(false)
    }
  }

  async function handleStream() {
    if (streaming) {
      abortRef.current?.abort()
      setStreaming(false)
      return
    }
    setStreaming(true)
    setStreamText('')
    const controller = new AbortController()
    abortRef.current = controller
    try {
      await streamProbe(
        DEFAULT_PROBE,
        {
          onChunk: (text) => setStreamText((prev) => prev + text),
          onDone: (payload) => {
            setStreaming(false)
            notify({
              tone: 'ok',
              title: '流式输出正常',
              desc: `${payload.provider} · ${payload.model} · ${payload.latency_ms}ms`,
            })
          },
          onError: (message) => {
            setStreaming(false)
            notify({ tone: 'error', title: '流式输出失败', desc: message })
          },
        },
        controller.signal,
      )
    } catch {
      // 用户主动中止不算错误
      setStreaming(false)
    }
  }

  if (loadError) {
    return (
      <div className="stack-gap">
        <p className="hint note-line">
          读取模型配置失败：{loadError}
        </p>
      </div>
    )
  }

  return (
    <section className="card card--pad">
      <div className="run-card__head">
        <h3 className="run-card__title">模型</h3>
        {info && (
          <StatusBadge
            variant={info.degraded ? 'warn' : info.provider === 'mock' ? 'warn' : 'ok'}
          >
            {info.label}
          </StatusBadge>
        )}
      </div>

      {/* 降级必须让用户看见：否则界面写着"本地 Ollama"，实际答案却是云端出的 */}
      {info?.degraded && (
        <div className="panel-note panel-note--warn">
          <StatusBadge variant="warn">已降级</StatusBadge>
          <span>
            {info.degraded_reason ?? '主模型不可用，当前由兜底 provider 作答'}
            {info.active_provider ? `（实际作答：${info.active_provider}）` : ''}
          </span>
        </div>
      )}

      {!info ? (
        <div className="skeleton skeleton-block" />
      ) : (
        <>
          <div className="run-card__metrics">
            <div className="run-metric">
              <span className="run-metric__value metric-value-lg">
                {info.model}
              </span>
              <span className="run-metric__label">当前模型</span>
            </div>
            <div className="run-metric">
              <span className="run-metric__value metric-value-lg">
                {info.timeout_seconds}s
              </span>
              <span className="run-metric__label">单次超时</span>
            </div>
            <div className="run-metric">
              <span className="run-metric__value metric-value-lg">
                {info.fallback ?? '未配置'}
              </span>
              <span className="run-metric__label">兜底 provider</span>
            </div>
            <div className="run-metric">
              <span className="run-metric__value metric-value-lg">
                {info.stream_enabled ? '开启' : '关闭'}
              </span>
              <span className="run-metric__label">流式输出</span>
            </div>
          </div>

          <dl className="page-head__notes">
            <div className="page-head__note">
              <dt>服务地址</dt>
              <dd className="mono-line">{info.base_url || '（默认）'}</dd>
            </div>
            {info.provider === 'ollama' && (
              <>
                <div className="page-head__note">
                  <dt>上下文窗口 / 生成上限</dt>
                  <dd>
                    {info.num_ctx} / {info.num_predict} tokens
                  </dd>
                </div>
                <div className="page-head__note">
                  <dt>常驻显存 / 思考模式</dt>
                  <dd>
                    {info.keep_alive} · 思考{info.think ? '开启' : '关闭'}
                  </dd>
                </div>
              </>
            )}
            <div className="page-head__note">
              <dt>怎么换模型</dt>
              <dd>改后端 .env 的 LLM_PROVIDER / OLLAMA_MODEL 后重启，页面上不会直接写配置。</dd>
            </div>
          </dl>

          <div className="grid-actions">
            <button
              className={`button ${pinging ? 'button--busy' : ''}`.trim()}
              onClick={() => void handlePing()}
              disabled={pinging}
            >
              {pinging ? '自检中…' : '连通性自检'}
            </button>
            <button
              className={`button ${streaming ? 'button--busy' : ''}`.trim()}
              onClick={() => void handleStream()}
              disabled={!info.stream_enabled}
              title={info.stream_enabled ? '逐字输出，验证流式链路' : '流式输出已关闭'}
            >
              {streaming ? '停止' : '流式输出自测'}
            </button>
          </div>

          {pingResult && (
            <div className="alert__row">
              <StatusBadge variant={pingResult.status === 'ok' ? 'ok' : 'error'}>
                {pingResult.status === 'ok' ? '可正常调用' : '调用失败'}
              </StatusBadge>
              <span className="hint note-line">
                {pingResult.latency != null && `${pingResult.latency}ms · `}
                {pingResult.text}
              </span>
            </div>
          )}

          {(streaming || streamText) && (
            <div className="stream-box">
              {streamText}
              {streaming && <span className="badge badge--running">生成中</span>}
            </div>
          )}
        </>
      )}
    </section>
  )
}

import { apiGet, apiUrl } from './client'

/**
 * 统一模型调用层的对外接口（后端 app/api/routes/llm.py）。
 *
 * 前端只关心两件事：
 *   1. 现在在调哪个模型（GET /api/llm/provider）—— 展示与排障
 *   2. 这个模型现在能不能答（GET /api/llm/ping、POST /api/llm/stream）—— 自检
 *
 * 注意：这里**永远拿不到 API Key**。后端只回传 provider / 模型名 / 地址。
 */

export interface LlmProviderInfo {
  provider: string
  label: string
  model: string
  base_url: string
  stream_enabled: boolean
  timeout_seconds: number
  keep_alive?: string
  think?: boolean
  num_ctx?: number
  num_predict?: number
  fallback?: string | null
  /** 实际作答的 provider。与 provider 不一致 = 发生了降级 */
  active_provider?: string
  /** 当前是否处于降级（主模型不可用，由兜底作答） */
  degraded?: boolean
  degraded_reason?: string
  environment?: string
}

export interface LlmPingResult {
  status: 'ok' | 'fail'
  content?: string
  model?: string
  provider?: string
  latency_ms?: number
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number }
  kind?: string
  message?: string
}

export function fetchLlmProvider(signal?: AbortSignal): Promise<LlmProviderInfo> {
  return apiGet<LlmProviderInfo>('/api/llm/provider', signal)
}

export function pingLlm(probe: string, signal?: AbortSignal): Promise<LlmPingResult> {
  return apiGet<LlmPingResult>(
    `/api/llm/ping?probe=${encodeURIComponent(probe)}`,
    signal,
  )
}

export interface StreamProbeCallbacks {
  onChunk: (text: string) => void
  onDone: (payload: { model: string; provider: string; latency_ms: number }) => void
  onError: (message: string) => void
}

/**
 * 流式自测：边生成边回调。
 *
 * 为什么不用浏览器原生 EventSource：它是 GET-only，而提示词是中文长文本，
 * 放 query string 会被代理截断或编码出错，所以后端用 POST + text/event-stream，
 * 前端用 fetch + ReadableStream 手动解析 SSE 帧。
 */
export async function streamProbe(
  prompt: string,
  callbacks: StreamProbeCallbacks,
  signal?: AbortSignal,
): Promise<void> {
  const response = await fetch(apiUrl('/api/llm/stream'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt }),
    signal,
  })

  if (!response.ok || !response.body) {
    callbacks.onError(`流式请求失败（HTTP ${response.status}）`)
    return
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })

    // SSE 帧以空行分隔；可能一次读到半个帧，所以要按分隔符切完整帧
    const frames = buffer.split('\n\n')
    buffer = frames.pop() ?? ''

    for (const frame of frames) {
      const eventLine = frame.split('\n').find((line) => line.startsWith('event: '))
      const dataLine = frame.split('\n').find((line) => line.startsWith('data: '))
      if (!eventLine || !dataLine) continue
      const event = eventLine.slice(7).trim()
      const raw = dataLine.slice(6)
      try {
        const payload = JSON.parse(raw)
        if (event === 'chunk') callbacks.onChunk(payload.text ?? '')
        else if (event === 'done') callbacks.onDone(payload)
        else if (event === 'error') callbacks.onError(payload.message ?? '未知错误')
      } catch {
        // 单帧解析失败不应中断整条流
      }
    }
  }
}

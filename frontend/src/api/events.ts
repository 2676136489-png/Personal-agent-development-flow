import { apiGet, apiUrl } from './client'
import { RUN_EVENT_TYPES, isTerminalEvent, type RunEvent } from '../types/events'

/**
 * 订阅一次运行的 SSE 事件流。
 *
 * [P0] 为什么不用 `source.onmessage`：
 * 后端的每条事件都写了 `event: <type>` 字段（见 app/events/sse.py），
 * 浏览器会把这些当成「具名事件」分发，`onmessage` 只会收到没有 event 字段的默认消息。
 * 所以必须对每个已知类型逐个 addEventListener。
 */
export interface RunEventHandlers {
  onEvent: (event: RunEvent) => void
  onOpen?: () => void
  onError?: () => void
}

export function subscribeRunEvents(threadId: string, handlers: RunEventHandlers): EventSource {
  const source = new EventSource(apiUrl(`/api/graph/research/${threadId}/events`))
  const listener = (raw: MessageEvent<string>) => {
    let event: RunEvent
    try {
      event = JSON.parse(raw.data) as RunEvent
    } catch {
      // 只兜住「单条报文损坏」这一种情况，跳过它，不让整个事件流因此中断
      return
    }
    handlers.onEvent(event)
    if (isTerminalEvent(event.type)) {
      source.close()
    }
  }

  for (const type of RUN_EVENT_TYPES) {
    source.addEventListener(type, listener as EventListener)
  }
  source.onopen = () => handlers.onOpen?.()
  source.onerror = () => handlers.onError?.()

  return source
}

/**
 * [B37] 事件轮询：SSE 不可用时的替代通道。
 *
 * 为什么需要：云端网关会把 `text/event-stream` 整条响应缓冲住，
 * 连响应头都不下发 —— EventSource 永远停在 CONNECTING，前端只能手动刷新。
 * 这个接口是普通 JSON，不会被缓冲。
 */
export async function fetchRunEvents(
  threadId: string,
  afterId: number,
): Promise<{ events: RunEvent[]; lastId: number }> {
  const data = await apiGet<{ events: RunEvent[]; last_id: number }>(
    `/api/graph/runs/${threadId}/events?after=${afterId}`,
  )
  return { events: data.events ?? [], lastId: data.last_id ?? afterId }
}

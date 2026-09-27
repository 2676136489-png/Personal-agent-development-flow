import { useCallback, useRef, useState } from 'react'
import { fetchRunEvents, subscribeRunEvents } from '../../api/events'
import { isTerminalEvent, type RunEvent } from '../../types/events'

export type StreamStatus = 'idle' | 'connecting' | 'open' | 'error' | 'closed'

/** 事件通道类型：SSE 实时推送，或轮询拉取（网关缓冲 SSE 时的替代通道） */
export type StreamTransport = 'sse' | 'polling'

type Listener = {
  onEvent: (event: RunEvent) => void
  onOpen?: () => void
  onError?: () => void
  onTransport?: (transport: StreamTransport) => void
}

/**
 * [F5] 模块级连接管理器：一次运行对应**一条** SSE 连接，连接生命周期与组件
 * 挂载周期解耦。
 *
 * 之前连接由 useRunEvents 独占持有，组件卸载（切换导航）就 close()，
 * 于是页面文案写的「你可切到其他模块同步查看，进度不会中断」根本不成立 ——
 * 一切走就断流，回来只剩手动刷新。
 *
 * 现在：
 * - 组件只注册/注销「监听器」，不拥有连接
 * - 连接只在终态事件、显式 closeStream() 或切换到新 thread 时关闭
 * - 新加入的监听器会先拿到已缓存的事件，所以切回来时进度是完整的
 *
 * [B37] 轮询降级：云端反向代理会把 `text/event-stream` 整条响应缓冲住，
 * 连响应头都不下发 —— EventSource 的 onopen / onerror 都不会触发，
 * 前端永远停在「连接中…」，进度只能靠用户手点「刷新状态」。
 * 因此加一条看门狗：SSE 若在 SSE_OPEN_TIMEOUT_MS 内没打开，就主动关掉它、
 * 改用普通 JSON 接口拉事件（不会被任何网关缓冲）。
 */
const listeners = new Map<string, Set<Listener>>()
const sources = new Map<string, EventSource>()
const eventCache = new Map<string, RunEvent[]>()

/** 轮询定时器 / 已消费的最大事件 id / SSE 看门狗 / 当前通道 */
const pollTimers = new Map<string, number>()
const lastEventIds = new Map<string, number>()
const watchdogs = new Map<string, number>()
const transports = new Map<string, StreamTransport>()

/** SSE 若这么久还没走到 open，就判定为「被网关缓冲」，改用轮询 */
const SSE_OPEN_TIMEOUT_MS = 6000
const POLL_INTERVAL_MS = 2500

function broadcast(threadId: string, fn: (listener: Listener) => void): void {
  const snapshot = [...(listeners.get(threadId) ?? [])]
  for (const listener of snapshot) fn(listener)
}

/** 统一的事件入口：去重 → 广播 → 终态收尾。SSE 与轮询共用同一条链路。 */
function ingest(threadId: string, incoming: RunEvent[]): void {
  for (const event of incoming) {
    const cache = eventCache.get(threadId) ?? []
    if (cache.some((e) => e.id === event.id)) continue
    cache.push(event)
    eventCache.set(threadId, cache)
    lastEventIds.set(threadId, Math.max(lastEventIds.get(threadId) ?? 0, event.id))
    broadcast(threadId, (l) => l.onEvent(event))
    if (isTerminalEvent(event.type)) {
      closeStream(threadId)
      return
    }
  }
}

function startPolling(threadId: string): void {
  if (pollTimers.has(threadId)) return
  // 关掉那条永远连不上的 SSE：HTTP/1.1 下每个域名只有 6 个并发连接，
  // 让它挂着会挤掉后续轮询请求。
  sources.get(threadId)?.close()
  sources.delete(threadId)
  cancelWatchdog(threadId)

  const tick = async () => {
    try {
      const { events, lastId } = await fetchRunEvents(
        threadId,
        lastEventIds.get(threadId) ?? 0,
      )
      if (lastId) lastEventIds.set(threadId, Math.max(lastEventIds.get(threadId) ?? 0, lastId))
      ingest(threadId, events)
    } catch {
      // 单次拉取失败不打断轮询：下一次 tick 自然会重试
    }
  }

  void tick()
  pollTimers.set(threadId, window.setInterval(() => void tick(), POLL_INTERVAL_MS))
  transports.set(threadId, 'polling')
  broadcast(threadId, (l) => {
    l.onTransport?.('polling')
    l.onOpen?.()
  })
}

function cancelWatchdog(threadId: string): void {
  const timer = watchdogs.get(threadId)
  if (timer !== undefined) {
    window.clearTimeout(timer)
    watchdogs.delete(threadId)
  }
}

function attach(threadId: string): void {
  if (sources.has(threadId) || pollTimers.has(threadId)) return

  const source = subscribeRunEvents(threadId, {
    onOpen: () => {
      cancelWatchdog(threadId)
      transports.set(threadId, 'sse')
      broadcast(threadId, (l) => {
        l.onTransport?.('sse')
        l.onOpen?.()
      })
    },
    onEvent: (event) => ingest(threadId, [event]),
    // 明确报错（例如代理直接 502）也立刻切轮询，不必等看门狗超时
    onError: () => {
      broadcast(threadId, (l) => l.onError?.())
      startPolling(threadId)
    },
  })
  sources.set(threadId, source)

  watchdogs.set(
    threadId,
    window.setTimeout(() => startPolling(threadId), SSE_OPEN_TIMEOUT_MS),
  )
}

/** 关闭某个 thread 的连接并清空其监听器 */
export function closeStream(threadId: string): void {
  sources.get(threadId)?.close()
  sources.delete(threadId)
  const timer = pollTimers.get(threadId)
  if (timer !== undefined) {
    window.clearInterval(timer)
    pollTimers.delete(threadId)
  }
  cancelWatchdog(threadId)
  listeners.delete(threadId)
  eventCache.delete(threadId)
  transports.delete(threadId)
}

/** 切换到新的 thread：关掉其它连接，避免连接数无限增长 */
export function switchStream(threadId: string): void {
  for (const id of [...sources.keys(), ...pollTimers.keys()]) {
    if (id !== threadId) closeStream(id)
  }
}

function addListener(threadId: string, listener: Listener): () => void {
  const set = listeners.get(threadId) ?? new Set<Listener>()
  set.add(listener)
  listeners.set(threadId, set)

  // 补发已经收到的事件（刷新页面 / 切回本页时进度不丢）
  for (const event of eventCache.get(threadId) ?? []) listener.onEvent(event)

  // 通道早已就绪时不会再有 onOpen 回调，给新监听器补发一次，
  // 否则状态会停在「连接中…」
  const transport = transports.get(threadId)
  if (transport) {
    listener.onTransport?.(transport)
    listener.onOpen?.()
  } else if (sources.get(threadId)?.readyState === EventSource.OPEN) {
    listener.onOpen?.()
  }

  // 注意：取消订阅时刻意**不**关闭连接 —— 组件卸载不应中断后台运行
  return () => {
    listeners.get(threadId)?.delete(listener)
  }
}

/**
 * 订阅一次运行的事件流。
 *
 * 组件只负责渲染；连接由上面的模块级管理器持有，
 * 因此切换到其他页面再回来，进度是连续的。
 */
export function useRunEvents() {
  const [events, setEvents] = useState<RunEvent[]>([])
  const [status, setStatus] = useState<StreamStatus>('idle')
  const [transport, setTransport] = useState<StreamTransport | null>(null)
  const unsubscribeRef = useRef<(() => void) | null>(null)

  const close = useCallback(() => {
    unsubscribeRef.current?.()
    unsubscribeRef.current = null
  }, [])

  const subscribe = useCallback((threadId: string) => {
    unsubscribeRef.current?.()
    setEvents([])
    setStatus('connecting')
    setTransport(null)
    switchStream(threadId)

    unsubscribeRef.current = addListener(threadId, {
      onOpen: () => setStatus('open'),
      onTransport: (next) => setTransport(next),
      onEvent: (event) => {
        // 事件可能因重连/补发而重复，按 id 去重
        setEvents((prev) => (prev.some((e) => e.id === event.id) ? prev : [...prev, event]))
        if (isTerminalEvent(event.type)) {
          setStatus('closed')
        }
      },
      onError: () => setStatus((prev) => (prev === 'closed' ? prev : 'error')),
    })

    attach(threadId)
  }, [])

  return { events, status, transport, subscribe, close }
}

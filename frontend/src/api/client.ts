import type { ApiResponse } from '../types/api'

/**
 * [P0] 唯一的 HTTP 出口。
 *
 * 为什么要把 fetch 包一层，而不是在组件里直接 fetch：
 * 1. baseURL、错误处理、超时只写一次
 * 2. 组件里不需要关心响应是信封格式还是裸数据
 * 3. 以后要加鉴权头、重试、埋点，只改这一个文件
 */

/**
 * 后端地址。
 *
 * 默认用**同源**（空字符串 = 当前页面的 origin），而不是写死 localhost:8000。
 * 理由：线上是同端口部署（FastAPI 同时提供页面和 /api），此时相对路径天然
 * 正确，且不依赖部署域名——域名变了不用重新构建前端。
 *
 * 本地开发仍走 Vite dev server（5173）直连后端（8000），此时由
 * frontend/.env.local 里的 VITE_API_BASE_URL 覆盖成绝对地址。
 * 这个「开发用绝对、线上用相对」的分工就写在那份 env 文件里。
 */
const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? ''

/**
 * 供 UI **展示**用的后端地址。
 *
 * 与 `API_BASE_URL` 的区别：后者为空字符串时表示同源（请求时用相对路径，
 * 这是对的），但展示给用户看时空白会让人以为没配。这里把同源解析成
 * 实际的绝对地址，只用于显示和拼「打开 /api/health 试试」这类链接。
 */
export function apiBaseUrlForDisplay(): string {
  if (API_BASE_URL) return API_BASE_URL
  return typeof window === 'undefined' ? '' : window.location.origin
}

// [F1] 默认超时：启动一次研究工作流会跑 1~2 分钟，给足余量；
// 但也不能无限等，否则网络断开时 UI 会永远停在"执行中"。
const DEFAULT_TIMEOUT_MS = 300_000

/**
 * 拼出完整的后端地址。
 * SSE 用的是浏览器原生 EventSource，它不走 request()，需要绝对 URL。
 */
export function apiUrl(path: string): string {
  return `${API_BASE_URL}${path}`
}

/** 所有请求都会被包成这个错误抛出，组件只需要 catch 一种类型 */
export class ApiClientError extends Error {
  readonly code: string
  readonly status: number
  readonly details?: unknown

  constructor(params: { message: string; code: string; status: number; details?: unknown }) {
    super(params.message)
    this.name = 'ApiClientError'
    this.code = params.code
    this.status = params.status
    this.details = params.details
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

/** 把 HTTP 状态码翻译成用户能看懂的一句短语。 */
function describeStatus(status: number): string {
  if (status === 0) return '网络错误'
  if (status === 401) return '未授权'
  if (status === 403) return '无权限'
  if (status === 404) return '接口不存在'
  if (status === 408) return '服务端等待超时'
  if (status === 429) return '请求过于频繁'
  if (status === 502) return '网关错误'
  if (status === 504) return '网关超时'
  if (status >= 500) return `服务端错误（HTTP ${status}）`
  return `HTTP ${status}`
}

/** 额度类错误的详情（见后端 DailyRunBudgetMiddleware 的 details）。 */
interface BudgetDetails {
  /** 额度重置时刻（epoch 毫秒）。后端只回时间戳，由前端翻译成本地时间。 */
  reset_at_ms?: number
}

/** 把重置时刻渲染成「今天 23:59 / 明天 08:00 / 9 月 30 日 00:00」这种人话。 */
export function formatResetMoment(ms: number): string {
  const date = new Date(ms)
  if (Number.isNaN(date.getTime())) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`
  const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString()
  const now = new Date()
  if (sameDay(date, now)) return `今天 ${time}`
  const tomorrow = new Date(now.getTime())
  tomorrow.setDate(tomorrow.getDate() + 1)
  if (sameDay(date, tomorrow)) return `明天 ${time}`
  return `${date.getMonth() + 1} 月 ${date.getDate()} 日 ${time}`
}

/**
 * 给「每日运行预算用尽」这类额度错误补上恢复时刻。
 *
 * 后端有意只回 epoch 毫秒（它不知道也不该猜客户端时区），
 * 由这里翻译成本地时间 —— 用户最关心的是「几点能再用」。
 */
function decorateErrorMessage(code: string, message: string, details: unknown): string {
  if (code !== 'daily_budget_exceeded') return message
  const resetAt = (details as BudgetDetails | undefined)?.reset_at_ms
  if (typeof resetAt !== 'number') return message
  const moment = formatResetMoment(resetAt)
  return moment ? `${message}（${moment}恢复）` : message
}

/**
 * [F1] 把「外部 signal + 超时」合并成一个控制器。
 *
 * 之前这里只在注释里写了"用 AbortController 让请求可以被取消"，
 * 实际代码里根本没有创建过控制器：所有请求都无法取消、也没有超时，
 * 1~2 分钟的长请求在切换页面后仍会继续跑并尝试 setState。
 */
function withTimeout(
  external?: AbortSignal | null,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  const onExternalAbort = () => controller.abort()
  if (external) {
    if (external.aborted) controller.abort()
    else external.addEventListener('abort', onExternalAbort, { once: true })
  }

  const cleanup = () => {
    clearTimeout(timer)
    external?.removeEventListener('abort', onExternalAbort)
  }

  return { signal: controller.signal, cleanup }
}

/**
 * 统一解析响应信封，并把失败翻译成 `ApiClientError`。
 *
 * [F11] 关键改进：**先把 body 读成文本**，再尝试 JSON 解析。
 * 这样在「响应不是 JSON」时能拿到 HTTP 状态码 + Content-Type + 片段，
 * 给出可诊断的错误，而不是笼统一句"请确认 API_BASE_URL"。
 *
 * 现实中最常见的「非 JSON 响应」根因，是**网关/反向代理返回的 HTML 错误页**
 * （例如长时间请求被代理判定超时后返回 502/504 页面），其次才是接口地址不对。
 * 把这两种情况在文案里区分开，排障效率完全不同。
 */
async function parseEnvelope<T>(response: Response, path: string): Promise<T> {
  let raw = ''
  try {
    raw = await response.text()
  } catch {
    raw = ''
  }
  const contentType = response.headers.get('content-type') ?? ''

  let payload: ApiResponse<T> | null = null
  let parsed = false
  if (raw.trim()) {
    try {
      payload = JSON.parse(raw) as ApiResponse<T>
      parsed = true
    } catch {
      parsed = false
    }
  }

  // ① 不是 JSON（空 body / HTML 错误页 / 纯文本）
  if (!parsed) {
    const looksHtml = /^\s*<(?:!doctype|html)/i.test(raw)
    const cause = looksHtml
      ? '收到的是 HTML 页面，通常是网关/代理错误页（例如请求超时）或接口地址不对'
      : raw.trim()
        ? '响应体不是合法 JSON'
        : '响应体为空'
    const snippet = raw.replace(/\s+/g, ' ').trim().slice(0, 120)
    throw new ApiClientError({
      message:
        `后端返回了非 JSON 响应（${describeStatus(response.status)}` +
        `${contentType ? `，${contentType}` : ''}）：${cause}` +
        `${snippet ? `。响应片段：${snippet}` : ''}`,
      code: 'invalid_response',
      status: response.status,
      details: { path, contentType, snippet },
    })
  }

  // ② HTTP 状态码和 body 里的 success 都要看。
  // 后端保证 success=false 时一定带 error，但反过来 4xx/5xx 也可能带 error。
  if (!response.ok || !payload!.success) {
    const code = payload?.error?.code ?? 'http_error'
    throw new ApiClientError({
      message: decorateErrorMessage(
        code,
        payload?.error?.message ?? `请求失败（${describeStatus(response.status)}）`,
        payload?.error?.details,
      ),
      code,
      status: response.status,
      details: payload?.error?.details,
    })
  }

  if (payload!.data === null) {
    throw new ApiClientError({
      message: '后端返回了空的 data',
      code: 'empty_data',
      status: response.status,
    })
  }

  return payload!.data
}

async function request<T>(
  path: string,
  init?: RequestInit,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<T> {
  const { signal, cleanup } = withTimeout(init?.signal, timeoutMs)

  let response: Response
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      ...init,
      signal,
      headers: {
        Accept: 'application/json',
        ...init?.headers,
      },
    })
  } catch (error) {
    cleanup()
    if (isAbortError(error)) {
      throw new ApiClientError({
        message: '请求超时或已被取消，请重试',
        code: 'aborted',
        status: 0,
      })
    }
    // [F1] 网络层失败（后端未启动 / 断网）也要包成 ApiClientError，
    // 否则调用方 catch 到的是裸 TypeError，UI 无法给出可读提示。
    // [F11] 用 apiBaseUrlForDisplay() 而不是 API_BASE_URL：后者在同源部署下是
    //       空串，拼出来会变成「无法连接后端（），…」这种空括号。
    throw new ApiClientError({
      message: `无法连接后端（${apiBaseUrlForDisplay()}），请确认服务已启动`,
      code: 'network_error',
      status: 0,
    })
  }
  cleanup()

  return parseEnvelope<T>(response, path)
}

export function apiGet<T>(path: string, signal?: AbortSignal): Promise<T> {
  return request<T>(path, { method: 'GET', signal })
}

export function apiPost<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  return request<T>(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  })
}

export function apiDelete<T>(path: string, signal?: AbortSignal): Promise<T> {
  return request<T>(path, { method: 'DELETE', signal })
}

/** 文件上传：multipart 不能设置 Content-Type，交给浏览器自动带 boundary */
export async function apiUpload<T>(path: string, file: File): Promise<T> {
  const formData = new FormData()
  formData.append('file', file)
  const { signal, cleanup } = withTimeout(undefined, DEFAULT_TIMEOUT_MS)

  let response: Response
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      method: 'POST',
      body: formData,
      signal,
    })
  } catch (error) {
    if (isAbortError(error)) {
      throw new ApiClientError({ message: '上传超时', code: 'aborted', status: 0 })
    }
    throw new ApiClientError({
      message: `无法连接后端（${apiBaseUrlForDisplay()}）`,
      code: 'network_error',
      status: 0,
    })
  } finally {
    cleanup()
  }

  // [F7] 复用与 request() 相同的错误分支：非 JSON 响应不再抛裸 SyntaxError
  return parseEnvelope<T>(response, path)
}

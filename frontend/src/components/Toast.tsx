import { useEffect, useState } from 'react'

/**
 * 全局轻提示（Toast）。
 *
 * 为什么用「模块级单例 + 订阅」而不是 React Context：
 * 业务代码（发起研究、上传文件、刷新状态）散落在各个页面里，
 * 为了弹一个提示去层层传 props / 套 Provider 会污染所有组件签名。
 * 模块级单例让「任何地方一行 notify() 就能给反馈」，组件树零改动。
 *
 * 只做「操作结果的即时反馈」，不做阻塞式弹窗：
 * 错误详情仍然留在页面内的 ErrorState 里，这里只负责让用户知道「刚才那下生效了 / 失败了」。
 */

export type ToastTone = 'info' | 'ok' | 'error' | 'warn'

export interface ToastItem {
  id: number
  tone: ToastTone
  title: string
  desc?: string
}

type Listener = (items: ToastItem[]) => void

let items: ToastItem[] = []
let listeners: Listener[] = []
let seq = 0

/** 默认停留时长（ms）。带描述的提示给久一点，纯标题给短一点。 */
const DEFAULT_DURATION = 3600

function emit() {
  for (const listener of listeners) listener([...items])
}

export function notify(input: { tone?: ToastTone; title: string; desc?: string }): number {
  seq += 1
  const id = seq
  items = [...items, { id, tone: input.tone ?? 'info', title: input.title, desc: input.desc }]
  emit()
  window.setTimeout(() => dismiss(id), input.desc ? DEFAULT_DURATION + 1200 : DEFAULT_DURATION)
  return id
}

export function dismiss(id: number): void {
  items = items.filter((item) => item.id !== id)
  emit()
}

function subscribe(listener: Listener): () => void {
  listeners = [...listeners, listener]
  listener([...items])
  return () => {
    listeners = listeners.filter((l) => l !== listener)
  }
}

/** 在 App 根部挂一次即可（见 App.tsx 的 <ToastHost />） */
export function ToastHost() {
  const [list, setList] = useState<ToastItem[]>([])

  useEffect(() => subscribe(setList), [])

  if (list.length === 0) return null

  return (
    <div className="toast-host" role="status" aria-live="polite">
      {list.map((item) => (
        <div className="toast" data-tone={item.tone} key={item.id}>
          <span className="toast__bar" aria-hidden="true" />
          <div>
            <div className="toast__title">{item.title}</div>
            {item.desc && <div className="toast__desc">{item.desc}</div>}
            <button
              type="button"
              className="link-button stack-top-sm"
              onClick={() => dismiss(item.id)}
            >
              知道了
            </button>
          </div>
        </div>
      ))}
    </div>
  )
}

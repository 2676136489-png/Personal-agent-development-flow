import { Component, type ErrorInfo, type ReactNode } from 'react'

/**
 * 全局错误边界（上线必备）。
 *
 * 为什么必须有：React 在渲染阶段抛出的错误会**卸载整棵组件树** ——
 * 没有边界时，用户看到的是纯白屏，连导航都没有，只能手动改地址。
 * 有了它：任何一个页面的渲染崩溃最多影响那一屏，且给出「刷新 / 回首页」的出路。
 *
 * 为什么用 class：React 的错误边界只能是 class 组件
 * （`getDerivedStateFromError` / `componentDidCatch` 没有 hooks 等价物）。
 *
 * 刻意不依赖任何 app 上下文 / motion / 路由 —— 它要能在**最外层**兜住一切。
 */
interface ErrorBoundaryProps {
  children: ReactNode
}

interface ErrorBoundaryState {
  error: Error | null
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error }
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // 上报点：生产环境可在此接入监控（Sentry 等）；当前至少落到 console 便于排障。
    // 注意不要在这里 setState（会掩盖原始错误），getDerivedStateFromError 已处理状态。
    console.error('[ErrorBoundary] 渲染崩溃：', error, info.componentStack)
  }

  private handleReload = (): void => {
    window.location.reload()
  }

  private handleHome = (): void => {
    // 把会话内的页面记忆重置到概览，避免再次崩到同一个坏页面
    try {
      sessionStorage.setItem('arw-page', 'dashboard')
    } catch {
      // 存储被禁用：忽略，直接回首页
    }
    window.location.assign('/')
  }

  override render(): ReactNode {
    const { error } = this.state
    if (!error) return this.props.children

    return (
      <div className="crash" role="alert">
        <div className="crash__card">
          <span className="badge badge--error">页面出错</span>
          <h1 className="crash__title">界面遇到了一点问题</h1>
          <p className="crash__desc">
            这不影响已经生成的研究数据。可以先刷新重试；如果反复出现，请把下面的错误信息反馈给我们。
          </p>
          <pre className="crash__detail">{error.message || String(error)}</pre>
          <div className="crash__actions">
            <button type="button" className="button button--primary" onClick={this.handleReload}>
              刷新页面
            </button>
            <button type="button" className="button" onClick={this.handleHome}>
              回到首页
            </button>
          </div>
        </div>
      </div>
    )
  }
}

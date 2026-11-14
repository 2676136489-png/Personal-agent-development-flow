import { Suspense, lazy, useCallback, useEffect, useState } from 'react'
import { AnimatePresence, LazyMotion, domAnimation } from 'motion/react'
import { CloseIcon } from './components/icons'
import { ToastHost } from './components/Toast'
import { PageShell } from './components/PageShell'
import { ScrollProgress } from './components/ScrollProgress'
import { TripleRingSpinner } from './components/TripleRingSpinner'

/**
 * 页面级按需加载。
 *
 * 为什么用 React.lazy 而不是路由库：项目红线明确「不引入 react-router」。
 * SPA 只有 8 个静态页面，本来也不需要路由 —— 状态切页 + lazy 足够。
 * 首屏只下载「概览」（含 WebGL 立方体）相关代码，其余模块点开才加载；
 * three.js 因为只被概览页引用，会被切成独立 chunk，不进其他页面的包。
 */
const Dashboard = lazy(() =>
  import('./features/dashboard/Dashboard').then((m) => ({ default: m.Dashboard })),
)
const ResearchWorkflow = lazy(() =>
  import('./features/workflow/ResearchWorkflow').then((m) => ({ default: m.ResearchWorkflow })),
)
const KnowledgeBase = lazy(() =>
  import('./features/knowledge/KnowledgeBase').then((m) => ({ default: m.KnowledgeBase })),
)
const RagLab = lazy(() => import('./features/rag/RagLab').then((m) => ({ default: m.RagLab })))
const Tutorial = lazy(() => import('./features/tutorial/Tutorial').then((m) => ({ default: m.Tutorial })))
const Reports = lazy(() => import('./features/reports/Reports').then((m) => ({ default: m.Reports })))
const Evaluation = lazy(() =>
  import('./features/evaluation/Evaluation').then((m) => ({ default: m.Evaluation })),
)
const Settings = lazy(() => import('./features/settings/Settings').then((m) => ({ default: m.Settings })))

/** 空闲时预热「深度研究」（推荐入口），消掉首次点击的加载感 */
function usePrefetchPrimaryPage() {
  useEffect(() => {
    const warm = () => {
      void import('./features/workflow/ResearchWorkflow')
    }
    const idle = (window as unknown as { requestIdleCallback?: (cb: () => void) => number })
      .requestIdleCallback
    if (typeof idle === 'function') idle(warm)
    else window.setTimeout(warm, 1500)
  }, [])
}

/* ===================== 导航数据 ===================== */

export type PageKey =
  | 'dashboard'
  | 'workflow'
  | 'knowledge'
  | 'rag'
  | 'reports'
  | 'evaluation'
  | 'settings'
  | 'tutorial'

export interface NavItem {
  key: PageKey
  /** 导航显示文案 */
  label: string
  /** 目录里的英文名，与中文名一起构成双语条目 */
  en: string
}

/** 顶栏只放三个高频入口；其余全部收到目录里，保持导航只有一行 */
export const NAV_PRIMARY: NavItem[] = [
  { key: 'dashboard', label: '概览', en: 'Overview' },
  { key: 'workflow', label: '深度研究', en: 'Research' },
  { key: 'knowledge', label: '知识库', en: 'Library' },
]

export const NAV_ITEMS: NavItem[] = [
  { key: 'dashboard', label: '概览', en: 'Overview' },
  { key: 'workflow', label: '深度研究', en: 'Deep Research' },
  { key: 'knowledge', label: '知识库', en: 'Knowledge Base' },
  { key: 'rag', label: 'RAG 流程', en: 'Retrieval Lab' },
  { key: 'reports', label: '研究报告', en: 'Reports' },
  { key: 'evaluation', label: '效果评估', en: 'Evaluation' },
  { key: 'settings', label: '系统设置', en: 'Settings' },
  { key: 'tutorial', label: '使用教程', en: 'Guide' },
]

/* ===================== 会话内页面记忆 ===================== */

const PAGE_KEY = 'arw-page'
/** 白名单：只有 NAV_ITEMS 里出现过的 key 才可被恢复，避免存储被篡改后落到陌生页 */
const PAGE_KEYS: PageKey[] = NAV_ITEMS.map((i) => i.key)

function readStoredPage(): PageKey {
  try {
    const v = sessionStorage.getItem(PAGE_KEY)
    return v && (PAGE_KEYS as string[]).includes(v) ? (v as PageKey) : 'dashboard'
  } catch {
    return 'dashboard'
  }
}

/** `#/workflow` → 页面；非法值返回 null */
function readHashPage(): PageKey | null {
  const raw = window.location.hash.replace(/^#\/?/, '')
  const page = raw.split('?')[0]
  return page && (PAGE_KEYS as string[]).includes(page) ? (page as PageKey) : null
}

/** `#/reports?thread=xxx` → 要打开哪一次运行 */
function readHashThread(): string | null {
  const raw = window.location.hash.replace(/^#\/?/, '')
  const queryStart = raw.indexOf('?')
  if (queryStart < 0) return null
  const thread = new URLSearchParams(raw.slice(queryStart + 1)).get('thread')
  return thread && thread.trim() ? thread.trim() : null
}

export type NavigateFn = (key: string, threadId?: string) => void

/* ===================== 徽标 ===================== */

/**
 * 白色半圆的进化：外半圆减去内半圆，得到一枚粗半环。
 * 它保留老标记的「D」形轮廓，中间的空洞让它像镜头 / 光圈——
 * 从一块空白，变成一个有焦点的形状。单色、无渐变，16px 仍清晰。
 */
export function LogoMark() {
  return (
    <svg className="logo-mark" viewBox="0 0 18 36" aria-hidden="true" focusable="false">
      <path fillRule="evenodd" d="M0 0A18 18 0 0 1 0 36ZM0 9A9 9 0 0 1 0 27Z" />
    </svg>
  )
}

/* ===================== App ===================== */

export default function App() {
  const [page, setPage] = useState<PageKey>(() => readHashPage() ?? readStoredPage())
  const [focusThread, setFocusThread] = useState<string | null>(() => readHashThread())
  const [scrolled, setScrolled] = useState(false)
  const [indexOpen, setIndexOpen] = useState(false)
  usePrefetchPrimaryPage()

  // 页面记忆双写：sessionStorage 负责会话内恢复，hash 负责刷新 / 分享 / 后退
  useEffect(() => {
    try {
      sessionStorage.setItem(PAGE_KEY, page)
    } catch {
      /* 存储被禁用时静默降级 */
    }
    const target = focusThread
      ? `#/${page}?thread=${encodeURIComponent(focusThread)}`
      : `#/${page}`
    if (window.location.hash !== target) {
      window.history.pushState(null, '', target)
    }
  }, [page, focusThread])

  useEffect(() => {
    const syncFromHash = () => {
      const fromHash = readHashPage()
      if (fromHash) setPage(fromHash)
      setFocusThread(readHashThread())
    }
    window.addEventListener('popstate', syncFromHash)
    window.addEventListener('hashchange', syncFromHash)
    return () => {
      window.removeEventListener('popstate', syncFromHash)
      window.removeEventListener('hashchange', syncFromHash)
    }
  }, [])

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 12)
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  // 目录打开时锁滚动 + Esc 关闭
  useEffect(() => {
    if (!indexOpen) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setIndexOpen(false)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      document.body.style.overflow = prev
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [indexOpen])

  const clearFocusThread = useCallback(() => setFocusThread(null), [])

  const navigate: NavigateFn = (key, threadId) => {
    const item = NAV_ITEMS.find((i) => i.key === key)
    if (!item) return
    setPage(item.key)
    setFocusThread(threadId ?? null)
    setIndexOpen(false)
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  return (
    <LazyMotion features={domAnimation} strict>
      <div className="site-shell">
        <header className="nav" data-scrolled={scrolled}>
          <a
            className="logo"
            href="#/dashboard"
            aria-label="回到概览"
            onClick={(event) => {
              event.preventDefault()
              navigate('dashboard')
            }}
          >
            <LogoMark />
            <b>Research</b>
            <span>Workspace</span>
          </a>

          {/* 宽屏把所有页面平铺出来（用户明确要求「导航栏应该把这些写出来」）；
              窄到放不下时才收成 3 个主入口 + 目录。 */}
          <ul className="nav-links">
            {NAV_ITEMS.map((item) => {
              const primary = NAV_PRIMARY.some((entry) => entry.key === item.key)
              return (
                <li key={item.key} className={primary ? undefined : 'nav-links__extra'}>
                  <a
                    className="nav-link"
                    href={`#/${item.key}`}
                    data-active={page === item.key ? 'true' : 'false'}
                    aria-current={page === item.key ? 'page' : undefined}
                    onClick={(event) => {
                      event.preventDefault()
                      navigate(item.key)
                    }}
                  >
                    {item.label}
                  </a>
                </li>
              )
            })}
            <li className="nav-links__index">
              <button
                className="nav-index"
                type="button"
                onClick={() => setIndexOpen(true)}
                aria-expanded={indexOpen}
                aria-controls="site-index"
              >
                <span aria-hidden="true" />
                目录
              </button>
            </li>
          </ul>
        </header>

        {indexOpen && (
          <div className="index-layer" id="site-index" role="dialog" aria-modal="true" aria-label="全站目录">
            <div className="index-layer__head">
              <span className="logo">
                <LogoMark />
                <b>Research</b>
                <span>Workspace</span>
              </span>
              <button
                className="index-layer__close"
                type="button"
                aria-label="关闭目录"
                onClick={() => setIndexOpen(false)}
              >
                <CloseIcon size={17} />
              </button>
            </div>

            <ul className="index-list">
              {NAV_ITEMS.map((item, i) => (
                <li key={item.key}>
                  <button className="index-item" type="button" onClick={() => navigate(item.key)}>
                    <span className="index-item__no">{String(i + 1).padStart(2, '0')}</span>
                    <span className="index-item__label">{item.label}</span>
                    <span className="index-item__en">{item.en}</span>
                  </button>
                </li>
              ))}
            </ul>

            <div className="index-layer__foot">
              <span>AI Research Workspace</span>
              <span>Seven steps · Every source traceable</span>
            </div>
          </div>
        )}

        <ScrollProgress />

        <main className="main">
          <AnimatePresence mode="wait" initial={false}>
            <PageShell key={page}>
              <div className={page === 'dashboard' ? 'shell shell--full' : 'shell shell--tight'}>
                <Suspense
                  fallback={
                    <div className="loading-stage" role="status" aria-label="正在加载模块…">
                      <TripleRingSpinner size={64} />
                      <span className="loading-stage__label">正在加载模块…</span>
                    </div>
                  }
                >
                  {page === 'dashboard' && <Dashboard onNavigate={navigate} />}
                  {page === 'workflow' && <ResearchWorkflow focusThread={focusThread} />}
                  {page === 'knowledge' && <KnowledgeBase onNavigate={navigate} />}
                  {page === 'rag' && <RagLab />}
                  {page === 'tutorial' && <Tutorial onNavigate={navigate} />}
                  {page === 'reports' && (
                    <Reports
                      focusThread={focusThread}
                      onFocusConsumed={clearFocusThread}
                      onOpenReport={(threadId) => navigate('reports', threadId)}
                    />
                  )}
                  {page === 'evaluation' && <Evaluation onNavigate={navigate} />}
                  {page === 'settings' && <Settings />}
                </Suspense>
              </div>
            </PageShell>
          </AnimatePresence>
        </main>

        <ToastHost />
      </div>
    </LazyMotion>
  )
}

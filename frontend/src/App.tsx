import { Suspense, lazy, useCallback, useEffect, useState } from 'react'
import { AnimatePresence, LazyMotion, domAnimation } from 'motion/react'
import { ChevronDownIcon, CloseIcon, MenuIcon, MoonIcon, SunIcon } from './components/icons'
import { ToastHost } from './components/Toast'
import { PageShell } from './components/PageShell'
import { ScrollProgress } from './components/ScrollProgress'
import { LoadingState } from './components/LoadingState'

/**
 * 页面级按需加载。
 *
 * 为什么用 React.lazy 而不是路由库：项目红线明确「不引入 react-router」。
 * 而 SPA 只有 9 个静态页面，本来也不需要路由 —— 用状态切页 + lazy 就够了。
 * 收益：首屏只下载「概览」相关的代码，报告/教程/设置等模块点开才加载。
 */
const Dashboard = lazy(() =>
  import('./features/dashboard/Dashboard').then((m) => ({ default: m.Dashboard })),
)
const ResearchWorkflow = lazy(() =>
  import('./features/workflow/ResearchWorkflow').then((m) => ({ default: m.ResearchWorkflow })),
)
const ResearchPlanner = lazy(() =>
  import('./features/research/ResearchPlanner').then((m) => ({ default: m.ResearchPlanner })),
)
const AgentRunner = lazy(() =>
  import('./features/agent/AgentRunner').then((m) => ({ default: m.AgentRunner })),
)
const KnowledgeBase = lazy(() =>
  import('./features/knowledge/KnowledgeBase').then((m) => ({ default: m.KnowledgeBase })),
)
const Tutorial = lazy(() =>
  import('./features/tutorial/Tutorial').then((m) => ({ default: m.Tutorial })),
)
const Reports = lazy(() =>
  import('./features/reports/Reports').then((m) => ({ default: m.Reports })),
)
const Evaluation = lazy(() =>
  import('./features/evaluation/Evaluation').then((m) => ({ default: m.Evaluation })),
)
const Settings = lazy(() =>
  import('./features/settings/Settings').then((m) => ({ default: m.Settings })),
)

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

/**
 * 顶栏导航 + 内容区。
 *
 * 响应式（纯 CSS 断点，除抽屉开合外无额外状态）：
 *  - ≥1200px：组标签可见，9 项平铺在 3 组内；
 *  - 1024–1199px：隐藏组标签，只留组间竖线；
 *  - 768–1023px：顶栏只留 NAV_CORE_KEYS 三项 +「更多」下拉（3 组标题 + 全部 9 项）；
 *  - <768px：汉堡按钮 + 移动抽屉（唯一的 navOpen state，9 项 + 3 组标题）。
 */

/* ===================== 导航数据结构（S1 / §2.1） ===================== */

export type PageKey =
  | 'dashboard' | 'workflow' | 'research' | 'agent' | 'knowledge'
  | 'reports' | 'evaluation' | 'settings' | 'tutorial'

/** 视觉层级：家 / 主推 / 次（开发者向也用次） */
export type NavTier = 'home' | 'primary' | 'secondary'

export interface NavItem {
  key: PageKey
  /** 导航显示文案（唯一可改名的地方） */
  label: string
  /** 视觉层级 */
  tier: NavTier
  /** 推荐角标（只有 workflow 为 true） */
  recommend?: boolean
  /** 命令面板 / 抽屉的补充说明（可选） */
  hint?: string
}

export interface NavGroup {
  id: 'home' | 'research' | 'results' | 'system'
  /** 组标签文案；'home' 为空字符串（顶栏不渲染标签，见 Q2） */
  label: string
  items: NavItem[]
}

export const NAV_GROUPS: NavGroup[] = [
  { id: 'home', label: '', items: [
    { key: 'dashboard', label: '概览', tier: 'home' },
  ]},
  { id: 'research', label: '研究', items: [
    { key: 'workflow', label: '深度研究', tier: 'primary', recommend: true, hint: '推荐入口' },
    { key: 'research', label: '研究规划', tier: 'secondary' },
    { key: 'agent', label: '智能体', tier: 'secondary' },
    { key: 'knowledge', label: '知识库', tier: 'secondary' },
  ]},
  { id: 'results', label: '结果', items: [
    { key: 'reports', label: '研究报告', tier: 'secondary' },
    { key: 'evaluation', label: '效果评估', tier: 'secondary', hint: '开发者向' },
  ]},
  { id: 'system', label: '系统', items: [
    { key: 'settings', label: '系统设置', tier: 'secondary', hint: '开发者向' },
    { key: 'tutorial', label: '使用教程', tier: 'secondary' },
  ]},
]

/** 扁平索引：保持 NAV_ITEMS 的既有用法（navigate() 查找等）不变 */
export const NAV_ITEMS: NavItem[] = NAV_GROUPS.flatMap((g) => g.items)

/**
 * 768–1023px 顶栏保留项。不在本列表中的组，在该档位整组不渲染。
 * ⚠️ M7：严格等于 ['dashboard','workflow','reports']，不要增删。
 */
const NAV_CORE_KEYS: PageKey[] = ['dashboard', 'workflow', 'reports']

/**
 * 抽屉是「全量说明」场景，家的组标签也要出（NAV_GROUPS 里 home.label 为空字符串）。
 * 见 §2.1 Q2 与 §2.5。
 */
const DRAWER_GROUP_LABEL: Partial<Record<NavGroup['id'], string>> = { home: '概览' }

/* 图标统一见 src/components/icons.tsx（§5.1 B1）：本文件不再自行声明 svg 图标 */

/* ===================== 会话内页面记忆（§2.6） ===================== */

const PAGE_KEY = 'arw-page'
/** 白名单：只有 NAV_ITEMS 里出现过的 key 才可被恢复，避免存储被篡改后落到陌生页 */
const PAGE_KEYS: PageKey[] = NAV_ITEMS.map((i) => i.key)

/** 读取：非法值一律回落 'dashboard'，绝不信任存储内容 */
function readStoredPage(): PageKey {
  try {
    const v = sessionStorage.getItem(PAGE_KEY)
    return v && (PAGE_KEYS as string[]).includes(v) ? (v as PageKey) : 'dashboard'
  } catch {
    // 隐私模式 / 禁用存储
    return 'dashboard'
  }
}

/**
 * 从 URL hash（`#/workflow`）解析页面：让页面可刷新、可分享、可后退。
 *
 * 为什么用 hash 而不是引入路由库：项目红线是「不引入 react-router」，
 * 而 9 个静态页面只需要一个「当前页」标识 —— hash 零依赖，且天然兼容
 * 后端的 SPA fallback（任何路径都回落 index.html）。非法值返回 null。
 */
function readHashPage(): PageKey | null {
  const raw = window.location.hash.replace(/^#\/?/, '')
  const page = raw.split('?')[0]
  return page && (PAGE_KEYS as string[]).includes(page) ? (page as PageKey) : null
}

/**
 * 从 URL hash 解析「要打开哪一次运行」：`#/reports?thread=thread_xxx`。
 *
 * [F11] 效果评估页的「最近运行」需要能跳到具体某一次运行 ——
 * 但只有页面标识不足以表达「打开哪一条」，所以给 hash 加一个可选的 thread 参数。
 * 这样链接可分享、可刷新、可后退，和既有的「hash 即状态」设计一致，依然零依赖。
 */
function readHashThread(): string | null {
  const raw = window.location.hash.replace(/^#\/?/, '')
  const queryStart = raw.indexOf('?')
  if (queryStart < 0) return null
  const thread = new URLSearchParams(raw.slice(queryStart + 1)).get('thread')
  return thread && thread.trim() ? thread.trim() : null
}

/** 跨页跳转用的导航签名：可选的 threadId 表示「并且打开这一次运行」 */
export type NavigateFn = (key: string, threadId?: string) => void

/* ===================== 共用的导航项渲染（§2.5） ===================== */

interface NavLinkButtonProps {
  item: NavItem
  page: PageKey
  /** 是否标记 data-core="true"（决定 768–1023 档位顶栏是否保留） */
  core: boolean
  onNavigate: (key: string) => void
}

/** 三个容器（顶栏 / 更多下拉 / 抽屉）共用同一份渲染，零分支 */
function NavLinkButton({ item, page, core, onNavigate }: NavLinkButtonProps) {
  const active = item.key === page
  const cls = [
    'nav-link',
    item.tier === 'primary' ? 'nav-link--primary' : '',
    item.key === 'evaluation' || item.key === 'settings' ? 'nav-link--dev' : '',
    active ? 'nav-link--active' : '',
  ].filter(Boolean).join(' ')

  return (
    <button
      type="button"
      className={cls}
      data-core={core ? 'true' : 'false'}
      aria-current={active ? 'page' : undefined}
      onClick={() => onNavigate(item.key)}
    >
      {item.label}
      {item.recommend && <span className="nav-link__badge">推荐</span>}
      {item.hint && <span className="nav-link__hint">{item.hint}</span>}
    </button>
  )
}

/* ===================== App ===================== */

export default function App() {
  // 初始页：优先 URL hash（分享链接 / 刷新），其次 sessionStorage（会话内记忆）；
  // 写入统一放在 effect 里，避免首帧把 'dashboard' 写回去
  const [page, setPage] = useState<PageKey>(() => readHashPage() ?? readStoredPage())
  // [F11] 深链目标：`#/reports?thread=xxx` 要求目标页打开这一次运行
  const [focusThread, setFocusThread] = useState<string | null>(() => readHashThread())
  const [theme, setTheme] = useState<'light' | 'dark'>(
    () => (localStorage.getItem('arw-theme') as 'light' | 'dark') || 'light',
  )
  const [scrolled, setScrolled] = useState(false)
  usePrefetchPrimaryPage()
  // 唯一的 UI 状态：移动端抽屉开合
  const [navOpen, setNavOpen] = useState(false)

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    localStorage.setItem('arw-theme', theme)
  }, [theme])

  // 页面记忆双写（§2.6 扩展）：sessionStorage 负责会话内恢复，
  // URL hash 负责刷新 / 分享 / 后退 —— 用 pushState 而非改 location.hash，
  // 既不触发 hashchange（避免与下面的监听自回环），又能留下后退历史。
  useEffect(() => {
    try {
      sessionStorage.setItem(PAGE_KEY, page)
    } catch {
      // 存储被禁用时静默降级
    }
    const target = focusThread
      ? `#/${page}?thread=${encodeURIComponent(focusThread)}`
      : `#/${page}`
    if (window.location.hash !== target) {
      window.history.pushState(null, '', target)
    }
  }, [page, focusThread])

  // 浏览器后退/前进（popstate）与手动改 hash（hashchange）：一律跟随 URL
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

  // 抽屉开启时：锁定 body 滚动 + Esc 关闭；视口放大回桌面档时自动收起（避免滚动锁残留）
  useEffect(() => {
    if (!navOpen) return
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setNavOpen(false)
    }
    const mq = window.matchMedia('(min-width: 768px)')
    const onViewportChange = () => {
      if (mq.matches) setNavOpen(false)
    }
    window.addEventListener('keydown', onKeyDown)
    mq.addEventListener('change', onViewportChange)

    return () => {
      document.body.style.overflow = prevOverflow
      window.removeEventListener('keydown', onKeyDown)
      mq.removeEventListener('change', onViewportChange)
    }
  }, [navOpen])

  /** 深链目标已处理完：清掉它（同时把 URL 里的 ?thread= 去掉） */
  const clearFocusThread = useCallback(() => setFocusThread(null), [])

  /**
   * 切换页面。
   *
   * [F11] 第二个参数 threadId：带上它表示「跳到该页面并打开这一次运行」
   * （效果评估页的最近运行列表就是靠它实现「点一条 → 直接看到那条」）。
   * 不传即普通导航，同时清掉上一次的深链目标，避免旧目标在新页面上残留生效。
   */
  const navigate: NavigateFn = (key, threadId) => {
    const item = NAV_ITEMS.find((i) => i.key === key)
    if (item) {
      setPage(item.key)
      setFocusThread(threadId ?? null)
      window.scrollTo({ top: 0, behavior: 'smooth' })
    }
  }

  /** 抽屉内点击后：导航并收起抽屉 */
  const navigateAndClose = (key: string) => {
    navigate(key)
    setNavOpen(false)
  }

  /** 该组是否含 core 项（顶栏整组跳过，避免出现「空组 + 空竖线」） */
  const hasCore = (group: NavGroup) => group.items.some((item) => NAV_CORE_KEYS.includes(item.key))

  return (
    <LazyMotion features={domAnimation} strict>
    <div className="site-shell">
      <header className="global-nav" data-scrolled={scrolled}>
        <div className="nav-inner">
          <a
            className="nav-brand"
            href="#"
            onClick={(e) => {
              e.preventDefault()
              navigate('dashboard')
            }}
          >
            <span className="nav-logo">ARW</span>
            AI 研究工作台
          </a>

          {/* ≥768px 顶栏：渲染全部分组；含 core 项的组打 data-core="true"、整组无 core 的组
              （如「系统」）打 data-has-core="false"，由 responsive.css 在 ≤1023px 隐藏其整组，
              避免「空组 + 孤立竖线」。≤1023px 非 core 单项也隐藏，仅留 core 三项 + 「更多」下拉。
              「更多」下拉始终渲染全部 9 项，确保 768–1023px 仍可到达系统设置 / 教程。
              注意：≥1024px 时整组都渲染（含系统组），否则桌面端将完全无法访问设置/教程。 */}
          <nav className="nav-menu" aria-label="主导航">
            {NAV_GROUPS.map((group) => (
              <div
                className="nav-group"
                data-group={group.id}
                data-has-core={hasCore(group) ? 'true' : 'false'}
                key={group.id}
              >
                {group.label && (
                  <span className="nav-group__label" aria-hidden="true">{group.label}</span>
                )}
                {group.items.map((item) => (
                  <NavLinkButton
                    key={item.key}
                    item={item}
                    page={page}
                    core={NAV_CORE_KEYS.includes(item.key)}
                    onNavigate={navigate}
                  />
                ))}
              </div>
            ))}
          </nav>

          {/* 平板档（768–1023px）「更多」下拉：纯 CSS 展开，无 state。
              内部按组展示全部 9 项（含组标题），是用户第一次学到分组心智的地方。 */}
          <div className="nav-more">
            <button className="nav-link nav-more__btn" type="button" aria-haspopup="true">
              更多
              <span className="nav-more__caret" aria-hidden="true"><ChevronDownIcon /></span>
            </button>
            <div className="nav-more__menu">
              <nav className="nav-more__groups" aria-label="更多导航">
                {NAV_GROUPS.map((group) => (
                  <div className="nav-more__group" key={group.id}>
                    <div className="nav-more__label" aria-hidden="true">{group.label || DRAWER_GROUP_LABEL[group.id] || ''}</div>
                    {group.items.map((item) => (
                      <NavLinkButton
                        key={item.key}
                        item={item}
                        page={page}
                        core={false}
                        onNavigate={navigate}
                      />
                    ))}
                  </div>
                ))}
              </nav>
            </div>
          </div>

          <div className="nav-actions">
            <button
              className="nav-icon"
              type="button"
              aria-label={theme === 'light' ? '切换到深色外观' : '切换到浅色外观'}
              onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')}
            >
              {theme === 'light' ? <MoonIcon size={17} /> : <SunIcon size={17} />}
            </button>

            <button
              className="nav-toggle"
              type="button"
              aria-label="打开导航菜单"
              aria-expanded={navOpen}
              aria-controls="nav-drawer"
              onClick={() => setNavOpen(true)}
            >
              <MenuIcon size={18} />
            </button>
          </div>
        </div>
      </header>

      {/* 移动抽屉（<768px 才会被打开；纯 CSS 断点控制显隐，无额外状态） */}
      {navOpen && (
        <div className="nav-drawer-layer">
          <button className="nav-scrim" type="button" aria-label="关闭导航菜单" onClick={() => setNavOpen(false)} />
          <aside id="nav-drawer" className="nav-drawer" role="dialog" aria-modal="true" aria-label="主导航">
            <div className="nav-drawer__head">
              <span className="nav-drawer__title">导航</span>
              <button className="nav-icon" type="button" aria-label="关闭" onClick={() => setNavOpen(false)}>
                <CloseIcon size={18} />
              </button>
            </div>
            {NAV_GROUPS.map((group) => (
              <div className="nav-drawer__group" key={group.id}>
                <div className="nav-drawer__label">
                  {group.label || DRAWER_GROUP_LABEL[group.id] || ''}
                </div>
                {group.items.map((item) => (
                  <NavLinkButton
                    key={item.key}
                    item={item}
                    page={page}
                    core={false}
                    onNavigate={navigateAndClose}
                  />
                ))}
              </div>
            ))}
          </aside>
        </div>
      )}

      <ScrollProgress />

      <main className="main">
        {/* AnimatePresence + key：切页时先播离场再播入场，避免两页内容重叠闪烁 */}
        <AnimatePresence mode="wait" initial={false}>
          <PageShell key={page}>
            <div className="shell shell--tight">
              <Suspense
                fallback={<LoadingState variant="card" rows={4} label="正在加载模块…" />}
              >
                {page === 'dashboard' && <Dashboard onNavigate={navigate} />}
                {page === 'workflow' && <ResearchWorkflow focusThread={focusThread} />}
                {page === 'research' && <ResearchPlanner onNavigate={navigate} />}
                {page === 'agent' && <AgentRunner />}
                {page === 'knowledge' && <KnowledgeBase />}
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

      {/* 全局轻提示：任何模块一行 notify() 即可给出操作反馈 */}
      <ToastHost />
    </div>
    </LazyMotion>
  )
}

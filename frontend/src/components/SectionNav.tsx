import { useEffect, useState } from 'react'

/**
 * 滚动监听目录（scrollspy）。
 *
 * iGEM 获奖 wiki 的长文档几乎都有的「右侧 sticky 目录 + 当前章节高亮」。
 * 纯 IntersectionObserver 实现，零依赖；点击平滑滚动到对应锚点，并同步地址栏 hash。
 */
export interface SectionNavItem {
  id: string
  label: string
}

export function SectionNav({
  items,
  title = '本页内容',
}: {
  items: SectionNavItem[]
  title?: string
}) {
  const [active, setActive] = useState(items[0]?.id ?? '')

  useEffect(() => {
    if (items.length === 0) return
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)
        if (visible[0]) setActive(visible[0].target.id)
      },
      // 让「当前章节」判定落在视口上半部，而非刚冒头就切
      { rootMargin: '-18% 0px -72% 0px', threshold: 0 },
    )
    for (const item of items) {
      const el = document.getElementById(item.id)
      if (el) observer.observe(el)
    }
    return () => observer.disconnect()
  }, [items])

  const go = (e: React.MouseEvent<HTMLAnchorElement>, id: string) => {
    e.preventDefault()
    const el = document.getElementById(id)
    if (!el) return
    el.scrollIntoView({ behavior: 'smooth', block: 'start' })
    history.replaceState(null, '', `#${id}`)
  }

  return (
    <nav className="section-nav" aria-label={title}>
      <p className="section-nav__title">{title}</p>
      <ul>
        {items.map((item) => (
          <li key={item.id}>
            <a
              href={`#${item.id}`}
              className={active === item.id ? 'is-active' : ''}
              aria-current={active === item.id ? 'true' : undefined}
              onClick={(e) => go(e, item.id)}
            >
              {item.label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  )
}

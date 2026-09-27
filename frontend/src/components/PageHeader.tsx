import type { ReactNode } from 'react'

/**
 * PageHeader —— 全站统一的页头。
 *
 * 解决的具体问题：之前每个模块只有「一行标题 + 一句副标题」，
 * 用户切进来之后不知道这个模块能干什么、该怎么用，只能靠猜。
 * 现在页头固定承载四件事：
 *   ① eyebrow（模块分类） ② 标题 ③ 一句话说明 ④ 右侧「能做什么 / 怎么用 / 注意」
 *
 * 固定结构带来的好处：所有页面的说明在**同一个位置**，扫一眼就能找到，
 * 不用在每个页面里重新学习说明放在哪。
 */

export interface PageHeaderNote {
  term: string
  desc: string
}

interface PageHeaderProps {
  /** 模块分类（等宽小字，如「深度研究」） */
  eyebrow: string
  title: string
  /** 一句话说明这个模块解决什么问题 */
  lede: string
  /** 右侧说明卡：建议 2–3 条（能做什么 / 怎么用 / 注意） */
  notes?: PageHeaderNote[]
  /** 标题右侧的状态区（徽标、按钮等） */
  actions?: ReactNode
}

export function PageHeader({ eyebrow, title, lede, notes, actions }: PageHeaderProps) {
  return (
    <header className="page-head">
      <div className="page-head__grid">
        <div>
          <p className="eyebrow eyebrow--flush">
            {eyebrow}
          </p>
          <h2 className="page-head__title">{title}</h2>
          <p className="page-head__lede">{lede}</p>
        </div>
        <div className="grid-start">
          {actions}
          {notes && notes.length > 0 && (
            <dl className="page-head__notes">
              {notes.map((note) => (
                <div className="page-head__note" key={note.term}>
                  <dt>{note.term}</dt>
                  <dd>{note.desc}</dd>
                </div>
              ))}
            </dl>
          )}
        </div>
      </div>
    </header>
  )
}

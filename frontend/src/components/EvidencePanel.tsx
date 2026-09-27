import type { ResearchRun } from '../types/graph'

/**
 * EvidencePanel —— 「内容分析的结果 + 依据来源」。
 *
 * 为什么要单独做这个组件：研究类产品的可信度来自**可溯源**，
 * 而不是结论写得多漂亮。之前结论和来源是两块互不相干的折叠卡，
 * 用户看到一条结论时不知道它对应哪条证据。
 *
 * 现在把两者放进同一个视图：
 *   ① 分析结论（编号 + 原文）
 *   ② 证据缺口（明说哪些地方没查到 —— 这是诚实度的一部分）
 *   ③ 依据来源（每条都能点开原始 URL，标明来自联网搜索还是知识库）
 */

export interface SourceItem {
  id: string
  title: string
  url: string
  snippet: string
  /** 来源类型：联网搜索 / 知识库文档 */
  origin: 'web' | 'knowledge'
  /** 附加元信息（文件名 / 页码 / 相关度） */
  meta?: string
}

/**
 * 把后端结构化好的来源映射成组件可用的形状。
 *
 * ⚠️ 这里**不做任何解析**：来源由后端 `app/graph/sources.py` 产出
 * （联网搜索会解析 search_web 的 JSON，知识库会转换 citations），
 * 前端只负责渲染。之前前端自己 `JSON.parse(tool_calls[].output_preview)`
 * 是错的——那个字段只存在于 Agent 路径，深度研究的 tool_calls 里根本没有。
 */
export function collectSources(run: ResearchRun): SourceItem[] {
  return run.sources.map((source, index) => ({
    id: source.url || `${source.origin}-${index}`,
    title: source.title || source.url || '未命名来源',
    url: source.url,
    snippet: source.snippet,
    origin: source.origin === 'knowledge' ? 'knowledge' : 'web',
    meta: source.source || undefined,
  }))
}

const ORIGIN_LABEL: Record<SourceItem['origin'], string> = {
  web: '联网搜索',
  knowledge: '知识库',
}

function hostname(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

interface EvidencePanelProps {
  findings: string[]
  gaps: string[]
  sources: SourceItem[]
}

export function EvidencePanel({ findings, gaps, sources }: EvidencePanelProps) {
  return (
    <div className="result-stack">
      <div className="card card--pad">
        <div>
          <p className="eyebrow eyebrow--flush">
            内容分析
          </p>
          <h3 className="title-sm">
            结论与依据
          </h3>
          <p className="hint note-line">
            结论末尾的 [证据N] 是分析阶段的内部证据编号；可逐条点开核对的原始页面见下方「依据来源」。
            缺口一节明说哪些问题没有被证据覆盖 —— 结论的适用范围以此为准。
          </p>
        </div>

        {findings.length > 0 && (
          <div>
            <div className="plan__heading">核心结论（{findings.length}）</div>
            <ol className="data-list stack-top-sm">
              {findings.map((finding, i) => (
                <li className="data-list__item" key={i}>
                  <span className="data-list__bullet" />
                  <span className="data-list__text">{finding}</span>
                </li>
              ))}
            </ol>
          </div>
        )}

        {gaps.length > 0 && (
          <div>
            <div className="plan__heading">证据缺口（{gaps.length}）</div>
            <p className="hint note-line note-line--before">
              这些地方没查到足够证据，结论的置信度因此受限：
            </p>
            <ul className="data-list">
              {gaps.map((gap, i) => (
                <li className="data-list__item" key={i}>
                  <span className="data-list__bullet" />
                  <span className="data-list__text">{gap}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div>
          <div className="plan__heading">依据来源（{sources.length}）</div>
          {sources.length === 0 ? (
            <p className="hint note-line">
              本次运行没有留下可展示的来源（可能是离线语料，或检索被跳过）。
            </p>
          ) : (
            <div className="evidence stack-top-sm">
              {sources.map((source, i) => (
                <div className="evidence__item" key={source.id}>
                  <span className="evidence__no">{i + 1}</span>
                  <div>
                    <div className="evidence__title">
                      {source.url ? (
                        <a
                          className="evidence__link"
                          href={source.url}
                          target="_blank"
                          rel="noreferrer noopener"
                        >
                          {source.title}
                        </a>
                      ) : (
                        source.title
                      )}
                    </div>
                    {source.snippet && <p className="evidence__quote">{source.snippet}</p>}
                    <div className="evidence__meta">
                      <span className="badge badge--info">{ORIGIN_LABEL[source.origin]}</span>
                      {source.url && <span>{hostname(source.url)}</span>}
                      {source.meta && <span>{source.meta}</span>}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

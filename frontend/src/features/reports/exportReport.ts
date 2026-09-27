/**
 * 报告导出：Markdown / Word / PDF 三种格式，全部纯前端实现，零新增依赖。
 *
 * 为什么不做后端导出：
 * - PDF 后端生成（reportlab 等）需要中文字体，沙箱里没有，出来全是方块；
 *   浏览器打印通道天然带全部字体与排版，质量最好。
 * - Word 用「HTML + msword MIME」是 Word 官方兼容的打开方式，中文无忧。
 * - 用户数据不出浏览器，也少一次网络往返。
 *
 * 覆盖面说明：markdownToHtml 是极简转换器，只处理我们报告 prompt 契约里
 * 出现的格式（## 标题、- 列表、1. 列表、**加粗**、段落），不追求完整 GFM。
 * 原始 Markdown 永远以 .md 下载为准 —— 那是无损的源文本。
 */

export interface ExportableReport {
  title: string
  summary: string
  sections: { heading: string; content: string }[]
  limitations: string[]
}

/** 附录里的一条依据来源：让导出文件离开系统后仍能点回原文 */
export interface ExportSource {
  title: string
  url: string
  origin?: 'web' | 'knowledge'
  /** 附加元信息（文件名 / 页码 / 相关度），仅知识库来源有 */
  meta?: string
}

/** 报告所属的研究问题，写进文档头，让导出的文件离开系统也能读懂上下文 */
export interface ExportMeta {
  question?: string
  generatedAt?: string
  /** 依据来源清单（来自 run.sources）；为空则不生成附录 */
  sources?: ExportSource[]
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

// ---------------------------------------------------------------- Markdown

export function reportToMarkdown(report: ExportableReport, meta: ExportMeta = {}): string {
  const lines: string[] = [`# ${report.title || '研究报告'}`, '']
  if (meta.question) lines.push(`> 研究问题：${meta.question}`, '')
  lines.push(`> 生成时间：${meta.generatedAt ?? new Date().toLocaleString()}`, '')

  if (report.summary.trim()) {
    lines.push('## 摘要', '', report.summary.trim(), '')
  }
  for (const section of report.sections) {
    lines.push(`## ${section.heading}`, '', section.content.trim(), '')
  }
  if (report.limitations.length > 0) {
    lines.push('## 局限', '')
    report.limitations.forEach((item, i) => lines.push(`${i + 1}. ${item}`))
    lines.push('')
  }
  const sources = meta.sources ?? []
  if (sources.length > 0) {
    lines.push('## 附录：依据来源', '', '> 以下为本次研究实际检索到的来源，按展示顺序列出。', '')
    sources.forEach((source, i) => {
      const label =
        source.origin === 'knowledge' && source.meta
          ? `${source.title}（知识库 · ${source.meta}）`
          : source.title
      lines.push(source.url ? `${i + 1}. [${label}](${source.url})` : `${i + 1}. ${label}`)
    })
    lines.push('')
  }
  return lines.join('\n')
}

// ---------------------------------------------------------------- HTML（Word / PDF 共用）

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** 行内格式：**加粗** → <strong>（先转义再替换，HTML 注入安全） */
function inlineFormat(text: string): string {
  return escapeHtml(text).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
}

/**
 * 极简 Markdown → HTML：只覆盖报告契约内的格式。
 * 块级：##/### 标题、- 无序列表、1. 有序列表、普通段落；
 * 行内：**加粗**。
 */
export function markdownToHtml(markdown: string): string {
  const lines = markdown.replace(/\\n/g, '\n').split('\n')
  const html: string[] = []
  let listType: 'ul' | 'ol' | null = null

  const closeList = () => {
    if (listType) {
      html.push(`</${listType}>`)
      listType = null
    }
  }

  for (const raw of lines) {
    const line = raw.trimEnd()
    const heading = /^(#{2,4})\s+(.*)$/.exec(line)
    const unordered = /^[-*]\s+(.*)$/.exec(line)
    const ordered = /^\d+\.\s+(.*)$/.exec(line)

    if (heading) {
      closeList()
      const level = heading[1].length
      html.push(`<h${level}>${inlineFormat(heading[2])}</h${level}>`)
    } else if (unordered) {
      if (listType !== 'ul') {
        closeList()
        html.push('<ul>')
        listType = 'ul'
      }
      html.push(`<li>${inlineFormat(unordered[1])}</li>`)
    } else if (ordered) {
      if (listType !== 'ol') {
        closeList()
        html.push('<ol>')
        listType = 'ol'
      }
      html.push(`<li>${inlineFormat(ordered[1])}</li>`)
    } else if (line.trim() === '') {
      closeList()
    } else {
      closeList()
      html.push(`<p>${inlineFormat(line)}</p>`)
    }
  }
  closeList()
  return html.join('\n')
}

const DOCUMENT_CSS = `
  body { font-family: "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif;
         line-height: 1.8; color: #1a1a1a; max-width: 760px; margin: 40px auto; padding: 0 24px; }
  h1 { font-size: 26px; border-bottom: 2px solid #333; padding-bottom: 12px; }
  h2 { font-size: 20px; margin-top: 32px; }
  h3, h4 { font-size: 16px; }
  blockquote { color: #555; border-left: 3px solid #ccc; margin: 8px 0; padding-left: 12px; }
  li { margin: 4px 0; }
  .meta { color: #666; font-size: 13px; margin-bottom: 24px; }
  a { color: #1a5fb4; }
  .sources li { margin: 6px 0; }
  .src-host { color: #888; font-size: 12px; margin-left: 8px; }
`

export function reportToHtmlDocument(report: ExportableReport, meta: ExportMeta = {}): string {
  const parts: string[] = [
    `<h1>${escapeHtml(report.title || '研究报告')}</h1>`,
    '<div class="meta">',
  ]
  if (meta.question) parts.push(`<div>研究问题：${escapeHtml(meta.question)}</div>`)
  parts.push(`<div>生成时间：${escapeHtml(meta.generatedAt ?? new Date().toLocaleString())}</div>`)
  parts.push('</div>')

  if (report.summary.trim()) {
    parts.push('<h2>摘要</h2>', markdownToHtml(report.summary))
  }
  for (const section of report.sections) {
    parts.push(`<h2>${escapeHtml(section.heading)}</h2>`, markdownToHtml(section.content))
  }
  if (report.limitations.length > 0) {
    parts.push('<h2>局限</h2>', '<ol>')
    for (const item of report.limitations) parts.push(`<li>${inlineFormat(item)}</li>`)
    parts.push('</ol>')
  }

  const sources = meta.sources ?? []
  if (sources.length > 0) {
    parts.push('<h2>附录：依据来源</h2>', '<ol class="sources">')
    for (const source of sources) {
      const label =
        source.origin === 'knowledge' && source.meta
          ? `${escapeHtml(source.title)}（知识库 · ${escapeHtml(source.meta)}）`
          : escapeHtml(source.title)
      parts.push(
        source.url
          ? `<li><a href="${escapeHtml(source.url)}">${label}</a>` +
              `<span class="src-host">${escapeHtml(hostOf(source.url))}</span></li>`
          : `<li>${label}</li>`,
      )
    }
    parts.push('</ol>')
  }

  return [
    '<!DOCTYPE html>',
    '<html lang="zh-CN"><head>',
    '<meta charset="utf-8">',
    `<title>${escapeHtml(report.title || '研究报告')}</title>`,
    `<style>${DOCUMENT_CSS}</style>`,
    '</head><body>',
    parts.join('\n'),
    '</body></html>',
  ].join('\n')
}

// ---------------------------------------------------------------- 下载通道

function downloadBlob(filename: string, content: string, mime: string): void {
  // ﻿：让 Windows 记事本 / Excel 系软件正确识别 UTF-8（无 BOM 会乱码）
  const blob = new Blob(['﻿' + content], { type: `${mime};charset=utf-8` })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  URL.revokeObjectURL(url)
}

function safeFilename(title: string, ext: string): string {
  const base = (title || '研究报告').replace(/[\\/:*?"<>|]/g, '_').slice(0, 60)
  return `${base}.${ext}`
}

export function downloadMarkdown(report: ExportableReport, meta: ExportMeta = {}): void {
  downloadBlob(safeFilename(report.title, 'md'), reportToMarkdown(report, meta), 'text/markdown')
}

export function downloadWord(report: ExportableReport, meta: ExportMeta = {}): void {
  downloadBlob(
    safeFilename(report.title, 'doc'),
    reportToHtmlDocument(report, meta),
    'application/msword',
  )
}

/**
 * PDF 走浏览器打印通道（用户选「另存为 PDF」）：
 * 隐藏 iframe 里渲染独立的报告文档再打印，不会把页面其余部分带进打印稿。
 */
export function downloadPdf(report: ExportableReport, meta: ExportMeta = {}): void {
  const iframe = document.createElement('iframe')
  iframe.style.position = 'fixed'
  iframe.style.right = '0'
  iframe.style.bottom = '0'
  iframe.style.width = '0'
  iframe.style.height = '0'
  iframe.style.border = 'none'
  document.body.appendChild(iframe)

  const doc = iframe.contentDocument
  if (!doc) {
    iframe.remove()
    return
  }
  doc.open()
  doc.write(reportToHtmlDocument(report, meta))
  doc.close()

  // 打印完成后移除 iframe；afterprint 在部分浏览器不可靠，兜底定时清理
  const cleanup = () => iframe.remove()
  iframe.contentWindow?.addEventListener('afterprint', cleanup)
  iframe.contentWindow?.focus()
  iframe.contentWindow?.print()
  window.setTimeout(cleanup, 60_000)
}

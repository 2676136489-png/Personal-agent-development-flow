import { useEffect, useRef, useState } from 'react'
import { ChevronDownIcon } from './icons'
import { notify } from './Toast'
import {
  downloadMarkdown,
  downloadPdf,
  downloadWord,
  type ExportMeta,
  type ExportableReport,
} from '../features/reports/exportReport'

interface DownloadReportButtonProps {
  report: ExportableReport
  meta?: ExportMeta
}

const FORMATS = [
  { key: 'pdf', label: 'PDF（打印/另存）', desc: '排版最好，浏览器打印通道' },
  { key: 'word', label: 'Word（.doc）', desc: '可继续编辑' },
  { key: 'md', label: 'Markdown（.md）', desc: '无损源文本' },
] as const

type FormatKey = (typeof FORMATS)[number]['key']

/**
 * 「下载报告」下拉按钮：主按钮默认 PDF，右侧箭头展开三种格式。
 * 纯前端导出（Blob / 打印 iframe），不走后端 —— 中文排版零风险。
 */
export function DownloadReportButton({ report, meta }: DownloadReportButtonProps) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)

  // 点击组件外部时收起下拉
  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [open])

  function handleDownload(format: FormatKey) {
    setOpen(false)
    try {
      if (format === 'pdf') {
        downloadPdf(report, meta)
        notify({ tone: 'ok', title: '已打开打印窗口', desc: '在打印对话框选择「另存为 PDF」即可。' })
      } else if (format === 'word') {
        downloadWord(report, meta)
        notify({ tone: 'ok', title: 'Word 文档已开始下载' })
      } else {
        downloadMarkdown(report, meta)
        notify({ tone: 'ok', title: 'Markdown 文件已开始下载' })
      }
    } catch {
      notify({ tone: 'error', title: '导出失败', desc: '浏览器阻止了下载，请重试。' })
    }
  }

  return (
    <div className="download-report" ref={rootRef}>
      <button
        className="button button--primary download-report__main"
        onClick={() => handleDownload('pdf')}
      >
        下载报告
      </button>
      <button
        className="button button--primary download-report__toggle"
        aria-label="选择下载格式"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <ChevronDownIcon size={14} />
      </button>
      {open && (
        <div className="download-report__menu" role="menu">
          {FORMATS.map((format) => (
            <button
              key={format.key}
              className="download-report__item"
              role="menuitem"
              onClick={() => handleDownload(format.key)}
            >
              <span className="download-report__item-label">{format.label}</span>
              <span className="download-report__item-desc">{format.desc}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

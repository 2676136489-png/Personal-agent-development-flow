import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

interface MarkdownProps {
  children: string
  className?: string
}

/**
 * [B20] 后端历史数据（以及偶发的模型双重转义）会把换行存成字面 "\n" 两个字符，
 * 直接交给 ReactMarkdown 会原样渲染出满屏反斜杠。
 * 这里在渲染前统一把字面 \n / \t 恢复成真实字符 —— 后端新数据已在
 * structured.py 源头清理，这里是覆盖历史数据与渲染层的双保险。
 */
function restoreEscaped(text: string): string {
  if (!text.includes('\\n') && !text.includes('\\t')) return text
  return text.replace(/\\n/g, '\n').replace(/\\t/g, '\t')
}

export function Markdown({ children, className }: MarkdownProps) {
  return (
    <div className={`markdown-body ${className ?? ''}`}>
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{restoreEscaped(children)}</ReactMarkdown>
    </div>
  )
}

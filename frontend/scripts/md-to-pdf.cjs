/**
 * 把 Markdown 面试手册转成 PDF。
 *
 * 为什么走 CDP 的 Page.printToPDF 而不是 --print-to-pdf 命令行：
 * 本机只有 chrome-headless-shell（Playwright 装的精简版），它**不支持**
 * --print-to-pdf，进程会静默退出。而 Page.printToPDF 是 CDP 协议方法，
 * headless-shell 支持，能精确控制纸张尺寸、边距、页眉页脚。
 *
 * 用法：node scripts/md-to-pdf.cjs <输入.md> <输出.pdf>
 */
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

const CHROME =
  process.env.PROBE_CHROME ||
  'C:/Users/111/AppData/Local/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-win64/chrome-headless-shell.exe'
const SRC = path.resolve(process.argv[2] || 'docs/interview/网页测试岗面试问答.md')
const OUT = path.resolve(process.argv[3] || 'docs/interview/网页测试岗面试问答.pdf')
const PORT = 9347

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* ---------- 极简 Markdown 渲染（够用即可） ---------- */

const esc = (s) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** 行内标记：行内代码 → 粗体 → 斜体 → 链接 */
function inline(text) {
  let s = esc(text)
  // 行内代码先抽出来，避免内部被后续规则改写
  const codes = []
  s = s.replace(/`([^`]+)`/g, (_, c) => {
    codes.push(c)
    return `\u0000CODE${codes.length - 1}\u0000`
  })
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
  s = s.replace(/\u0000CODE(\d+)\u0000/g, (_, i) => `<code>${codes[Number(i)]}</code>`)
  return s
}

/** 把 Markdown 文本转成 HTML 片段 */
function mdToHtml(md) {
  const lines = md.split(/\r?\n/)
  const out = []
  let i = 0
  let inCode = false
  let codeLang = ''
  let codeBuf = []

  const flushCode = () => {
    if (!codeBuf.length) return
    out.push(
      `<pre class="code"><div class="code-lang">${esc(codeLang || 'text')}</div><code>${esc(
        codeBuf.join('\n')
      )}</code></pre>`
    )
    codeBuf = []
    codeLang = ''
  }

  while (i < lines.length) {
    const line = lines[i]

    // 代码块
    if (/^```/.test(line)) {
      if (inCode) {
        flushCode()
        inCode = false
      } else {
        flushCode()
        inCode = true
        codeLang = line.slice(3).trim()
      }
      i++
      continue
    }
    if (inCode) {
      codeBuf.push(line)
      i++
      continue
    }

    // 表格：| a | b | 后跟 | --- | --- |
    if (/^\|/.test(line) && /^\|[\s:|-]+\|?\s*$/.test(lines[i + 1] || '')) {
      const head = line.split('|').slice(1, -1).map((c) => c.trim())
      i += 2
      const rows = []
      while (i < lines.length && /^\|/.test(lines[i])) {
        rows.push(lines[i].split('|').slice(1, -1).map((c) => c.trim()))
        i++
      }
      out.push(
        `<table><thead><tr>${head
          .map((h) => `<th>${inline(h)}</th>`)
          .join('')}</tr></thead><tbody>${rows
          .map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`)
          .join('')}</tbody></table>`
      )
      continue
    }

    // 标题
    const h = /^(#{1,6})\s+(.*)$/.exec(line)
    if (h) {
      const lvl = h[1].length
      out.push(`<h${lvl}>${inline(h[2])}</h${lvl}>`)
      i++
      continue
    }

    // 分隔线
    if (/^---+$/.test(line.trim())) {
      out.push('<hr />')
      i++
      continue
    }

    // 引用
    if (/^>\s?/.test(line)) {
      const buf = []
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        buf.push(lines[i].replace(/^>\s?/, ''))
        i++
      }
      out.push(`<blockquote>${mdToHtml(buf.join('\n'))}</blockquote>`)
      continue
    }

    // 有序列表
    /* 列表项可以有续行（缩进但不是新项），必须并进上一项 ——
       否则编号会在续行处断开，下一段重新从 1 开始。 */
    if (/^\d+\.\s+/.test(line)) {
      const items = []
      while (i < lines.length && /^\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\d+\.\s+/, ''))
        i++
        // 吃掉缩进续行
        while (
          i < lines.length &&
          lines[i].trim() !== '' &&
          /^\s{2,}/.test(lines[i]) &&
          !/^\d+\.\s+/.test(lines[i])
        ) {
          items[items.length - 1] += ' ' + lines[i].trim()
          i++
        }
      }
      out.push(`<ol>${items.map((t) => `<li>${inline(t)}</li>`).join('')}</ol>`)
      continue
    }

    // 无序列表
    if (/^[-*]\s+/.test(line)) {
      const items = []
      while (i < lines.length && /^[-*]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^[-*]\s+/, ''))
        i++
        while (
          i < lines.length &&
          lines[i].trim() !== '' &&
          /^\s{2,}/.test(lines[i]) &&
          !/^[-*]\s+/.test(lines[i])
        ) {
          items[items.length - 1] += ' ' + lines[i].trim()
          i++
        }
      }
      out.push(`<ul>${items.map((t) => `<li>${inline(t)}</li>`).join('')}</ul>`)
      continue
    }

    // 段落（连续非空行合并）
    if (line.trim() === '') {
      i++
      continue
    }
    const buf = []
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !/^(#{1,6}\s|```|\||>|[-*]\s|\d+\.\s|---+$)/.test(lines[i])
    ) {
      buf.push(lines[i])
      i++
    }
    out.push(`<p>${inline(buf.join(' '))}</p>`)
  }

  flushCode()
  return out.join('\n')
}

/* ---------- 页面样式 ---------- */

const CSS = `
@page { size: A4; margin: 15mm 13mm 16mm 13mm; }
* { box-sizing: border-box; }
body {
  font-family: "Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", -apple-system, sans-serif;
  font-size: 10.5pt; line-height: 1.7; color: #1a1f2e; margin: 0;
  -webkit-print-color-adjust: exact; print-color-adjust: exact;
}
h1 {
  font-size: 19pt; color: #0f172a; margin: 0 0 8pt;
  padding-bottom: 8pt; border-bottom: 2.5pt solid #2563eb; letter-spacing: -0.3pt;
}
h2 {
  font-size: 13.5pt; color: #0b2545; margin: 19pt 0 8pt; padding: 6pt 0 6pt 10pt;
  background: linear-gradient(90deg, #eef3ff 0%, rgba(238,243,255,0) 100%);
  border-left: 3.5pt solid #2563eb; page-break-after: avoid;
}
h3 {
  font-size: 11.6pt; color: #123a6b; margin: 14pt 0 6pt;
  padding-bottom: 3pt; border-bottom: 0.8pt solid #d3ddf0; page-break-after: avoid;
}
h4 { font-size: 10.7pt; color: #1e3a5f; margin: 10pt 0 4pt; page-break-after: avoid; }
p { margin: 5pt 0; }
hr { border: none; border-top: 0.8pt solid #dbe3f0; margin: 13pt 0; }
strong { color: #0f172a; font-weight: 700; }
em { color: #334155; }
a { color: #2563eb; text-decoration: none; }
code {
  font-family: "Cascadia Mono", Consolas, "Courier New", monospace;
  font-size: 9.2pt; background: #eef2f9; color: #1e40af;
  padding: 1pt 3.5pt; border-radius: 2.5pt; border: 0.4pt solid #dbe4f3;
  word-break: break-all;
}
pre.code {
  background: #0f1729; color: #e2e8f0; padding: 9pt 11pt; border-radius: 5pt;
  margin: 8pt 0; font-size: 8.8pt; line-height: 1.55;
  page-break-inside: avoid; position: relative;
}
pre.code code { background: none; color: inherit; padding: 0; border: none; font-size: inherit; }
.code-lang {
  font-size: 7.5pt; color: #7dd3fc; text-transform: uppercase; letter-spacing: 0.8pt;
  margin-bottom: 5pt; opacity: 0.85;
}
blockquote {
  margin: 8pt 0; padding: 7pt 11pt; background: #f4f8ff;
  border-left: 3pt solid #60a5fa; border-radius: 0 4pt 4pt 0;
  color: #1e3a5f; page-break-inside: avoid;
}
blockquote p { margin: 3pt 0; }
table {
  width: 100%; border-collapse: collapse; margin: 8pt 0; font-size: 9.5pt;
  page-break-inside: avoid;
}
th {
  background: #e8effc; color: #0b2545; font-weight: 700;
  text-align: left; padding: 5.5pt 7pt; border: 0.6pt solid #c3d3ec;
}
td { padding: 5pt 7pt; border: 0.6pt solid #d6e0f0; vertical-align: top; }
tbody tr:nth-child(even) { background: #f8fafd; }
ul, ol { margin: 5pt 0 5pt 18pt; padding: 0; }
li { margin: 3pt 0; }
strong code { color: #7c2d12; background: #fff4ed; border-color: #fed7aa; }
`

/* ---------- CDP 客户端 ---------- */

async function waitForDevtools() {
  for (let i = 0; i < 80; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/version`)
      if (res.ok) return
    } catch { /* poll */ }
    await sleep(250)
  }
  throw new Error('devtools 未就绪')
}

function connect(wsUrl) {
  const ws = new WebSocket(wsUrl)
  let id = 0
  const pending = new Map()
  ws.addEventListener('message', (e) => {
    const msg = JSON.parse(e.data)
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id)
      pending.delete(msg.id)
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result)
    }
  })
  return {
    ready: new Promise((res) => ws.addEventListener('open', res)),
    send(method, params = {}) {
      return new Promise((resolve, reject) => {
        const msgId = ++id
        pending.set(msgId, { resolve, reject })
        ws.send(JSON.stringify({ id: msgId, method, params }))
      })
    },
  }
}

/* ---------- 主流程 ---------- */

async function main() {
  if (!fs.existsSync(SRC)) throw new Error(`找不到源文件：${SRC}`)
  const md = fs.readFileSync(SRC, 'utf8')
  const body = mdToHtml(md)

  const html = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8" />
<title>网页测试岗面试问答</title><style>${CSS}</style></head>
<body>${body}</body></html>`

  const tmpHtml = path.join(os.tmpdir(), `md2pdf-${Date.now()}.html`)
  fs.writeFileSync(tmpHtml, html, 'utf8')

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'md2pdf-'))
  const child = spawn(
    CHROME,
    [
      '--headless=new',
      `--remote-debugging-port=${PORT}`,
      '--no-sandbox',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      `--user-data-dir=${profile}`,
      'about:blank',
    ],
    { stdio: 'ignore' }
  )

  try {
    await waitForDevtools()
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
    const cdp = connect(list.find((t) => t.type === 'page').webSocketDebuggerUrl)
    await cdp.ready
    await cdp.send('Page.enable')
    await cdp.send('Runtime.enable')

    await cdp.send('Page.navigate', { url: `file:///${tmpHtml.replace(/\\/g, '/')}` })
    // 等字体与布局就绪
    await cdp.send('Runtime.evaluate', {
      expression: `document.fonts.ready.then(() => new Promise(r => setTimeout(r, 500)))`,
      awaitPromise: true,
    })
    await sleep(600)

    const { data } = await cdp.send('Page.printToPDF', {
      printBackground: true,
      paperWidth: 8.27,   // A4
      paperHeight: 11.69,
      marginTop: 0.59,
      marginBottom: 0.63,
      marginLeft: 0.51,
      marginRight: 0.51,
      displayHeaderFooter: true,
      headerTemplate: `<div style="font-size:7pt;color:#94a3b8;width:100%;padding:0 12mm;
        font-family:'Microsoft YaHei',sans-serif;display:flex;justify-content:space-between;">
        <span>AI Research Workspace · 网页测试岗面试问答</span>
        <span></span></div>`,
      footerTemplate: `<div style="font-size:7.5pt;color:#94a3b8;width:100%;padding:0 12mm;
        font-family:'Microsoft YaHei',sans-serif;display:flex;justify-content:space-between;">
        <span></span><span>第 <span class="pageNumber"></span> / <span class="totalPages"></span> 页</span></div>`,
      preferCSSPageSize: false,
    })

    fs.writeFileSync(OUT, Buffer.from(data, 'base64'))
    const kb = (fs.statSync(OUT).size / 1024).toFixed(0)
    console.log(`✓ PDF 已生成：${OUT}  ${kb} KB`)
  } finally {
    child.kill()
    try { fs.rmSync(profile, { recursive: true, force: true }) } catch { /* ignore */ }
    try { fs.rmSync(tmpHtml, { force: true }) } catch { /* ignore */ }
  }
}

main().catch((e) => {
  console.error('✗', e.message)
  process.exit(1)
})

/**
 * 把 PDF 渲染成 PNG，用于人工校验排版（中文 PDF 最容易翻车的是
 * 字体缺失、表格截断、代码块溢出）。
 *
 * 用法：node scripts/pdf-preview.cjs <pdf> <输出目录> [要渲染的页码,逗号分隔]
 */
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

const CHROME =
  process.env.PROBE_CHROME ||
  'C:/Users/111/AppData/Local/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-win64/chrome-headless-shell.exe'
const PDF = path.resolve(process.argv[2] || 'docs/interview/网页测试岗面试问答.pdf')
const OUT = path.resolve(process.argv[3] || path.join(os.tmpdir(), 'pdfprev'))
const PAGES = (process.argv[4] || '0').split(',').map((n) => Number(n.trim()))

const PORT = 9349
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

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

async function main() {
  fs.mkdirSync(OUT, { recursive: true })
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfprev-'))
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
      '--window-size=1000,1400',
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

    for (const p of PAGES) {
      /* 必须先跳 blank 再进 PDF：只改 URL 的 #page= 片段属于同文档导航，
         Chrome 的 PDF 插件不会因此翻页 —— 之前就是这么截出两张一样的图。 */
      await cdp.send('Page.navigate', { url: 'about:blank' })
      await sleep(600)
      const url = `file:///${PDF.replace(/\\/g, '/')}#page=${p + 1}&toolbar=0&view=Fit`
      await cdp.send('Page.navigate', { url })
      await sleep(3500)
      const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' })
      const file = path.join(OUT, `page-${String(p + 1).padStart(2, '0')}.png`)
      fs.writeFileSync(file, Buffer.from(data, 'base64'))
      console.log(`🖼  ${file}  ${(Buffer.from(data, 'base64').length / 1024).toFixed(0)} KB`)
    }
  } finally {
    child.kill()
    try { fs.rmSync(profile, { recursive: true, force: true }) } catch { /* ignore */ }
  }
}

main().catch((e) => {
  console.error('✗', e.message)
  process.exit(1)
})

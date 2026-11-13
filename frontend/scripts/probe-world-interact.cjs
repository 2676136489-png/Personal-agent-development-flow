/**
 * 交互态截图：跑一次 RAG、打开一次报告弹窗，用来验收「有数据时」的版面。
 *
 * 静态截图只能看到空态；打分条、向量散点、报告弹窗这些只有真跑一遍才出现。
 * 用法：node scripts/probe-world-interact.cjs [BASE] [rag|reports]
 */
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const CHROME =
  process.env.PROBE_CHROME ||
  'C:/Users/111/AppData/Local/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-win64/chrome-headless-shell.exe'
const PORT = 9334
const BASE = (process.argv[2] || 'http://127.0.0.1:5173').replace(/\/$/, '')
const FLOW = process.argv[3] || 'rag'
const WIDTH = Number(process.argv[4] || 1440)
const HEIGHT = Number(process.argv[5] || 1000)
const OUT = path.resolve(__dirname, '../.probe-world')
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitForDevtools() {
  for (let i = 0; i < 80; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/version`)
      if (res.ok) return
    } catch {
      /* keep polling */
    }
    await sleep(250)
  }
  throw new Error('devtools 未就绪')
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true })
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'world-int-'))
  const child = spawn(
    CHROME,
    [
      '--headless=new',
      `--remote-debugging-port=${PORT}`,
      '--no-sandbox',
      '--no-proxy-server',
      '--no-first-run',
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      `--user-data-dir=${profile}`,
      `--window-size=${WIDTH},${HEIGHT}`,
      '--hide-scrollbars',
      'about:blank',
    ],
    { stdio: 'ignore' },
  )

  try {
    await waitForDevtools()
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
    const page = list.find((t) => t.type === 'page')
    const ws = new WebSocket(page.webSocketDebuggerUrl)
    let id = 0
    const pending = new Map()
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data)
      if (msg.id && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id)
        pending.delete(msg.id)
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result)
      }
    })
    await new Promise((resolve) => ws.addEventListener('open', resolve))
    const send = (method, params = {}) =>
      new Promise((resolve, reject) => {
        const msgId = ++id
        pending.set(msgId, { resolve, reject })
        ws.send(JSON.stringify({ id: msgId, method, params }))
      })
    const evaluate = async (expression) => {
      const res = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
      return res.result?.value
    }
    const shoot = async (name) => {
      const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
      fs.writeFileSync(path.join(OUT, `${name}-${WIDTH}.png`), Buffer.from(shot.data, 'base64'))
    }

    await send('Page.enable')
    await send('Runtime.enable')
    await send('Emulation.setDeviceMetricsOverride', {
      width: WIDTH,
      height: HEIGHT,
      deviceScaleFactor: 1,
      mobile: false,
    })
    /* headless Chrome 默认 prefers-reduced-motion: reduce，会直接跳到动画终态；
       要验证「一步一步点亮」必须显式声明用户没有开启减少动效 */
    await send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }],
    })

    if (FLOW === 'rag') {
      await send('Page.navigate', { url: `${BASE}/#/rag` })
      await sleep(3000)
      await evaluate(`document.querySelector('.rag-run__btn')?.click()`)
      await sleep(12000)
      await evaluate(`document.querySelector('.rag-results')?.scrollIntoView({block:'start'})`)
      await sleep(800)
      await shoot('rag-results-top')
      await evaluate(`window.scrollBy(0, 900)`)
      await sleep(500)
      await shoot('rag-results-mid')
      await evaluate(`window.scrollBy(0, 900)`)
      await sleep(500)
      await shoot('rag-results-low')
      const info = await evaluate(
        `JSON.stringify({ steps: document.querySelectorAll('.rag-runbar__stage').length, chunks: document.querySelectorAll('.rag-chunk').length, hits: document.querySelectorAll('.rag-hit').length, heat: document.querySelectorAll('.rag-heatmap__cell').length, dots: document.querySelectorAll('.rag-scatter__dot').length, err: document.querySelector('.alert--error')?.textContent?.slice(0,120) || '' })`,
      )
      console.log(info)
    }

    if (FLOW === 'reports') {
      await send('Page.navigate', { url: `${BASE}/#/reports` })
      await sleep(3000)
      const opened = await evaluate(`(() => { const b = document.querySelector('.report-card'); if (!b) return 'none'; b.click(); return 'clicked' })()`)
      await sleep(1200)
      await shoot('reports-modal')
      console.log('report card:', opened)
    }

    if (FLOW === 'workflow') {
      await send('Page.navigate', { url: `${BASE}/#/workflow` })
      await sleep(3000)
      // React 受控输入：必须走原生 setter + input 事件，直接改 value 不会触发 onChange
      await evaluate(`(() => {
        const el = document.querySelector('#wf-question')
        const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
        setter.call(el, '研究 2026 年 AI Agent 开发岗位的主要技术要求')
        el.dispatchEvent(new Event('input', { bubbles: true }))
        return el.value.length
      })()`)
      await sleep(400)
      await evaluate(`document.querySelector('.input-card .button--primary')?.click()`)
      await sleep(14000)
      await shoot('workflow-running')
      for (let i = 0; i < 30; i++) {
        await sleep(4000)
        const done = await evaluate(`!!document.querySelector('.approval')`)
        if (done) break
      }
      await evaluate(`document.querySelector('.card')?.scrollIntoView({ block: 'center' })`)
      await sleep(600)
      await shoot('workflow-done')
      const info = await evaluate(
        `JSON.stringify({ approval: !!document.querySelector('.approval'), metrics: document.querySelectorAll('.run-metric').length, steps: document.querySelectorAll('.stepper__item').length, error: document.querySelector('.state-error')?.textContent?.slice(0, 100) || '' })`,
      )
      console.log(info)
    }

    if (FLOW === 'pipeline') {
      await send('Page.navigate', { url: `${BASE}/#/dashboard` })
      await sleep(4200)
      await evaluate(`document.querySelector('.home-pipeline')?.scrollIntoView({ block: 'center' })`)
      await sleep(500)
      await shoot('pipeline-1')
      await sleep(900)
      await shoot('pipeline-2')
      await sleep(1600)
      await shoot('pipeline-3')
      await sleep(2200)
      await shoot('pipeline-4')
      const info = await evaluate(
        `JSON.stringify([...document.querySelectorAll('.pipeline__group')].map((g) => g.dataset.state))`,
      )
      console.log(info)
    }

    if (FLOW === 'nav') {
      await send('Page.navigate', { url: `${BASE}/#/dashboard` })
      await sleep(3500)
      // 顶栏链接：点「深度研究」→ 应切页并把 hash 写进地址栏
      const step1 = await evaluate(`(() => {
        const link = [...document.querySelectorAll('.nav-link')].find((el) => el.textContent.trim() === '深度研究')
        link?.click()
        return !!link
      })()`)
      await sleep(1800)
      const afterLink = await evaluate(`JSON.stringify({ hash: location.hash, title: document.querySelector('.page-head__title')?.textContent?.trim() || '' })`)
      // 目录浮层：打开 → 点第 4 项（RAG 流程）→ 应切页并关闭浮层
      await evaluate(`document.querySelector('.nav-index')?.click()`)
      await sleep(700)
      const opened = await evaluate(`!!document.querySelector('.index-layer')`)
      await evaluate(`document.querySelectorAll('.index-item')[3]?.click()`)
      await sleep(1800)
      const afterIndex = await evaluate(`JSON.stringify({ hash: location.hash, open: !!document.querySelector('.index-layer'), title: document.querySelector('.page-head__title')?.textContent?.trim() || '' })`)
      console.log(JSON.stringify({ clicked: step1, afterLink: JSON.parse(afterLink), overlayOpened: opened, afterIndex: JSON.parse(afterIndex) }))
    }

    if (FLOW === 'index') {
      await send('Page.navigate', { url: `${BASE}/#/dashboard` })
      await sleep(3500)
      await evaluate(`document.querySelector('.nav-index')?.click()`)
      await sleep(900)
      await shoot('index-overlay')
    }

    ws.close()
  } finally {
    child.kill()
  }
}

void main().catch((error) => {
  console.error(error)
  process.exit(1)
})

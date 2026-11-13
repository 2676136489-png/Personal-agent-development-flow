/**
 * 视觉验收截图：按页面路由逐张截「首屏」与「整页」，并收集控制台报错。
 *
 * 为什么不用 Playwright 依赖：仓库里已有成熟的 CDP 探针写法，Node 22 自带
 * WebSocket，零依赖就能跑。这个脚本只做三件事：开页 → 等就绪 → 截图。
 *
 * 用法：node scripts/shoot-world.cjs [BASE] [路由,路由] [宽] [高]
 *   例：node scripts/shoot-world.cjs http://127.0.0.1:5173 dashboard,workflow
 */
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const CHROME =
  process.env.PROBE_CHROME ||
  'C:/Users/111/AppData/Local/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-win64/chrome-headless-shell.exe'
const PORT = 9331
const BASE = (process.argv[2] || 'http://127.0.0.1:5173').replace(/\/$/, '')
const ROUTES = (process.argv[3] || 'dashboard')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
const WIDTH = Number(process.argv[4] || 1440)
const HEIGHT = Number(process.argv[5] || 900)
const OUT = path.resolve(__dirname, '../.probe-world')
const SCROLL_Y = Number(process.argv[6] || 0)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitForDevtools() {
  for (let i = 0; i < 80; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/version`)
      if (res.ok) return true
    } catch {
      /* keep polling */
    }
    await sleep(250)
  }
  throw new Error('devtools 未就绪')
}

function connect(wsUrl) {
  const ws = new WebSocket(wsUrl)
  let id = 0
  const pending = new Map()
  const events = new Map()
  ws.addEventListener('message', (e) => {
    const msg = JSON.parse(e.data)
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id)
      pending.delete(msg.id)
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result)
    } else if (msg.method && events.has(msg.method)) {
      events.get(msg.method).forEach((fn) => fn(msg.params))
    }
  })
  return {
    ready: new Promise((res) => ws.addEventListener('open', res)),
    close: () => ws.close(),
    send(method, params = {}, sessionId) {
      return new Promise((resolve, reject) => {
        const msgId = ++id
        pending.set(msgId, { resolve, reject })
        ws.send(JSON.stringify({ id: msgId, method, params, sessionId }))
      })
    },
    on(method, fn) {
      if (!events.has(method)) events.set(method, [])
      events.get(method).push(fn)
    },
  }
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true })
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'world-shoot-'))
  const child = spawn(
    CHROME,
    [
      '--headless=new',
      `--remote-debugging-port=${PORT}`,
      '--no-sandbox',
      '--no-proxy-server',
      '--no-first-run',
      '--no-default-browser-check',
      // 玻璃立方体必须真跑 WebGL：用 SwiftShader 软件光栅化，headless 也能出图
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      `--user-data-dir=${profile}`,
      `--window-size=${WIDTH},${HEIGHT}`,
      '--hide-scrollbars',
      '--force-device-scale-factor=1',
      'about:blank',
    ],
    { stdio: 'ignore' },
  )

  try {
    await waitForDevtools()
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
    const page = list.find((t) => t.type === 'page')
    if (!page) throw new Error('没有可用的页面目标')

    const cdp = connect(page.webSocketDebuggerUrl)
    await cdp.ready

    const errors = []
    cdp.on('Runtime.consoleAPICalled', (p) => {
      if (p.type === 'error' || p.type === 'warning') errors.push(p.args.map((a) => a.value ?? a.description ?? '').join(' '))
    })
    cdp.on('Runtime.exceptionThrown', (p) => {
      errors.push(p.exceptionDetails?.exception?.description || p.exceptionDetails?.text || 'exception')
    })

    await cdp.send('Page.enable')
    await cdp.send('Runtime.enable')
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: WIDTH,
      height: HEIGHT,
      deviceScaleFactor: 1,
      mobile: false,
    })

    for (const route of ROUTES) {
      // BASE 可能带 ?sharecode=：hash 必须排在查询串后面，不能插在 ? 之前
      const url = BASE.includes('?') ? `${BASE}#/${route}` : `${BASE}/#/${route}`
      await cdp.send('Page.navigate', { url })
      await sleep(route === 'dashboard' ? 6000 : 2200)
      if (SCROLL_Y > 0) {
        await cdp.send('Runtime.evaluate', { expression: `window.scrollTo(0, ${SCROLL_Y})` })
        await sleep(600)
      }

      const shot = await cdp.send('Page.captureScreenshot', {
        format: 'png',
        captureBeyondViewport: false,
      })
      const suffix = SCROLL_Y > 0 ? `-y${SCROLL_Y}` : ''
      fs.writeFileSync(path.join(OUT, `${route}-${WIDTH}${suffix}.png`), Buffer.from(shot.data, 'base64'))

      const metrics = await cdp.send('Runtime.evaluate', {
        expression: `(() => {
          const s = document.querySelector('#scene')
          const gl = s ? (s.getContext('webgl2') || s.getContext('webgl')) : null
          return JSON.stringify({
            title: document.title,
            h1: document.querySelector('h1')?.textContent?.trim() || '',
            bodyBg: getComputedStyle(document.body).backgroundColor,
            font: getComputedStyle(document.body).fontFamily.split(',')[0],
            poppins: document.fonts ? document.fonts.check('800 16px Poppins') : null,
            webgl: !!gl,
            model: document.querySelector('#hero')?.dataset.model || '',
            glb: (() => {
              const e = performance.getEntriesByType('resource').find((r) => /fa96096e/.test(r.name))
              return e ? { dur: Math.round(e.duration), size: e.transferSize, ok: e.responseStatus || 0 } : null
            })(),
            canvas: s ? [s.width, s.height] : null,
            overflowX: document.documentElement.scrollWidth > window.innerWidth,
            scrollW: document.documentElement.scrollWidth,
            innerW: window.innerWidth,
            height: document.documentElement.scrollHeight,
          })
        })()`,
        returnByValue: true,
      })
      console.log(route, metrics.result.value)
    }

    if (errors.length) {
      console.log('\n控制台报错：')
      console.log([...new Set(errors)].join('\n'))
    } else {
      console.log('\n无控制台报错')
    }
    cdp.close()
  } finally {
    child.kill()
  }
}

void main().catch((error) => {
  console.error(error)
  process.exit(1)
})

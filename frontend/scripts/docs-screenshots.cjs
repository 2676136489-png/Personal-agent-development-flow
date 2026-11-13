/**
 * 为文档生成截图（首屏，不是整页）。
 *
 * 为什么不用 probe-visual-theme 的整页截图：那张是 1440×2225 的 PNG，
 * 单张 470KB，放进 README 会让仓库体积翻几倍，而且读者要滚很久才看完。
 * 文档只需要「一眼看到产品长什么样」，首屏 1440×900 足够。
 *
 * 用法：node scripts/docs-screenshots.cjs [输出目录]
 */
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

const CHROME =
  process.env.PROBE_CHROME ||
  'C:/Users/111/AppData/Local/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-win64/chrome-headless-shell.exe'
const PORT = 9339
const BASE = (process.argv[2] || 'http://127.0.0.1:4178').replace(/\/$/, '')
/* 输出目录：相对路径以**仓库根**为基准。
   不能直接 path.resolve(参数) —— 它按调用方的 CWD 解析，
   从 frontend/ 传 "../../docs/images" 会落到仓库外面，截图就写丢位置了。 */
const REPO = path.resolve(__dirname, '../..')
const OUT_ARG = process.argv[3] || 'docs/images'
const OUT = path.isAbsolute(OUT_ARG) ? OUT_ARG : path.resolve(REPO, OUT_ARG)
/* 只重截某几张：新增页面时没必要把 7 张旧图也重跑一遍，diff 会全是二进制噪声 */
const ONLY = process.argv[4] || ''

/* 兜底：仍然越界就直接报错。截图散落在仓库外会被 git 漏掉，
   等于白跑一趟，还容易把旧图当新图发到文档里。 */
if (!OUT.startsWith(REPO + path.sep)) {
  console.error(`✗ 输出目录在仓库外：${OUT}\n  仓库根：${REPO}`)
  process.exit(1)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitForDevtools() {
  for (let i = 0; i < 60; i++) {
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
    }
  }
}

/* 要截的页面。route 为空表示首页。
   ⚠️ 已经没有明暗两套主题：全站只有纯黑一套，所以 theme 字段整体删掉。
   路由名见 App.tsx 的 NAV_GROUPS：workflow=深度研究、rag=RAG 流程。
   prepare 是截图前要先跑的一段脚本（如 RAG 页要先真跑一次链路），
   waitFor 是等它出现的选择器，scrollY 返回要滚到的位置 —— 首屏缺省为 0。 */
const SHOTS = [
  /* 首页多等一会儿：玻璃立方体要下载 GLB、等字体就绪后才开始渲染 */
  { file: 'overview.jpg', route: '', wait: 5200 },
  { file: 'research-workflow.jpg', route: 'workflow', wait: 3600 },
  { file: 'knowledge-base.jpg', route: 'knowledge', wait: 3000 },
  {
    file: 'rag-lab.jpg',
    route: 'rag',
    wait: 2000,
    prepare: "document.querySelector('.rag-run__btn')?.click()",
    waitFor: '.rag-report',
    settle: 1200,
    /* 停到「切块」那张图：色带 + 块卡片是这一页最有辨识度的部分 */
    scrollY: `(() => {
      const fig = document.querySelectorAll('.rag-figure')[1]
      return fig ? fig.getBoundingClientRect().top + window.scrollY - 92 : 0
    })()`
  },
  { file: 'reports.jpg', route: 'reports', wait: 3000 }
]

async function main() {
  fs.mkdirSync(OUT, { recursive: true })
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'docshot-'))
  const child = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${PORT}`,
    '--no-sandbox', '--no-proxy-server', '--no-first-run', '--no-default-browser-check',
    /* 首屏是 WebGL：不能 --disable-gpu，用 SwiftShader 软件光栅化保证 headless 能出图 */
    '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    `--user-data-dir=${profile}`, '--window-size=1440,900', '--hide-scrollbars',
    '--force-device-scale-factor=1', 'about:blank'
  ], { stdio: 'ignore' })

  try {
    await waitForDevtools()
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
    const cdp = connect(list.find((t) => t.type === 'page').webSocketDebuggerUrl)
    await cdp.ready
    await cdp.send('Page.enable')
    await cdp.send('Runtime.enable')

    for (const shot of ONLY ? SHOTS.filter((s) => s.file.includes(ONLY)) : SHOTS) {
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: 1440, height: 900, deviceScaleFactor: 1, mobile: false
      })
      await cdp.send('Page.navigate', { url: `${BASE}/#/${shot.route}` })

      /* 等 SPA 渲染完，再等字体就绪 —— 否则标题会回退到系统字体，截图与真机不一致。
         判定条件不能只看「#root 有子节点」：页面级 lazy 加载期间骨架屏已经挂在
         #root 上了，那条件会在数据到位前就通过，截出来是一张灰条。
         所以额外要求骨架屏消失。 */
      let ready = false
      for (let i = 0; i < 40; i++) {
        await sleep(250)
        const { result } = await cdp.send('Runtime.evaluate', {
          expression: `(() => {
            const root = document.querySelector('#root')
            if (!root || !root.childElementCount) return false
            return !document.querySelector('.skeleton, .skeleton-row, [class*="skeleton"]')
          })()`,
          returnByValue: true
        })
        if (result.value) { ready = true; break }
      }
      if (!ready) { console.warn(`⚠️ ${shot.file} 等待渲染超时，跳过`); continue }

      await cdp.send('Runtime.evaluate', {
        expression: `document.fonts.ready.then(() => new Promise(r => setTimeout(r, 400)))`,
        awaitPromise: true
      })
      await sleep(shot.wait)

      /* 需要先「用起来」的页面：跑一次真实链路，等结果渲染完再截 */
      if (shot.prepare) {
        await cdp.send('Runtime.evaluate', { expression: shot.prepare, awaitPromise: true })
        for (let i = 0; i < 120; i++) {
          await sleep(500)
          const { result } = await cdp.send('Runtime.evaluate', {
            expression: `!!document.querySelector('${shot.waitFor}')`,
            returnByValue: true
          })
          if (result.value) break
          if (i === 119) console.warn(`⚠️ ${shot.file} 等 ${shot.waitFor} 超时`)
        }
        await sleep(shot.settle || 600)
      }
      if (shot.scrollY) {
        const { result } = await cdp.send('Runtime.evaluate', {
          expression: `window.scrollTo({ top: ${shot.scrollY}, behavior: 'instant' })`,
          returnByValue: true
        })
        void result
        await sleep(500)
      }

      /* 视口截图，不captureBeyondViewport —— 这是体积控制的关键。
         用 JPEG q82：界面截图是连续色块，PNG 无损压缩对它效果差
         （同一页面 PNG 274KB），JPEG 能压到 1/4 且肉眼几乎无损。
         文字类截图才需要 PNG，这里全是UI，JPEG 是正确取舍。 */
      const data = await cdp.send('Page.captureScreenshot', {
        format: 'jpeg',
        quality: 82
      })
      const file = path.join(OUT, shot.file)
      fs.writeFileSync(file, Buffer.from(data.data, 'base64'))
      const kb = (Buffer.from(data.data, 'base64').length / 1024).toFixed(0)
      console.log(`📸 ${shot.file}  1440×900  ${kb} KB  (${shot.route || '/'})`)
    }
  } finally {
    child.kill()
    try { fs.rmSync(profile, { recursive: true, force: true }) } catch { /* ignore */ }
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
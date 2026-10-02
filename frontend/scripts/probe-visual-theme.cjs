/**
 * 视觉探针：实测「深空蓝」换血后各元素的**计算样式**，并出截图。
 *
 * 为什么不用截图目测：配色是否真的生效、深浅底对比度是否达标、
 * 渐变/发光是否被更高优先级规则覆盖 —— 这些只能靠 getComputedStyle 读实值。
 * 截图只作为补充证据，用来确认没有肉眼可见的破版。
 *
 * 零依赖：Node 22 自带全局 WebSocket。
 */
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const CHROME =
  process.env.PROBE_CHROME ||
  'C:/Users/111/AppData/Local/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-win64/chrome-headless-shell.exe'
const PORT = 9337
const BASE = (process.argv[2] || 'http://127.0.0.1:4178').replace(/\/$/, '')

/* 路由归一化：只保留 '#' 之后的 hash 部分。
   ⚠️ 不要用 `process.argv[3]` 直接当 URL 路径 —— Git Bash 会把以 `/` 开头的
   参数当 MSYS 路径转换，`"/"` 会变成 `C:/Users/.../PortableGit/versions/1.2.0/`，
   探针于是访问了一个无效路由，读到的是浏览器错误页（空令牌 + Times New Roman）。
   调用方传 `#/knowledge` 或 `knowledge` 都行。 */
const RAW_ROUTES = (process.argv[3] || '').split(',').map((s) => s.trim()).filter(Boolean)
const ROUTES = RAW_ROUTES.map((s) => s.replace(/^#?\/?/, '')) // 去掉前导 # 与 /
const WIDTH = Number(process.argv[4] || 1440)
const HEIGHT = Number(process.argv[5] || 900)
const OUT = path.resolve(__dirname, '../.probe-visual')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitForDevtools() {
  for (let i = 0; i < 60; i++) {
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

/* ---------- CDP 最小封装 ---------- */
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
    ws,
    ready: new Promise((res) => ws.addEventListener('open', res)),
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

/* 在页面里跑：返回指定选择器的关键计算样式 */
const PROBE = `(() => {
  const pick = (sel) => {
    const el = document.querySelector(sel)
    if (!el) return null
    const cs = getComputedStyle(el)
    const r = el.getBoundingClientRect()
    return {
      sel: sel,
      disabled: el.matches(':disabled') || el.getAttribute('aria-disabled') === 'true',
      bg: cs.backgroundColor,
      bgImage: cs.backgroundImage === 'none' ? 'none' : cs.backgroundImage.slice(0, 130),
      color: cs.color,
      borderColor: cs.borderTopColor,
      borderRadius: cs.borderTopLeftRadius,
      boxShadow: cs.boxShadow === 'none' ? 'none' : cs.boxShadow.slice(0, 110),
      backdrop: cs.backdropFilter && cs.backdropFilter !== 'none' ? cs.backdropFilter : 'none',
      fontFamily: cs.fontFamily.split(',')[0].replace(/"/g, ''),
      w: Math.round(r.width),
      h: Math.round(r.height)
    }
  }
  const sels = [
    '.global-nav', '.nav-logo', '.nav-link--active', '.nav-link',
    '.page', '.card', '.card--primary', '.button--primary', '.button',
    '.page-head', '.badge', '.hero', '.hero-lede',
    '.stepper__dot', '.input', '.textarea', '.page-head__notes'
  ]
  const root = getComputedStyle(document.documentElement)
  const tokens = {}
  for (const t of ['--page','--surface','--ink','--muted','--faint','--accent','--accent-ink',
                   '--accent-2','--danger','--ok','--warn','--grad-brand','--glow-md','--glass-bg',
                   '--font-display','--radius-md','--shadow-lift']) {
    tokens[t] = root.getPropertyValue(t).trim()
  }
  const body = getComputedStyle(document.body)
  /* loaded=false 表示这轮访问拿到的是浏览器错误页/空文档。
     此时所有派生断言（字体、令牌、渐变）都会假失败，先用这一项把原因说清楚。 */
  const loaded = !!(document.querySelector('#root') && document.querySelector('#root').childElementCount > 0)
  /* 字体**是否真被加载**。只读 font-family 声明是不够的 ——
     声明了 Inter 但 index.html 外链没拉 Inter 时，计算值照样显示 Inter，
     实际渲染却回退到系统字体。这种「声明与加载不一致」只有查 FontFaceSet 才发现得了。

     ⚠️ check(font) 不带字重时默认按 400 查。外链只请求了 500;600;700（标题只用
     semibold/bold），用默认 400 去查会**误报未加载** —— 实测就踩过这个：
     interTight=false 但 interTight@600 明明 loaded。
     所以这里按真实用到的字重查，并顺带确认 h1 真的落在 Inter Tight 上。 */
  const fonts = {
    inter: document.fonts ? document.fonts.check('500 16px "Inter"') : null,
    interTight: document.fonts ? document.fonts.check('600 16px "Inter Tight"') : null,
    mono: document.fonts ? document.fonts.check('500 16px "JetBrains Mono"') : null,
    /* 已加载的字重清单，便于确认外链请求的字重与实际用到的对得上 */
    loaded: document.fonts
      ? Array.from(new Set(
          Array.from(document.fonts).filter((f) => f.status === 'loaded')
            .map((f) => f.family + '@' + f.weight)
        ))
      : null,
    /* 外链里是否还留着已退役的字体（Fraunces/Public Sans） */
    retiredLinked: Array.from(document.querySelectorAll('link[rel="stylesheet"]'))
      .some((l) => /Fraunces|Public\+Sans/i.test(l.href))
  }
  const h1 = document.querySelector('h1')
  const h1Font = h1 ? getComputedStyle(h1).fontFamily : null
  return {
    loaded,
    href: location.href.slice(0, 120),
    rootChildren: document.querySelector('#root') ? document.querySelector('#root').childElementCount : -1,
    theme: document.documentElement.getAttribute('data-theme') || '(未设置)',
    tokens,
    fonts,
    h1Font,
    bodyBg: body.backgroundColor,
    bodyFont: body.fontFamily.split(',')[0].replace(/"/g, ''),
    horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth,
    scrollW: document.documentElement.scrollWidth,
    innerW: window.innerWidth,
    elements: sels.map(pick).filter(Boolean)
  }
})()`

async function main() {
  fs.mkdirSync(OUT, { recursive: true })
  const profile = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'probe-vis-'))
  const child = spawn(
    CHROME,
    [
      '--headless=new',
      `--remote-debugging-port=${PORT}`,
      // ⚠️ --no-sandbox 与 --user-data-dir 都不能省：
      // 缺 user-data-dir 时 headless shell 在 Windows 上会直接静默退出（连不上
      // /json/version），缺 no-sandbox 则起进程但端口不监听。两者都加才稳定。
      '--no-sandbox',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      `--user-data-dir=${profile}`,
      `--window-size=${WIDTH},${HEIGHT}`,
      '--hide-scrollbars',
      '--force-device-scale-factor=1',
      'about:blank'
    ],
    { stdio: 'ignore' }
  )

  try {
    await waitForDevtools()
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
    const target = list.find((t) => t.type === 'page')
    const cdp = connect(target.webSocketDebuggerUrl)
    await cdp.ready

    const results = []
    for (const route of ROUTES.length ? ROUTES : ['']) {
      await cdp.send('Page.enable')
      await cdp.send('Runtime.enable')
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false
      })
      const url = `${BASE}/#/${route}`
      await cdp.send('Page.navigate', { url })
      // SPA 要等 lazy chunk 挂上 #root，这里轮询而不是死等固定时长
      let ready = false
      for (let i = 0; i < 30; i++) {
        await sleep(250)
        const { result } = await cdp.send('Runtime.evaluate', {
          expression: `!!(document.querySelector('#root') && document.querySelector('#root').childElementCount)`,
          returnByValue: true
        })
        if (result.value) { ready = true; break }
      }
      if (!ready) console.warn(`⚠️ ${url} 等待 #root 渲染超时，仍继续探测（loaded 会标 false）`)
      await sleep(600)

      // 主题探针：浅色跑完切深色再跑一遍，确认双主题都换血了
      for (const theme of ['light', 'dark']) {
        await cdp.send('Runtime.evaluate', {
          expression: `document.documentElement.setAttribute('data-theme','${theme}')`
        })
        /* ⚠️ 必须等字体加载完再量。
           document.fonts.check() 的语义是「该字体**已被下载**」，
           而 Web Font 是按需加载的 —— 不等 fonts.ready 就会把
           「还没下载完」误判成「没这个字体」，实测 Inter Tight 就被这样误报过。 */
        await cdp.send('Runtime.evaluate', {
          expression: `document.fonts.ready.then(() => new Promise(r => setTimeout(r, 300)))`,
          awaitPromise: true
        })
        await sleep(500)
        const { result } = await cdp.send('Runtime.evaluate', { expression: PROBE, returnByValue: true })
        results.push({ route, ...result.value })

        const shotName = `theme-${theme}-${route.replace(/[^a-z0-9]+/gi, '_') || 'root'}.png`
        const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })
        fs.writeFileSync(path.join(OUT, shotName), Buffer.from(shot.data, 'base64'))
      }
    }

    fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(results, null, 2))

    /* ---- 断言 ---- */
    const fail = []
    const light = results.find((r) => r.theme === 'light')
    const dark = results.find((r) => r.theme === 'dark')

    const expect = (cond, msg) => { if (!cond) fail.push(msg) }

    expect(light, '浅色主题探针未产出')
    expect(dark, '深色主题探针未产出')

    // 前置：页面必须真的渲染出来了，否则后面的断言全是噪音
    for (const r of results) {
      expect(r.loaded, `${r.theme} ${r.href} 未渲染出 #root（rootChildren=${r.rootChildren}）—— 这是访问地址不对，不是样式问题`)
    }

    for (const r of results) {
      if (!r.loaded) continue
      expect(!r.horizontalOverflow, `${r.theme} 出现横向溢出 ${r.scrollW}>${r.innerW}`)
      expect(/Inter|system-ui|Noto Sans|PingFang|YaHei/.test(r.bodyFont),
        `${r.theme} 正文字体未换血（仍是 ${r.bodyFont}）`)

      /* 字体必须真被加载，且外链里不能还挂着已退役的字体。
         换字体只改 tokens 不改 index.html 外链 → 声明生效、实际回退系统字体，
         这个坑就是靠这条断言拦住的。 */
      if (r.fonts && r.fonts.inter !== null) {
        expect(r.fonts.inter, `${r.theme} Inter 未被真正加载（声明了但外链没拉，实际回退系统字体）`)
        expect(r.fonts.interTight, `${r.theme} Inter Tight 未被真正加载（按 600 字重查）`)
        expect(r.fonts.mono, `${r.theme} JetBrains Mono 未被真正加载`)
        expect(!r.fonts.retiredLinked,
          `${r.theme} 外链里还挂着已退役的 Fraunces / Public Sans，白拉两个用不到的字体并阻塞首屏`)
        /* 标题必须真的落在 Inter Tight 上 —— 令牌第一档被浏览器跳过时它会静默回退 Inter */
        if (r.h1Font) {
          expect(/Inter Tight/.test(r.h1Font) && r.fonts.interTight,
            `${r.theme} h1 未真正使用 Inter Tight（font-family=${String(r.h1Font).slice(0, 40)}）`)
        }
      }
      /* 主色必须是蓝色系，不允许残留 v2 的朱红 rgb(192,57,43)/rgb(255,106,77)。
         注意 getPropertyValue 返回的是**声明值**（这里是 hex），不是 rgb()，
         所以按 hex 判定，别写 rgb 正则。 */
      const acc = (r.tokens['--accent'] || '').toLowerCase()
      expect(
        acc === '#2563eb' || acc === '#5b93ff',
        `${r.theme} --accent 不是蓝色系：${acc || '(空)'}`
      )
      expect((r.tokens['--grad-brand'] || '').includes('gradient'), `${r.theme} --grad-brand 缺失`)
      // 品牌 logo 必须真的用上渐变（nav-logo 无 disabled 态）
      const logo = r.elements.find((e) => e.sel === '.nav-logo')
      if (logo) expect(logo.bgImage.includes('gradient'), `${r.theme} .nav-logo 未吃到渐变（${logo.bg}）`)
      /* 主按钮：仅对**可用**按钮断言渐变。
         components.css 的 `.button--primary:disabled`（0,2,0）本就故意压过
         redesign 的 (0,1,0) —— 禁用态不该发光，这是设计决定，不是 bug。 */
      const pb = r.elements.find((e) => e.sel === '.button--primary')
      if (pb) {
        if (pb.disabled) {
          expect(!pb.bgImage.includes('gradient'),
            `${r.theme} .button--primary 禁用态仍有渐变，禁用态不该发光`)
        } else {
          expect(pb.bgImage.includes('gradient'),
            `${r.theme} .button--primary 未吃到渐变（${pb.bg}）`)
        }
      }
      // 页面容器玻璃层
      const page = r.elements.find((e) => e.sel === '.page')
      if (page) expect(page.backdrop !== 'none', `${r.theme} .page 缺 backdrop-filter 玻璃层`)
    }

    /* ---- 报告 ---- */
    console.log('=== 令牌实测 ===')
    const keys = ['--page', '--ink', '--muted', '--accent', '--accent-ink', '--accent-2', '--grad-brand', '--font-display']
    for (const k of keys) {
      console.log(`  ${k.padEnd(15)} light=${(light.tokens[k] || '').slice(0, 58)}`)
      if ((dark.tokens[k] || '') !== (light.tokens[k] || '')) {
        console.log(`  ${''.padEnd(15)} dark =${(dark.tokens[k] || '').slice(0, 58)}`)
      }
    }

    for (const r of results) {
      console.log(`\n=== ${r.route || '/'} · ${r.theme} ===`)
      for (const e of r.elements.slice(0, 10)) {
        console.log(`  ${e.sel.padEnd(18)} bg=${e.bg.padEnd(22)} color=${e.color.padEnd(20)} ${e.bgImage !== 'none' ? 'GRADIENT ' : ''}${e.backdrop !== 'none' ? 'GLASS ' : ''}r=${e.borderRadius}`)
      }
    }

    console.log(`\n截图与报告目录：${OUT}`)
    if (fail.length) {
      console.error(`\n❌ ${fail.length} 项断言未通过：`)
      fail.forEach((f) => console.error('  - ' + f))
      process.exitCode = 1
    } else {
      console.log('\n✅ 全部断言通过')
    }
  } finally {
    child.kill()
    try { fs.rmSync(profile, { recursive: true, force: true }) } catch { /* ignore */ }
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
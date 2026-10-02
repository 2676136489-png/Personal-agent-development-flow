/**
 * 放大局部截图：验证「氛围层网格 / 极光 / 玻璃 / 发光」这些**低对比度**细节。
 *
 * 为什么需要它：整页截图缩到 700px 宽后，0.07 alpha 的网格线只剩一个像素都不到，
 * 肉眼看不出"有没有"。本脚本用 deviceScaleFactor=2 + clip 截关键区域，
 * 再用像素采样算出实际颜色差，用数字说话而不是靠眼睛。
 */
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const zlib = require('node:zlib')

const CHROME =
  process.env.PROBE_CHROME ||
  'C:/Users/111/AppData/Local/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-win64/chrome-headless-shell.exe'
const PORT = 9338
const BASE = (process.argv[2] || 'http://127.0.0.1:4178').replace(/\/$/, '')
const THEME = process.argv[3] || 'light'
const OUT = path.resolve(__dirname, '../.probe-visual')

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

/* ---- 极简 PNG 解码（只处理 8bit RGB/RGBA，非隔行），
       用来对截图做像素采样，验证网格线真的落在了像素上 ---- */
function decodePNG(buf) {
  let pos = 8
  let width = 0, height = 0, bitDepth = 0, colorType = 0
  const idat = []
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos)
    const type = buf.toString('ascii', pos + 4, pos + 8)
    const data = buf.subarray(pos + 8, pos + 8 + len)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      bitDepth = data[8]
      colorType = data[9]
      if (data[12] !== 0) throw new Error('隔行 PNG 不支持')
    } else if (type === 'IDAT') idat.push(data)
    else if (type === 'IEND') break
    pos += 12 + len
  }
  if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6)) {
    throw new Error(`不支持的 PNG 格式 depth=${bitDepth} type=${colorType}`)
  }
  const channels = colorType === 6 ? 4 : 3
  const raw = zlib.inflateSync(Buffer.concat(idat))
  const stride = width * channels
  const out = Buffer.alloc(height * stride)
  let rp = 0
  for (let y = 0; y < height; y++) {
    const filter = raw[rp++]
    const rowStart = y * stride
    for (let x = 0; x < stride; x++) {
      const rawByte = raw[rp + x]
      const a = x >= channels ? out[rowStart + x - channels] : 0
      const b = y > 0 ? out[rowStart - stride + x] : 0
      const c = x >= channels && y > 0 ? out[rowStart - stride + x - channels] : 0
      let v
      switch (filter) {
        case 0: v = rawByte; break
        case 1: v = rawByte + a; break
        case 2: v = rawByte + b; break
        case 3: v = rawByte + ((a + b) >> 1); break
        case 4: {
          const p = a + b - c
          const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c)
          v = rawByte + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)
          break
        }
        default: throw new Error(`未知 filter ${filter}`)
      }
      out[rowStart + x] = v & 0xff
    }
    rp += stride
  }
  return { width, height, channels, data: out }
}

const px = (img, x, y) => {
  const i = (y * img.width + x) * img.channels
  return [img.data[i], img.data[i + 1], img.data[i + 2]]
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true })
  const profile = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'probe-zoom-'))
  const child = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${PORT}`,
    '--no-sandbox', '--no-first-run', '--no-default-browser-check', '--disable-gpu',
    `--user-data-dir=${profile}`, '--window-size=1440,1000', '--hide-scrollbars',
    'about:blank'
  ], { stdio: 'ignore' })

  try {
    await waitForDevtools()
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
    const cdp = connect(list.find((t) => t.type === 'page').webSocketDebuggerUrl)
    await cdp.ready
    await cdp.send('Page.enable')
    await cdp.send('Runtime.enable')
    // 2 倍像素密度：低对比度细节才看得见
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1440, height: 1000, deviceScaleFactor: 2, mobile: false
    })
    await cdp.send('Page.navigate', { url: `${BASE}/#/` })
    for (let i = 0; i < 30; i++) {
      await sleep(250)
      const { result } = await cdp.send('Runtime.evaluate', {
        expression: `!!(document.querySelector('#root') && document.querySelector('#root').childElementCount)`,
        returnByValue: true
      })
      if (result.value) break
    }
    await cdp.send('Runtime.evaluate', {
      expression: `document.documentElement.setAttribute('data-theme','${THEME}')`
    })
    await sleep(1200)

    /* ---- 关键区域放大截图 ---- */
    const regions = [
      { name: 'nav-logo', sel: '.nav-logo', pad: 70 },
      { name: 'nav-active', sel: '.nav-link--active', pad: 70 },
      { name: 'hero-visual', sel: '.hero-visual', pad: 0 },
      { name: 'primary-btn', sel: '.button--primary', pad: 60 }
    ]
    for (const r of regions) {
      const { result } = await cdp.send('Runtime.evaluate', {
        expression: `(() => {
          const el = document.querySelector('${r.sel}')
          if (!el) return null
          const b = el.getBoundingClientRect()
          const p = ${r.pad}
          return { x: Math.max(0, b.x - p), y: Math.max(0, b.y - p),
                   width: Math.min(1440 - Math.max(0, b.x - p), b.width + p * 2),
                   height: b.height + p * 2, cx: b.x + b.width / 2, cy: b.y + b.height / 2 }
        })()`,
        returnByValue: true
      })
      if (!result.value) { console.log(`⚠️ 未找到 ${r.sel}`); continue }
      const clip = result.value
      // 把鼠标移到该元素中心，激活**真实 hover 态**再截图。
      // 之前只截静态态，漏掉了 hover 才暴露的「深底深字」缺陷。
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved', x: clip.cx, y: clip.cy, buttons: 0
      })
      await sleep(500)
      const shot = await cdp.send('Page.captureScreenshot', {
        format: 'png', clip: { ...clip, scale: 2 }
      })
      const file = path.join(OUT, `zoom-${THEME}-${r.name}.png`)
      fs.writeFileSync(file, Buffer.from(shot.data, 'base64'))
      console.log(`📸 ${path.basename(file)}  ${Math.round(clip.width)}×${Math.round(clip.height)} @2x（hover 态）`)
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 5, buttons: 0 })
      await sleep(200)
    }

    /* ---- 对比度断言：hover 态下「文字 vs 自身背景」必须仍然可读 ----
       这是本轮真实修掉的缺陷类型（深底深字），不该只靠肉眼复查。 */
    const { result: contrast } = await cdp.send('Runtime.evaluate', {
      expression: `(() => {
        const toRGB = (s) => {
          const m = s.match(/[\\d.]+/g)
          return m ? m.slice(0, 3).map(Number) : null
        }
        const lum = (c) => {
          const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4) }
          return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2])
        }
        const cr = (a, b) => {
          const l1 = lum(a), l2 = lum(b)
          return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)
        }
        // hover 状态下读激活项的实际呈现
        const el = document.querySelector('.nav-link--active')
        if (!el) return null
        el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
        const cs = getComputedStyle(el)
        const bg = cs.backgroundColor
        const fg = cs.color
        const bgImg = cs.backgroundImage
        // 有渐变时 backgroundColor 会是 transparent，改用渐变首个色标近似
        let effective = bg
        if (bgImg !== 'none') {
          const m = bgImg.match(/rgba?\\(([^)]+)\\)/)
          if (m) effective = 'rgb(' + m[1].split(',').slice(0, 3).join(',') + ')'
        }
        return { bg, fg, effective, hasGradient: bgImg !== 'none',
                 ratio: cr(toRGB(fg), toRGB(effective)) }
      })()`,
      returnByValue: true
    })
    if (contrast.value) {
      const c = contrast.value
      console.log(`\n=== 激活项 hover 态对比度（${THEME}）===`)
      console.log(`  文字 ${c.fg} / 底色 ${c.effective}（渐变=${c.hasGradient}）→ 对比度 ${c.ratio.toFixed(2)}:1`)
      if (c.ratio < 4.5) {
        console.error(`❌ hover 态出现「深底深字」，对比度不足 4.5:1`)
        process.exitCode = 1
      } else {
        console.log(`  ✅ ≥ 4.5:1，hover 不再压暗激活项文字`)
      }
    }

    /* ---- 像素级验证：氛围层网格到底画出来没有 ---- */
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
    const img = decodePNG(Buffer.from(shot.data, 'base64'))
    // 扫一条水平线，找相邻像素亮度跳变 —— 网格线就是这条跳变
    const y = Math.floor(img.height * 0.28)
    let jumps = []
    for (let x = 40; x < Math.min(420, img.width); x++) {
      const a = px(img, x, y), b = px(img, x + 1, y)
      const d = Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2])
      if (d >= 3) jumps.push({ x, d, a, b })
    }
    console.log(`\n=== 氛围层像素采样（${THEME}）===`)
    console.log(`扫描行 y=${y}，x=40..420，相邻像素 RGB 差 ≥3 的位置：${jumps.length} 个`)
    if (jumps.length) {
      console.log('前 8 个跳变点：')
      jumps.slice(0, 8).forEach((j) =>
        console.log(`  x=${String(j.x).padStart(3)}  Δ=${String(j.d).padStart(3)}  ${j.a}→${j.b}`)
      )
      const xs = jumps.map((j) => j.x)
      console.log(`间距样本：${xs.slice(0, 6).map((v, i) => (i ? v - xs[i - 1] : '-')).join(' ')}  （2x 下 32px 栅格 = 64 设备像素）`)
    }

    const verdict = jumps.length >= 3 ? '✅ 网格线已渲染到像素' : '❌ 氛围层网格几乎不可见'
    console.log(verdict)
    if (jumps.length < 3) process.exitCode = 1
  } finally {
    child.kill()
    try { fs.rmSync(profile, { recursive: true, force: true }) } catch { /* ignore */ }
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
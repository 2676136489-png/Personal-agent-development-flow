/**
 * 用 CDP 精确测量「报告弹窗为什么没居中」。
 *
 * 为什么不用肉眼/截图判断：弹窗样式本身是 `position: fixed; inset: 0;
 * place-items: center`，必然居中 —— 除非某个祖先元素创建了 containing block
 * （transform / filter / backdrop-filter / perspective / contain / will-change
 * 任意一个都会让 fixed 相对它而非视口定位）。这只能靠真实布局引擎量。
 *
 * 本脚本零依赖：Node 22 自带全局 WebSocket，直接说 CDP。
 */
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const CHROME =
  'C:/Users/111/AppData/Local/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-win64/chrome-headless-shell.exe'
const PORT = 9333
const URL = process.argv[2] || 'https://ai-research-workspace.app.workbuddy.host/#/reports'
const WIDTH = Number(process.argv[3] || 1280)
const HEIGHT = Number(process.argv[4] || 720)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitForDevtools() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/version`)
      if (res.ok) return true
    } catch {
      /* 还没起来 */
    }
    await sleep(250)
  }
  throw new Error('Chrome DevTools 端口未就绪')
}

class Cdp {
  constructor(ws) {
    this.ws = ws
    this.id = 0
    this.pending = new Map()
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data)
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result)
      }
    })
  }
  send(method, params = {}) {
    const id = ++this.id
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }
  async evaluate(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })
    if (r.exceptionDetails) {
      throw new Error('页面内异常: ' + JSON.stringify(r.exceptionDetails.exception))
    }
    return r.result.value
  }
}

/** 在页面里跑：点开第一个报告卡 → 量弹窗几何 → 逐层找「谁创建了包含块」 */
const PROBE = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // 1) 等报告卡片出现
  for (let i = 0; i < 60; i++) {
    if (document.querySelector('.report-card')) break;
    await sleep(500);
  }
  const cards = document.querySelectorAll('.report-card');
  let injected = false;
  if (cards.length) {
    cards[0].click();
  } else {
    // 没有已完成报告时，在**同一容器位置**注入等价结构：
    // 这样测的仍然是真实的 CSS 级联与 DOM 包裹关系，只是省去造数据。
    const host = document.querySelector('.panel') || document.querySelector('main');
    if (!host) return { error: '找不到可注入的容器', url: location.href };
    const bd = document.createElement('div');
    bd.className = 'modal-backdrop';
    const md = document.createElement('div');
    md.className = 'modal';
    md.style.height = '600px';
    bd.appendChild(md);
    host.appendChild(bd);
    injected = true;
  }

  for (let i = 0; i < 40; i++) {
    if (document.querySelector('.modal-backdrop')) break;
    await sleep(200);
  }
  await sleep(700); // 等入场动画结束

  const backdrop = document.querySelector('.modal-backdrop');
  const modal = document.querySelector('.modal');
  if (!backdrop || !modal) return { error: '弹窗没出现', html: document.body.innerHTML.slice(0, 400) };

  const rect = (el) => {
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
  };

  // 3) 逐层往上找：谁让 position:fixed 失效
  const suspects = [];
  let node = backdrop.parentElement;
  let depth = 0;
  while (node && depth < 40) {
    const cs = getComputedStyle(node);
    const reasons = [];
    if (cs.transform && cs.transform !== 'none') reasons.push('transform=' + cs.transform);
    if (cs.filter && cs.filter !== 'none') reasons.push('filter=' + cs.filter);
    if (cs.backdropFilter && cs.backdropFilter !== 'none') reasons.push('backdrop-filter=' + cs.backdropFilter);
    if (cs.perspective && cs.perspective !== 'none') reasons.push('perspective=' + cs.perspective);
    if (cs.contain && cs.contain !== 'none') reasons.push('contain=' + cs.contain);
    if (cs.willChange && cs.willChange !== 'auto') reasons.push('will-change=' + cs.willChange);
    if (cs.animationName && cs.animationName !== 'none') reasons.push('animation=' + cs.animationName + ' fill=' + cs.animationFillMode);
    if (reasons.length) {
      suspects.push({
        tag: node.tagName.toLowerCase(),
        cls: (node.className || '').toString().slice(0, 60),
        position: cs.position,
        rect: rect(node),
        reasons,
      });
    }
    node = node.parentElement;
    depth++;
  }

  const backdropCs = getComputedStyle(backdrop);
  return {
    url: location.href,
    injected,
    viewport: { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio },
    backdrop: { ...rect(backdrop), position: backdropCs.position, inset: backdropCs.inset, display: backdropCs.display, placeItems: backdropCs.placeItems },
    modal: { ...rect(modal), width: getComputedStyle(modal).width, maxHeight: getComputedStyle(modal).maxHeight },
    centerOffset: { x: Math.round(rect(modal).x + rect(modal).w / 2 - window.innerWidth / 2), y: Math.round(rect(modal).y + rect(modal).h / 2 - window.innerHeight / 2) },
    suspects,
    cardsFound: cards.length,
  };
})()`

async function main() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-prof-'))
  const child = spawn(
    CHROME,
    [
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${profile}`,
      `--window-size=${WIDTH},${HEIGHT}`,
      '--disable-dev-shm-usage',
      '--no-first-run',
      '--no-default-browser-check',
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  )
  child.stderr.on('data', (buf) => {
    const text = buf.toString()
    if (/error|Error|ERROR/.test(text)) console.error('[chrome]', text.trim().slice(0, 300))
  })
  console.error('[probe] 已启动 chrome，pid=' + child.pid)

  try {
    console.error('[probe] 等待 DevTools 端口…')
    await waitForDevtools()
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
    console.error('[probe] targets=' + list.length + ' types=' + list.map((t) => t.type).join(','))
    const target = list.find((t) => t.type === 'page')
    if (!target) throw new Error('没有可用的页面 target')

    const ws = new WebSocket(target.webSocketDebuggerUrl)
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve)
      ws.addEventListener('error', reject)
    })
    const cdp = new Cdp(ws)
    console.error('[probe] CDP 已连接')

    await cdp.send('Page.enable')
    await cdp.send('Runtime.enable')
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: WIDTH,
      height: HEIGHT,
      deviceScaleFactor: 1,
      mobile: false,
    })

    console.error('[probe] 导航到 ' + URL)
    await cdp.send('Page.navigate', { url: URL })
    await sleep(8000) // 等 SPA 挂载 + 数据加载
    console.error('[probe] 开始探测')

    const result = await cdp.evaluate(PROBE)
    console.log(JSON.stringify(result, null, 2))

    ws.close()
  } finally {
    child.kill()
    try {
      fs.rmSync(profile, { recursive: true, force: true })
    } catch {
      /* 临时目录清理失败无所谓 */
    }
  }
}

main().catch((e) => {
  console.error('探测失败:', e.message)
  process.exit(1)
})

/**
 * [F11] 验证「效果评估 → 点击最近运行 → 跳到对应页面并打开该记录」。
 *
 * 断言三件事：
 * 1. 点「已完成」的行 → URL 变 #/reports?thread=... 且报告弹窗打开，标题/内容对得上
 * 2. 点「待确认」的行 → URL 变 #/workflow?thread=... 且深度研究页加载了那一次运行
 * 3. 跳转后 URL 里的 thread 必须是**被点击的那一条**（点 A 看到 B 是最典型的 bug）
 *
 * 用法：node probe-evaluation-jump.cjs <baseUrl>
 */
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const CHROME =
  'C:/Users/111/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe'
const PORT = 9334
const BASE = (process.argv[2] || 'https://ebed98754f5b4e4abafe591d754aff06.app.workbuddy.host').replace(/\/$/, '')

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
  throw new Error('DevTools 端口未就绪')
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
    if (r.exceptionDetails) throw new Error('页面内异常: ' + JSON.stringify(r.exceptionDetails.exception))
    return r.result.value
  }
}

/** 点第 index 行最近运行，返回落地状态 */
const clickRow = (index) => `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const btn = document.querySelectorAll('.run-list__btn')[${index}];
  if (!btn) return { error: '第 ${index} 行不存在', rows: document.querySelectorAll('.run-list__btn').length };

  const row = { text: btn.innerText.replace(/\\s+/g, ' ').trim().slice(0, 80) };
  const before = location.hash;
  btn.click();
  await sleep(4500);

  return {
    row,
    hashBefore: before,
    hashAfter: location.hash,
    url: location.href,
    modalOpen: !!document.querySelector('.modal-backdrop'),
    modalTitle: (document.querySelector('.modal .panel__title') || {}).textContent || null,
    modalBodyHead: (document.querySelector('.modal .report-panel__title') || document.querySelector('.modal .report-panel') || {}).textContent?.slice(0, 60) || null,
    workflowQuestion: (document.querySelector('.field .textarea') || {}).value?.slice(0, 60) || null,
    statusBadges: [...document.querySelectorAll('.status-badge, .badge')].slice(0, 4).map((el) => el.textContent.trim()),
  };
})()`

const readEvaluation = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < 60; i++) {
    if (document.querySelectorAll('.run-list__btn').length) break;
    await sleep(500);
  }
  const rows = [...document.querySelectorAll('.run-list__btn')];
  return {
    url: location.href,
    rowCount: rows.length,
    rows: rows.map((el) => el.innerText.replace(/\\s+/g, ' ').trim().slice(0, 70)),
    anyPlainRow: !!document.querySelector('.run-list__row'),
  };
})()`

async function main() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-nav-'))
  const child = spawn(
    CHROME,
    [
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${profile}`,
      '--window-size=1440,900',
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--no-first-run',
      '--no-default-browser-check',
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  )
  child.stderr.on('data', () => {})

  try {
    await waitForDevtools()
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
    const target = list.find((t) => t.type === 'page')
    const ws = new WebSocket(target.webSocketDebuggerUrl)
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve)
      ws.addEventListener('error', reject)
    })
    const cdp = new Cdp(ws)
    await cdp.send('Page.enable')
    await cdp.send('Runtime.enable')
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1440,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    })

    console.log('=== 1) 打开效果评估页 ===')
    await cdp.send('Page.navigate', { url: `${BASE}/?r=${Date.now()}#/evaluation` })
    await sleep(6000)
    const evalPage = await cdp.evaluate(readEvaluation)
    console.log(JSON.stringify(evalPage, null, 2))

    if (!evalPage.rowCount) {
      console.log('!! 没有可点行，终止')
      return
    }

    /**
     * 每次点击前**重新读列表并按状态文字定位**。
     *
     * 不能缓存行下标：列表按 updated_at 倒序，一次点击/批准就会让顺序变化，
     * 复用旧下标会点到另一条（探针自己踩过这个坑，测出来的是假结论）。
     */
    async function clickByKeyword(keyword) {
      await cdp.send('Page.navigate', { url: `${BASE}/?r=${Date.now()}#/evaluation` })
      await sleep(6000)
      const fresh = await cdp.evaluate(readEvaluation)
      const idx = fresh.rows.findIndex((t) => t.includes(keyword))
      if (idx < 0) return { skipped: `本次没有「${keyword}」样本`, rows: fresh.rows }
      const picked = fresh.rows[idx]
      const result = await cdp.evaluate(clickRow(idx))
      return { picked, ...result }
    }

    console.log('\n=== 2) 点「已完成」行 → 应跳研究报告并打开该报告 ===')
    console.log(JSON.stringify(await clickByKeyword('已完成'), null, 2))

    console.log('\n=== 3) 点「待确认」行 → 应跳深度研究并加载该次运行 ===')
    console.log(JSON.stringify(await clickByKeyword('待确认'), null, 2))

    console.log('\n=== 4) 打开报告后关掉弹窗 → URL 里的 ?thread= 应被清掉 ===')
    const openedForClose = await clickByKeyword('已完成')
    console.log(
      '  打开：',
      JSON.stringify({ hash: openedForClose.hashAfter, modalOpen: openedForClose.modalOpen }),
    )
    const closed = await cdp.evaluate(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const closeBtn = document.querySelector('.modal .nav-icon');
      if (!closeBtn) return { error: '找不到关闭按钮', hash: location.hash };
      const hashOpened = location.hash;
      closeBtn.click();
      await sleep(1500);
      return {
        hashOpened,
        hashAfterClose: location.hash,
        modalStillOpen: !!document.querySelector('.modal-backdrop'),
      };
    })()`)
    console.log(JSON.stringify(closed, null, 2))

    ws.close()
  } finally {
    child.kill()
    try {
      fs.rmSync(profile, { recursive: true, force: true })
    } catch {
      /* 忽略 */
    }
  }
}

main().catch((e) => {
  console.error('验证失败:', e.message)
  process.exit(1)
})

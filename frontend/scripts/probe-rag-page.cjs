/**
 * RAG 页面探针：跑一次真实流水线，量出每块可视化的实际渲染结果并出图。
 *
 * 为什么不能只看接口返回：
 * 色带是用百分比定位的绝对元素、热力图是 grid、散点是 SVG —— 数据对了但
 * 定位/网格/视口算错时页面照样是空的。这里直接数量化：色带段数、热力格数、
 * 散点数、命中行数，再配截图。
 *
 * 零依赖：Node 22 自带全局 WebSocket。
 *
 * 用法：
 *   node scripts/probe-rag-page.cjs http://127.0.0.1:8765
 */
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const CHROME =
  process.env.PROBE_CHROME ||
  'C:/Users/111/AppData/Local/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-win64/chrome-headless-shell.exe'
const PORT = Number(process.env.PROBE_PORT || 9341)
const BASE = (process.argv[2] || 'http://127.0.0.1:8765').replace(/\/$/, '')
const OUT = path.resolve(__dirname, '../.probe-rag')
const WIDTH = 1440
const HEIGHT = 1000

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

const METRICS = `(() => {
  const all = (s) => Array.from(document.querySelectorAll(s))
  const text = (s) => {
    const el = document.querySelector(s)
    return el ? el.textContent.replace(/\\s+/g, ' ').trim().slice(0, 160) : null
  }
  const root = document.querySelector('#root')
  return {
    href: location.href,
    loaded: !!(root && root.childElementCount > 0),
    skeleton: !!document.querySelector('.skeleton'),
    theme: document.documentElement.getAttribute('data-theme'),
    segments: all('.rag-ruler__seg').length,
    overlaps: all('.rag-ruler__overlap').length,
    chunkCards: all('.rag-chunk').length,
    heatCells: all('.rag-heatmap__cell').length,
    scatterDots: all('.rag-scatter__dot').length,
    hitRows: all('.rag-hit').length,
    selectedHits: all('.rag-hit[data-selected="true"]').length,
    statItems: all('.rag-stats__item').length,
    figures: all('.rag-figure').length,
    promptChars: (document.querySelector('.rag-prompt')?.textContent || '').length,
    runTotal: text('.rag-runbar__total'),
    stepTitles: all('.rag-step__title').map((el) => el.textContent.trim()),
    recapItems: all('.rag-recap__item').length,
    recapLabels: all('.rag-recap__label').map((el) => el.textContent.trim()),
    recapValues: all('.rag-recap__value').map((el) => el.textContent.trim()),
    layout: (() => {
      const flow = document.querySelector('.rag-flow')
      const recap = document.querySelector('.rag-recap')
      const results = document.querySelector('.rag-results')
      if (!flow || !recap) return null
      const a = flow.getBoundingClientRect()
      const b = recap.getBoundingClientRect()
      // 每一步是一条横区：量它是竖着叠下去的，以及区内「选项在左、详情在右」
      const bands = Array.from(flow.querySelectorAll('.rag-step')).map((el) => {
        const options = el.querySelector('.rag-step__options')
        const pane = el.querySelector('.rag-step__pane')
        const box = el.getBoundingClientRect()
        const optBox = options?.getBoundingClientRect()
        const paneBox = pane?.getBoundingClientRect()
        return {
          title: el.querySelector('.rag-step__title')?.textContent.trim(),
          top: Math.round(box.top),
          h: Math.round(box.height),
          optionW: optBox ? Math.round(optBox.width) : 0,
          paneW: paneBox ? Math.round(paneBox.width) : 0,
          paneRightOfOptions: !!(optBox && paneBox) && paneBox.left >= optBox.right - 1,
        }
      })
      return {
        bands,
        stacked: bands.every((band, index) => index === 0 || band.top > bands[index - 1].top),
        docs: all('.rag-method-detail__doc').length,
        recapBelowFlow: b.top >= a.bottom - 1,
        resultsBelowRecap: results ? results.getBoundingClientRect().top >= b.bottom - 1 : null,
        flowW: Math.round(a.width),
        recapW: Math.round(b.width),
      }
    })(),
    figureTitles: all('.rag-figure__title').map((el) => el.textContent.trim()),
    warnings: all('.rag-alert--warn').map((el) => el.textContent.replace(/\\s+/g, ' ').trim()),
    runError: text('.rag-alert.alert--error'),
    overflowX: document.documentElement.scrollWidth > window.innerWidth,
    scrollW: document.documentElement.scrollWidth,
    innerW: window.innerWidth,
    bodyBg: getComputedStyle(document.body).backgroundColor,
    chunkPanel: {
      docs: all('.doc').length,
      chunks: all('.kb-chunk').length,
      status: text('.kb-status__title')
    },
    runtimeErrors: window.__errors || []
  }
})()`

async function evaluate(cdp, expression) {
  const { result, exceptionDetails } = await cdp.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  })
  if (exceptionDetails) throw new Error(exceptionDetails.text || 'evaluate failed')
  return result.value
}

async function waitFor(cdp, expression, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await evaluate(cdp, expression)) return true
    await sleep(300)
  }
  throw new Error(`等待超时：${label}`)
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true })
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-rag-'))
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
      `--window-size=${WIDTH},${HEIGHT}`,
      '--hide-scrollbars',
      '--force-device-scale-factor=1',
      'about:blank',
    ],
    { stdio: 'ignore' },
  )

  const report = { base: BASE, steps: [] }
  try {
    await waitForDevtools()
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
    const target = list.find((t) => t.type === 'page')
    const cdp = connect(target.webSocketDebuggerUrl)
    await cdp.ready

    const consoleErrors = []
    cdp.on('Runtime.exceptionThrown', (params) => {
      consoleErrors.push(params.exceptionDetails.text || 'exception')
    })
    cdp.on('Runtime.consoleAPICalled', (params) => {
      if (params.type === 'error') {
        consoleErrors.push(params.args.map((a) => a.value ?? a.description).join(' ').slice(0, 300))
      }
    })

    await cdp.send('Page.enable')
    await cdp.send('Runtime.enable')
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: WIDTH,
      height: HEIGHT,
      deviceScaleFactor: 1,
      mobile: false,
    })

    /* ---------- 1. RAG 页首次进入 ---------- */
    await cdp.send('Page.navigate', { url: `${BASE}/#/rag` })
    await waitFor(cdp, "!!document.querySelector('.rag-flow')", 30_000, 'RAG 方法配置')
    await waitFor(cdp, "!!document.querySelector('.rag-recap')", 30_000, '选择回显')
    await evaluate(cdp, "localStorage.removeItem('arw-rag-config')")
    await sleep(400)
    const beforeRun = await evaluate(cdp, METRICS)
    report.steps.push({ name: 'before-run', ...beforeRun })
    const layoutProblems = []
    if (beforeRun.stepTitles.length !== 4) {
      layoutProblems.push(`步骤应 4 步，实际 ${beforeRun.stepTitles.length}`)
    }
    if (beforeRun.recapItems !== 4) {
      layoutProblems.push(`回显项应 4 个，实际 ${beforeRun.recapItems}`)
    }
    const bands = beforeRun.layout?.bands ?? []
    if (bands.length !== 4) {
      layoutProblems.push(`横区应 4 条，实际 ${bands.length}`)
    }
    if (!beforeRun.layout?.stacked) {
      layoutProblems.push(`横区没有竖向依次堆叠：${bands.map((b) => b.top).join('/')}`)
    }
    bands.forEach((band) => {
      if (!band.paneRightOfOptions) {
        layoutProblems.push(`「${band.title}」的详情没有落在选项右侧`)
      }
      if (band.paneW < 460) {
        layoutProblems.push(`「${band.title}」详情区只有 ${band.paneW}px，展不开正文`)
      }
    })
    if ((beforeRun.layout?.docs ?? 0) < 1) {
      layoutProblems.push('详情区没有渲染出官方文档链接')
    }
    if (!beforeRun.layout?.recapBelowFlow) {
      layoutProblems.push('回显区没有落在配置区下方')
    }
    if (beforeRun.overflowX) {
      layoutProblems.push(`横向溢出：scrollW ${beforeRun.scrollW} > innerW ${beforeRun.innerW}`)
    }
    report.layoutProblems = layoutProblems

    /* ---------- 2. 跑一次真实流水线（文档语料 + 语义切分） ---------- */
    const switched = await evaluate(
      cdp,
      `(() => {
        const docTab = Array.from(document.querySelectorAll('.rag-switch__btn'))
          .find((el) => el.textContent.includes('知识库'))
        if (docTab) docTab.click()
        return !!docTab
      })()`,
    )
    if (switched) {
      await sleep(300)
      await evaluate(
        cdp,
        `(() => {
          const select = document.querySelector('.rag-step select.input')
          if (!select || !select.options.length) return false
          select.selectedIndex = 1
          select.dispatchEvent(new Event('change', { bubbles: true }))
          return select.value
        })()`,
      )
      await sleep(300)
      // 语义切分：验证「切块这一步会调向量模型」的路径
      await evaluate(
        cdp,
        `(() => {
          const btn = Array.from(document.querySelectorAll('.rag-method'))
            .find((el) => el.textContent.includes('语义切分'))
          if (btn) btn.click()
          return !!btn
        })()`,
      )
      await sleep(300)
    }

    // 回显要跟着选择走：选了文档就不该还显示「未选择文档」
    const recapAfterSwitch = await evaluate(
      cdp,
      "Array.from(document.querySelectorAll('.rag-recap__value')).map((el) => el.textContent.trim())",
    )
    report.recapAfterSwitch = recapAfterSwitch
    if (!recapAfterSwitch || recapAfterSwitch.length !== 4) {
      report.layoutProblems.push(`回显项异常：${JSON.stringify(recapAfterSwitch)}`)
    } else if (recapAfterSwitch[0].includes('未选择')) {
      report.layoutProblems.push(`已选文档但回显仍为「${recapAfterSwitch[0]}」`)
    }

    await evaluate(
      cdp,
      `(() => {
        const input = document.querySelector('.rag-step input.input[placeholder*="召回率"]')
        if (input) {
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
          setter.call(input, '向量数据库怎么选型，召回率和运维成本怎么权衡')
          input.dispatchEvent(new Event('input', { bubbles: true }))
        }
        document.querySelector('.rag-run__btn')?.click()
        return true
      })()`,
    )

    await waitFor(cdp, "!!document.querySelector('.rag-report')", 120_000, 'RAG 结果')
    await sleep(800)
    report.steps.push({ name: 'after-run', ...(await evaluate(cdp, METRICS)) })

    /* ---------- 2b. 换成递归切分 + 80 字重叠：验证斜纹真的画出来了 ---------- */
    const prevTotal =
      (await evaluate(cdp, "document.querySelector('.rag-runbar__total')?.textContent || ''")) || ''
    await evaluate(
      cdp,
      `(() => {
        const btn = Array.from(document.querySelectorAll('.rag-method'))
          .find((el) => el.textContent.includes('递归字符切分'))
        btn?.click()
        return !!btn
      })()`,
    )
    await sleep(300)
    await evaluate(cdp, "(() => { document.querySelector('.rag-run__btn')?.click(); return true })()")
    await waitFor(
      cdp,
      `(() => {
        const btn = document.querySelector('.rag-run__btn')
        const total = document.querySelector('.rag-runbar__total')?.textContent || ''
        return !!btn && !btn.disabled && total !== ${JSON.stringify(prevTotal)}
      })()`,
      120_000,
      '递归切分结果',
    )
    await sleep(700)
    report.steps.push({ name: 'recursive-run', ...(await evaluate(cdp, METRICS)) })

    const lightShot = await cdp.send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: true,
    })
    fs.writeFileSync(path.join(OUT, 'rag-light.png'), Buffer.from(lightShot.data, 'base64'))

    /* ---------- 3. 深色主题 ---------- */
    await evaluate(cdp, "document.documentElement.setAttribute('data-theme','dark')")
    await sleep(500)
    report.steps.push({ name: 'dark', ...(await evaluate(cdp, METRICS)) })
    const darkShot = await cdp.send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: true,
    })
    fs.writeFileSync(path.join(OUT, 'rag-dark.png'), Buffer.from(darkShot.data, 'base64'))

    await evaluate(cdp, "document.documentElement.setAttribute('data-theme','light')")

    /* ---------- 4. 知识库页：展开片段 ---------- */
    await cdp.send('Page.navigate', { url: `${BASE}/#/knowledge` })
    await waitFor(cdp, "!!document.querySelector('.doc')", 30_000, '知识库文档列表')
    await evaluate(
      cdp,
      `(() => {
        const btn = Array.from(document.querySelectorAll('.doc__actions .button'))
          .find((el) => el.textContent.includes('查看片段'))
        btn?.click()
        return !!btn
      })()`,
    )
    await waitFor(cdp, "!!document.querySelector('.kb-chunk')", 30_000, '片段列表')
    await sleep(500)
    report.steps.push({ name: 'knowledge', ...(await evaluate(cdp, METRICS)) })
    const kbShot = await cdp.send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: true,
    })
    fs.writeFileSync(path.join(OUT, 'knowledge-chunks.png'), Buffer.from(kbShot.data, 'base64'))

    report.consoleErrors = consoleErrors
    fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2))

    /* ---------- 5. 断言 ---------- */
    const before = report.steps.find((s) => s.name === 'before-run')
    const after = report.steps.find((s) => s.name === 'after-run')
    const recursive = report.steps.find((s) => s.name === 'recursive-run')
    const dark = report.steps.find((s) => s.name === 'dark')
    const knowledge = report.steps.find((s) => s.name === 'knowledge')
    const fail = []
    const expect = (cond, msg) => {
      if (!cond) fail.push(msg)
    }

    expect(before?.loaded && !before?.skeleton, 'RAG 页首屏没有正常渲染（骨架屏未消失）')
    expect(before?.stepTitles.join('') === '语料切块向量化检索', `四步顺序不对：${before?.stepTitles}`)
    expect(before?.layout?.bands?.length === 4, `横区应为 4 条，实际 ${before?.layout?.bands?.length}`)
    expect(before?.layout?.stacked === true, '四条横区没有竖向依次堆叠')
    expect(
      (before?.layout?.bands ?? []).every((band) => band.paneRightOfOptions),
      `有横区的详情没落在选项右侧：${(before?.layout?.bands ?? []).map((b) => `${b.title}:${b.paneRightOfOptions}`).join(' ')}`,
    )
    expect((before?.layout?.docs ?? 0) >= 1, '详情区没有官方文档链接')
    expect(before?.recapItems === 4, `回显项应为 4 个，实际 ${before?.recapItems}`)
    expect(
      before?.recapLabels.join('/') === '1 · 语料/2 · 切块/3 · 向量/4 · 检索',
      `回显标签不对：${before?.recapLabels}`,
    )
    report.layoutProblems.forEach((msg) => fail.push(msg))
    expect(after?.layout?.resultsBelowRecap === true, '结果区没有落在回显下方')
    expect(after?.figures === 5, `结果卡片应为 5 张，实际 ${after?.figures}`)
    expect(after?.segments > 0, '切块色带没有渲染出任何段')
    expect(after?.chunkCards === after?.segments, '色带段数与块卡片数不一致')
    expect(after?.heatCells > 0, '向量热力图没有单元格')
    expect(after?.scatterDots > 0, '向量散点图没有点')
    expect(after?.hitRows > 0, '检索结果没有候选行')
    expect(after?.selectedHits > 0, '没有「进入上下文」的命中行')
    expect(after?.promptChars > 100, '最终 prompt 是空的')
    expect(!after?.runError, `运行报错：${after?.runError}`)
    expect(
      recursive?.segments > 1 && recursive?.overlaps > 0,
      `递归切分下没有画出重叠区：${recursive?.segments} 段 / ${recursive?.overlaps} 处重叠`,
    )
    expect(!after?.overflowX, `RAG 页横向溢出 ${after?.scrollW}>${after?.innerW}`)
    expect(dark?.theme === 'dark' && dark?.bodyBg !== after?.bodyBg, '深色主题没有生效')
    expect(knowledge?.chunkPanel.chunks > 0, '知识库页没有展开出片段')
    expect(!report.consoleErrors.length, `控制台有错误：${report.consoleErrors.join(' | ')}`)

    console.log(JSON.stringify({ ok: fail.length === 0, fail, steps: report.steps.map((s) => ({
      name: s.name,
      figures: s.figures,
      segments: s.segments,
      overlaps: s.overlaps,
      chunkCards: s.chunkCards,
      heat: s.heatCells,
      dots: s.scatterDots,
      hits: s.hitRows,
      selected: s.selectedHits,
      promptChars: s.promptChars,
      runTotal: s.runTotal,
      steps: s.stepTitles,
      recap: s.recapValues,
      layout: s.layout,
      warnings: s.warnings,
      chunksInKb: s.chunkPanel?.chunks,
    })) }, null, 2))
    if (fail.length) process.exitCode = 1
  } finally {
    child.kill()
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})

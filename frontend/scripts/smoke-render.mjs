/**
 * 渲染冒烟：SSR 真实渲染 App / Dashboard / Settings，并校验设计系统契约。
 *
 * 为什么保留这一层而不是只靠截图：截图看不出「某个类名没有被任何样式命中」，
 * 也看不出「首屏该有的无障碍标题 / 两个箭头 / 三个分页点」是否真的渲染了。
 * 这里断言结构与契约，视觉判断交给 scripts/shoot-world.cjs 的截图。
 *
 * 移植自旧版 smoke-render：T10 的阶段数契约（7 步）原样保留 ——
 * 换皮不该动业务常量，这条断言正好证明它没被动过。
 *
 * 运行：node scripts/smoke-render.mjs
 */
import { createServer } from 'vite'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/* ---- 浏览器环境打桩（必须在 ssrLoadModule 之前） ---- */
const store = new Map()
globalThis.sessionStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
}
globalThis.localStorage = globalThis.sessionStorage
globalThis.matchMedia = () => ({
  matches: false,
  addEventListener() {},
  removeEventListener() {},
  addListener() {},
  removeListener() {},
})
globalThis.IntersectionObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0)
globalThis.cancelAnimationFrame = (id) => clearTimeout(id)
globalThis.location = { hash: '', pathname: '/', origin: 'http://localhost', href: 'http://localhost/' }
globalThis.history = { pushState() {} }
globalThis.window = globalThis
globalThis.window.location = globalThis.location
globalThis.window.addEventListener = () => {}
globalThis.window.removeEventListener = () => {}
globalThis.window.scrollTo = () => {}
globalThis.window.scrollY = 0
globalThis.window.requestIdleCallback = (cb) => setTimeout(cb, 0)
globalThis.document = {
  documentElement: {
    dataset: {},
    setAttribute() {},
    removeAttribute() {},
    getAttribute: () => null,
    style: {},
    scrollHeight: 5000,
  },
  body: { setAttribute() {}, removeAttribute() {}, style: {}, appendChild: () => {} },
  addEventListener() {},
  removeEventListener() {},
  getElementById: () => null,
  createElement: () => ({ style: {}, setAttribute() {}, remove() {}, appendChild() {}, select() {} }),
  querySelectorAll: () => [],
  querySelector: () => null,
}

const checks = []
const expect = (name, cond) => checks.push([name, !!cond])
const count = (html, re) => (html.match(re) || []).length

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

const server = await createServer({
  server: { middlewareMode: true },
  appType: 'custom',
  logLevel: 'silent',
  optimizeDeps: { noDiscovery: true, include: [] },
})

try {
  const App = (await server.ssrLoadModule('/src/App.tsx')).default
  const { Dashboard } = await server.ssrLoadModule('/src/features/dashboard/Dashboard.tsx')
  const { Settings } = await server.ssrLoadModule('/src/features/settings/Settings.tsx')
  const { Tutorial } = await server.ssrLoadModule('/src/features/tutorial/Tutorial.tsx')

  /* ============ App：外壳与导航 ============ */
  const app = renderToStaticMarkup(React.createElement(App))

  expect('外壳：.site-shell 渲染', app.includes('class="site-shell"'))
  expect(
    '顶栏：白半圆 logo-mark + 双段字标',
    app.includes('logo-mark') && /<b>Research<\/b>/.test(app) && /<span>Workspace<\/span>/.test(app),
  )
  expect(
    '顶栏：八个页面入口全部渲染（宽屏平铺）',
    ['概览', '深度研究', '知识库', 'RAG 流程', '研究报告', '效果评估', '系统设置', '使用教程'].every(
      (t) => app.includes(t),
    ) && count(app, /class="nav-link"/g) === 8,
  )
  expect('顶栏：目录入口按钮仍在（<1181px 时替代平铺）', app.includes('class="nav-index"'))
  expect('顶栏：旧的 10 项分组菜单已移除', !app.includes('nav-group') && !app.includes('nav-link__badge'))
  expect('目录浮层：默认关闭（不占 DOM）', !app.includes('index-layer'))

  /* ============ Dashboard：首屏结构逐条对齐规格 ============ */
  const dash = renderToStaticMarkup(React.createElement(Dashboard, { onNavigate: () => {} }))

  expect('Hero：<section class="hero" id="hero">', /<section class="hero" id="hero">/.test(dash))
  expect('Hero：canvas#scene 带无障碍标签', dash.includes('id="scene"') && dash.includes('Rotatable glass cube'))
  expect('Hero：视觉隐藏的 h1「Explore New Ideas」', dash.includes('class="sr-only"') && dash.includes('Explore New Ideas'))
  expect('Hero：两个箭头按钮（prev/next）', dash.includes('id="prev"') && dash.includes('id="next"'))
  expect(
    'Hero：左右箭头 path 与规格一致',
    dash.includes('M19 12H5M11 6l-6 6 6 6') && dash.includes('M5 12h14M13 6l6 6-6 6'),
  )
  expect(
    'Hero：三个分页点，默认第二个空心',
    count(dash, /class="dot( active)?"/g) === 3 && count(dash, /class="dot active"/g) === 1,
  )
  expect('Hero：标语 + 粗体落点', dash.includes('class="tagline"') && dash.includes('<strong>Research.</strong>'))
  expect(
    'Hero：CTA 按钮 + 横线 + 出血的 07',
    dash.includes('class="cta"') && dash.includes('class="cta-line"') && /class="count"[^>]*>07</.test(dash),
  )
  expect('Hero：加载态文案「Loading model」', dash.includes('id="loader"') && dash.includes('Loading model'))
  expect(
    '首屏之下：流水线图排在「从这里开始」之前',
    dash.includes('home-pipeline') &&
      dash.indexOf('home-pipeline') > 0 &&
      dash.indexOf('home-pipeline') < dash.indexOf('section--entry'),
  )
  expect(
    '首屏之下：流水线含 7 个节点 + 回环说明',
    count(dash, /class="pipeline__group"/g) === 7 && dash.includes('循环补充证据'),
  )
  expect('首屏之下：三个入口 + 次级文字链', dash.includes('entry-grid') && dash.includes('RAG 流程') && dash.includes('效果评估'))
  expect('首屏之下：入口卡 3 张、1 张主入口', count(dash, /card--entry/g) === 3 && count(dash, /card--primary/g) === 1)
  expect('首屏之下：七步流程仍在', dash.includes('七步流水线') && dash.includes('flow__step'))
  expect('首屏之下：后端状态与模型仍在', dash.includes('status-line') && dash.includes('正在检测后端…'))

  /* ============ Settings / Tutorial：复杂页面没有在换皮中被砍掉 ============ */
  const settings = renderToStaticMarkup(React.createElement(Settings))
  // Settings 首屏是「页头 + 加载态」，配置行要等接口回来才渲染（SSR 没有接口）
  expect(
    'Settings：页头 / 系统连接分组 / 请求中提示都渲染',
    settings.includes('page-head') && settings.includes('module-section') && settings.includes('正在请求后端'),
  )
  expect('Settings：模型面板保留了连通性自检按钮', read('src/features/settings/ModelPanel.tsx').includes('连通性自检'))

  const tutorial = renderToStaticMarkup(React.createElement(Tutorial, { onNavigate: () => {} }))
  expect('Tutorial：8 个模块各渲染 1 个 svg 图标', count(tutorial, /class="module__icon"><svg/g) === 8)
  expect('Tutorial：侧栏与分步指引都还在', tutorial.includes('section-nav') && tutorial.includes('guide__item'))

  /* ============ CSS 契约 ============ */
  const world = read('src/styles/world.css')
  const pages = read('src/styles/world-pages.css')
  const main = read('src/main.tsx')
  const styles = [world, pages].join('\n')

  expect(
    '样式入口只引两个文件',
    /styles\/world\.css/.test(main) &&
      /styles\/world-pages\.css/.test(main) &&
      !/styles\/(tokens|layout|components|pages|redesign|rag|loading)\.css/.test(main),
  )
  expect('旧主题体系已退役（无 data-theme 浅色分支）', !styles.includes('[data-theme="dark"]') && !styles.includes('--page: #f4f6fb'))
  expect('底与字：纯黑 #000 + 纯白 #fff', /--bg:\s*#000/.test(styles) && /--fg:\s*#fff/.test(styles))
  expect('字体：Poppins 进 var(--font)', /--font:\s*"Poppins"/.test(styles))
  expect('不再出现电光蓝主色', !/#2563eb|#5b93ff|#0e7490/i.test(styles))
  expect('圆角只有两档（6px / 10px）', styles.includes('--r-sm: 6px') && styles.includes('--r-md: 10px'))
  expect('Hero 规格：100svh + 最小高度 520', styles.includes('height: 100svh') && styles.includes('min-height: 520px'))
  expect(
    'Hero 规格：箭头 2.5px 描边 / CTA hover 反白',
    /\.arrow\s*\{[\s\S]{0,160}border:\s*2\.5px solid #fff/.test(styles) && /\.cta:hover\s*\{\s*background:\s*#fff/.test(styles),
  )
  expect('Hero 规格：07 为 1.5px 描边数字', /-webkit-text-stroke:\s*1\.5px/.test(styles))

  /* ============ 类名覆盖：换皮最容易漏的是错误态 / 展开态 ============ */
  const walk = (dir, test) => {
    const out = []
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) out.push(...walk(full, test))
      else if (test(entry.name)) out.push(full)
    }
    return out
  }
  const fromTsx = new Set()
  for (const file of walk(path.join(ROOT, 'src'), (n) => n.endsWith('.tsx'))) {
    const source = fs.readFileSync(file, 'utf8')
    for (const match of source.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\}|\{([^}]*)\})/g)) {
      // 条件表达式（{primary ? undefined : 'a'}）里只有引号内的才是类名，
      // 变量名/undefined 不是 —— 直接按空白切词会把它们也算进来。
      const raw =
        match[1] ??
        match[2] ??
        (match[3] || '')
          .replace(/\$\{[^}]*\}/g, ' ')
          .match(/'[^']*'|"[^"]*"/g)
          ?.join(' ')
          .replace(/['"]/g, '') ??
        ''
      raw
        .replace(/\$\{[^}]*\}/g, ' ')
        .split(/[\s"'`+]+/)
        .filter((t) => /^[a-zA-Z][\w-]*$/.test(t))
        .forEach((t) => fromTsx.add(t))
    }
  }
  const fromCss = new Set()
  for (const file of walk(path.join(ROOT, 'src', 'styles'), (n) => n.endsWith('.css'))) {
    const source = fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
    for (const match of source.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) fromCss.add(match[1])
  }
  // 模板字符串拼出来的前缀（rag-seg--0、stepper__item--done …）静态扫描看不到全名
  const DYNAMIC_PREFIX = /^(rag-seg--|stepper__item--|state-loading--|process-timeline__item--|selected|className|dashboard)$/
  const missing = [...fromTsx].filter((name) => !fromCss.has(name) && !DYNAMIC_PREFIX.test(name))
  expect(
    `类名覆盖：所有 TSX 类名都有样式（缺 ${missing.length} 个${missing.length ? '：' + missing.join(', ') : ''}）`,
    missing.length === 0,
  )

  /* ============ three.js：玻璃渲染管线契约 ============ */
  const hero = read('src/features/hero/GlassHero.tsx')
  expect('three：直接加载规格里的 GLB 地址', hero.includes('https://motionsites.org/assets/prompt-media/fa96096e78c8153a70d2.glb'))
  expect('three：GLB 失败回落 RoundedBoxGeometry', hero.includes('RoundedBoxGeometry(1, 1, 1, 8, 0.12)'))
  expect('three：合并顶点 + 合并网格', hero.includes('mergeVertices(') && hero.includes('mergeGeometries('))
  expect(
    'three：两张 HalfFloat 渲染目标（背面 / 正面）',
    hero.includes('HalfFloatType') && hero.includes('rtBack') && hero.includes('rtFront') && count(hero, /WebGLRenderTarget/g) >= 1,
  )
  expect('three：六段色散 + 16 次折射采样', hero.includes('uIorR') && hero.includes('uIorP') && /const int LOOP = 16/.test(hero))
  expect('three：两遍渲染都关了 autoClear 再画立方体', count(hero, /renderer\.autoClear = false/g) >= 2)
  expect('three：颜色空间 chunk 单独成行', count(hero, /#include <colorspace_fragment>/g) === 2)

  /* =========================================================================
     [T10] 阶段顺序契约（前端侧）—— 与后端 tests/test_graph.py 的
     test_stage_order_matches_frontend_contract 配对。
     前端只断言自己这一处声明的性质，跨端一致性由后端 introspect 编译产物。
     ========================================================================= */
  const flowSrc = read('src/features/workflow/FlowOverview.tsx')
  const stepCount = count(flowSrc, /^\s{4}no:\s*\d+,/gm)
  expect('T10 ①：FlowOverview.STEPS 条数 == 7（后端正常阶段数契约）', stepCount === 7)
  const stepNos = (flowSrc.match(/^\s{4}no:\s*(\d+),/gm) || []).map((m) => Number(m.match(/(\d+)/)[1]))
  expect('T10 ①：STEPS 序号连续 1..7（无洞无重复）', stepNos.length === 7 && stepNos.every((n, i) => n === i + 1))

  const rfSrc = read('src/features/workflow/ResearchWorkflow.tsx')
  const nodeLabelCount = count(rfSrc, /^\s{2}\{ key: '[a-z_]+', label: '[^']+' \},/gm)
  expect('T10 ②：ResearchWorkflow.NODE_LABELS 条数 == 7', nodeLabelCount === 7)

  const progSrc = read('src/features/workflow/runProgress.ts')
  const baseNodes = Number((progSrc.match(/export const BASE_NODES = (\d+)/) || [])[1])
  expect('T10 ③：runProgress.BASE_NODES == 7', baseNodes === 7)
  expect('T10 ③：三处「7」互相一致（STEPS / NODE_LABELS / BASE_NODES）', stepCount === nodeLabelCount && nodeLabelCount === baseNodes)

  const stepNames = (flowSrc.match(/^\s{4}name:\s*'([^']+)'/gm) || []).map((m) =>
    m.replace(/^\s{4}name:\s*'/, '').replace(/'$/, ''),
  )
  expect(
    'T10 ④：STEPS[].name 保持中文展示名（非 snake_case 标识符）',
    stepNames.length === 7 && stepNames.every((n) => /[\u4e00-\u9fa5]/.test(n)),
  )
} catch (err) {
  checks.push([`渲染抛错: ${err.message}`, false])
} finally {
  await server.close().catch(() => {})
}

let failed = 0
for (const [name, ok] of checks) {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
}
console.log(`\n结果: ${checks.length - failed}/${checks.length} 通过`)
process.exit(failed ? 1 : 0)

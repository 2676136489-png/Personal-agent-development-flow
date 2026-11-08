/**
 * SSR 渲染冒烟：验证 T05（导航响应式/抽屉结构）+ T06（Dashboard 入口页 / Settings 收纳）真实渲染。
 * 说明：媒体查询与 hover/开合等交互需肉眼确认；此处验证「结构 / 文案 / 属性」与 CSS 契约。
 */
import { createServer } from 'vite';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import fs from 'node:fs';
import path from 'node:path';

/* ---- 浏览器环境打桩（必须在 ssrLoadModule 之前） ---- */
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
globalThis.matchMedia = () => ({
  matches: false,
  addEventListener() {},
  removeEventListener() {},
  addListener() {},
  removeListener() {},
});
globalThis.IntersectionObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
globalThis.location = { hash: '', pathname: '/', origin: 'http://localhost' };
globalThis.window = globalThis;
globalThis.window.location = globalThis.location;
globalThis.window.addEventListener = () => {};
globalThis.window.removeEventListener = () => {};
globalThis.window.scrollTo = () => {};
globalThis.window.scrollY = 0;
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
};

const checks = [];
const expect = (name, cond) => checks.push([name, !!cond]);
const count = (html, re) => (html.match(re) || []).length;

const server = await createServer({
  server: { middlewareMode: true },
  appType: 'custom',
  logLevel: 'silent',
  optimizeDeps: { noDiscovery: true, include: [] },
});

try {
  const App = (await server.ssrLoadModule('/src/App.tsx')).default;
  const { Dashboard } = await server.ssrLoadModule('/src/features/dashboard/Dashboard.tsx');
  const { Settings } = await server.ssrLoadModule('/src/features/settings/Settings.tsx');

  /* ============ App：导航结构（初始态，dashboard） ============ */
  const app = renderToStaticMarkup(React.createElement(App));

  /* ---- S1 导航信息架构（NAV_GROUPS / NAV_CORE_KEYS / sessionStorage） ----
     注意：nav-link__badge / nav-link__hint 的前缀也含 `class="nav-link`，
     因此计数正则必须带后行断言 (?=[ "])，否则会把角标/说明一起数进来。 */
  const NAV_LINK = /class="nav-link(?=[ "])/g;
  /** 顶栏横向菜单：分组全渲染，768–1023px 靠 CSS 隐藏非 core 组（data-core 供该断点用） */
  const menu = app.slice(app.indexOf('class="nav-menu"'), app.indexOf('class="nav-more"'));
  expect('nav-menu 共 8 个导航项', count(menu, NAV_LINK) === 8);
  expect('顶栏 3 项标记 data-core="true"（概览/深度研究/研究报告）', count(menu, /data-core="true"/g) === 3);
  expect('顶栏其余 5 项标记 data-core="false"', count(menu, /data-core="false"/g) === 5);
  expect('顶栏渲染 4 个 nav-group 容器', count(menu, /class="nav-group"/g) === 4);
  expect('nav-group 顺序为 home/research/results/system',
    (menu.match(/data-group="[a-z]+"/g) || []).join(',') === 'data-group="home",data-group="research",data-group="results",data-group="system"');
  expect('主推项「深度研究」带「推荐」角标', menu.includes('深度研究') && count(menu, /class="nav-link__badge"/g) === 1);
  expect('开发者向项降级样式 nav-link--dev', menu.includes('效果评估') && count(menu, /nav-link--dev/g) === 1);
  expect('当前页带 aria-current="page"（语义而非仅 class）', count(menu, /aria-current="page"/g) === 1);

  // 「更多」纯 CSS 下拉：3 个组标题 + 全部 8 项；role=menu 已降级为普通导航列表
  const more = app.slice(app.indexOf('class="nav-more"'), app.indexOf('class="nav-actions"'));
  expect('nav-more 下拉存在', more.includes('nav-more__menu'));
  expect('nav-more 含 4 个组标题（含家组，下拉/抽屉为全量说明场景）', count(more, /class="nav-more__group"/g) === 4);
  expect('nav-more 含 8 项 + 1 个触发按钮', count(more, NAV_LINK) === 9);
  expect('nav-more 已去除 role=menu/menuitem（无方向键实现即为 a11y 反模式）',
    !more.includes('role="menuitem"') && !more.includes('role="menu"') && more.includes('aria-label="更多导航"'));

  // 汉堡按钮 + 主题切换都在 nav-actions 中
  expect('汉堡按钮 nav-toggle 存在', app.includes('class="nav-toggle"'));
  expect('汉堡按钮带 aria-controls="nav-drawer"', app.includes('aria-controls="nav-drawer"'));
  expect('主题切换 nav-icon 存在', app.includes('class="nav-icon"'));

  // 初始抽屉关闭：不渲染 nav-drawer
  expect('初始不渲染抽屉', !app.includes('class="nav-drawer"'));

  /* ============ Dashboard：3 区块 ============ */
  const dash = renderToStaticMarkup(React.createElement(Dashboard, { onNavigate: () => {} }));
  const dashMain = dash; // Dashboard 无共享导航，无需限定 main

  expect('hero：新 H1 文案', dashMain.includes('提一个问题，拿到一份有出处的研究报告。'));
  expect('hero：一句话说明', dashMain.includes('写报告前会停下来等你确认，每条结论都标了来源。'));
  expect('hero：主按钮「开始研究」', dashMain.includes('开始研究'));
  expect('hero：次按钮「3 分钟上手教程」', dashMain.includes('3 分钟上手教程'));
  expect('hero：轻量状态点 status-line', dashMain.includes('class="status-line"'));
  expect('hero：状态点初始为检测中', dashMain.includes('正在检测后端…'));

  expect('入口卡：entry-grid 存在', dashMain.includes('class="entry-grid"'));
  expect('入口卡：共 3 张 card--entry', count(dashMain, /card--entry/g) === 3);
  expect('入口卡：恰 1 张主入口 card--primary', count(dashMain, /card--primary/g) === 1);
  expect('入口卡：主入口带「推荐」角标', dashMain.includes('>推荐<'));
  expect('入口卡：3 张标题齐全（「研究工作流」已改名「深度研究」）',
    ['深度研究', '知识库', '研究报告'].every((t) => dashMain.includes(`class="card__title">${t}<`)));
  expect('次级文字链 entry-links', dashMain.includes('class="entry-links"'));
  expect('次级文字链含 4 项', ['RAG 流程', '效果评估', '系统设置', '教程'].every((t) => dashMain.includes(`>${t}</button>`)));

  expect('区块③ 研究流程保留', dashMain.includes('七步流水线，每一步都看得见。'));
  expect('已移除「它能做什么」feature 区', !dashMain.includes('它能做什么'));
  expect('已移除旧 hero 文案', !dashMain.includes('把一个问题，跑成一份有出处的研究报告。'));

  /* ============ Settings：系统连接分组 ============ */
  const settings = renderToStaticMarkup(React.createElement(Settings));
  expect('Settings：标题「运行配置与连接」', settings.includes('运行配置与连接'));
  expect('Settings：含「系统连接」分组', settings.includes('系统连接'));
  expect('Settings：连接区初始加载中', settings.includes('正在请求后端…'));
  expect('Settings：模块分组容器 module-section', settings.includes('module-section'));

  /* ============ CSS 契约（断点规则是否存在） ============ */
  const stylesDir = path.resolve(process.cwd(), 'src/styles');
  const responsive = fs.readFileSync(path.join(stylesDir, 'responsive.css'), 'utf8');
  const layoutCss = fs.readFileSync(path.join(stylesDir, 'layout.css'), 'utf8');
  const pagesCss = fs.readFileSync(path.join(stylesDir, 'pages.css'), 'utf8');

  expect('CSS：平板断点 1023px', /@media \(max-width: 1023px\)/.test(responsive));
  expect('CSS：移动断点 767px', /@media \(max-width: 767px\)/.test(responsive));
  expect('CSS：平板隐藏非核心项', /data-core=.false.\]/.test(responsive));
  expect('CSS：1024–1199 隐藏组标签（只留组间竖线）', /@media \(min-width: 1024px\) and \(max-width: 1199px\)\s*\{[\s\S]*?nav-group__label \{[^}]*display: none/.test(responsive));
  expect('CSS：组间竖线用 --nav-group-line 令牌', /\.nav-group \+ \.nav-group::before \{[\s\S]*?background: var\(--nav-group-line\)/.test(layoutCss));
  expect('CSS：移动隐藏 nav-menu + nav-more', /\.nav-menu,\s*\.nav-more\s*\{[^}]*display: none/.test(responsive));
  expect('CSS：移动显示 nav-toggle', /\.nav-toggle\s*\{\s*display: grid/.test(responsive));
  expect('CSS：入口卡桌面 4 列', /\.entry-grid[\s\S]*?repeat\(4, minmax\(0, 1fr\)\)/.test(pagesCss));
  expect('CSS：入口卡平板 2 列', /repeat\(2, minmax\(0, 1fr\)\)/.test(responsive));
  expect('CSS：抽屉 nav-drawer 定义', /\.nav-drawer\s*\{/.test(layoutCss));
  expect('CSS：抽屉纯 CSS 展开（hover/focus-within）', /\.nav-more:hover \.nav-more__menu[\s\S]*?\.nav-more:focus-within \.nav-more__menu/.test(layoutCss));

  /* ============ 抽屉行为契约（SSR 不执行 effect/state，锚定需求本身） ============ */
  const appSrc = fs.readFileSync(path.resolve(process.cwd(), 'src/App.tsx'), 'utf8');
  expect('抽屉：含遮罩 nav-scrim（点遮罩关闭）', appSrc.includes('className="nav-scrim"'));
  expect('抽屉：选中项后收起 navigateAndClose', /navigateAndClose/.test(appSrc) && /setNavOpen\(false\)/.test(appSrc));
  expect('抽屉：Esc 关闭', appSrc.includes("e.key === 'Escape'"));
  expect('抽屉：打开时锁 body 滚动', /document\.body\.style\.overflow = 'hidden'/.test(appSrc));
  expect('抽屉：离开时恢复 overflow', /document\.body\.style\.overflow = prevOverflow/.test(appSrc));
  expect('仅新增 1 个 navOpen state', count(appSrc, /const \[navOpen, setNavOpen\] = useState\(false\)/g) === 1);
  expect('未改动 PageKey / NAV_ITEMS / navigate 结构',
    /export type PageKey\s*=/.test(appSrc) && /const NAV_ITEMS/.test(appSrc) && /const navigate = \(key: string\)/.test(appSrc));

  /* ---- S1 会话内页面记忆 + 焦点环（§2.6 / §9） ---- */
  expect('S1：会话内页面记忆 key 为 arw-page', appSrc.includes("const PAGE_KEY = 'arw-page'"));
  expect('S1：初始值读 sessionStorage（readStoredPage）', /useState<PageKey>\(\(\) => readStoredPage\(\)\)/.test(appSrc));
  expect('S1：写入放在 effect 里（首帧不回写 dashboard）', /useEffect\(\(\) => \{[\s\S]{0,160}sessionStorage\.setItem\(PAGE_KEY, page\)/.test(appSrc));
  expect('S1：读取有白名单兜底 + try/catch',
    /PAGE_KEYS as string\[\]\)\.includes\(v\)/.test(appSrc) && /try \{\s*const v = sessionStorage\.getItem/.test(appSrc));
  expect('S1：NAV_CORE_KEYS 严格等于 概览/深度研究/研究报告',
    /const NAV_CORE_KEYS: PageKey\[\] = \['dashboard', 'workflow', 'reports'\]/.test(appSrc));
  expect('S1：App.tsx 已无内联 style（改用 .shell--tight）', !appSrc.includes('style={{'));
  const baseCssEarly = fs.readFileSync(path.resolve(process.cwd(), 'src/styles/base.css'), 'utf8');
  expect('S1：base.css 有全局 :focus-visible 焦点环', /:focus-visible \{[\s\S]{0,120}outline: 2px solid var\(--focus-outline\)/.test(baseCssEarly));
  expect('S1：base.css 有 focus-visible 变体（内嵌描边防裁切）',
    /\.collapsible-card__header:focus-visible,\s*\.modal__head :focus-visible,\s*\.nav-drawer__head :focus-visible \{[^}]*outline-offset: -3px/.test(baseCssEarly));
  expect('S1：抽屉按 NAV_GROUPS 渲染分组（8 项全进，家组也出标签）',
    count(appSrc, /className="nav-drawer__group"/g) === 1 &&
    count(appSrc, /className="nav-drawer__label"/g) === 1 &&
    /DRAWER_GROUP_LABEL: Partial<Record<NavGroup\['id'\], string>> = \{ home: '概览' \}/.test(appSrc));
  expect('S1：「更多」下拉与抽屉都以 core={false} 渲染全部项', count(appSrc, /core=\{false\}/g) === 2);

  /* ============ T07：workflow / research / agent「主操作优先」 ============ */
  const { ResearchWorkflow } = await server.ssrLoadModule('/src/features/workflow/ResearchWorkflow.tsx');

  const ordered = (html, ...needles) => {
    let last = -1;
    for (const n of needles) {
      const i = html.indexOf(n);
      if (i < 0 || i < last) return false;
      last = i;
    }
    return true;
  };

  const pages = [
    ['workflow', ResearchWorkflow],
  ];
  for (const [name, Comp] of pages) {
    const html = renderToStaticMarkup(React.createElement(Comp));
    expect(`T07 ${name}：容器为 .page`, /class="page[ "]/.test(html));
    expect(`T07 ${name}：page__head 标题区`, html.includes('page__head'));
    expect(`T07 ${name}：page__primary 主操作区`, html.includes('page__primary'));
    expect(`T07 ${name}：page__content 内容区`, html.includes('page__content'));
    expect(`T07 ${name}：page__aside 折叠说明区`, html.includes('page__aside'));
    expect(`T07 ${name}：主操作先于说明区（首屏优先）`, ordered(html, 'page__primary', 'page__aside'));
    expect(`T07 ${name}：折叠说明为 details.fold.card--fold`, html.includes('fold card--fold'));
    expect(`T07 ${name}：idle 空态 EmptyState`, html.includes('state-empty'));
    expect(`T07 ${name}：含主按钮 button--primary`, html.includes('button--primary'));
    expect(`T07 ${name}：tip 提示条恰 1 个`, count(html, /class="tip"/g) === 1);
  }

  const wfHtml = renderToStaticMarkup(React.createElement(ResearchWorkflow));
  expect('T07 workflow：placeholder 用稿', wfHtml.includes('例如：研究 2026 年 AI Agent 开发岗位的主要技术要求…'));
  expect('T07 workflow：tip 文案', wfHtml.includes('启动后可以切到其他页面，进度不会中断'));
  expect('T07 workflow：原置顶「这个模块能做什么？」已沉底', ordered(wfHtml, 'page__primary', '这个模块能做什么？'));

  /* ============ OBS-1：研究工作流跨页 UI 自动恢复 ============ */
  const wfSource = fs.readFileSync(path.resolve(process.cwd(), 'src/features/workflow/ResearchWorkflow.tsx'), 'utf8');
  expect('OBS-1：定义 sessionStorage key arw-last-thread', wfSource.includes("'arw-last-thread'"));
  expect('OBS-1：启动成功后写入 thread_id', /setRun\(await startResearch[\s\S]{0,120}?writeLastThread\(threadId\)/.test(wfSource));
  expect('OBS-1：挂载时读取该 key（readLastThread）', /const threadId = readLastThread\(\)/.test(wfSource));
  expect('OBS-1：挂载时复用 handleLoadFromHistory 触发一次恢复', /handleLoadFromHistory\(threadId, \{ silent: true \}\)/.test(wfSource));
  expect('OBS-1：恢复失败（404）静默清除 key', /if \(!ok\) clearLastThread\(\)/.test(wfSource));
  expect('OBS-1：挂载恢复带 ref 守卫防重复触发', /restoredRef\.current/.test(wfSource) && /useRef\(false\)/.test(wfSource));
  expect('OBS-1：question 回填沿用既有逻辑', /setQuestion\(loaded\.question\)/.test(wfSource));
  expect('OBS-1：未改动 SSE 订阅方式（useRunEvents 调用不变）', /const \{ events, status: streamStatus, subscribe \} = useRunEvents\(\)/.test(wfSource));
  expect('OBS-1：恢复仍走既有 getResearch API', /const loaded = await getResearch\(threadId\)/.test(wfSource));
  expect('OBS-1：sessionStorage 读写在 try/catch 内（隐私模式静默降级）', /try \{\s*return sessionStorage\.getItem/.test(wfSource));
  expect('OBS-1：手动（非 silent）成功加载也写入 arw-last-thread', /if \(!options\?\.silent\) writeLastThread\(threadId\)/.test(wfSource));
  expect('OBS-1：writeLastThread 调用恰 2 处（启动 + 非silent 加载），silent/失败不写', count(wfSource, /writeLastThread\(threadId\)/g) === 2);

  /* ---- OBS-1 补丁：迟到 onOpen（useRunEvents） ---- */
  const evtSource = fs.readFileSync(path.resolve(process.cwd(), 'src/features/workflow/useRunEvents.ts'), 'utf8');
  expect('OBS-1：addListener 补发迟到的 onOpen（readyState === EventSource.OPEN）', /readyState === EventSource\.OPEN/.test(evtSource));
  expect('OBS-1：迟到 onOpen 位于回放 eventCache 之后', /eventCache\.get\(threadId\)[\s\S]{0,220}?readyState === EventSource\.OPEN/.test(evtSource));
  expect('OBS-1：未调整 subscribe 顺序（先 addListener 回放 → 再 attach 建连）', /addListener\(threadId[\s\S]{0,400}?attach\(threadId\)/.test(evtSource));
  expect('OBS-1：连接/缓存机制未改（sources/eventCache/closeStream/switchStream 保留）', /const sources = new Map<string, EventSource>\(\)/.test(evtSource) && /const eventCache = new Map<string, RunEvent\[\]>\(\)/.test(evtSource) && /function closeStream/.test(evtSource) && /function switchStream/.test(evtSource));

  /* ============ T08：状态补齐 + 缺陷修复 + 响应式收尾 ============ */
  const load = (rel) => server.ssrLoadModule(rel);
  const { Reports } = await load('/src/features/reports/Reports.tsx');
  const { Evaluation } = await load('/src/features/evaluation/Evaluation.tsx');
  const { RunHistory } = await load('/src/features/workflow/RunHistory.tsx');
  const { KnowledgeBase } = await load('/src/features/knowledge/KnowledgeBase.tsx');

  const reports = renderToStaticMarkup(React.createElement(Reports));
  expect('T08 Reports：首屏加载态骨架（非误导空态）', reports.includes('state-loading'));

  const evalHtml = renderToStaticMarkup(React.createElement(Evaluation));
  expect('T08 Evaluation：首屏加载态骨架（非误导空态）', evalHtml.includes('state-loading'));

  const runHistoryHtml = renderToStaticMarkup(React.createElement(RunHistory));
  expect('T08 RunHistory：首屏加载态骨架（非误导空态）', runHistoryHtml.includes('state-loading'));

  const kb = renderToStaticMarkup(React.createElement(KnowledgeBase));
  expect('T08 Knowledge：首屏加载态骨架（非误导空态）', kb.includes('state-loading'));
  expect(
    'T08 Knowledge：文件控件 .file-field + 原生 input',
    kb.includes('class="file-field"') && kb.includes('file-field__input') && kb.includes('type="file"'),
  );
  expect('T08 Knowledge：检索 placeholder 用稿', kb.includes('例如：向量数据库如何选型'));

  /* ---- 源级契约：状态三态 / 缺陷修复 ---- */
  const readSrc = (rel) => fs.readFileSync(path.resolve(process.cwd(), rel), 'utf8');
  const reportsSrc = readSrc('src/features/reports/Reports.tsx');
  const evalSrc = readSrc('src/features/evaluation/Evaluation.tsx');
  const runHistorySrc = readSrc('src/features/workflow/RunHistory.tsx');
  const kbSrc = readSrc('src/features/knowledge/KnowledgeBase.tsx');
  const settingsSrc = readSrc('src/features/settings/Settings.tsx');

  expect('T08 Evaluation：4 张统计卡为 .card.card--stat', count(evalSrc, /card card--stat/g) === 4);

  // P0-6：Evaluation 与 RunHistory 行盒一致
  expect('T08 P0-6：Evaluation 行内容包在 run-list__row', /run-list__item[\s\S]{0,200}run-list__row/.test(evalSrc));
  expect('T08 P0-6：RunHistory 行使用 run-list__btn', runHistorySrc.includes('run-list__btn'));
  expect('T08 P0-6：两页行内容列结构一致（徽章/问题/时间）', evalSrc.includes('run-list__q') && runHistorySrc.includes('run-list__q'));

  // P0-7 / 全站：错误不再用 .hint
  expect('T08 P0-7：RunHistory 错误用 ErrorState（非 .hint）', runHistorySrc.includes('ErrorState') && !/<p className="hint">\{error/.test(runHistorySrc));
  expect('T08：RunHistory 错误带 onRetry', runHistorySrc.includes('onRetry={() => void refresh()}'));
  expect('T08：Reports 错误态 ErrorState + 重试', reportsSrc.includes('ErrorState') && /onRetry=\{\(\) => void load\(\)\}/.test(reportsSrc));
  expect('T08：Reports 加载态骨架 LoadingState', reportsSrc.includes('LoadingState'));
  expect('T08：Reports 卡片迁移到 .card 基线', reportsSrc.includes('card card--interactive report-card'));
  expect('T08：Evaluation 错误态 ErrorState + 重试', evalSrc.includes('ErrorState') && /onRetry=\{\(\) => void load\(\)\}/.test(evalSrc));
  expect('T08：Evaluation 加载态骨架 LoadingState', evalSrc.includes('LoadingState'));
  expect('T08：Settings 配置错误态 ErrorState + 重试', settingsSrc.includes('ErrorState') && /onRetry=\{\(\) => void loadConfig\(\)\}/.test(settingsSrc));
  expect('T08：Settings 配置加载态骨架 LoadingState', settingsSrc.includes('LoadingState'));
  expect('T08：Knowledge 列表错误态 ErrorState + 重试', kbSrc.includes('ErrorState') && /onRetry=\{\(\) => void refresh\(\)\}/.test(kbSrc));
  expect('T08：Knowledge 列表加载态 LoadingState', kbSrc.includes('LoadingState'));
  expect('T08：Knowledge 检索错误态也带重试', /onRetry=\{\(\) => void handleSearch\(\)\}/.test(kbSrc));

  /* ---- CSS 契约：清理 + 收敛 ---- */
  const componentsCss = fs.readFileSync(path.join(stylesDir, 'components.css'), 'utf8');
  const baseCss = fs.readFileSync(path.join(stylesDir, 'base.css'), 'utf8');

  expect('T08 CSS：run-list__btn 与 run-list__row 共用行盒', /\.run-list__btn,\s*\.run-list__row\s*\{/.test(componentsCss));
  expect('T08 CSS（QA BUG-1）：run-list 用 minmax(0,1fr) 防横向溢出', /\.run-list\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/.test(componentsCss));
  expect('T08 CSS（QA BUG-1）：run-list__item min-width:0', /\.run-list__item\s*\{[^}]*min-width:\s*0/.test(componentsCss));
  expect('T08 CSS（QA BUG-1）：data-list/doc-list/report-list 亦加 minmax(0,1fr)', [componentsCss, pagesCss].join('\n').match(/grid-template-columns:\s*minmax\(0,\s*1fr\)/g).length >= 4);
  expect('T08 CSS：.card--metric 基线存在（修复 .metric 丢失盒模型）', /\.card--metric\s*\{/.test(componentsCss));
  expect('T08：Settings 指标卡迁移为 .card.card--metric', settingsSrc.includes('card card--metric'));
  expect('T08 CSS：正文行长 max-width=--content-measure', /\.markdown-body\s*\{[^}]*max-width:\s*var\(--content-measure\)/.test(componentsCss));
  expect('T08 CSS：已删除旧 .feature 规则', !/\.feature[\s{,:]/.test(pagesCss));
  expect('T08 CSS：已删除旧 .empty-state 规则', !/\.empty-state/.test(componentsCss));
  expect('T08 CSS：已删除旧 .list-row 基线', !/\.list-row/.test(componentsCss));
  expect('T08 CSS：已删除 .panel--clean 别名', !/\.panel--clean/.test(layoutCss));
  expect('T08 CSS：已删除 .section-head--center', !/section-head--center/.test(layoutCss));
  expect('T08 CSS：run-card 容器规则已移除（迁移 .card）', !/^\.run-card\s*\{/m.test(componentsCss));
  expect('T08 CSS：file-field :focus-within 聚焦环', /\.file-field:focus-within/.test(pagesCss));
  expect('T08 CSS：html 横向溢出兜底', /overflow-x:\s*hidden/.test(baseCss));

  /* ---- 断点审计：860/640 已并入 1023/767 ---- */
  expect('T08 断点：已移除 860 断点', !/@media \(max-width: 860px\)/.test(responsive));
  expect('T08 断点：已移除 640 断点', !/@media \(max-width: 640px\)/.test(responsive));
  expect('T08 断点：保留 1023（平板）', /@media \(max-width: 1023px\)/.test(responsive));
  expect('T08 断点：保留 767（移动）', /@media \(max-width: 767px\)/.test(responsive));
  expect('T08 响应式：移动端报告弹窗全屏', /\.modal\s*\{[^}]*height:\s*100%/.test(responsive));
  expect('T08 响应式：设置表移动端单列', /\.settings-row\s*\{\s*grid-template-columns:\s*1fr/.test(responsive));
  expect('T08 响应式：移动端触摸目标 ≥44px', /min-height:\s*44px/.test(responsive));

  /* ===================== T02 · S2 深色主题 + reduced-motion ===================== */
  const tokensCss = fs.readFileSync(path.join(stylesDir, 'tokens.css'), 'utf8');
  const darkBlock = tokensCss.slice(tokensCss.indexOf(':root[data-theme="dark"]'));
  expect('T02 令牌：新增 --accent-strong / --on-accent（浅深各自取值）',
    /--accent-strong: #0071e3/.test(tokensCss) && /--accent-strong: #0f6fd6/.test(darkBlock) &&
    /--on-accent: #ffffff/.test(tokensCss) && /--on-accent: #ffffff/.test(darkBlock));
  expect('T02 令牌：新增 --accent-ink（浅 #0062c4 / 深 #6ab7ff）',
    /--accent-ink: #0062c4/.test(tokensCss) && /--accent-ink: #6ab7ff/.test(darkBlock));
  expect('T02 令牌（M2）：--faint 浅 #6b6b70 / 深 #98989d',
    /--faint: #6b6b70/.test(tokensCss) && /--faint: #98989d/.test(darkBlock));
  expect('T02 令牌：--surface-sunken / --line-sunken / --skeleton-bg / --skeleton-sheen / --ambient-glow / --z-toast 均存在',
    ['--surface-sunken', '--line-sunken', '--skeleton-bg', '--skeleton-sheen', '--ambient-glow', '--z-toast', '--toast-bg', '--toast-border', '--toast-shadow', '--kbd-bg', '--measure-lede', '--dur-short']
      .every((t) => tokensCss.includes(t)));
  expect('T02 令牌（F9）：--z-modal 已定义且被 .modal-backdrop 使用',
    /--z-modal: 400/.test(tokensCss) && /\.modal-backdrop \{[^}]*z-index: var\(--z-modal\)/.test(pagesCss));

  expect('T02 F1：承载白字的 5 处底色全部改 --accent-strong + --on-accent',
    /\.button--primary \{[^}]*background: var\(--accent-strong\)[^}]*color: var\(--on-accent\)/.test(componentsCss) &&
    /\.nav-logo \{[^}]*background: var\(--accent-strong\)[^}]*color: var\(--on-accent\)/.test(layoutCss) &&
    /\.flow__no \{[^}]*background: var\(--accent-strong\)[^}]*color: var\(--on-accent\)/.test(pagesCss) &&
    /\.guide__no \{[^}]*background: var\(--accent-strong\)[^}]*color: var\(--on-accent\)/.test(pagesCss) &&
    /\.tip__label \{[^}]*background: var\(--accent-strong\)[^}]*color: var\(--on-accent\)/.test(componentsCss));
  expect('T02 F7：.progress-node--done .progress-node__no 改 tinted 方案（不再压白字）',
    /\.progress-node--done \.progress-node__no \{[^}]*background: var\(--ok-bg\)[^}]*color: var\(--ok\)[^}]*border: 1px solid var\(--ok-border\)/.test(componentsCss));
  expect('T02 F10：.progress-node--active .progress-node__no 用 --accent-strong / --on-accent',
    /\.progress-node--active \.progress-node__no \{[^}]*background: var\(--accent-strong\)[^}]*color: var\(--on-accent\)/.test(componentsCss));
  expect('T02 F8：tinted 底上的 accent 文字统一改 --accent-ink',
    [componentsCss, pagesCss, layoutCss].join('\n').split('color: var(--accent-ink)').length - 1 === 11);
  expect('T02 F3（M5/R5）：.progress-track / .run-metric / .process-timeline__detail / .citation__quote / .answer-card 同时换底与边框',
    [componentsCss].join('\n').match(/background: var\(--surface-sunken\);\s*border: 1px solid var\(--line-sunken\)/g).length >= 4);
  expect('T02 M6：.progress-track 不再有永不生效的 overflow-x:auto',
    !/\.progress-track \{[^}]*overflow-x/.test(componentsCss));
  expect('T02 F2：骨架屏用 --skeleton-bg / --skeleton-sheen',
    /\.skeleton \{[^}]*background: var\(--skeleton-bg\)/.test(componentsCss) &&
    /linear-gradient\(90deg, transparent, var\(--skeleton-sheen\), transparent\)/.test(componentsCss));
  expect('T02 F4：环境光改用 --ambient-glow 并把扩散收到 78%',
    /body::before \{[\s\S]*?background: radial-gradient\(closest-side, var\(--ambient-glow\), transparent 78%\)/.test(baseCss));
  expect('T02 W3：.flow__step:hover 去掉 scale(1.05) 与 z-index:10',
    /\.flow__step:\hover \{[^}]*transform: translateY\(-2px\)[^}]*border-color: var\(--accent\)[^}]*\}/.test(pagesCss) &&
    !/\.flow__step:\hover \{[^}]*scale\(1\.05\)/.test(pagesCss));
  expect('T02 W1：page-in 220ms / Reveal 320ms + 12px',
    /main \{\s*animation: page-in 220ms/.test(baseCss) &&
    /\[data-reveal\] \{[\s\S]*?translate3d\(0, 12px, 0\);[\s\S]*?320ms/.test(baseCss));

  /* ---- reduced-motion 全覆盖（AC12） ---- */
  expect('T02 AC12：兜底规则存在（含 !important）',
    /\*, \*::before, \*::after \{[\s\S]*?animation-duration: 0\.01ms !important/.test(responsive) &&
    /transition-duration: 0\.01ms !important/.test(responsive));
  expect('T02 AC12：覆盖 badge--running::before / collapsible-card__body / modal / modal-backdrop / nav-scrim / nav-drawer',
    ['.badge--running::before', '.collapsible-card__body', '.modal,', '.modal-backdrop', '.nav-scrim,', '.nav-drawer']
      .every((s) => responsive.includes(s)));
  expect('T02 AC12：覆盖本轮新增动画（progress-node--active / run-pill__dot / toast）',
    /\.progress-node--active,[\s\S]*?\.run-pill__dot,[\s\S]*?\.toast,/.test(responsive));
  expect('T02 AC12：hover/active 位移类改纯颜色反馈',
    /\.flow__step:hover,[\s\S]*?\.card--interactive:hover,[\s\S]*?\.button:active\s*\{ transform: none !important; \}/.test(responsive));

  /* ---- AC13：styles 目录下除 tokens.css 外零硬编码颜色 ---- */
  expect('T02 AC13：styles/*.css 除 tokens.css 外无硬编码颜色',
    fs.readdirSync(stylesDir)
      .filter((f) => f.endsWith('.css') && f !== 'tokens.css')
      .every((f) => !/#(?:[0-9a-fA-F]{3,8})\b|rgb\(/.test(fs.readFileSync(path.join(stylesDir, f), 'utf8'))));

  /* =========================================================================
     T03 · S3 图标统一 + 内联样式收敛 + 排版刻度
     ========================================================================= */

  /* ---- B1：图标库文件存在、导出齐全、App.tsx 不再自绘 svg ---- */
  const iconsSrc = fs.readFileSync(path.resolve(process.cwd(), 'src/components/icons.tsx'), 'utf8');
  const ICON_NAMES = [
    'SunIcon', 'MoonIcon', 'MenuIcon', 'CloseIcon', 'ChevronDownIcon', 'ChevronRightIcon',
    'SearchIcon', 'PlayIcon', 'PauseIcon', 'BulbIcon', 'ListIcon', 'FileIcon', 'WrenchIcon',
    'BeakerIcon', 'CheckIcon', 'PencilIcon', 'AlertIcon', 'XIcon', 'DotIcon', 'BoltIcon',
    'HomeIcon', 'FlaskIcon', 'ClipboardIcon', 'BotIcon', 'BookIcon', 'DocIcon',
    'GraduationIcon', 'BarChartIcon', 'SlidersIcon', 'UndoIcon',
  ];
  expect('T03 B1：icons.tsx 存在且导出全部图标',
    ICON_NAMES.every((n) => new RegExp(`export function ${n}\\(`).test(iconsSrc)));
  expect('T03 B1：图标统一 24 视框 + 1.75 描边 + aria-hidden',
    /viewBox="0 0 24 24"/.test(iconsSrc) &&
    /strokeWidth = 1\.75/.test(iconsSrc) &&
    /aria-hidden="true"/.test(iconsSrc) &&
    /focusable="false"/.test(iconsSrc));
  expect('T03 B1：App.tsx 不再自行声明 svg 图标', !/function (Sun|Moon|Menu|Close|ChevronDown)Icon/.test(appSrc));
  expect('T03 B1：App.tsx 从 icons.tsx 引入图标',
    /from '\.\/components\/icons'/.test(appSrc) && /<MenuIcon size=\{18\} \/>/.test(appSrc) &&
    /<MoonIcon size=\{17\} \/>/.test(appSrc) && /<SunIcon size=\{17\} \/>/.test(appSrc));

  /* ---- B2：字符图标清零 ---- */
  const allCss = [baseCssEarly, layoutCss, componentsCss, pagesCss, responsive].join('\n');
  expect('T03 B2：CSS 中无字符图标（⚡ / ▸ / ▾ / ✕）',
    !/content: "[⚡▸▾✕]"/.test(allCss));
  expect('T03 B2：.fold__summary::before 已关掉字符箭头',
    /\.fold__summary::before \{\s*content: none;/.test(layoutCss));
  expect('T03 B2：.fold__summary 内联 ChevronRightIcon（DOM 侧）',
    [fs.readFileSync(path.resolve(process.cwd(), 'src/features/workflow/ResearchWorkflow.tsx'), 'utf8')]
      .every((s) => /<ChevronRightIcon size=\{14\} \/>/.test(s)) &&
    /\.fold\[open\] \.fold__summary > svg \{[^}]*transform: rotate\(90deg\);/.test(layoutCss));
  expect('T03 B2：.tool-call-card__tool::before 已关掉 ⚡',
    /\.tool-call-card__tool::before \{\s*content: none;/.test(componentsCss));
  expect('T03 B2：ToolCallCard 内联 BoltIcon',
    fs.readFileSync(path.resolve(process.cwd(), 'src/components/ToolCallCard.tsx'), 'utf8')
      .includes('<BoltIcon size={13} />'));
  expect('T03 B2：Reports 弹窗关闭按钮用 CloseIcon（不再 ✕）',
    fs.readFileSync(path.resolve(process.cwd(), 'src/features/reports/Reports.tsx'), 'utf8')
      .includes('<CloseIcon size={18} />'));

  /* ---- B3：事件流 emoji 清零 ---- */
  const rfSrc = fs.readFileSync(path.resolve(process.cwd(), 'src/features/workflow/ResearchWorkflow.tsx'), 'utf8');
  expect('T03 B3：EVENT_ICON 改为组件映射（无 emoji 字符串）',
    /const EVENT_ICON: Record<string, ComponentType<IconProps>> = \{/.test(rfSrc) &&
    !/EVENT_ICON: Record<string, string>/.test(rfSrc) &&
    !/[▶💡📋🔎📄🔬🧩✓✍⏸✅❌🛑]/.test(rfSrc));
  expect('T03 B3：事件图标走 renderEventIcon（size=13）',
    /function renderEventIcon\(type: string\)/.test(rfSrc) && /<Icon size=\{13\} \/>/.test(rfSrc));

  /* ---- B4：汉字图标清零 ---- */
  expect('T03 B4：Dashboard 入口卡图标为组件（无「程智库报」）',
    !/icon: '[程智库报]'/.test(fs.readFileSync(path.resolve(process.cwd(), 'src/features/dashboard/Dashboard.tsx'), 'utf8')) &&
    /icon: FlaskIcon,/.test(fs.readFileSync(path.resolve(process.cwd(), 'src/features/dashboard/Dashboard.tsx'), 'utf8')));
  expect('T03 B4：Tutorial 模块图标为组件（无「览规体库程教」）',
    !/icon: '[览规体库程教]'/.test(fs.readFileSync(path.resolve(process.cwd(), 'src/features/tutorial/Tutorial.tsx'), 'utf8')));
  /** 只看容器声明块内部：用 [^}]* 收紧，别让它一路扫到文件末尾的无关 font-size */
  const blockOf = (css, sel) => {
    const m = css.match(new RegExp(sel + ' \\{([^}]*)\\}'))
    return m ? m[1] : ''
  }
  expect('T03 B4：.card__icon / .module__icon 不再依赖 font-size 画汉字',
    !/font-size/.test(blockOf(componentsCss, '.card__icon')) &&
    !/font-weight/.test(blockOf(componentsCss, '.card__icon')) &&
    !/font-size/.test(blockOf(pagesCss, '.module__icon')) &&
    !/font-weight/.test(blockOf(pagesCss, '.module__icon')));

  /* ---- AC10：内联样式收敛 ---- */
  const tsxFiles = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.tsx')) tsxFiles.push(p);
    }
  })(path.resolve(process.cwd(), 'src'));
  const inlineStyles = tsxFiles
    .filter((f) => !f.endsWith(path.join('components', 'Reveal.tsx')))
    .filter((f) => fs.readFileSync(f, 'utf8').includes('style={{'));
  expect('T03 AC10：Reveal 之外内联 style={{ 为 0（验收线 ≤3）', inlineStyles.length === 0);
  expect('T03 AC10：Reveal 的动态 transitionDelay 保留',
    fs.readFileSync(path.resolve(process.cwd(), 'src/components/Reveal.tsx'), 'utf8').includes('transitionDelay'));
  expect('T03：工具类已在 CSS 落地（stack/text-flush/push-right/badge-row/run-card__meta--end）',
    ['.stack-gap-xs', '.stack-gap-sm', '.stack-gap ', '.push-right', '.text-flush', '.badge-row',
      '.data-list--gap', '.run-card__meta--end']
      .every((c) => componentsCss.includes(c)));
  expect('T03：工具类放在 components.css 末尾（才能覆盖组件类的 margin）',
    componentsCss.lastIndexOf('.text-flush') > componentsCss.indexOf('.card__icon'));

  /* ---- V3 / V7：既有非刻度值已刻度化 ---- */
  expect('T03 V3：.data-list / .steps gap 走 --space-3',
    /\.data-list \{[\s\S]*?gap: var\(--space-3\);/.test(componentsCss) &&
    /\.steps \{[\s\S]*?gap: var\(--space-3\);/.test(componentsCss));
  expect('T03 V3：.steps--compact gap 走 --space-2',
    /\.steps--compact \{\s*gap: var\(--space-2\);/.test(componentsCss));
  expect('T03 V3：.plan__heading margin 走令牌',
    /\.plan__heading \{[\s\S]*?margin: var\(--space-5\) 0 var\(--space-2\);/.test(componentsCss));
  expect('T03 V3：.metrics / .field / .tip / .input-card 上间距走令牌',
    /\.metrics \{[\s\S]*?margin: var\(--space-5\) 0 0;/.test(componentsCss) &&
    /\.field \{\s*margin-bottom: var\(--space-5\);/.test(componentsCss) &&
    /\.tip \{[\s\S]*?margin-top: var\(--space-5\);/.test(componentsCss) &&
    /\.input-card \{\s*margin-top: var\(--space-5\);/.test(componentsCss));
  expect('T03 V3：.activity 上间距走 --space-6',
    /\.activity \{[\s\S]*?margin-top: var\(--space-6\);/.test(componentsCss));
  expect('T03 V3：.panel__header--compact .panel__subtitle 行长走 --content-measure',
    /\.panel__header--compact \.panel__subtitle \{\s*max-width: var\(--content-measure\);/.test(layoutCss));
  expect('T03：.alert__row 统一 margin-top（#33 内联条件恒真已消除）',
    /\.alert__row \{\s*margin-top: var\(--space-3\);/.test(componentsCss));
  expect('T03：.state-error 补 margin-bottom（Settings 包裹 div 已删）',
    /\.state-error \{[\s\S]*?margin-bottom: var\(--space-5\);/.test(componentsCss));
  expect('T03：.nav-inner / .shell 宽度口径统一为 --gutter',
    count(layoutCss, /width: min\(var\(--max-width\), calc\(100% - var\(--gutter\)\)\);/g) === 2);

  /* ---- 渲染层：图标确实出现在 HTML 里 ---- */
  const dashIcons = count(dashMain, /class="card__icon"><svg/g);
  expect('T03 B4：Dashboard 3 张入口卡各渲染 1 个 svg 图标', dashIcons === 3);
  const { Tutorial } = await server.ssrLoadModule('/src/features/tutorial/Tutorial.tsx');
  const tutorial = renderToStaticMarkup(React.createElement(Tutorial, { onNavigate: () => {} }));
  expect('T03 B4：Tutorial 8 个模块各渲染 1 个 svg 图标',
    count(tutorial, /class="module__icon"><svg/g) === 8);

  /* =========================================================================
     [T10] 阶段顺序契约（前端侧）—— 与后端 tests/test_graph.py 的
     test_stage_order_matches_frontend_contract 配对。
     =========================================================================
     ⚠️ 这里【不抄一份节点序列】。抄列表 = 用会漂的副本守会漂的副本，
        而且两份都是我写的 → 还会自己绿。
        前端侧只断言「前端自己这一处声明」的性质，跨端一致性交给后端那条
        （它 introspect graph.nodes，读的是编译产物）。

     分工：
       后端断言 = 「后端的阶段序列没变」（runtime introspection）
       前端断言 = 「前端引用的阶段数 == 后端那条断言钉住的那个数」
     两者相加 = 跨端一致，且没有任何一处是「抄来的第二份序列」。
  */

  /* ---- ① FlowOverview.STEPS 条数 == 7（后端 BASE_NODES 契约值） ---- */
  const flowSrc = fs.readFileSync(
    path.resolve(process.cwd(), 'src/features/workflow/FlowOverview.tsx'), 'utf8');
  // 数 STEPS 数组里的 `no:` 声明条数 —— 不数 name（name 是中文，与后端 snake_case
  // 是两个命名空间，对不上；见 team-lead 的原始告诫）
  const stepCount = count(flowSrc, /^\s{4}no:\s*\d+,/gm);
  expect('T10 ①：FlowOverview.STEPS 条数 == 7（后端正常阶段数契约）', stepCount === 7);
  // 序号必须连续 1..7，不能有洞（改到一半删一条会留洞）
  const stepNos = (flowSrc.match(/^\s{4}no:\s*(\d+),/gm) || [])
    .map((m) => Number(m.match(/(\d+)/)[1]));
  expect('T10 ①：STEPS 序号连续 1..7（无洞无重复）',
    stepNos.length === 7 && stepNos.every((n, i) => n === i + 1));

  /* ---- ② NODE_LABELS 条数 == 7（进度阶梯的 7 格） ---- */
  const nodeLabelCount = count(rfSrc, /^\s{2}\{ key: '[a-z_]+', label: '[^']+' \},/gm);
  expect('T10 ②：ResearchWorkflow.NODE_LABELS 条数 == 7', nodeLabelCount === 7);

  /* ---- ③ 前端 BASE_NODES 常数 == 7，且与上面两处一致 ---- */
  const progSrc = fs.readFileSync(
    path.resolve(process.cwd(), 'src/features/workflow/runProgress.ts'), 'utf8');
  const baseNodes = Number((progSrc.match(/export const BASE_NODES = (\d+)/) || [])[1]);
  expect('T10 ③：runProgress.BASE_NODES == 7', baseNodes === 7);
  expect('T10 ③：三处「7」互相一致（STEPS / NODE_LABELS / BASE_NODES）',
    stepCount === nodeLabelCount && nodeLabelCount === baseNodes);

  /* ---- ④ 命名空间告诫：STEPS[].name 是中文、后端是 snake_case，不得互相断言 ---- */
  // 这条是「反向断言」：证明我们【没有】误把两个命名空间对起来。
  // 若有人日后「顺手统一」把前端 name 改成 understand_task，这条会红 —— 那是有意的：
  // 前端展示名是中文文案，改成标识符会直接损害用户可读性。
  const stepNames = (flowSrc.match(/^\s{4}name:\s*'([^']+)'/gm) || [])
    .map((m) => m.replace(/^\s{4}name:\s*'/, '').replace(/'$/, ''));
  expect('T10 ④：STEPS[].name 保持中文展示名（非 snake_case 标识符）',
    stepNames.length === 7 && stepNames.every((n) => /[\u4e00-\u9fa5]/.test(n)));

} catch (err) {
  checks.push([`渲染抛错: ${err.message}`, false]);
} finally {
  await server.close().catch(() => {});
}

let failed = 0;
for (const [n, ok] of checks) {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}`);
}
console.log(`\n结果: ${checks.length - failed}/${checks.length} 通过`);
process.exit(failed ? 1 : 0);

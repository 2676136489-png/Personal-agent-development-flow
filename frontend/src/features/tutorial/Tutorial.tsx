import { Reveal } from '../../components/Reveal'
import { PageHeader } from '../../components/PageHeader'
import { SectionNav } from '../../components/SectionNav'
import { Stagger, StaggerItem } from '../../components/Stagger'
import { BotIcon, BookIcon, ClipboardIcon, FlaskIcon, GraduationIcon, HomeIcon } from '../../components/icons'
import type { IconProps } from '../../components/icons'
import type { ComponentType } from 'react'

type NavigateFn = (key: string) => void

type Module = {
  /** B4：由汉字改为线图标组件 */
  icon: ComponentType<IconProps>
  name: string
  role: string
  scenario: string
  interaction: string
}

const MODULES: Module[] = [
  {
    icon: HomeIcon,
    name: '概览',
    role: '平台入口与后端连通性自检。一句话讲清「把一个问题跑成一份有出处的研究报告」，并展示能力卡与七步研究流程。',
    scenario: '第一次打开、想快速了解平台能做什么，或排查前后端是否连通。',
    interaction: '进入即自动请求 GET /api/health 显示状态；点击「重新检测」可再次探活。',
  },
  {
    icon: ClipboardIcon,
    name: '研究规划',
    role: '把模糊问题拆成研究目标、关键子问题、执行步骤与预期来源（结构化输出）。',
    scenario: '动手前先把研究方向和问题想清楚，避免研究跑偏。',
    interaction: '输入问题 → 点「生成计划」→ 查看目标 / 子问题 / 步骤 / 来源，可再次生成。',
  },
  {
    icon: BotIcon,
    name: '智能体工作台',
    role: '让智能体自主决定调用工具（联网搜索 / 网页抓取 / 计算），实时产出带引用的答案与执行轨迹。',
    scenario: '想快速拿到一个可溯源的研究结论，或观察智能体如何决策。',
    interaction: '输入任务 → 「开始研究」→ 实时查看工具调用轨迹、最终答案与引用来源。',
  },
  {
    icon: BookIcon,
    name: '知识库',
    role: '上传 PDF / Markdown / TXT，自动解析、切块、向量化，供研究时检索引用。',
    scenario: '研究需要引用你的私有 / 内部资料，而非仅公开网络内容。',
    interaction: '上传文档 → 等待「就绪」→ 用「检索测试」输入问题，验证可被命中引用。',
  },
  {
    icon: FlaskIcon,
    name: '深度研究',
    role: '端到端跑完整研究：理解 → 规划 → 检索 / 分析循环 → 核查 → 写报告，写报告前会中断等你确认。',
    scenario: '想拿到一份结构化、有出处、可中断把关的研究报告。',
    interaction:
      '输入问题 → 开始 → 实时事件流 → 在「待确认」中断点查看草稿并确认 / 修改 → 获取最终报告。支持后台持续运行，可切到其他模块同步查看。',
  },
  {
    icon: GraduationIcon,
    name: '教程（本页）',
    role: '汇总各模块的作用、适用场景与交互逻辑，并给出常见场景与分步操作指引。',
    scenario: '第一次上手，或想系统了解每个模块能解决什么问题。',
    interaction: '自上而下阅读：先看模块详解，再对照场景，最后按分步指引跑通一次。',
  },
]

const SCENARIOS = [
  {
    tag: '场景一',
    title: '快速吃透一个新方向',
    desc: '用「研究规划」理清目标与子问题，再到「深度研究」执行，最后拿到带来源的研究报告。',
  },
  {
    tag: '场景二',
    title: '对比不同公开方案',
    desc: '在「深度研究」中描述对比需求，智能体联网检索多个来源并自动标注出处与异同。',
  },
  {
    tag: '场景三',
    title: '基于内部资料做研究',
    desc: '先在「知识库」上传你的文档，再到「深度研究」检索并引用这些私有内容，结论有据可依。',
  },
  {
    tag: '场景四',
    title: '边研究边把关',
    desc: '利用流程中的中断确认，在生成报告前审核计划与草稿，方向不对可随时修改，避免白跑。',
  },
]

const STEPS = [
  { title: '打开「概览」，确认连通', desc: '花 30 秒了解平台能做什么，并确认后端显示「已连接」（否则先排查后端与 CORS）。' },
  { title: '进入「研究规划」，生成计划', desc: '输入你的问题，点击「生成计划」，查看研究目标、关键子问题与执行步骤。' },
  { title: '进入「深度研究」，开始执行', desc: '粘贴同一问题，点击「开始研究」，实时观察理解、检索、分析、核查等每一步进展。' },
  { title: '处理中断确认', desc: '当流程停在「待确认」，查看计划 / 报告草稿，点击「确认」继续；需要方向调整时点「修改」。' },
  { title: '获取研究报告', desc: '流程结束后查看带来源的最终报告与引用列表；如需沉淀，可把资料上传到「知识库」。' },
]

export function Tutorial({ onNavigate }: { onNavigate?: NavigateFn }) {
  return (
    <>
      <PageHeader
        eyebrow="使用教程"
        title="三步上手，把问题跑成研究报告。"
        lede="无论你是第一次使用，还是想摸清每个模块的能力，这份教程都能帮你快速理解平台，并跑通一次完整研究。"
        notes={[
          { term: '适合谁', desc: '第一次上手、或想系统了解每个模块能解决什么问题的用户。' },
          { term: '怎么读', desc: '自上而下：先看模块详解，再对照场景，最后按分步指引跑通一次。' },
          { term: '读完能做什么', desc: '独立用任意模块，并把它们串成一条完整的研究链路。' },
        ]}
        actions={
          <div className="hero-actions">
            <button className="button button--primary" onClick={() => onNavigate?.('workflow')}>
              直接开始研究
            </button>
            <button className="button" onClick={() => onNavigate?.('dashboard')}>
              回到概览
            </button>
          </div>
        }
      />

      <div className="doc-layout">
        <SectionNav
          title="本页内容"
          items={[
            { id: 'modules', label: '功能模块' },
            { id: 'scenarios', label: '常见场景' },
            { id: 'steps', label: '分步指引' },
          ]}
        />

        <div className="doc-layout__main">
          {/* ============ 功能模块详解 ============ */}
          <section className="section" id="modules">
            <Reveal className="section-head">
              <p className="eyebrow">功能模块</p>
              <h2>每个模块解决什么问题？</h2>
              <p className="section-lede">
                平台由「概览 / 研究规划 / 智能体 / 知识库 / 深度研究」五个模块组成，各司其职、可单独使用，也可串成完整研究链路。
              </p>
            </Reveal>

            <Stagger className="module-grid">
              {MODULES.map((m) => {
                const Icon = m.icon
                return (
                  <StaggerItem key={m.name}>
                    <div className="module">
                      <div className="module__head">
                        <span className="module__icon"><Icon size={21} /></span>
                        <h3>{m.name}</h3>
                      </div>
                      <p className="module__role">{m.role}</p>
                      <div className="module__meta">
                        <div className="module__row">
                          <b>适用场景</b>
                          {m.scenario}
                        </div>
                        <div className="module__row">
                          <b>交互逻辑</b>
                          {m.interaction}
                        </div>
                      </div>
                    </div>
                  </StaggerItem>
                )
              })}
            </Stagger>
          </section>

          {/* ============ 常见使用场景 ============ */}
          <section className="section" id="scenarios">
            <Reveal className="section-head">
              <p className="eyebrow">常见场景</p>
              <h2>这些事，用它最顺手。</h2>
              <p className="section-lede">
                从「快速了解一个方向」到「基于内部资料做研究」，下面是几种最常落地的用法。
              </p>
            </Reveal>

            <div className="scenario-grid">
              {SCENARIOS.map((s, i) => (
                <Reveal className="scenario" key={s.title} delay={(i % 2) * 80}>
                  <span className="scenario__tag">{s.tag}</span>
                  <h3>{s.title}</h3>
                  <p>{s.desc}</p>
                </Reveal>
              ))}
            </div>
          </section>

          {/* ============ 分步操作指引 ============ */}
          <section className="section" id="steps">
            <Reveal className="section-head">
              <p className="eyebrow">分步指引</p>
              <h2>照着做，五步跑通一次研究。</h2>
              <p className="section-lede">
                按从「概览」到「研究报告」的顺序操作。深度研究与智能体会在后台持续运行并实时推送事件，你可以随时切到其他模块同步查看，进度不会中断。
              </p>
            </Reveal>

            <ol className="guide">
              {STEPS.map((s, i) => (
                <Reveal className="guide__item" as="li" key={s.title}>
                  <span className="guide__no">{i + 1}</span>
                  <div className="guide__body">
                    <h4>{s.title}</h4>
                    <p>{s.desc}</p>
                  </div>
                </Reveal>
              ))}
            </ol>

            <div className="cta-banner">
              <h3>准备好跑一次研究了吗？</h3>
              <p>从「深度研究」开始，或直接回到「概览」再看一遍平台能做什么。</p>
              <div className="hero-actions">
                <button className="button button--primary" onClick={() => onNavigate?.('workflow')}>
                  开始研究
                </button>
                <button className="button" onClick={() => onNavigate?.('dashboard')}>
                  查看概览
                </button>
              </div>
            </div>
          </section>
        </div>
      </div>
    </>
  )
}

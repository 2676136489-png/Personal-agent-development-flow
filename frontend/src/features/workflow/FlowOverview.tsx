/** 研究工作流的流程说明：用卡片逐段解释每个阶段在做什么。
 *  抽成独立组件，避免把所有展示逻辑堆在 ResearchWorkflow 里。
 *
 *  ⚠️ 这里的 7 个阶段名必须与真实节点（understand_task / plan / research /
 *  retrieve / analyze / verify / write）以及步骤条 STEP_DEFS 保持一致：
 *  之前写的是「研究决策 / 资料获取」这类概念名，用户对照步骤条时要自己在
 *  两套词汇之间翻译，越读越糊涂。 */
interface FlowStep {
  no: number
  name: string
  desc: string
  detail: string
  tag?: string
}

const STEPS: FlowStep[] = [
  {
    no: 1,
    name: '理解任务',
    desc: '解析你提出的问题，明确研究目标、需要回答的关键子问题，以及研究的边界范围。',
    detail: '输出结构化的「任务理解」：研究目标、关键子问题、研究范围。后面每一轮检索都从这些子问题出发，保证不跑题。',
  },
  {
    no: 2,
    name: '制定计划',
    desc: '把目标拆成若干可执行的研究步骤，每步都写清要查什么、预期用什么来源。',
    detail: '计划会展示在「研究计划」卡片里：步骤标题、执行说明与预期来源。它是这次研究的施工图，也可用来判断它有没有理解对你的意图。',
  },
  {
    no: 3,
    name: '研究检索',
    desc: '逐个检索关键子问题：先查你自己的知识库，没命中再联网搜索，结果去重后累加。',
    detail: '知识库优先意味着：已上传的资料不消耗联网额度。每轮最多覆盖 3 个子问题，回炉时从未搜过的子问题开始补。',
  },
  {
    no: 4,
    name: '抽取证据',
    desc: '从检索结果里抽取可引用的正文片段，作为后续结论的依据，并整理成「依据来源」。',
    detail: '证据只抽取不编造：网页正文会被当作不可信数据包裹后再交给模型，避免页面里的指令性文字污染研究过程。',
  },
  {
    no: 5,
    name: '分析归纳',
    desc: '基于已有证据归纳核心结论，并主动标出「证据缺口」——哪些问题还没有被证据支撑。',
    detail: '结论必须能对上证据：每条结论末尾会标注依据编号。证据之间互相矛盾时，矛盾本身会被写进缺口清单，而不是硬下结论。',
  },
  {
    no: 6,
    name: '核对验证',
    desc: '逐条核对结论与证据是否真的匹配，给出「通过」或「需要补充」的判定。',
    detail: '这是回炉的开关：判定「需要补充」时，缺失的点会作为待补清单退回第 3 步继续检索，然后再分析、再核对，直到通过或达到核对上限。',
    tag: '不通过则回炉补检索',
  },
  {
    no: 7,
    name: '撰写报告',
    desc: '把研究结果汇总成结构化报告——落笔之前会先暂停，等待你确认。',
    detail: '报告含标题、摘要、分节正文与局限说明；你可以在确认时补充要求（例如侧重应用场景），模型会按你的意见调整后再落笔。',
    tag: '人工确认闸门',
  },
]

export function FlowOverview() {
  return (
    <section className="flow-wrap">
      <h3 className="plan__heading">工作流程</h3>
      <p className="lead">
        整条研究链路由 LangGraph 驱动，与上方「执行进度」的 7 个阶段一一对应：
        先「理解」再「计划」，随后在「研究检索 ⇄ 抽取证据」之间循环补料；
        「核对验证」不通过会自动回炉补充检索（回炉次数会显示在阶段徽标里，
        形如 ×2）；证据核对通过后，在写报告前主动中断，等待你的人工确认（human-in-the-loop）。
      </p>
      <div className="flow">
        {STEPS.map((s) => (
          <div key={s.no} className="flow__step">
            <div className="flow__head">
              <span className="flow__no">{s.no}</span>
              <span className="flow__name">{s.name}</span>
            </div>
            <p className="flow__desc">{s.desc}</p>
            <p className="flow__detail">{s.detail}</p>
            {s.tag && <span className="flow__tag">{s.tag}</span>}
          </div>
        ))}
      </div>
    </section>
  )
}
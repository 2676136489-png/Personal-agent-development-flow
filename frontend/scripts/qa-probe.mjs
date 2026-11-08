/**
 * ============================ 空壳警示（必读） ============================
 * 本脚本当前【不执行任何浏览器测量】，只导出一张页面清单常量表，并把它打到 stdout。
 *
 * 它没有任何 agent-browser 集成：不启动浏览器、不打开页面、不读取 DOM、
 * 不测量横向溢出 / 导航可见性 / 首屏主操作。全仓库也没有任何文件 import 它的
 * PAGE_LABELS / PRIMARY_ACTION_PROBE —— 这两个导出目前无人消费。
 *
 * 因此：
 *   - 跑通它、exit 0，只说明「一个 console.log 没抛异常」；
 *   - 它【不是】量具，引用它等于引用一张清单，不等于验证了任何页面。
 *
 * 真实渲染层的证据在 scripts/smoke-render.mjs（SSR 渲染真实组件树并断言 DOM 文本），
 * 以及 scripts/qa/viewport-probe.js / loading-probe.js（页面上下文探针，经 agent-browser 注入执行）。
 *
 * 如需本脚本名副其实，须补 agent-browser 集成；当前状态为 team-lead 已裁定的
 * 「接受浏览器层改名未验证」。改动本文件时请一并复核这段警示是否仍然成立。
 * ==========================================================================
 *
 * QA 独立探针脚本（严过关）。不得修改工程师的 smoke-render.mjs。
 * 用法：node scripts/qa-probe.mjs <viewportW> <viewportH>
 * 输出：清单 JSON 到 stdout（非测量结果）
 */
const W = Number(process.argv[2] || 1440)
const H = Number(process.argv[3] || 900)

/* ---------- 可直接在页面上下文里 eval 的测量函数（字符串） ---------- */
// 所有测量逻辑都写成纯函数字符串，便于用 eval 注入
export const PAGE_LABELS = [
  '概览',
  '深度研究',
  '知识库',
  'RAG 流程',
  '研究报告',
  '效果评估',
  '系统设置',
  '教程',
]

// 主操作可见性：每页首屏应出现的「主操作」选择器
export const PRIMARY_ACTION_PROBE = {
  概览: '.hero-actions .button--primary',
  深度研究: 'button--primary', // 用文本兜底；该页主按钮文案为「启动深度研究」
}

console.log(JSON.stringify({ w: W, h: H, pages: PAGE_LABELS }))

/**
 * 类名覆盖审计：把 TSX 里出现的 class 与 CSS 里定义的 class 做差集。
 *
 * 为什么需要它：换皮时最容易漏的不是颜色，是某些只在错误态 / 展开态
 * 才出现的类（state-error__actions、rag-scatter__readout …）—— 眼睛看不出来，
 * 要等线上真的报错才露馅。这个脚本把「未被任何样式命中」的类名直接列出来。
 */
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')

function walk(dir, test) {
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
  const re = /className=(?:"([^"]*)"|\{`([^`]*)`\}|\{([^}]*)\})/g
  let match
  while ((match = re.exec(source))) {
    // 条件表达式里只有引号内的是类名（变量名 / undefined 不是）
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
      .filter((token) => /^[a-zA-Z][\w-]*$/.test(token))
      .forEach((token) => fromTsx.add(token))
  }
}

const fromCss = new Set()
for (const file of walk(path.join(ROOT, 'src', 'styles'), (n) => n.endsWith('.css'))) {
  const source = fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
  for (const match of source.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) fromCss.add(match[1])
}

const missing = [...fromTsx].filter((name) => !fromCss.has(name)).sort()
const unused = [...fromCss].filter((name) => !fromTsx.has(name)).sort()

console.log(`TSX 类名 ${fromTsx.size} 个 / CSS 选择器类名 ${fromCss.size} 个`)
console.log(`\n未被任何 CSS 命中（${missing.length}）：`)
console.log(missing.join('\n'))
if (process.argv.includes('--unused')) {
  console.log(`\nCSS 里定义但 TSX 未使用（${unused.length}，多为状态类/工具类，仅参考）：`)
  console.log(unused.join('\n'))
}

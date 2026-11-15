import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const DIST = 'dist'
const ASSETS = join(DIST, 'assets')

const required = [
  join(DIST, 'index.html'),
  join(DIST, 'favicon.svg'),
  join(DIST, 'models', 'glass.glb'),
  join(DIST, 'fonts', 'poppins-400.woff2'),
]

const forbidden = [
  'fonts.googleapis.com',
  'fonts.gstatic.com',
  'cdn.jsdelivr.net',
  'unpkg.com',
  'cdnjs.cloudflare.com',
  'motionsites.org',
]

const externalTag = /<(?:script|link|img)\b[^>]*(?:src|href)=["']https?:\/\//i
const externalCss = /url\(\s*["']?https?:\/\//i

function fail(message) {
  console.error(`[assets] ${message}`)
  process.exitCode = 1
}

for (const file of required) {
  if (!existsSync(file)) fail(`缺少本地资源：${file}`)
}

if (!existsSync(ASSETS)) {
  fail('缺少 dist/assets，请先执行 npm run build')
  process.exit()
}

const files = readdirSync(ASSETS).filter((name) => /\.(?:js|css)$/.test(name))

for (const name of files) {
  const file = join(ASSETS, name)
  if (!statSync(file).isFile()) continue
  const text = readFileSync(file, 'utf8')

  for (const host of forbidden) {
    if (text.includes(host)) fail(`${name} 仍引用外部资源域名：${host}`)
  }

  if (name.endsWith('.css') && externalCss.test(text)) {
    fail(`${name} 仍包含外部 CSS 资源地址`)
  }
}

const html = readFileSync(join(DIST, 'index.html'), 'utf8')
if (externalTag.test(html)) fail('index.html 仍包含外部 script/link/img 地址')

if (!process.exitCode) {
  console.log(`[assets] 本地资源检查通过：${files.length} 个构建文件，无外部 CDN 依赖`)
}

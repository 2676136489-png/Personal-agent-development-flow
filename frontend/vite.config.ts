import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Phase 1 故意不配置 server.proxy：
// 前端直连 http://localhost:8000，这样浏览器会真正发起跨域请求，
// 后端 CORS 配置是否生效能立刻被验证出来。
// 用 proxy 会把跨域"藏起来"，上线时反而容易踩坑。
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: '127.0.0.1',
  },
  build: {
    // 单 bundle 388KB 的问题不只是"大"：业务代码一改，整包缓存全失效。
    // 这里按**变更频率**切 vendor，让 react / 动画 / markdown 长期命中缓存。
    // 页面级按需加载由 App.tsx 的 React.lazy 负责（两者互补，缺一不可）。
    rollupOptions: {
      output: {
        manualChunks(id: string) {
          if (!id.includes('node_modules')) return undefined
          // react 运行时：版本一锁就是几个月不动
          if (
            id.includes('/react-dom/') ||
            id.includes('/react/') ||
            id.includes('/scheduler/')
          ) {
            return 'vendor-react'
          }
          // 动画引擎：体积大且稳定。
          // ⚠️ `motion-dom` 必须单独匹配 —— 只写 '/motion/' 匹配不到它
          // （后面跟的是 `-dom` 不是 `/`），结果它会掉进兜底的 vendor 块，
          // 让首屏白白多下 130KB。
          if (
            id.includes('/motion/') ||
            id.includes('/motion-dom/') ||
            id.includes('/framer-motion/')
          ) {
            return 'vendor-motion'
          }
          // markdown 走 unified 生态（micromark / remark / rehype / mdast…），
          // 只有看报告时才需要，独立成块才能被真正按需加载
          if (
            id.includes('/react-markdown/') ||
            id.includes('/remark') ||
            id.includes('/rehype') ||
            id.includes('/micromark') ||
            id.includes('/mdast') ||
            id.includes('/hast') ||
            id.includes('/unist-') ||
            id.includes('/unified/') ||
            id.includes('/vfile')
          ) {
            return 'vendor-markdown'
          }
          return 'vendor'
        },
      },
    },
    // 分包后单块会小很多，阈值放宽到 400KB，避免噪音告警
    chunkSizeWarningLimit: 400,
  },
})

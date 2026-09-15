import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import basicSsl from '@vitejs/plugin-basic-ssl'

const src = (p) => fileURLToPath(new URL(p, import.meta.url))

// PLAYGROUND_HTTP=1 時不開 HTTPS：http://localhost 本身就是 secure context，
// 給桌機自動化測試用（自簽憑證的攔截頁無法被自動化工具點過）。手機一律用 HTTPS。
const useHttps = !process.env.PLAYGROUND_HTTP

export default defineConfig({
  // 部署到 nginx 子路徑時設 PLAYGROUND_BASE=/scanner/（結尾要有斜線）
  base: process.env.PLAYGROUND_BASE || '/',
  plugins: [vue(), ...(useHttps ? [basicSsl()] : [])],
  server: {
    host: true, // 讓手機透過區網 IP 連進來
    port: useHttps ? 5173 : 5174,
  },
  resolve: {
    // 開發期直接指到各 package 的 src，改 core 不用重 build 就能在手機上看到。
    // 注意：這表示 dev 測的不是 dist 產物；驗打包結果請用 `pnpm build && pnpm preview`。
    alias: {
      '@scanner/core': src('../../packages/core/src/index.ts'),
      '@scanner/vue': src('../../packages/vue/src/index.ts'),
      '@scanner/ui': src('../../packages/ui/src/index.ts'),
    },
  },
})

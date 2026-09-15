import { execSync } from 'node:child_process'
import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import basicSsl from '@vitejs/plugin-basic-ssl'

const src = (p) => fileURLToPath(new URL(p, import.meta.url))

// 版本號：git 短碼 + build 時間，顯示在頁面上，確認手機拿到的是不是最新版
let gitHash = 'nogit'
try { gitHash = execSync('git rev-parse --short HEAD').toString().trim() } catch {}
const buildStamp = `${gitHash} ${new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Taipei' }).slice(0, 16)}`

// PLAYGROUND_HTTP=1 時不開 HTTPS：http://localhost 本身就是 secure context，
// 給桌機自動化測試用（自簽憑證的攔截頁無法被自動化工具點過）。手機一律用 HTTPS。
const useHttps = !process.env.PLAYGROUND_HTTP

export default defineConfig({
  // 部署到 nginx 子路徑時設 PLAYGROUND_BASE=/scanner/（結尾要有斜線）
  base: process.env.PLAYGROUND_BASE || '/',
  define: { __BUILD__: JSON.stringify(buildStamp) },
  plugins: [vue(), ...(useHttps ? [basicSsl()] : [])],
  // @scanner/* 透過 workspace link 直接吃各 package 的 dist（開發時 `pnpm dev` 會同時跑 tsup --watch）。
  // 好處：開發期測的就是真正的打包產物，Worker 路徑等問題在開發期就會暴露。
  // 不要把它們 pre-bundle，否則 `new URL('./wasm-worker.js', import.meta.url)` 會失效。
  optimizeDeps: { exclude: ['@scanner/core', '@scanner/vue', '@scanner/ui'] },
  server: {
    host: true, // 讓手機透過區網 IP 連進來
    port: useHttps ? 5173 : 5174,
  },
})

import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import cssInjectedByJs from 'vite-plugin-css-injected-by-js'
import dts from 'vite-plugin-dts'

// ui 含 .vue SFC，tsup 不吃，所以走 Vite lib mode
export default defineConfig({
  plugins: [
    vue(),
    dts({ tsconfigPath: './tsconfig.json', exclude: ['src/**/*.test.ts'] }),
    // 把 SFC 的 CSS 塞進 JS：使用者 import 元件就有樣式，不用另外 import 一個 .css
    cssInjectedByJs(),
  ],
  build: {
    lib: {
      entry: fileURLToPath(new URL('./src/index.ts', import.meta.url)),
      formats: ['es', 'cjs'],
      fileName: (format) => (format === 'es' ? 'index.js' : 'index.cjs'),
    },
    sourcemap: true,
    rollupOptions: {
      // 全部交給 App 端 bundler 處理，ui 只打包自己的元件
      external: ['vue', '@scanner/core', '@scanner/vue'],
    },
  },
})

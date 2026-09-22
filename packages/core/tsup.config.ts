import { readFileSync } from 'node:fs'
import { defineConfig } from 'tsup'

// 把 package.json 的版本編進 dist：App 印 `VERSION` 就知道瀏覽器**真正在跑**哪一版（不是 package.json 裝了哪一版）
const version = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version as string
const define = { __CORE_VERSION__: JSON.stringify(version) }

export default defineConfig([
  {
    entry: { index: 'src/index.ts' },
    format: ['esm', 'cjs'],
    dts: true,
    sourcemap: true,
    // 不在這裡 clean：兩個 config 共用 dist，watch 模式下 index 重建會把 wasm-worker.js 清掉。
    // 清理交給 package.json 的 build script。
    clean: false,
    target: 'es2022',
    treeshake: true,
    splitting: false,
    define,
    // 不用 shims：tsup 的 shim 會把 Node 的 path/url 塞進 ESM 輸出，瀏覽器載入會失敗。
    // CJS 輸出沒有 import.meta.url，wasm 路徑需要呼叫端提供 wasm.createWorker（見 wasm.ts）。
  },
  {
    // Worker 獨立 entry：把 zxing-wasm 的 JS glue bundle 進來（module worker 不能 import bare specifier）。
    // .wasm 檔不在這裡：由 wasmUrl 或 zxing-wasm 預設的 CDN 提供。
    entry: { 'wasm-worker': 'src/decoder/wasm-worker.ts' },
    format: ['esm'],
    dts: false,
    sourcemap: true,
    target: 'es2022',
    platform: 'browser',
    noExternal: ['zxing-wasm'],
    treeshake: true,
    define,
  },
])

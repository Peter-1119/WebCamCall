// 把 core 套件附帶的 .wasm 複製到 public/，讓 playground 自架（廠內可能沒有外網，不能靠 CDN）
// （Vite 專案也可以不複製，直接 `import wasmUrl from '@cclemon/scanner-core/zxing_reader.wasm?url'`）
import { copyFileSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const src = require.resolve('@cclemon/scanner-core/zxing_reader.wasm')
const dst = resolve(dirname(fileURLToPath(import.meta.url)), '../public/zxing_reader.wasm')
mkdirSync(dirname(dst), { recursive: true })
copyFileSync(src, dst)
console.log(`copied zxing_reader.wasm → public/`)

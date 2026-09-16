// 把 zxing-wasm 的 .wasm 放進 dist，一起發布：使用者不用另外下載，
// Vite 專案可直接 `import wasmUrl from '@cclemon/scanner-core/zxing_reader.wasm?url'`
import { copyFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const src = require.resolve('zxing-wasm/reader/zxing_reader.wasm')
const dst = resolve(dirname(fileURLToPath(import.meta.url)), '../dist/zxing_reader.wasm')
copyFileSync(src, dst)
console.log('copied zxing_reader.wasm → dist/')

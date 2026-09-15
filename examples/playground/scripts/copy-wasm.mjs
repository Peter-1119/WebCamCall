// 把 zxing-wasm 的 .wasm 複製到 public/，讓 playground 自架（廠內可能沒有外網，不能靠 CDN）
import { copyFileSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const src = require.resolve('zxing-wasm/reader/zxing_reader.wasm')
const dst = resolve(dirname(fileURLToPath(import.meta.url)), '../public/zxing_reader.wasm')
mkdirSync(dirname(dst), { recursive: true })
copyFileSync(src, dst)
console.log(`copied zxing_reader.wasm → public/`)

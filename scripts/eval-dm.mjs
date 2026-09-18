// 離線評測：模擬即時掃描管線（decodeScale 階梯 → located → 全解析度局部裁切 → 點陣膨脹），
// 回報每張圖在哪一級 / 哪個變體解出、耗時。圖片是私有資料（pics/ 已 gitignore），腳本進 repo。
//
// 用法：node scripts/eval-dm.mjs <dir> [--kernels 5,9,13,17,23] [--formats DataMatrix] [--max 4] [--verbose]
import { readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { PNG } from 'pngjs'

const coreDir = resolve(import.meta.dirname, '../packages/core')
const coreRequire = createRequire(join(coreDir, 'package.json'))
const { prepareZXingModule, readBarcodes } = await import(pathToFileURL(coreRequire.resolve('zxing-wasm/reader')).href)
const { dilateDots, rgbaToGray, grayToRgba, dottedKernels } = await import(pathToFileURL(join(coreDir, 'dist/index.js')).href)

const args = process.argv.slice(2)
const dir = args[0]
if (!dir) {
  console.error('usage: node scripts/eval-dm.mjs <dir> [--kernels ...] [--formats DataMatrix] [--max 4] [--verbose]')
  process.exit(1)
}
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : def
}
const verbose = args.includes('--verbose')
const kernelsOverride = opt('kernels', null)?.split(',').map(Number)
const formats = opt('formats', 'DataMatrix').split(',')
const maxSymbols = Number(opt('max', '4'))
const ladder = opt('ladder', '640,960,1280,0').split(',').map(Number)
const hatWhole = opt('hat', '0') === 'k' ? 'k' : Number(opt('hat', '0')) // 整張圖變體的帽半徑（0 = 關）
const hatZoom = opt('hat-zoom', '0') === 'k' ? 'k' : Number(opt('hat-zoom', '0')) // 候選裁切變體的帽半徑（0 = 關）

await prepareZXingModule({ overrides: { wasmBinary: readFileSync(coreRequire.resolve('zxing-wasm/reader/zxing_reader.wasm')) }, fireImmediately: true })

function loadPng(path) {
  const png = PNG.sync.read(readFileSync(path))
  return { data: new Uint8ClampedArray(png.data.buffer, png.data.byteOffset, png.data.length), width: png.width, height: png.height }
}

/** 最近鄰縮小（模擬 grabber 的 drawImage 縮放；夠用） */
function resizeGray(gray, w, h, tw) {
  if (tw >= w) return { gray, w, h, scale: 1 }
  const scale = tw / w
  const th = Math.round(h * scale)
  const out = new Uint8Array(tw * th)
  for (let y = 0; y < th; y++) {
    const sy = Math.min(h - 1, Math.floor(y / scale))
    for (let x = 0; x < tw; x++) out[y * tw + x] = gray[sy * w + Math.min(w - 1, Math.floor(x / scale))]
  }
  return { gray: out, w: tw, h: th, scale }
}

function cropGray(gray, w, h, rect) {
  const x0 = Math.max(0, Math.floor(rect.x))
  const y0 = Math.max(0, Math.floor(rect.y))
  const x1 = Math.min(w, Math.ceil(rect.x + rect.width))
  const y1 = Math.min(h, Math.ceil(rect.y + rect.height))
  const cw = x1 - x0
  const ch = y1 - y0
  const out = new Uint8Array(cw * ch)
  for (let y = 0; y < ch; y++) out.set(gray.subarray((y0 + y) * w + x0, (y0 + y) * w + x1), y * cw)
  return { gray: out, w: cw, h: ch, x: x0, y: y0 }
}

const baseOptions = (tryHarder) => ({ formats, tryHarder, tryRotate: true, tryInvert: true, tryDownscale: false, returnErrors: true, maxNumberOfSymbols: maxSymbols })

let attempts = 0
async function decodeGray(gray, w, h, tryHarder) {
  attempts++
  const res = await readBarcodes({ data: grayToRgba(gray), width: w, height: h }, baseOptions(tryHarder))
  return { ok: res.filter((r) => r.isValid), located: res.filter((r) => !r.isValid) }
}

function bbox(r) {
  const p = r.position
  const xs = [p.topLeft.x, p.topRight.x, p.bottomRight.x, p.bottomLeft.x]
  const ys = [p.topLeft.y, p.topRight.y, p.bottomRight.y, p.bottomLeft.y]
  const x = Math.min(...xs)
  const y = Math.min(...ys)
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y }
}

/**
 * 對一張灰階圖跑「原圖 → 膨脹階梯」；回傳第一個成功的標籤與結果。
 */
async function decodeWithDotted(gray, w, h, tryHarder, kernels, hat = 0) {
  let r = await decodeGray(gray, w, h, tryHarder)
  if (r.ok.length) return { label: 'raw', r }
  const located = r.located
  const scratch = { a: new Uint8Array(w * h), b: new Uint8Array(w * h) }
  for (const polarity of ['dark', 'light']) {
    for (const kernel of kernels) {
      const d = dilateDots(gray, w, h, hat ? { kernel, polarity, hat: hat === 'k' ? kernel : hat } : { kernel, polarity }, scratch)
      r = await decodeGray(d, w, h, tryHarder)
      if (r.ok.length) return { label: `${polarity[0]}${kernel}`, r }
      if (r.located.length) located.push(...r.located)
    }
  }
  return { label: null, r: { ok: [], located } }
}

const files = readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.png')).sort()
let okCount = 0
for (const f of files) {
  const img = loadPng(join(dir, f))
  const fullGray = rgbaToGray(img.data)
  attempts = 0
  const t0 = performance.now()
  let hit = null
  const log = []

  // decodeScale 階梯：每級先整幀（縮到該寬度），沒解出但有 located → 對候選做全解析度裁切再試
  for (const width of ladder) {
    const level = resizeGray(fullGray, img.width, img.height, width || img.width)
    const kernels = kernelsOverride ?? dottedKernels(level.w)
    const first = await decodeWithDotted(level.gray, level.w, level.h, width !== 640, kernels, hatWhole)
    if (first.label) {
      const b = bbox(first.r.ok[0])
      hit = { where: `level${width || 'full'}:${first.label}`, text: first.r.ok[0].text, module: (b.width / 22 / level.scale).toFixed(1), at: `${Math.round(b.x / level.scale)},${Math.round(b.y / level.scale)},${Math.round(b.width / level.scale)}` }
      break
    }
    // zoomToCandidate：每個 located 候選（去重）都試
    const seen = new Set()
    for (const cand of first.r.located) {
      const b = bbox(cand)
      const key = `${Math.round(b.x / 20)},${Math.round(b.y / 20)}`
      if (seen.has(key)) continue
      seen.add(key)
      // 回到全解析度座標，外擴 50%
      const fx = b.x / level.scale
      const fy = b.y / level.scale
      const fw = b.width / level.scale
      const fh = b.height / level.scale
      const pad = Math.max(fw, fh) * 0.5
      const crop = cropGray(fullGray, img.width, img.height, { x: fx - pad, y: fy - pad, width: fw + pad * 2, height: fh + pad * 2 })
      if (crop.w < 40 || crop.h < 40 || crop.w > 2000) continue
      const ck = kernelsOverride ?? dottedKernels(crop.w)
      const z = await decodeWithDotted(crop.gray, crop.w, crop.h, true, ck, hatZoom)
      log.push(`  zoom@level${width || 'full'} cand(${Math.round(fx)},${Math.round(fy)} ${Math.round(fw)}px) crop ${crop.w}x${crop.h} kernels [${ck}] → ${z.label ?? 'x'}`)
      if (z.label) {
        const zb = bbox(z.r.ok[0])
        hit = { where: `zoom@level${width || 'full'}:${z.label}`, text: z.r.ok[0].text, module: (zb.width / 22).toFixed(1), at: `${crop.x + Math.round(zb.x)},${crop.y + Math.round(zb.y)},${Math.round(zb.width)}` }
        break
      }
    }
    if (hit) break
  }

  const ms = performance.now() - t0
  if (hit) okCount++
  console.log(`${basename(f).padEnd(14)} ${(hit ? hit.where : 'FAIL').padEnd(22)} ${hit ? `"${hit.text}"` : ''.padEnd(15)} module≈${hit?.module ?? '-'}px  at(${hit?.at ?? '-'})  attempts=${attempts}  ${ms.toFixed(0)}ms`)
  if (verbose) for (const l of log) console.log(l)
}
console.log(`\n${okCount}/${files.length} decoded`)

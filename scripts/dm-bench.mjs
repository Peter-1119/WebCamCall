// E3：在「已知位置」的裁切（labels.json，oracle ROI）上比較各種前處理 / 解碼方法的逐幀命中率。
// 目的：把「定位」與「解碼」分開量——這裡假設定位完美，看每個方法在 3 px 模組的點陣碼上能解多少。
//
// 用法：node scripts/dm-bench.mjs <framesDir> [--methods base,tophat,dog,...] [--size 160] [--up 1] [--every 1] [--verbose]
import { readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { PNG } from 'pngjs'

const coreDir = resolve(import.meta.dirname, '../packages/core')
const rq = createRequire(join(coreDir, 'package.json'))
const { prepareZXingModule, readBarcodes } = await import(pathToFileURL(rq.resolve('zxing-wasm/reader')).href)
const core = await import(pathToFileURL(join(coreDir, 'dist/index.js')).href)
const { dilateDots, rgbaToGray, grayToRgba, stretchContrast } = core
await prepareZXingModule({ overrides: { wasmBinary: readFileSync(rq.resolve('zxing-wasm/reader/zxing_reader.wasm')) }, fireImmediately: true })

const args = process.argv.slice(2)
const dir = args[0]
const opt = (n, d) => {
  const i = args.indexOf(`--${n}`)
  return i >= 0 ? args[i + 1] : d
}
const verbose = args.includes('--verbose')
const SIZE = Number(opt('size', '160'))
const UP = Number(opt('up', '1'))
const every = Number(opt('every', '1'))
const methodNames = opt('methods', 'base').split(',')

const labels = JSON.parse(readFileSync(join(dir, 'labels.json'), 'utf8'))
const files = readdirSync(dir)
  .filter((f) => f.endsWith('.png') && labels[f] && labels[f].score >= 0.35)
  .sort()
  .filter((_, i) => i % every === 0)

// ---------- 影像工具（灰階 Uint8Array） ----------
function cropGray(img, cx, cy, size) {
  const half = size >> 1
  const out = new Uint8Array(size * size)
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const sx = Math.min(img.w - 1, Math.max(0, cx - half + x))
      const sy = Math.min(img.h - 1, Math.max(0, cy - half + y))
      out[y * size + x] = img.g[sy * img.w + sx]
    }
  return { g: out, w: size, h: size }
}
function upscale(im, f) {
  if (f === 1) return im
  const tw = im.w * f
  const th = im.h * f
  const o = new Uint8Array(tw * th)
  for (let y = 0; y < th; y++) {
    const sy = y / f
    const y0 = Math.min(im.h - 1, sy | 0)
    const y1 = Math.min(im.h - 1, y0 + 1)
    const fy = sy - y0
    for (let x = 0; x < tw; x++) {
      const sx = x / f
      const x0 = Math.min(im.w - 1, sx | 0)
      const x1 = Math.min(im.w - 1, x0 + 1)
      const fx = sx - x0
      o[y * tw + x] = (im.g[y0 * im.w + x0] * (1 - fx) + im.g[y0 * im.w + x1] * fx) * (1 - fy) + (im.g[y1 * im.w + x0] * (1 - fx) + im.g[y1 * im.w + x1] * fx) * fy
    }
  }
  return { g: o, w: tw, h: th }
}
/** 可分離盒狀均值（積分影像），半徑 r */
function boxBlur(g, w, h, r) {
  const tmp = new Float32Array(w * h)
  const out = new Float32Array(w * h)
  for (let y = 0; y < h; y++) {
    let acc = 0
    for (let x = -r; x <= r; x++) acc += g[y * w + Math.min(w - 1, Math.max(0, x))]
    for (let x = 0; x < w; x++) {
      tmp[y * w + x] = acc / (2 * r + 1)
      acc += g[y * w + Math.min(w - 1, x + r + 1)] - g[y * w + Math.max(0, x - r)]
    }
  }
  for (let x = 0; x < w; x++) {
    let acc = 0
    for (let y = -r; y <= r; y++) acc += tmp[Math.min(h - 1, Math.max(0, y)) * w + x]
    for (let y = 0; y < h; y++) {
      out[y * w + x] = acc / (2 * r + 1)
      acc += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x]
    }
  }
  return out
}
/** 灰階 min / max 濾波（van Herk 簡化版：直接視窗掃描，裁切很小所以夠用） */
function minmax(g, w, h, r, isMax) {
  const tmp = new Uint8Array(w * h)
  const out = new Uint8Array(w * h)
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let v = isMax ? 0 : 255
      for (let k = -r; k <= r; k++) {
        const s = g[y * w + Math.min(w - 1, Math.max(0, x + k))]
        v = isMax ? Math.max(v, s) : Math.min(v, s)
      }
      tmp[y * w + x] = v
    }
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let v = isMax ? 0 : 255
      for (let k = -r; k <= r; k++) {
        const s = tmp[Math.min(h - 1, Math.max(0, y + k)) * w + x]
        v = isMax ? Math.max(v, s) : Math.min(v, s)
      }
      out[y * w + x] = v
    }
  return out
}
/** Black-hat：closing(g) − g，把「比周圍暗的小點」抽出來變成亮點；回傳反相後（點為暗）的影像 */
function blackhat(im, r) {
  const closed = minmax(minmax(im.g, im.w, im.h, r, true), im.w, im.h, r, false)
  const o = new Uint8Array(im.w * im.h)
  let max = 1
  for (let i = 0; i < o.length; i++) max = Math.max(max, closed[i] - im.g[i])
  for (let i = 0; i < o.length; i++) o[i] = 255 - Math.round(((closed[i] - im.g[i]) * 255) / max)
  return { g: o, w: im.w, h: im.h }
}
/** Top-hat：g − opening(g)，抽「比周圍亮的小點」 */
function tophat(im, r) {
  const opened = minmax(minmax(im.g, im.w, im.h, r, false), im.w, im.h, r, true)
  const o = new Uint8Array(im.w * im.h)
  let max = 1
  for (let i = 0; i < o.length; i++) max = Math.max(max, im.g[i] - opened[i])
  for (let i = 0; i < o.length; i++) o[i] = 255 - Math.round(((im.g[i] - opened[i]) * 255) / max)
  return { g: o, w: im.w, h: im.h }
}
/** DoG 點濾波：blur(小) − blur(大)，負值（暗點）強化；輸出點為暗 */
function dog(im, r1, r2) {
  const a = boxBlur(im.g, im.w, im.h, r1)
  const b = boxBlur(im.g, im.w, im.h, r2)
  const o = new Uint8Array(im.w * im.h)
  let lo = 0
  for (let i = 0; i < o.length; i++) lo = Math.min(lo, a[i] - b[i])
  for (let i = 0; i < o.length; i++) o[i] = Math.round(Math.min(255, Math.max(0, 255 + ((a[i] - b[i]) * 255) / (-lo || 1))))
  return { g: o, w: im.w, h: im.h }
}
/** Sauvola 局部二值化 */
function sauvola(im, r, k = 0.3) {
  const mean = boxBlur(im.g, im.w, im.h, r)
  const sq = new Float32Array(im.w * im.h)
  for (let i = 0; i < sq.length; i++) sq[i] = im.g[i] * im.g[i]
  const meanSq = boxBlur(sq, im.w, im.h, r)
  const o = new Uint8Array(im.w * im.h)
  for (let i = 0; i < o.length; i++) {
    const sd = Math.sqrt(Math.max(0, meanSq[i] - mean[i] * mean[i]))
    o[i] = im.g[i] < mean[i] * (1 + k * (sd / 128 - 1)) ? 0 : 255
  }
  return { g: o, w: im.w, h: im.h }
}
/** 對比指標：DoG 響應的標準差（點越清楚越大） */
function contrastMetric(im) {
  const a = boxBlur(im.g, im.w, im.h, 1)
  const b = boxBlur(im.g, im.w, im.h, 4)
  let s = 0
  let s2 = 0
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i]
    s += d
    s2 += d * d
  }
  const n = a.length
  return Math.sqrt(s2 / n - (s / n) ** 2)
}

// ---------- 解碼 ----------
const zx = (extra = {}) => ({ formats: ['DataMatrix'], tryHarder: true, tryRotate: true, tryInvert: true, tryDownscale: false, returnErrors: true, maxNumberOfSymbols: 4, ...extra })
async function read(im, extra) {
  const res = await readBarcodes({ data: grayToRgba(im.g), width: im.w, height: im.h }, zx(extra))
  return { ok: res.find((r) => r.isValid), located: res.find((r) => !r.isValid) }
}
const KERNELS = [3, 5, 7, 9, 13, 17]
/** 原圖 + 全部膨脹變體（exhaustive），回傳第一個成功的標籤 */
async function dottedAll(im, extra, kernels = KERNELS) {
  let r = await read(im, extra)
  if (r.ok) return { label: 'raw', ...r }
  let located = r.located
  const scratch = { a: new Uint8Array(im.w * im.h), b: new Uint8Array(im.w * im.h) }
  for (const polarity of ['dark', 'light'])
    for (const kernel of kernels) {
      const d = dilateDots(im.g, im.w, im.h, { kernel, polarity }, scratch)
      r = await read({ g: d, w: im.w, h: im.h }, extra)
      if (r.ok) return { label: `${polarity[0]}${kernel}`, ...r }
      located ||= r.located
    }
  return { label: null, ok: null, located }
}

async function dottedAllHat(im, hat, kernels = KERNELS) {
  let r = await read(im)
  if (r.ok) return { label: 'raw', ...r }
  let located = r.located
  const scratch = { a: new Uint8Array(im.w * im.h), b: new Uint8Array(im.w * im.h) }
  for (const polarity of ['dark', 'light'])
    for (const kernel of kernels) {
      const d = dilateDots(im.g, im.w, im.h, { kernel, polarity, hat: hat === 'k' ? kernel : hat }, scratch)
      r = await read({ g: d, w: im.w, h: im.h })
      if (r.ok) return { label: `${polarity[0]}${kernel}`, ...r }
      located ||= r.located
    }
  return { label: null, ok: null, located }
}

// ---------- 方法表 ----------
const METHODS = {
  // 目前 core 的做法（對比拉伸在 dilateDots 內）
  base: (im) => dottedAll(im),
  // B1：zxing binarizer
  'bin-global': (im) => dottedAll(im, { binarizer: 'GlobalHistogram' }),
  'bin-fixed': (im) => dottedAll(im, { binarizer: 'FixedThreshold' }),
  // B2：形態學去背景（r ≈ 1.5× 模組）
  blackhat: (im) => dottedAll(blackhat(im, 4 * UP)),
  // core 內建的帽濾波（variant.hat）— 應與 blackhat3 等價
  'core-hat3': (im) => dottedAllHat(im, 3 * UP),
  'core-hat2': (im) => dottedAllHat(im, 2 * UP),
  'core-hat4': (im) => dottedAllHat(im, 4 * UP),
  'core-hatk': (im) => dottedAllHat(im, 'k'),
  blackhat3: (im) => dottedAll(blackhat(im, 3 * UP)),
  blackhat5: (im) => dottedAll(blackhat(im, 5 * UP)),
  blackhat6: (im) => dottedAll(blackhat(im, 6 * UP)),
  blackhat8: (im) => dottedAll(blackhat(im, 8 * UP)),
  // black-hat 再 DoG（先去背景再強化點）
  'bh+dog': (im) => dottedAll(dog(blackhat(im, 4 * UP), 1 * UP, 4 * UP)),
  // black-hat 後只跑小核（點陣模組 3 px 時只有 3/5 命中）
  'bh-k35': (im) => dottedAll(blackhat(im, 4 * UP), {}, [3, 5]),
  'bh-k357': (im) => dottedAll(blackhat(im, 4 * UP), {}, [3, 5, 7]),
  tophat: (im) => dottedAll(tophat(im, 4 * UP)),
  // B3：DoG 點濾波
  dog: (im) => dottedAll(dog(im, 1 * UP, 4 * UP)),
  dog13: (im) => dottedAll(dog(im, 1 * UP, 3 * UP)),
  dog16: (im) => dottedAll(dog(im, 1 * UP, 6 * UP)),
  dog02: (im) => dottedAll(dog(im, 0, 2 * UP)),
  // B4：Sauvola
  sauvola: (im) => dottedAll(sauvola(im, 8 * UP)),
  // 只做對比拉伸 + 原圖（不膨脹）— 看膨脹到底貢獻多少
  'no-dilate': async (im) => {
    const r = await read({ g: stretchContrast(im.g), w: im.w, h: im.h })
    return { label: r.ok ? 'raw' : null, ...r }
  },
}

const stats = Object.fromEntries(methodNames.map((m) => [m, { hits: 0, located: 0, ms: 0, labels: {} }]))
const perFrame = []
for (const f of files) {
  const png = PNG.sync.read(readFileSync(join(dir, f)))
  const g = rgbaToGray(new Uint8ClampedArray(png.data.buffer, png.data.byteOffset, png.data.length))
  const img = { g, w: png.width, h: png.height }
  const l = labels[f]
  const crop = upscale(cropGray(img, l.cx, l.cy, SIZE), UP)
  const c = contrastMetric(crop)
  const row = { f, contrast: c }
  for (const m of methodNames) {
    const t0 = performance.now()
    const r = await METHODS[m](crop)
    const ms = performance.now() - t0
    const s = stats[m]
    s.ms += ms
    if (r.ok) {
      s.hits++
      s.labels[r.label] = (s.labels[r.label] ?? 0) + 1
    } else if (r.located) s.located++
    row[m] = r.ok ? `HIT(${r.label})` : r.located ? 'loc' : '-'
  }
  perFrame.push(row)
  if (verbose) console.log(`${f} c=${c.toFixed(1).padStart(5)}  ${methodNames.map((m) => `${m}=${row[m]}`).join('  ')}`)
}

// 對比分佈 × 命中：把幀依對比分成四分位，看各方法在低對比幀的表現
const sorted = [...perFrame].sort((a, b) => a.contrast - b.contrast)
const q = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))].contrast
console.log(`\nframes: ${files.length} (oracle ROI ${SIZE}px ×${UP})   contrast quartiles: ${q(0.25).toFixed(1)} / ${q(0.5).toFixed(1)} / ${q(0.75).toFixed(1)}`)
console.log('method'.padEnd(12), 'hits'.padStart(5), 'rate'.padStart(7), 'loc-only'.padStart(9), 'ms/frame'.padStart(9), '  hits by contrast quartile (low→high)   labels')
for (const m of methodNames) {
  const s = stats[m]
  const byQ = [0, 0, 0, 0]
  for (const r of perFrame) if (r[m].startsWith('HIT')) byQ[Math.min(3, Math.floor((sorted.indexOf(r) / sorted.length) * 4))]++
  console.log(m.padEnd(12), String(s.hits).padStart(5), `${((s.hits / files.length) * 100).toFixed(1)}%`.padStart(7), String(s.located).padStart(9), (s.ms / files.length).toFixed(0).padStart(9), '  ', byQ.join(' / ').padEnd(24), JSON.stringify(s.labels))
}

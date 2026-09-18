// 即時掃描逐幀模擬：把影片抽出的幀（PNG，已縮到相機幀寬）依序餵進與 Scanner 相同的邏輯——
// decodeScale 階梯（ScaleController）+ 每幀一個點陣變體（DottedCycler，成功後 sticky）+ zxing。
// 輸出每幀結果與統計：命中率、首次命中幀、最長空窗、各階梯級距分佈。
//
// 用法：node scripts/sim-live.mjs <framesDir> [--roi 0.1,0.3,0.8,0.4] [--formats DataMatrix] [--fps 15] [--verbose]
import { readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { PNG } from 'pngjs'

const coreDir = resolve(import.meta.dirname, '../packages/core')
const coreRequire = createRequire(join(coreDir, 'package.json'))
const { prepareZXingModule, readBarcodes } = await import(pathToFileURL(coreRequire.resolve('zxing-wasm/reader')).href)
const core = await import(pathToFileURL(join(coreDir, 'dist/index.js')).href)
const { createScaleController, DEFAULT_DECODE_SCALE, dilateDots, rgbaToGray, grayToRgba, kernelFromSymbolWidth } = core

const args = process.argv.slice(2)
const dir = args[0]
if (!dir) {
  console.error('usage: node scripts/sim-live.mjs <framesDir> [--roi x,y,w,h] [--formats DataMatrix] [--fps 15] [--verbose]')
  process.exit(1)
}
const opt = (n, d) => {
  const i = args.indexOf(`--${n}`)
  return i >= 0 ? args[i + 1] : d
}
const verbose = args.includes('--verbose')
const formats = opt('formats', 'DataMatrix').split(',')
const fps = Number(opt('fps', '15'))
const roiArg = opt('roi', null)
const roi = roiArg ? (([x, y, width, height]) => ({ x, y, width, height }))(roiArg.split(',').map(Number)) : null
const dottedOn = formats.includes('DataMatrix')

await prepareZXingModule({ overrides: { wasmBinary: readFileSync(coreRequire.resolve('zxing-wasm/reader/zxing_reader.wasm')) }, fireImmediately: true })

// 與 wasm-worker.ts 相同的 zxing 選項
const zxOptions = (tryHarder, dotted) => ({
  formats,
  tryHarder,
  tryRotate: true,
  tryInvert: true,
  tryDownscale: false,
  returnErrors: true,
  maxNumberOfSymbols: dotted ? 4 : 4,
})

function loadPng(path) {
  const png = PNG.sync.read(readFileSync(path))
  return { data: new Uint8ClampedArray(png.data.buffer, png.data.byteOffset, png.data.length), width: png.width, height: png.height }
}

/** 裁切 + 縮放（雙線性近似：區域平均），模擬 grabber 的 drawImage */
function cropResize(gray, w, h, crop, targetWidth) {
  const scale = targetWidth > 0 && targetWidth < crop.width ? targetWidth / crop.width : 1
  const tw = Math.max(1, Math.round(crop.width * scale))
  const th = Math.max(1, Math.round(crop.height * scale))
  const out = new Uint8Array(tw * th)
  const inv = 1 / scale
  for (let y = 0; y < th; y++) {
    const sy0 = crop.y + y * inv
    const sy1 = Math.min(crop.y + crop.height, sy0 + inv)
    for (let x = 0; x < tw; x++) {
      const sx0 = crop.x + x * inv
      const sx1 = Math.min(crop.x + crop.width, sx0 + inv)
      let acc = 0
      let cnt = 0
      for (let yy = Math.floor(sy0); yy < Math.ceil(sy1); yy++) {
        for (let xx = Math.floor(sx0); xx < Math.ceil(sx1); xx++) {
          acc += gray[Math.min(h - 1, yy) * w + Math.min(w - 1, xx)]
          cnt++
        }
      }
      out[y * tw + x] = cnt ? acc / cnt : 0
    }
  }
  return { gray: out, w: tw, h: th, scale }
}

// 模擬 core 的 DottedCycler（同一份程式碼）
const cycler = core.createDottedCycler ? core.createDottedCycler() : null

const files = readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.png')).sort()
const scale = createScaleController(DEFAULT_DECODE_SCALE, roi)
const rows = []
let scratch = null
let lastText = null
let lastLocatedWidth = null

for (const f of files) {
  const img = loadPng(join(dir, f))
  const gray = rgbaToGray(img.data)
  const imageSize = { width: img.width, height: img.height }
  const plan = scale.plan(imageSize)
  const lv = cropResize(gray, img.width, img.height, plan.crop, plan.targetWidth)
  const tryHarder = plan.level !== 'base'
  const t0 = performance.now()

  let res = await readBarcodes({ data: grayToRgba(lv.gray), width: lv.w, height: lv.h }, zxOptions(tryHarder, false))
  let ok = res.find((r) => r.isValid)
  let variant = null
  let dottedHit = false
  if (!ok && dottedOn && cycler) {
    const hint = lastLocatedWidth !== null ? kernelFromSymbolWidth(lastLocatedWidth * lv.scale) : undefined
    variant = cycler.next(lv.w, hint)
    if (!scratch || scratch.a.length !== lv.w * lv.h) scratch = { a: new Uint8Array(lv.w * lv.h), b: new Uint8Array(lv.w * lv.h) }
    const d = dilateDots(lv.gray, lv.w, lv.h, variant, scratch)
    const second = await readBarcodes({ data: grayToRgba(d), width: lv.w, height: lv.h }, zxOptions(tryHarder, true))
    ok = second.find((r) => r.isValid)
    if (ok) dottedHit = true
    else if (second.length) res = res.concat(second)
  }
  const located = res.find((r) => !r.isValid)
  const ms = performance.now() - t0

  // 回饋（與 scanner.ts 相同）
  if (ok) scale.report('decoded', imageSize)
  else if (located) {
    const p = located.position
    scale.report('located', imageSize, [
      { x: plan.crop.x + p.topLeft.x / lv.scale, y: plan.crop.y + p.topLeft.y / lv.scale },
      { x: plan.crop.x + p.topRight.x / lv.scale, y: plan.crop.y + p.topRight.y / lv.scale },
      { x: plan.crop.x + p.bottomRight.x / lv.scale, y: plan.crop.y + p.bottomRight.y / lv.scale },
      { x: plan.crop.x + p.bottomLeft.x / lv.scale, y: plan.crop.y + p.bottomLeft.y / lv.scale },
    ])
  } else scale.report('none', imageSize)
  if (variant) {
    if (dottedHit) cycler.report(variant, true)
    else if (!ok) cycler.report(variant, false)
  }
  if (ok) lastText = ok.text
  const src = ok ?? located
  if (src) {
    const p = src.position
    lastLocatedWidth = Math.hypot(p.topRight.x - p.topLeft.x, p.topRight.y - p.topLeft.y) / lv.scale
  } else lastLocatedWidth = null

  rows.push({ f, ok: !!ok, text: ok?.text, located: !!located, level: plan.level, hint: lastLocatedWidth ? kernelFromSymbolWidth(lastLocatedWidth * lv.scale) : null, variant: variant ? `${variant.polarity[0]}${variant.kernel}` : '-', dottedHit, ms })
  if (verbose) console.log(`${f}  ${ok ? 'HIT ' : located ? 'loc ' : '    '} level=${String(plan.level).padEnd(4)} ${lv.w}x${lv.h} ${variant ? (dottedHit ? '*' : ' ') + `${variant.polarity[0]}${variant.kernel}` : '   '} ${ms.toFixed(0)}ms ${ok ? ok.text : ''}`)
}

// ---- 統計 ----
const n = rows.length
const hits = rows.filter((r) => r.ok)
const firstHit = rows.findIndex((r) => r.ok)
let maxGap = 0
let gap = 0
for (const r of rows) {
  if (r.ok) {
    maxGap = Math.max(maxGap, gap)
    gap = 0
  } else gap++
}
maxGap = Math.max(maxGap, gap)
const texts = [...new Set(hits.map((r) => r.text))]
const byLevel = {}
for (const r of hits) byLevel[r.level] = (byLevel[r.level] ?? 0) + 1
const byVariant = {}
for (const r of hits.filter((r) => r.dottedHit)) byVariant[r.variant] = (byVariant[r.variant] ?? 0) + 1
const avgMs = rows.reduce((s, r) => s + r.ms, 0) / n
const secs = Math.ceil(n / fps)
const timeline = []
for (let s = 0; s < secs; s++) {
  const slice = rows.slice(s * fps, (s + 1) * fps)
  const h = slice.filter((r) => r.ok).length
  const l = slice.filter((r) => !r.ok && r.located).length
  timeline.push(h === slice.length ? '█' : h > 0 ? '▓' : l > 0 ? '░' : '·')
}

console.log(`\nframes: ${n} (${(n / fps).toFixed(1)}s @${fps}fps)   hits: ${hits.length} (${((hits.length / n) * 100).toFixed(1)}%)   located-only: ${rows.filter((r) => !r.ok && r.located).length}`)
console.log(`first hit: frame ${firstHit} (${(firstHit / fps).toFixed(1)}s)   longest gap without hit: ${maxGap} frames (${(maxGap / fps).toFixed(1)}s)`)
console.log(`texts: ${texts.join(', ')}`)
console.log(`hits by level: ${JSON.stringify(byLevel)}   dotted hits by variant: ${JSON.stringify(byVariant)}   raw hits: ${hits.filter((r) => !r.dottedHit).length}`)
console.log(`avg per-frame decode: ${avgMs.toFixed(1)}ms`)
console.log(`timeline (1 char = 1s; █ all hit, ▓ some hit, ░ located only, · nothing):\n${timeline.join('')}`)

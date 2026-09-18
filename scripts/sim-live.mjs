// 即時掃描逐幀模擬：把影片抽出的幀（PNG，已縮到相機幀寬）依序餵進與 scanner.ts 相同的邏輯——
// ScaleController（階梯 / 候選放大 / 追蹤交替）+ DottedCycler（整幀每幀一個變體）+ 裁切幀多變體 +
// 點密度定位（整幀沒結果時）+ zxing。輸出每幀結果與統計：命中率、首次命中幀、最長空窗、各級距分佈。
//
// 用法：node scripts/sim-live.mjs <framesDir> [--roi 0.1,0.3,0.8,0.4] [--formats DataMatrix] [--fps 15]
//       [--no-track] [--no-locate] [--verbose]
import { readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { PNG } from 'pngjs'

const coreDir = resolve(import.meta.dirname, '../packages/core')
const coreRequire = createRequire(join(coreDir, 'package.json'))
const { prepareZXingModule, readBarcodes } = await import(pathToFileURL(coreRequire.resolve('zxing-wasm/reader')).href)
const core = await import(pathToFileURL(join(coreDir, 'dist/index.js')).href)
const { createScaleController, DEFAULT_DECODE_SCALE, createDottedCycler, dilateDots, locateDotClusters, rgbaToGray, grayToRgba, kernelFromSymbolWidth } = core

const args = process.argv.slice(2)
const dir = args[0]
if (!dir) {
  console.error('usage: node scripts/sim-live.mjs <framesDir> [--roi x,y,w,h] [--formats DataMatrix] [--fps 15] [--no-track] [--no-locate] [--verbose]')
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
const trackOn = dottedOn && !args.includes('--no-track')
const locateOn = dottedOn && !args.includes('--no-locate')
const locateEvery = Number(opt('locate-every', '1')) // 每 N 個整幀跑一次定位（實驗用）
let wholeCount = 0

// 與 scanner.ts 相同的常數
const DOTTED_TRACK_FRAMES = 10
const DOTTED_LOCATE_K = 3
const DOTTED_SYMBOL_PX = 66
const DOTTED_CROP_BUDGET_MS = 40
const DOTTED_INPLACE_MIN_SCALE = 0.75
function cropVariants(symbolWidth) {
  const k = symbolWidth !== undefined ? kernelFromSymbolWidth(symbolWidth) : 3
  const kernels = [...new Set([k, Math.min(17, k + 2), Math.max(3, k - 2)])]
  const out = []
  for (const kernel of kernels) for (const polarity of ['dark', 'light']) out.push({ kernel, polarity, hat: kernel })
  return out
}

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

/** 裁切 + 縮放（區域平均），模擬 grabber 的 drawImage */
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

const toImage = (p, plan, lv) => ({ x: plan.crop.x + p.x / lv.scale, y: plan.crop.y + p.y / lv.scale })
const quadOf = (r, plan, lv) => [toImage(r.position.topLeft, plan, lv), toImage(r.position.topRight, plan, lv), toImage(r.position.bottomRight, plan, lv), toImage(r.position.bottomLeft, plan, lv)]
const quadWidth = (q) => Math.max(q[0].x, q[1].x, q[2].x, q[3].x) - Math.min(q[0].x, q[1].x, q[2].x, q[3].x)

const cycler = createDottedCycler()
const files = readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.png')).sort()
const scale = createScaleController(DEFAULT_DECODE_SCALE, roi, trackOn ? DOTTED_TRACK_FRAMES : 0)
const rows = []
let scratch = null
let lastLocatedWidth = null
const cost = { whole: 0, crop: 0, locate: 0, aux: 0, wholeN: 0, cropN: 0, locateN: 0, auxN: 0 }

for (const f of files) {
  const img = loadPng(join(dir, f))
  const gray = rgbaToGray(img.data)
  const imageSize = { width: img.width, height: img.height }
  const plan = scale.plan(imageSize)
  const isCrop = plan.level === 'zoom'
  const tryHarder = isCrop || plan.level !== 'base'
  const t0 = performance.now()

  // aux（追蹤裁切）先解：原圖 + 帽濾波變體（預算內），命中就不解主幀（與 wasm-worker.ts 相同）
  let ok = null
  let label = null
  let fromAux = false
  let auxMiss = false
  let auxLv = null
  if (plan.aux) {
    auxLv = cropResize(gray, img.width, img.height, plan.aux.crop, 0)
    const an = auxLv.w * auxLv.h
    const as = { a: new Uint8Array(an), b: new Uint8Array(an) }
    const deadline = performance.now() + DOTTED_CROP_BUDGET_MS
    ok = (await readBarcodes({ data: grayToRgba(auxLv.gray), width: auxLv.w, height: auxLv.h }, zxOptions(true, true))).find((r) => r.isValid)
    if (ok) label = 'aux-raw'
    else
      for (const v of cropVariants(plan.aux.symbolWidth)) {
        if (performance.now() > deadline) break
        ok = (await readBarcodes({ data: grayToRgba(dilateDots(auxLv.gray, auxLv.w, auxLv.h, v, as)), width: auxLv.w, height: auxLv.h }, zxOptions(true, true))).find((r) => r.isValid)
        if (ok) {
          label = `aux-${v.polarity[0]}${v.kernel}h`
          break
        }
      }
    if (ok) fromAux = true
    else auxMiss = true
  }
  const auxMs = performance.now() - t0
  cost.aux += auxMs
  cost.auxN += plan.aux ? 1 : 0

  const lv = fromAux ? null : cropResize(gray, img.width, img.height, plan.crop, plan.targetWidth)
  const n = lv ? lv.w * lv.h : 0
  if (lv && (!scratch || scratch.a.length !== n)) scratch = { a: new Uint8Array(n), b: new Uint8Array(n) }

  let res = fromAux ? [] : await readBarcodes({ data: grayToRgba(lv.gray), width: lv.w, height: lv.h }, zxOptions(tryHarder, false))
  if (!fromAux) ok = res.find((r) => r.isValid)
  let variant = null
  if (ok && !fromAux) label = 'raw'
  let dottedHit = false
  if (!ok && dottedOn) {
    // 裁切幀：一組帽濾波變體（預算內）；整幀：輪替器給一個
    const variants = isCrop ? cropVariants(plan.symbolWidth) : [(variant = cycler.next(lv.w, lastLocatedWidth !== null ? kernelFromSymbolWidth(lastLocatedWidth * lv.scale) : undefined))]
    for (const v of variants) {
      if (isCrop && performance.now() - t0 > DOTTED_CROP_BUDGET_MS) break
      const d = dilateDots(lv.gray, lv.w, lv.h, v, scratch)
      const second = await readBarcodes({ data: grayToRgba(d), width: lv.w, height: lv.h }, zxOptions(tryHarder, true))
      ok = second.find((r) => r.isValid)
      if (ok) {
        dottedHit = true
        label = `${v.polarity[0]}${v.kernel}${v.hat ? 'h' : ''}`
        break
      }
      if (second.length) res = res.concat(second)
    }
  }
  const located = res.find((r) => !r.isValid)
  // 點密度定位：整幀、完全沒結果時
  let candidates
  let tLoc = 0
  if (!isCrop && !fromAux) wholeCount++
  if (locateOn && !isCrop && !ok && !located && wholeCount % locateEvery === 0) {
    const t1 = performance.now()
    const window = Math.max(24, Math.round(DOTTED_SYMBOL_PX * lv.scale))
    const side = (2.4 * window) / lv.scale
    const clusters = locateDotClusters(lv.gray, lv.w, lv.h, { k: DOTTED_LOCATE_K, window }, scratch)
    // 解析度夠：直接在這張圖上裁候選再解（與 wasm-worker.ts 的 decodeCandidates 相同）
    if (lv.scale >= DOTTED_INPLACE_MIN_SCALE && clusters.length) {
      const s = Math.min(Math.round(2.4 * window), lv.w, lv.h)
      const cg = new Uint8Array(s * s)
      const cs = { a: new Uint8Array(s * s), b: new Uint8Array(s * s) }
      const deadline = performance.now() + DOTTED_CROP_BUDGET_MS
      outer: for (const c of clusters) {
        const x0 = Math.min(Math.max(0, Math.round(c.cx - s / 2)), lv.w - s)
        const y0 = Math.min(Math.max(0, Math.round(c.cy - s / 2)), lv.h - s)
        for (let y = 0; y < s; y++) cg.set(lv.gray.subarray((y0 + y) * lv.w + x0, (y0 + y) * lv.w + x0 + s), y * s)
        const shift = (r) => ({ ...r, position: Object.fromEntries(Object.entries(r.position).map(([k, p]) => [k, { x: p.x + x0, y: p.y + y0 }])) })
        let r = (await readBarcodes({ data: grayToRgba(cg), width: s, height: s }, zxOptions(true, true))).find((x) => x.isValid)
        if (r) { ok = shift(r); label = 'cand-raw'; break }
        for (const v of cropVariants()) {
          if (performance.now() > deadline) break outer
          r = (await readBarcodes({ data: grayToRgba(dilateDots(cg, s, s, v, cs)), width: s, height: s }, zxOptions(true, true))).find((x) => x.isValid)
          if (r) { ok = shift(r); label = `cand-${v.polarity[0]}${v.kernel}h`; break outer }
        }
      }
    }
    // in-place 試過的候選不再排進下一幀（與 worker 相同）
    candidates = ok || lv.scale >= DOTTED_INPLACE_MIN_SCALE ? undefined : clusters.map((c) => ({
      x: plan.crop.x + c.cx / lv.scale - side / 2,
      y: plan.crop.y + c.cy / lv.scale - side / 2,
      width: side,
      height: side,
    }))
    tLoc = performance.now() - t1
    cost.locate += tLoc
    cost.locateN++
  }
  const ms = performance.now() - t0
  if (!fromAux) {
    if (isCrop) {
      cost.crop += ms - auxMs
      cost.cropN++
    } else {
      cost.whole += ms - tLoc - auxMs
      cost.wholeN++
    }
  }

  // 回饋（與 scanner.ts 相同）；aux 的座標用 aux 的 crop / scale 換算
  const space = fromAux ? { crop: plan.aux.crop } : plan
  const spaceLv = fromAux ? auxLv : lv
  if (ok) scale.report('decoded', imageSize, quadOf(ok, space, spaceLv), undefined, auxMiss)
  else if (located) scale.report('located', imageSize, quadOf(located, space, spaceLv), undefined, auxMiss)
  else scale.report('none', imageSize, undefined, candidates, auxMiss)
  if (variant) {
    if (dottedHit) cycler.report(variant, true)
    else if (!ok) cycler.report(variant, false)
  }
  const src = ok ?? located
  lastLocatedWidth = src ? quadWidth(quadOf(src, space, spaceLv)) : null

  rows.push({ f, ok: !!ok, text: ok?.text, located: !!located, level: plan.level, label, ms })
  if (verbose)
    console.log(
      `${f}  ${ok ? 'HIT ' : located ? 'loc ' : candidates?.length ? 'cand' : '    '} level=${String(plan.level).padEnd(5)}${plan.aux ? '+aux' : '    '} ${lv ? `${String(lv.w).padStart(4)}x${String(lv.h).padEnd(4)}` : '         '} ${(label ?? '').padEnd(9)} ${ms.toFixed(0).padStart(4)}ms ${ok ? ok.text : ''}`,
    )
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
const byLabel = {}
for (const r of hits) byLabel[r.label] = (byLabel[r.label] ?? 0) + 1
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
console.log(`hits by level: ${JSON.stringify(byLevel)}   by variant: ${JSON.stringify(byLabel)}`)
console.log(
  `avg cost: whole-frame ${(cost.whole / Math.max(1, cost.wholeN)).toFixed(1)}ms ×${cost.wholeN}   zoom ${(cost.crop / Math.max(1, cost.cropN)).toFixed(1)}ms ×${cost.cropN}   locate ${(cost.locate / Math.max(1, cost.locateN)).toFixed(1)}ms ×${cost.locateN}   aux ${(cost.aux / Math.max(1, cost.auxN)).toFixed(1)}ms ×${cost.auxN}   (Node JS，無 SIMD；瀏覽器數字要實機量)`,
)
console.log(`timeline (1 char = 1s; █ all hit, ▓ some hit, ░ located only, · nothing):\n${timeline.join('')}`)

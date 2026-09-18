// E1：逐幀標註 2DID 位置（半自動）。從一個已知位置的錨點幀開始，用正規化互相關（NCC）
// 逐幀向前 / 向後追蹤，模板每幀更新（相鄰幀變化小，適應旋轉 / 亮度慢變）。
// 輸出 <framesDir>/labels.json：{ "f00118.png": { cx, cy, score }, ... }（score 低表示追丟）。
//
// 用法：node scripts/dm-track.mjs <framesDir> --anchor f00118.png,468,592 [--size 120] [--search 70] [--sheet out.png]
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PNG } from 'pngjs'

const args = process.argv.slice(2)
const dir = args[0]
const opt = (n, d) => {
  const i = args.indexOf(`--${n}`)
  return i >= 0 ? args[i + 1] : d
}
// 可給多個錨點（--anchor 重複）；每幀取「索引距離最近的錨點」追出來的結果，追丟時換一個錨點重來
const anchors = []
for (let i = 0; i < args.length; i++) if (args[i] === '--anchor') anchors.push(args[i + 1].split(','))
if (!dir || anchors.length === 0) {
  console.error('usage: node scripts/dm-track.mjs <framesDir> --anchor <file>,<cx>,<cy> [--anchor ...] [--size 120] [--search 70] [--sheet out.png]')
  process.exit(1)
}
const SIZE = Number(opt('size', '120')) // 模板邊長（含方框）
const SEARCH = Number(opt('search', '70')) // 每幀搜尋半徑
const MIN_SCORE = 0.35 // NCC 低於此視為追丟（不再更新模板，仍記錄最佳位置）
const sheet = opt('sheet', null)

function loadGray(path) {
  const png = PNG.sync.read(readFileSync(path))
  const g = new Float32Array(png.width * png.height)
  for (let i = 0, j = 0; i < g.length; i++, j += 4) g[i] = png.data[j] * 0.299 + png.data[j + 1] * 0.587 + png.data[j + 2] * 0.114
  return { g, w: png.width, h: png.height }
}

function patch(img, cx, cy, size) {
  const half = size >> 1
  const out = new Float32Array(size * size)
  let mean = 0
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const sx = Math.min(img.w - 1, Math.max(0, cx - half + x))
      const sy = Math.min(img.h - 1, Math.max(0, cy - half + y))
      const v = img.g[sy * img.w + sx]
      out[y * size + x] = v
      mean += v
    }
  mean /= out.length
  let norm = 0
  for (let i = 0; i < out.length; i++) {
    out[i] -= mean
    norm += out[i] * out[i]
  }
  norm = Math.sqrt(norm) || 1
  for (let i = 0; i < out.length; i++) out[i] /= norm
  return out
}

/** 在 (cx,cy) ± search 範圍內找 NCC 最大的位置（步長 2 粗搜 → 步長 1 細搜） */
function track(img, tpl, cx, cy) {
  const size = Math.sqrt(tpl.length)
  let best = { cx, cy, score: -1 }
  const half = size >> 1
  const evalAt = (x, y) => {
    if (x < half || y < half || x > img.w - half || y > img.h - half) return -1 // 出界不追（碼離開畫面）
    const p = patch(img, x, y, size)
    let s = 0
    for (let i = 0; i < p.length; i++) s += p[i] * tpl[i]
    return s
  }
  for (let dy = -SEARCH; dy <= SEARCH; dy += 2)
    for (let dx = -SEARCH; dx <= SEARCH; dx += 2) {
      const s = evalAt(cx + dx, cy + dy)
      if (s > best.score) best = { cx: cx + dx, cy: cy + dy, score: s }
    }
  const c = { ...best }
  for (let dy = -1; dy <= 1; dy++)
    for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue
      const s = evalAt(c.cx + dx, c.cy + dy)
      if (s > best.score) best = { cx: c.cx + dx, cy: c.cy + dy, score: s }
    }
  return best
}

const files = readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.png')).sort()
const anchorIdxs = anchors.map(([f]) => {
  const i = files.indexOf(f)
  if (i < 0) throw new Error(`anchor ${f} not in ${dir}`)
  return i
})
// 每個錨點負責的區間：到相鄰錨點的中點
const owner = (i) => anchorIdxs.reduce((best, a, k) => (Math.abs(i - a) < Math.abs(i - anchorIdxs[best]) ? k : best), 0)
const labels = {}
anchors.forEach(([f, x, y], k) => {
  labels[f] = { cx: Number(x), cy: Number(y), score: 1, anchor: k }
  for (const dirn of [1, -1]) {
    let img = loadGray(join(dir, f))
    let tpl = patch(img, Number(x), Number(y), SIZE)
    let cx = Number(x)
    let cy = Number(y)
    for (let i = anchorIdxs[k] + dirn; i >= 0 && i < files.length && owner(i) === k; i += dirn) {
      img = loadGray(join(dir, files[i]))
      const r = track(img, tpl, cx, cy)
      labels[files[i]] = { ...r, anchor: k }
      if (r.score >= MIN_SCORE) {
        cx = r.cx
        cy = r.cy
        tpl = patch(img, cx, cy, SIZE)
      }
      if (i % 20 === 0) console.log(`${files[i]}  (${r.cx},${r.cy})  ncc=${r.score.toFixed(2)}${r.score < MIN_SCORE ? '  LOST' : ''}`)
    }
  }
})

writeFileSync(join(dir, 'labels.json'), JSON.stringify(labels, null, 1))
const lost = Object.values(labels).filter((l) => l.score < MIN_SCORE).length
console.log(`\nlabels.json written: ${files.length} frames, ${lost} low-confidence`)

// 縮圖總表：每 N 幀一格，肉眼確認追蹤正確
if (sheet) {
  const step = Math.max(1, Math.floor(files.length / 24))
  const picks = files.filter((_, i) => i % step === 0).slice(0, 24)
  const CELL = 160
  const cols = 6
  const rows = Math.ceil(picks.length / cols)
  const out = new PNG({ width: cols * CELL, height: rows * CELL })
  picks.forEach((f, k) => {
    const img = PNG.sync.read(readFileSync(join(dir, f)))
    const l = labels[f]
    const ox = (k % cols) * CELL
    const oy = Math.floor(k / cols) * CELL
    const half = SIZE >> 1
    for (let y = 0; y < CELL; y++)
      for (let x = 0; x < CELL; x++) {
        const sx = Math.min(img.width - 1, Math.max(0, Math.round(l.cx - half + (x * SIZE) / CELL)))
        const sy = Math.min(img.height - 1, Math.max(0, Math.round(l.cy - half + (y * SIZE) / CELL)))
        const i = (sy * img.width + sx) * 4
        const o = ((oy + y) * out.width + ox + x) * 4
        out.data[o] = img.data[i]
        out.data[o + 1] = img.data[i + 1]
        out.data[o + 2] = img.data[i + 2]
        out.data[o + 3] = 255
      }
    // 低信心格子左上角畫紅方塊
    if (l.score < MIN_SCORE)
      for (let y = 0; y < 12; y++)
        for (let x = 0; x < 12; x++) {
          const o = ((oy + y) * out.width + ox + x) * 4
          out.data[o] = 255
          out.data[o + 1] = 0
          out.data[o + 2] = 0
        }
  })
  writeFileSync(sheet, PNG.sync.write(out))
  console.log(`sheet: ${sheet} (${picks.length} cells, every ${step} frames)`)
}

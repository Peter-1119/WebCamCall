// @vitest-environment node
/**
 * 影像品質整合測試：清晰 / 模糊 / 傾斜 / 低光 四組，全部用真的 zxing-wasm 解。
 * 影像在程式裡從 QR 矩陣產生再做退化處理，不依賴外部圖片檔。
 *
 * 只測 wasm 路徑：Node 沒有 BarcodeDetector；native 與 wasm 的一致性在 iPad/Chrome 上以
 * playground 的「解碼圖片檔」對照（見 docs/device-checklist.md）。
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import QRCode from 'qrcode'
import { beforeAll, describe, expect, it } from 'vitest'
import { prepareZXingModule, readBarcodes } from 'zxing-wasm/reader'
import type { ReaderOptions } from 'zxing-wasm/reader'

const require = createRequire(import.meta.url)

interface Raster {
  data: Uint8ClampedArray
  width: number
  height: number
}

const TEXT = 'QUALITY-TEST-2026'

function blank(width: number, height: number, level = 255): Raster {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let i = 0; i < data.length; i += 4) {
    data[i] = data[i + 1] = data[i + 2] = level
    data[i + 3] = 255
  }
  return { data, width, height }
}

/** 乾淨的 QR：每模組 scale px，置中。 */
function clean(size = 320, scale = 6): Raster {
  const qr = QRCode.create(TEXT, { errorCorrectionLevel: 'M' })
  const n = qr.modules.size
  const r = blank(size, size)
  const ox = Math.floor((size - n * scale) / 2)
  const oy = ox
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (!qr.modules.get(y, x)) continue
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const i = ((oy + y * scale + dy) * r.width + (ox + x * scale + dx)) * 4
          r.data[i] = r.data[i + 1] = r.data[i + 2] = 0
        }
      }
    }
  }
  return r
}

/** box blur，radius px。模擬失焦。 */
function blur(src: Raster, radius: number): Raster {
  const { width: w, height: h } = src
  const out = blank(w, h)
  const gray = new Float32Array(w * h)
  for (let i = 0; i < w * h; i++) gray[i] = src.data[i * 4]!
  const tmp = new Float32Array(w * h)
  const k = radius * 2 + 1
  for (let y = 0; y < h; y++) {
    let acc = 0
    for (let x = -radius; x <= radius; x++) acc += gray[y * w + Math.min(w - 1, Math.max(0, x))]!
    for (let x = 0; x < w; x++) {
      tmp[y * w + x] = acc / k
      const outX = Math.max(0, x - radius)
      const inX = Math.min(w - 1, x + radius + 1)
      acc += gray[y * w + inX]! - gray[y * w + outX]!
    }
  }
  for (let x = 0; x < w; x++) {
    let acc = 0
    for (let y = -radius; y <= radius; y++) acc += tmp[Math.min(h - 1, Math.max(0, y)) * w + x]!
    for (let y = 0; y < h; y++) {
      const v = acc / k
      const i = (y * w + x) * 4
      out.data[i] = out.data[i + 1] = out.data[i + 2] = v
      const outY = Math.max(0, y - radius)
      const inY = Math.min(h - 1, y + radius + 1)
      acc += tmp[inY * w + x]! - tmp[outY * w + x]!
    }
  }
  return out
}

/** 繞中心旋轉（最近鄰），模擬傾斜。 */
function rotate(src: Raster, degrees: number): Raster {
  const { width: w, height: h } = src
  const out = blank(w, h)
  const rad = (degrees * Math.PI) / 180
  const cos = Math.cos(rad)
  const sin = Math.sin(rad)
  const cx = w / 2
  const cy = h / 2
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = x - cx
      const dy = y - cy
      const sx = Math.round(cx + dx * cos + dy * sin)
      const sy = Math.round(cy - dx * sin + dy * cos)
      if (sx < 0 || sy < 0 || sx >= w || sy >= h) continue
      const si = (sy * w + sx) * 4
      const di = (y * w + x) * 4
      out.data[di] = out.data[di + 1] = out.data[di + 2] = src.data[si]!
    }
  }
  return out
}

/** 低光：把亮度壓到 [floor, floor+range]，再加雜訊。 */
function dim(src: Raster, floor: number, range: number, noise: number, seed = 1): Raster {
  const out = blank(src.width, src.height)
  let s = seed
  const rnd = () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff
    return s / 0x7fffffff
  }
  for (let i = 0; i < src.data.length; i += 4) {
    const v = floor + (src.data[i]! / 255) * range + (rnd() - 0.5) * noise
    const c = Math.max(0, Math.min(255, Math.round(v)))
    out.data[i] = out.data[i + 1] = out.data[i + 2] = c
  }
  return out
}

const options: ReaderOptions = {
  formats: ['QRCode'],
  tryHarder: true,
  tryRotate: true,
  tryInvert: true,
  tryDownscale: false,
  returnErrors: true,
  maxNumberOfSymbols: 1,
}

async function decode(r: Raster) {
  const res = await readBarcodes(r as unknown as ImageData, options)
  return res.find((x) => x.isValid)
}

beforeAll(async () => {
  const wasmBinary = readFileSync(require.resolve('zxing-wasm/reader/zxing_reader.wasm'))
  await prepareZXingModule({ overrides: { wasmBinary }, fireImmediately: true })
}, 60000)

describe('image quality (wasm)', () => {
  it('clear', async () => {
    expect((await decode(clean()))?.text).toBe(TEXT)
  })

  it('blurry: 2px box blur on 6px modules still decodes', async () => {
    expect((await decode(blur(clean(), 2)))?.text).toBe(TEXT)
  })

  it('blurry beyond the module size fails cleanly (no crash, no false positive)', async () => {
    const res = await decode(blur(clean(320, 4), 6))
    expect(res === undefined || res.text === TEXT).toBe(true)
  })

  it('tilted: 20° and 37° rotations decode', async () => {
    expect((await decode(rotate(clean(), 20)))?.text).toBe(TEXT)
    expect((await decode(rotate(clean(), 37)))?.text).toBe(TEXT)
  })

  it('low light: dark range with noise decodes', async () => {
    // 亮度 20..90（對比只有 70 級）+ ±20 雜訊
    expect((await decode(dim(clean(), 20, 70, 40)))?.text).toBe(TEXT)
  })

  it('low light + tilt combined', async () => {
    expect((await decode(dim(rotate(clean(), 15), 30, 80, 30)))?.text).toBe(TEXT)
  })

  it('inverted (white on black) decodes thanks to tryInvert', async () => {
    const r = clean()
    for (let i = 0; i < r.data.length; i += 4) r.data[i] = r.data[i + 1] = r.data[i + 2] = 255 - r.data[i]!
    expect((await decode(r))?.text).toBe(TEXT)
  })
})

// @vitest-environment node
/**
 * 用真的 zxing-wasm 跑：驗證我們送的 ReaderOptions、格式對照、position 的角點語意。
 * QR 用 `qrcode` 在程式裡產生（純 JS，不需 canvas），不依賴外部圖片。
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import QRCode from 'qrcode'
import { beforeAll, describe, expect, it } from 'vitest'
import { prepareZXingModule, readBarcodes } from 'zxing-wasm/reader'
import type { ReaderOptions } from 'zxing-wasm/reader'
import { fromZxingFormat, toZxingFormats } from './format-map'

const require = createRequire(import.meta.url)
const wasmPath = require.resolve('zxing-wasm/reader/zxing_reader.wasm')

interface Raster {
  data: Uint8ClampedArray
  width: number
  height: number
}

function blank(width: number, height: number): Raster {
  const data = new Uint8ClampedArray(width * height * 4).fill(255)
  return { data, width, height }
}

/** 把 QR 模組矩陣畫進 raster，每模組 `scale` px，左上角在 (ox, oy)。回傳模組數。 */
function paintQr(r: Raster, text: string, ox: number, oy: number, scale: number): number {
  const qr = QRCode.create(text, { errorCorrectionLevel: 'M' })
  const n = qr.modules.size
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (!qr.modules.get(y, x)) continue
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const i = ((oy + y * scale + dy) * r.width + (ox + x * scale + dx)) * 4
          r.data[i] = 0
          r.data[i + 1] = 0
          r.data[i + 2] = 0
        }
      }
    }
  }
  return n
}

/** 與 wasm-worker.ts 相同的選項（測的就是這組設定）。 */
function options(formats: string[], multi: boolean, tryHarder = false): ReaderOptions {
  return {
    formats: formats as NonNullable<ReaderOptions['formats']>,
    tryHarder,
    tryRotate: true,
    tryInvert: true,
    tryDownscale: false,
    returnErrors: true,
    maxNumberOfSymbols: multi ? 255 : 3,
  }
}

beforeAll(async () => {
  // Node 沒有可用的 fetch(file path)：直接把 binary 餵給 Emscripten
  const wasmBinary = readFileSync(wasmPath)
  await prepareZXingModule({ overrides: { wasmBinary }, fireImmediately: true })
}, 60000)

describe('zxing-wasm integration (QR)', () => {
  it('decodes a QR and reports corners at the symbol bounds', async () => {
    const r = blank(400, 400)
    const scale = 6
    const n = paintQr(r, 'hello scanner', 60, 80, scale)
    const [res] = await readBarcodes(r as unknown as ImageData, options(toZxingFormats(['qr_code']), false))
    expect(res?.isValid).toBe(true)
    expect(res?.text).toBe('hello scanner')
    expect(fromZxingFormat(res!.format)).toBe('qr_code')
    // zxing 的 position 指的是 finder pattern 的中心附近到符號邊界；容許半個模組誤差
    const tol = scale
    expect(res!.position.topLeft.x).toBeGreaterThan(60 - tol)
    expect(res!.position.topLeft.x).toBeLessThan(60 + scale * 4)
    expect(res!.position.topLeft.y).toBeGreaterThan(80 - tol)
    expect(res!.position.bottomRight.x).toBeLessThan(60 + n * scale + tol)
    expect(res!.position.bottomRight.y).toBeLessThan(80 + n * scale + tol)
    expect(res!.position.topRight.x).toBeGreaterThan(res!.position.topLeft.x)
    expect(res!.position.bottomLeft.y).toBeGreaterThan(res!.position.topLeft.y)
  })

  it('returns bytes for the raw payload', async () => {
    const r = blank(300, 300)
    paintQr(r, 'ABC', 40, 40, 6)
    const [res] = await readBarcodes(r as unknown as ImageData, options(['QRCode'], false))
    expect(Array.from(res!.bytes)).toEqual([65, 66, 67])
  })

  it('multi: decodes two codes in one image', async () => {
    const r = blank(700, 400)
    paintQr(r, 'left', 40, 60, 5)
    paintQr(r, 'right', 380, 60, 5)
    const res = await readBarcodes(r as unknown as ImageData, options(['QRCode'], true))
    expect(res.filter((x) => x.isValid).map((x) => x.text).sort()).toEqual(['left', 'right'])
  })

  it('blank image → no results', async () => {
    const res = await readBarcodes(blank(200, 200) as unknown as ImageData, options(['QRCode'], false))
    expect(res.filter((x) => x.isValid)).toEqual([])
  })

  it('format filter: a QR is not reported when only EAN13 is requested', async () => {
    const r = blank(300, 300)
    paintQr(r, 'x', 40, 40, 6)
    const res = await readBarcodes(r as unknown as ImageData, options(toZxingFormats(['ean_13']), false))
    expect(res.filter((x) => x.isValid)).toEqual([])
  })

  it('small code (2 px per module) still decodes with tryHarder', async () => {
    const r = blank(300, 300)
    paintQr(r, 'tiny', 100, 100, 2)
    const res = await readBarcodes(r as unknown as ImageData, options(['QRCode'], false, true))
    expect(res[0]?.text).toBe('tiny')
  })
})

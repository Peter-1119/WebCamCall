// @vitest-environment node
/**
 * 點陣式 Data Matrix（PCB 鑽孔 / 雷刻 DPM）：
 * 用 zxing writer 產生 DM 矩陣 → 每個模組畫成小圓點 → 驗證「原圖解不出、膨脹後解得出」。
 * 這對應實機 PCB 照片的結果（原圖 0/3，膨脹核 ≈ 模組大小 3/3）。
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { beforeAll, describe, expect, it } from 'vitest'
import { prepareZXingModule as prepareReader, readBarcodes } from 'zxing-wasm/reader'
import { prepareZXingModule as prepareWriter, writeBarcode } from 'zxing-wasm/writer'
import type { ReaderOptions } from 'zxing-wasm/reader'
import { createDottedCycler, dilateDots, dottedKernels, grayToRgba, rgbaToGray } from './morphology'

const require = createRequire(import.meta.url)
const TEXT = '4260708009502'

/** 解析 writer 的 utf8 半格輸出成 0/1 矩陣（每個字元代表上下兩個模組）。 */
function parseUtf8(utf8: string): boolean[][] {
  const lines = utf8.split('\n').filter((l) => l.length > 0)
  const rows: boolean[][] = []
  for (const line of lines) {
    const top: boolean[] = []
    const bottom: boolean[] = []
    for (const ch of line) {
      top.push(ch === '█' || ch === '▀')
      bottom.push(ch === '█' || ch === '▄')
    }
    rows.push(top, bottom)
  }
  return rows
}

/** 把矩陣畫成點陣：每個暗模組 = 直徑 `dotRatio × module` 的圓點；`light` 極性則反轉。 */
function renderDotted(matrix: boolean[][], module: number, dotRatio: number, polarity: 'dark' | 'light', quiet = 4) {
  const n = matrix.length
  const size = (n + quiet * 2) * module
  const bg = polarity === 'dark' ? 230 : 40
  const fg = polarity === 'dark' ? 30 : 220
  const gray = new Uint8Array(size * size).fill(bg)
  const r = (module * dotRatio) / 2
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (!matrix[y]![x]) continue
      const cx = (x + quiet) * module + module / 2
      const cy = (y + quiet) * module + module / 2
      if (dotRatio >= 1) {
        // 實心方格（一般印刷 DM）
        for (let py = 0; py < module; py++) for (let px = 0; px < module; px++) gray[((y + quiet) * module + py) * size + (x + quiet) * module + px] = fg
        continue
      }
      for (let py = Math.floor(cy - r); py <= Math.ceil(cy + r); py++) {
        for (let px = Math.floor(cx - r); px <= Math.ceil(cx + r); px++) {
          if ((px - cx) ** 2 + (py - cy) ** 2 <= r * r) gray[py * size + px] = fg
        }
      }
    }
  }
  return { gray, size }
}

const options: ReaderOptions = {
  formats: ['DataMatrix'],
  tryHarder: true,
  tryRotate: true,
  tryInvert: true,
  tryDownscale: false,
  returnErrors: true,
  maxNumberOfSymbols: 1,
}

async function decodeGray(gray: Uint8Array, size: number) {
  const res = await readBarcodes({ data: grayToRgba(gray), width: size, height: size } as unknown as ImageData, options)
  return res.find((r) => r.isValid)?.text
}

let matrix: boolean[][]

beforeAll(async () => {
  await prepareReader({ overrides: { wasmBinary: readFileSync(require.resolve('zxing-wasm/reader/zxing_reader.wasm')) }, fireImmediately: true })
  await prepareWriter({ overrides: { wasmBinary: readFileSync(require.resolve('zxing-wasm/writer/zxing_writer.wasm')) }, fireImmediately: true })
  const w = await writeBarcode(TEXT, { format: 'DataMatrix', withQuietZones: false })
  matrix = parseUtf8(w.utf8)
  expect(matrix.length).toBeGreaterThan(8)
}, 60000)

describe('dotted Data Matrix (DPM)', () => {
  it('solid modules decode without help (sanity)', async () => {
    const { gray, size } = renderDotted(matrix, 10, 1.0, 'dark')
    expect(await decodeGray(gray, size)).toBe(TEXT)
  })

  it('small dots (55% of module) do NOT decode raw, but decode after dilation with kernel ≈ module', async () => {
    const module = 10
    const { gray, size } = renderDotted(matrix, module, 0.55, 'dark')
    // 原圖：zxing 對點陣無能為力（實機同樣結果）
    expect(await decodeGray(gray, size)).toBeUndefined()
    const dilated = dilateDots(gray, size, size, { kernel: 9, polarity: 'dark' })
    expect(await decodeGray(dilated, size)).toBe(TEXT)
  })

  it('light dots on dark background need the light polarity', async () => {
    const module = 10
    const { gray, size } = renderDotted(matrix, module, 0.55, 'light')
    expect(await decodeGray(gray, size)).toBeUndefined()
    const wrong = dilateDots(gray, size, size, { kernel: 9, polarity: 'dark' })
    expect(await decodeGray(wrong, size)).toBeUndefined()
    const right = dilateDots(gray, size, size, { kernel: 9, polarity: 'light' })
    expect(await decodeGray(right, size)).toBe(TEXT)
  })

  it('kernel ladder covers far / mid / near module sizes', async () => {
    for (const module of [5, 8, 13]) {
      const { gray, size } = renderDotted(matrix, module, 0.55, 'dark')
      let ok = false
      for (const kernel of dottedKernels(640)) {
        if ((await decodeGray(dilateDots(gray, size, size, { kernel, polarity: 'dark' }), size)) === TEXT) {
          ok = true
          break
        }
      }
      expect(ok, `module ${module}px`).toBe(true)
    }
  })

  it('cycler walks dark then light kernels, then sticks to a success', () => {
    const c = createDottedCycler()
    const seen = Array.from({ length: 6 }, () => c.next(640))
    expect(c.next(640)).toEqual({ kernel: 5, polarity: 'light' })
    expect(c.next(640)).toEqual({ kernel: 3, polarity: 'light' })
    expect(seen.map((v) => `${v.polarity}${v.kernel}`)).toEqual(['dark5', 'dark3', 'dark9', 'dark7', 'dark13', 'dark17'])
    c.report(seen[1]!, true)
    expect(c.next(640)).toEqual(seen[1])
    for (let i = 0; i < 6; i++) c.report(seen[1]!, false)
    expect(c.next(640)).not.toEqual(seen[1]) // 放掉，重新輪替
  })

  it('rgba/gray conversions round-trip and kernels scale with width', () => {
    const rgba = new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 255])
    const g = rgbaToGray(rgba)
    expect(Array.from(g)).toEqual([255, 0])
    expect(Array.from(grayToRgba(g))).toEqual([255, 255, 255, 255, 0, 0, 0, 255])
    // 絕對值，與寬度無關
    expect(dottedKernels(640)).toEqual([5, 3, 9, 7, 13, 17])
    expect(dottedKernels(3024)).toEqual([5, 3, 9, 7, 13, 17])
  })
})

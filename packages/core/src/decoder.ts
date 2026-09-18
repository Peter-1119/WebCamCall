import type { GrabbedFrame } from './camera/frame-grabber'
import { dottedKernels } from './decoder/morphology'
import type { DottedVariant } from './decoder/morphology'
import type { DecodedSymbol, DecodeOutput } from './decoder/port'
import { createDecoderPort, selectBackend } from './decoder/select'
import { expandRect, pickClosest, quadBounds } from './geometry'
import { resolveOptions } from './options'
import type { CreateDecoder, DecodedResult, Rect } from './types'

/** 拍照模式的搜尋預算（毫秒）。到期後回傳目前為止的結果（可能是空陣列），不會 reject。 */
const DEFAULT_BUDGET_MS = 3000
/**
 * 多尺度階梯：實測（17 張 PCB 照片）命中多在 960 / 1280，所以先試這兩級。
 * 整張圖最大只到 1920：12 MP 原圖整張跑 12 個變體要好幾秒，原尺寸只用在候選裁切。
 */
const PHOTO_LADDER = [960, 1280, 640, 1920]
/** 候選裁切最大寬度：假候選可能框到一大塊板子，原尺寸跑 12 個變體要好幾秒。 */
const MAX_CROP_WIDTH = 1200

/**
 * 單張影像解碼（「拍照模式」）。與 Scanner 共用後端與座標換算，但沒有每幀預算，所以做得比即時掃描多：
 *
 * 1. **多尺度**：整張圖依 {@link PHOTO_LADDER} 縮放後各解一次（大圖直接解又慢又容易被假候選搶走）
 * 2. **候選裁切**：任何一級回報「找到位置但解不出」時，對候選周圍做**原尺寸**裁切再解
 * 3. **點陣變體**：`dotted` 開啟時，每個尺度 / 裁切都把膨脹核 × 極性全部試過
 *
 * 全部受 3 秒預算限制；一般印刷碼第一級就解出（< 100 ms），只有難的點陣碼才會用滿。
 * 即時掃描（Scanner）**不走**這條路，每幀仍只做一個變體，不影響一般流程的速度。
 */
export const createDecoder: CreateDecoder = async (options = {}) => {
  const opts = resolveOptions(options)
  const backend = await selectBackend(opts.backend, opts.formats)
  const port = await createDecoderPort(backend, opts.formats, opts.wasm)
  const dottedEnabled = (opts.dotted === 'auto' ? opts.formats.includes('data_matrix') : opts.dotted) && backend === 'wasm'
  let frameId = 0

  /** 所有點陣變體，一次交給 Worker 在同一份像素上依序試（像素只讀回一次）。 */
  const allVariants: DottedVariant[] = []
  if (dottedEnabled) for (const polarity of ['dark', 'light'] as const) for (const kernel of dottedKernels()) allVariants.push({ kernel, polarity })

  const request = (maxMs: number) => ({ formats: opts.formats, multi: opts.multi, tryHarder: true, dotted: allVariants, maxMs })

  /** 對一個區域（crop，原圖座標）以目標寬度解一次。bitmap 由這裡建立、port 負責關閉。 */
  async function decodeRegion(source: ImageBitmap, crop: Rect, targetWidth: number, timestamp: number, maxMs: number): Promise<DecodeOutput> {
    const scale = targetWidth > 0 && targetWidth < crop.width ? targetWidth / crop.width : 1
    const bitmap = await createImageBitmap(source, crop.x, crop.y, crop.width, crop.height, {
      resizeWidth: Math.max(1, Math.round(crop.width * scale)),
      resizeHeight: Math.max(1, Math.round(crop.height * scale)),
      resizeQuality: 'high', // 實測平滑縮放比最近鄰好（11/17 vs 9/17）
    })
    const frame: GrabbedFrame = {
      bitmap,
      crop,
      scale: bitmap.width / crop.width,
      imageSize: { width: source.width, height: source.height },
      frameId: frameId++,
      timestamp,
    }
    return port.decode(frame, request(maxMs))
  }

  return {
    backend,
    async decode(source, { budgetMs = DEFAULT_BUDGET_MS }: { budgetMs?: number } = {}) {
      const full = await createImageBitmap(source)
      const imageSize = { width: full.width, height: full.height }
      const fullRect: Rect = { x: 0, y: 0, width: full.width, height: full.height }
      const timestamp = performance.now()
      const deadline = timestamp + budgetMs
      const overBudget = () => performance.now() > deadline
      const remaining = () => Math.max(0, deadline - performance.now())

      let results: readonly DecodedSymbol[] = []
      const tried = new Set<string>()

      try {
        outer: for (const width of PHOTO_LADDER) {
          if (width >= full.width && width !== PHOTO_LADDER[0]) continue // 比原圖大的級距沒意義（但至少跑一級）
          if (overBudget()) break
          const out = await decodeRegion(full, fullRect, width, timestamp, remaining())
          if (out.results.length) {
            results = out.results
            break
          }
          // 候選裁切：對每個「找到位置但解不出」的區域做原尺寸局部解碼（去重）
          for (const quad of out.located) {
            const rect = expandRect(quadBounds(quad), 0.5, fullRect)
            const key = `${Math.round(rect.x / 20)},${Math.round(rect.y / 20)}`
            if (tried.has(key) || rect.width < 40 || rect.height < 40) continue
            tried.add(key)
            if (overBudget()) break outer
            const z = await decodeRegion(full, rect, Math.min(rect.width, MAX_CROP_WIDTH), timestamp, remaining())
            if (z.results.length) {
              results = z.results
              break outer
            }
          }
        }
      } finally {
        full.close()
      }

      if (!opts.multi && results.length > 1) {
        const r = pickClosest(results, (x) => x.quad, { x: imageSize.width / 2, y: imageSize.height / 2 })
        results = r ? [r] : []
      }
      return results.map(
        (s): DecodedResult => ({
          text: s.text,
          format: s.format,
          quad: s.quad,
          rawBytes: s.rawBytes,
          imageSize,
          frameId,
          timestamp,
          backend,
        }),
      )
    },
    dispose: () => port.dispose(),
  }
}

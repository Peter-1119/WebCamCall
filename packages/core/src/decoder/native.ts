import type { GrabbedFrame } from '../camera/frame-grabber'
import { createDecoderError, createUnsupportedBackendError, createUnsupportedFormatError } from '../errors'
import { rectToQuad, toImageSpace } from '../geometry'
import { getBarcodeDetector } from '../support'
import type { NativeDetectedBarcode } from '../support'
import type { BarcodeFormat, Quad } from '../types'
import { fromNativeFormat, toNativeFormats } from './format-map'
import type { DecodedSymbol, DecodeOutput, DecoderPort, DecodeRequest } from './port'

function cornersToQuad(r: NativeDetectedBarcode): Quad<'image'> {
  const c = r.cornerPoints
  // 規格是 4 點、順時針從左上開始；實作若給不足 4 點就退回 boundingBox
  if (c.length === 4) return [c[0]!, c[1]!, c[2]!, c[3]!]
  const b = r.boundingBox
  return rectToQuad({ x: b.x, y: b.y, width: b.width, height: b.height })
}

/**
 * BarcodeDetector 後端。跑在主執行緒（API 本身是非同步的，瀏覽器內部會用自己的執行緒）。
 * `detect()` 直接吃 ImageBitmap，沒有像素讀回。
 *
 * 限制（規格層面）：
 * - 沒有 raw bytes（`rawBytes` 一律 `null`）
 * - 不回報「找到位置但解不出」（`located` 一律空），所以 `zoomToCandidate` 對它無效
 * - 格式改變要重建 detector（`request.formats` 與建立時不同會重建一次）
 */
export async function createNativeDecoder(formats: readonly BarcodeFormat[]): Promise<DecoderPort> {
  const maybe = getBarcodeDetector()
  if (!maybe) throw createUnsupportedBackendError('native')
  const Detector = maybe

  let supported: readonly string[]
  try {
    supported = await Detector.getSupportedFormats()
  } catch (err) {
    throw createDecoderError('decoder-init-failed', 'native', false, err)
  }
  if (supported.length === 0) throw createUnsupportedBackendError('native')

  const known = new Set(supported)
  const usable = toNativeFormats(formats, supported)
  if (usable.length !== formats.length) {
    throw createUnsupportedFormatError('native', formats.filter((f) => !known.has(f)))
  }

  let currentFormats = usable
  let detector = new Detector({ formats: usable })

  async function decode(frame: GrabbedFrame, request: DecodeRequest): Promise<DecodeOutput> {
    if (request.formats !== currentFormats && !sameSet(request.formats, currentFormats)) {
      currentFormats = toNativeFormats(request.formats, supported)
      detector = new Detector({ formats: currentFormats })
    }
    const t0 = performance.now()
    let raw: readonly NativeDetectedBarcode[]
    try {
      raw = await detector.detect(frame.bitmap)
    } catch {
      raw = []
    } finally {
      frame.bitmap.close()
    }
    const results: DecodedSymbol[] = []
    for (const r of raw) {
      const format = fromNativeFormat(r.format, known)
      if (!format) continue
      results.push({ text: r.rawValue, format, quad: toImageSpace(cornersToQuad(r), frame.crop, frame.scale), rawBytes: null })
      if (!request.multi) break
    }
    return { results, located: [], decodeMs: performance.now() - t0 }
  }

  return {
    backend: 'native',
    decode,
    async dispose() {
      /* BarcodeDetector 沒有資源要釋放 */
    },
  }
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x) => b.includes(x))
}

import type { GrabbedFrame } from './camera/frame-grabber'
import { createDecoderPort, selectBackend } from './decoder/select'
import { dottedKernels } from './decoder/morphology'
import type { DottedVariant } from './decoder/morphology'
import { pickClosest } from './geometry'
import { resolveOptions } from './options'
import type { CreateDecoder, DecodedResult } from './types'

/**
 * 單張影像解碼。與 Scanner 共用後端與座標換算；沒有 ROI / debounce / 節流。
 * 用途：上傳圖片、整合測試。
 */
export const createDecoder: CreateDecoder = async (options = {}) => {
  const opts = resolveOptions(options)
  const backend = await selectBackend(opts.backend, opts.formats)
  const port = await createDecoderPort(backend, opts.formats, opts.wasm)
  let frameId = 0

  return {
    backend,
    async decode(source) {
      const bitmap = await createImageBitmap(source)
      const imageSize = { width: bitmap.width, height: bitmap.height }
      const frame: GrabbedFrame = {
        bitmap,
        crop: { x: 0, y: 0, width: bitmap.width, height: bitmap.height },
        scale: 1,
        imageSize,
        frameId: frameId++,
        timestamp: performance.now(),
      }
      // 單張圖片沒有每幀預算：正常解不出就把所有點陣膨脹變體都試過
      const dotted = opts.dotted === 'auto' ? opts.formats.includes('data_matrix') : opts.dotted
      const variants: Array<DottedVariant | null> = [null]
      if (dotted && backend === 'wasm') {
        for (const polarity of ['dark', 'light'] as const) for (const kernel of dottedKernels(bitmap.width)) variants.push({ kernel, polarity })
      }
      let out = await port.decode(frame, { formats: opts.formats, multi: opts.multi, tryHarder: true, dotted: variants[1] ?? null })
      for (let i = 2; i < variants.length && out.results.length === 0; i++) {
        const again = await createImageBitmap(source)
        out = await port.decode({ ...frame, bitmap: again }, { formats: opts.formats, multi: opts.multi, tryHarder: true, dotted: variants[i]! })
      }
      let results = out.results
      if (!opts.multi) {
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
          frameId: frame.frameId,
          timestamp: frame.timestamp,
          backend,
        }),
      )
    },
    dispose: () => port.dispose(),
  }
}

import type { GrabbedFrame } from './camera/frame-grabber'
import { createDecoderPort, selectBackend } from './decoder/select'
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
      const out = await port.decode(frame, { formats: opts.formats, multi: opts.multi, tryHarder: true })
      return out.results.map(
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

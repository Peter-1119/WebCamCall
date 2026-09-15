import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GrabbedFrame } from '../camera/frame-grabber'
import { createNativeDecoder } from './native'
import { selectBackend } from './select'

function installDetector(formats: string[] | null, detect = vi.fn(async () => [] as unknown[])) {
  if (formats === null) {
    delete (globalThis as { BarcodeDetector?: unknown }).BarcodeDetector
    return { detect, ctor: null }
  }
  const ctor = vi.fn(function (this: { detect: unknown }) {
    this.detect = detect
  }) as unknown as { new (o?: unknown): unknown; getSupportedFormats: () => Promise<string[]> }
  ctor.getSupportedFormats = vi.fn(async () => formats)
  ;(globalThis as { BarcodeDetector?: unknown }).BarcodeDetector = ctor
  return { detect, ctor }
}

function frame(): GrabbedFrame {
  return {
    bitmap: { width: 640, height: 360, close: vi.fn() } as unknown as ImageBitmap,
    crop: { x: 100, y: 100, width: 1280, height: 720 },
    scale: 0.5,
    imageSize: { width: 1920, height: 1080 },
    frameId: 0,
    timestamp: 0,
  }
}

afterEach(() => {
  delete (globalThis as { BarcodeDetector?: unknown }).BarcodeDetector
  Object.defineProperty(globalThis, 'Worker', { value: class {}, configurable: true })
})

describe('native decoder', () => {
  it('throws unsupported-backend without BarcodeDetector or with zero formats (Windows Chrome)', async () => {
    installDetector(null)
    await expect(createNativeDecoder(['qr_code'])).rejects.toMatchObject({ code: 'unsupported-backend', backend: 'native' })
    installDetector([])
    await expect(createNativeDecoder(['qr_code'])).rejects.toMatchObject({ code: 'unsupported-backend' })
  })

  it('throws unsupported-format listing the missing ones', async () => {
    installDetector(['qr_code', 'ean_13'])
    await expect(createNativeDecoder(['qr_code', 'micro_qr', 'databar'])).rejects.toMatchObject({
      code: 'unsupported-format',
      backend: 'native',
      formats: ['micro_qr', 'databar'],
    })
  })

  it('maps cornerPoints through crop/scale, closes the bitmap, no rawBytes', async () => {
    const { detect } = installDetector(['qr_code'])
    detect.mockResolvedValueOnce([
      {
        rawValue: 'hi',
        format: 'qr_code',
        cornerPoints: [{ x: 10, y: 10 }, { x: 110, y: 10 }, { x: 110, y: 110 }, { x: 10, y: 110 }],
        boundingBox: { x: 10, y: 10, width: 100, height: 100 },
      },
    ])
    const port = await createNativeDecoder(['qr_code'])
    const f = frame()
    const out = await port.decode(f, { formats: ['qr_code'], multi: false, tryHarder: false })
    expect(f.bitmap.close).toHaveBeenCalled()
    expect(out.located).toEqual([])
    expect(out.results[0]).toMatchObject({ text: 'hi', format: 'qr_code', rawBytes: null })
    expect(out.results[0]!.quad[0]).toEqual({ x: 100 + 10 / 0.5, y: 100 + 10 / 0.5 })
    expect(out.results[0]!.quad[2]).toEqual({ x: 100 + 110 / 0.5, y: 100 + 110 / 0.5 })
  })

  it('a throwing detect() yields an empty frame result', async () => {
    const { detect } = installDetector(['qr_code'])
    detect.mockRejectedValueOnce(new Error('gpu'))
    const port = await createNativeDecoder(['qr_code'])
    expect((await port.decode(frame(), { formats: ['qr_code'], multi: false, tryHarder: false })).results).toEqual([])
  })
})

describe('selectBackend', () => {
  it('auto → native only when every requested format is covered', async () => {
    installDetector(['qr_code', 'ean_13'])
    expect(await selectBackend('auto', ['qr_code'])).toBe('native')
    expect(await selectBackend('auto', ['qr_code', 'micro_qr'])).toBe('wasm')
  })

  it('auto → wasm when BarcodeDetector is absent or empty (iPad Safari / Windows Chrome)', async () => {
    installDetector(null)
    expect(await selectBackend('auto', ['qr_code'])).toBe('wasm')
    installDetector([])
    expect(await selectBackend('auto', ['qr_code'])).toBe('wasm')
  })

  it('forced native fails loudly', async () => {
    installDetector(null)
    await expect(selectBackend('native', ['qr_code'])).rejects.toMatchObject({ code: 'unsupported-backend', backend: 'native' })
    installDetector(['qr_code'])
    await expect(selectBackend('native', ['ean_13'])).rejects.toMatchObject({ code: 'unsupported-format', formats: ['ean_13'] })
  })

  it('wasm unavailable (no Worker) → unsupported-backend wasm', async () => {
    installDetector(null)
    Object.defineProperty(globalThis, 'Worker', { value: undefined, configurable: true })
    await expect(selectBackend('auto', ['qr_code'])).rejects.toMatchObject({ code: 'unsupported-backend', backend: 'wasm' })
  })
})

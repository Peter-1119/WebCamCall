import type { BarcodeFormat, ProbeSupport } from './types'
import { ALL_FORMATS } from './types'

/** 最小化的 BarcodeDetector 型別，避免依賴 lib.dom 之外的宣告（Firefox 沒有此 API）。 */
export interface BarcodeDetectorLike {
  detect(source: ImageBitmapSource): Promise<readonly NativeDetectedBarcode[]>
}
export interface NativeDetectedBarcode {
  readonly rawValue: string
  readonly format: string
  readonly cornerPoints: ReadonlyArray<{ readonly x: number; readonly y: number }>
  readonly boundingBox: DOMRectReadOnly
}
export interface BarcodeDetectorCtor {
  new (options?: { formats?: readonly string[] }): BarcodeDetectorLike
  getSupportedFormats(): Promise<readonly string[]>
}

/** 取得全域 BarcodeDetector（SSR / Firefox 下為 `undefined`）。 */
export function getBarcodeDetector(): BarcodeDetectorCtor | undefined {
  if (typeof globalThis === 'undefined') return undefined
  return (globalThis as { BarcodeDetector?: BarcodeDetectorCtor }).BarcodeDetector
}

const KNOWN = new Set<string>(ALL_FORMATS)

export const probeSupport: ProbeSupport = async () => {
  const hasWindow = typeof window !== 'undefined'
  const nav = typeof navigator !== 'undefined' ? navigator : undefined

  const Detector = getBarcodeDetector()
  let nativeFormats: BarcodeFormat[] = []
  if (Detector) {
    try {
      const raw = await Detector.getSupportedFormats()
      nativeFormats = raw.filter((f): f is BarcodeFormat => KNOWN.has(f))
    } catch {
      // 有建構子但 getSupportedFormats 炸掉：視為不可用
      nativeFormats = []
    }
  }

  return {
    secureContext: hasWindow ? window.isSecureContext === true : false,
    getUserMedia: typeof nav?.mediaDevices?.getUserMedia === 'function',
    native: { present: !!Detector, available: !!Detector && nativeFormats.length > 0, formats: nativeFormats },
    wasm: { available: typeof Worker !== 'undefined' && typeof WebAssembly !== 'undefined' },
    requestVideoFrameCallback:
      hasWindow &&
      typeof HTMLVideoElement !== 'undefined' &&
      'requestVideoFrameCallback' in HTMLVideoElement.prototype,
    offscreenCanvas: typeof OffscreenCanvas !== 'undefined',
  }
}

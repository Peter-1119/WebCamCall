import type { DecodeScaleOptions, ResolvedScannerOptions, ScannerOptions } from './types'

export const DEFAULT_DECODE_SCALE: Required<DecodeScaleOptions> = {
  base: 640,
  ladder: [960, 1280, 0],
  escalateAfterFrames: 5,
  zoomToCandidate: true,
}

/** 套用預設值。所有預設值集中在這裡，TSDoc 上寫的數字以此為準。 */
export function resolveOptions(options: ScannerOptions = {}): ResolvedScannerOptions {
  const camera = options.camera ?? {}
  return {
    formats: options.formats ?? ['qr_code'],
    backend: options.backend ?? 'auto',
    roi: options.roi ?? null,
    decodeScale: { ...DEFAULT_DECODE_SCALE, ...stripUndefined(options.decodeScale ?? {}) },
    debounceFrames: options.debounceFrames ?? 2,
    rescanDelayMs: options.rescanDelayMs ?? 1500,
    targetFps: options.targetFps ?? 15,
    multi: options.multi ?? false,
    emitStats: options.emitStats ?? false,
    dotted: options.dotted ?? 'auto',
    camera: {
      facingMode: camera.facingMode ?? 'environment',
      idealWidth: camera.idealWidth ?? 1920,
      idealHeight: camera.idealHeight ?? 1080,
      preferMainCamera: camera.preferMainCamera ?? true,
      ...(camera.deviceId !== undefined ? { deviceId: camera.deviceId } : {}),
      ...(camera.stream !== undefined ? { stream: camera.stream } : {}),
    },
    wasm: options.wasm ?? {},
  }
}

/** `exactOptionalPropertyTypes` 下 `{ base: undefined }` 會蓋掉預設值，先剔除。 */
function stripUndefined<T extends object>(obj: T): Partial<T> {
  const out: Partial<T> = {}
  for (const k of Object.keys(obj) as (keyof T)[]) {
    if (obj[k] !== undefined) out[k] = obj[k]
  }
  return out
}

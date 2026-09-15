import { createScannerError } from '../errors'
import type { ResolvedScannerOptions, ScannerError } from '../types'

export type ResolvedCameraOptions = ResolvedScannerOptions['camera']

/**
 * getUserMedia 的 fallback 階梯。每一級都比上一級寬鬆：
 *
 * 0. `full`          ：deviceId(exact) 或 facingMode(ideal) + 理想解析度
 * 1. `no-device`     ：丟掉 deviceId 改用 facingMode（deviceId 失效：拔除、iOS 重開機後 id 變動）
 * 2. `no-resolution` ：再丟掉解析度（某些 Android 對非標準 ideal 值會 OverconstrainedError）
 *
 * 只有 `OverconstrainedError` 會往下一級走；權限、無相機等錯誤重試也沒用，直接失敗。
 */
export type ConstraintLevel = 'full' | 'no-device' | 'no-resolution'

export function constraintLadder(camera: ResolvedCameraOptions, deviceId?: string): readonly ConstraintLevel[] {
  const id = deviceId ?? camera.deviceId
  return id ? ['full', 'no-device', 'no-resolution'] : ['full', 'no-resolution']
}

export function buildConstraints(
  camera: ResolvedCameraOptions,
  level: ConstraintLevel,
  deviceId?: string,
): MediaStreamConstraints {
  const id = deviceId ?? camera.deviceId
  const video: MediaTrackConstraints = {}

  if (id && level === 'full') {
    video.deviceId = { exact: id }
  } else {
    // 一律用 ideal 不用 exact：桌機沒有後鏡頭時 exact 會直接失敗；
    // 部分 iPad 對 exact: 'environment' 也有問題（需實機驗證）。
    video.facingMode = { ideal: camera.facingMode }
  }

  if (level !== 'no-resolution') {
    video.width = { ideal: camera.idealWidth }
    video.height = { ideal: camera.idealHeight }
  }

  // focusMode 刻意不放這裡：部分 Android 放進 advanced 會直接 OverconstrainedError。
  // 拿到 track 後查 getCapabilities() 再 applyConstraints（見 controller.ts）。

  return { video, audio: false }
}

/** 判斷這個錯誤是否值得換下一級 constraints 再試。 */
export function isOverconstrained(err: unknown): boolean {
  const name = (err as { name?: unknown } | null)?.name
  return name === 'OverconstrainedError' || name === 'ConstraintNotSatisfiedError'
}

/**
 * DOMException → ScannerError。
 *
 * 名稱對照（含舊版 Chrome / Firefox 的別名）：
 * - NotAllowedError, PermissionDeniedError → permission-denied
 * - SecurityError → permission-denied（recoverable: false，通常是 Permissions-Policy 擋掉）
 * - NotFoundError, DevicesNotFoundError → no-camera
 * - NotReadableError, TrackStartError, AbortError → camera-in-use
 * - OverconstrainedError, ConstraintNotSatisfiedError → constraints-unsatisfiable
 * - TypeError → 非安全上下文（舊瀏覽器在 http 下 mediaDevices 為 undefined 會走到這）
 * - 其他 → camera-failed
 */
export function mapGetUserMediaError(err: unknown): ScannerError {
  const name = (err as { name?: unknown } | null)?.name
  switch (name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
      return createScannerError('permission-denied', { cause: err })
    case 'SecurityError':
      return createScannerError('permission-denied', { recoverable: false, cause: err })
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return createScannerError('no-camera', { cause: err })
    case 'NotReadableError':
    case 'TrackStartError':
    case 'AbortError':
      return createScannerError('camera-in-use', { cause: err })
    case 'OverconstrainedError':
    case 'ConstraintNotSatisfiedError':
      return createScannerError('constraints-unsatisfiable', { cause: err })
    case 'TypeError':
      return typeof window !== 'undefined' && window.isSecureContext
        ? createScannerError('camera-failed', { cause: err })
        : createScannerError('insecure-context', { cause: err })
    default:
      return createScannerError('camera-failed', { cause: err })
  }
}

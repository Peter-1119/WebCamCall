import type {
  CapabilityUnsupportedError,
  DecoderBackend,
  DecoderError,
  ErrorCode,
  InvalidStateError,
  BarcodeFormat,
  ScannerAction,
  ScannerError,
  ScannerState,
  SimpleErrorCode,
  UnsupportedBackendError,
  UnsupportedFormatError,
} from './types'

/**
 * 執行期的 ScannerError 實作。只有一個 class，靠 `code` 與額外欄位區分；
 * 對外型別是 `ScannerError` union（見 types/errors.ts）。
 *
 * `message` 刻意等於 `code`：core 不輸出任何使用者可見文案。
 */
class ScannerErrorImpl extends Error {
  override readonly name = 'ScannerError' as const
  readonly code: ErrorCode
  readonly recoverable: boolean

  constructor(code: ErrorCode, recoverable: boolean, extra: Record<string, unknown>, cause?: unknown) {
    super(code, cause === undefined ? undefined : { cause })
    this.code = code
    this.recoverable = recoverable
    Object.assign(this, extra)
  }
}

/** 各 code 的預設 recoverable，見 types/errors.ts 的表格。 */
const DEFAULT_RECOVERABLE: Record<SimpleErrorCode, boolean> = {
  'insecure-context': false,
  'permission-denied': true,
  'no-camera': false,
  'camera-in-use': true,
  'constraints-unsatisfiable': true,
  'camera-failed': true,
  'track-ended': true,
}

export function createScannerError(
  code: SimpleErrorCode,
  options: { readonly recoverable?: boolean; readonly cause?: unknown } = {},
): ScannerError {
  return new ScannerErrorImpl(
    code,
    options.recoverable ?? DEFAULT_RECOVERABLE[code],
    {},
    options.cause,
  ) as ScannerError
}

export function createUnsupportedFormatError(
  backend: DecoderBackend,
  formats: readonly BarcodeFormat[],
): UnsupportedFormatError {
  return new ScannerErrorImpl('unsupported-format', false, { backend, formats }) as UnsupportedFormatError
}

export function createUnsupportedBackendError(backend: DecoderBackend): UnsupportedBackendError {
  return new ScannerErrorImpl('unsupported-backend', false, { backend }) as UnsupportedBackendError
}

export function createCapabilityError(
  capability: CapabilityUnsupportedError['capability'],
): CapabilityUnsupportedError {
  return new ScannerErrorImpl('capability-unsupported', false, { capability }) as CapabilityUnsupportedError
}

export function createDecoderError(
  code: DecoderError['code'],
  backend: DecoderBackend,
  recoverable: boolean,
  cause?: unknown,
): DecoderError {
  return new ScannerErrorImpl(code, recoverable, { backend }, cause) as DecoderError
}

export function createInvalidStateError(action: ScannerAction, state: ScannerState): InvalidStateError {
  return new ScannerErrorImpl('invalid-state', false, { action, state }) as InvalidStateError
}

/** `instanceof` 的替代：跨 bundle 副本（例如 vue adapter 與 App 各打包一份 core）仍能判斷。 */
export function isScannerError(value: unknown): value is ScannerError {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { name?: unknown }).name === 'ScannerError' &&
    typeof (value as { code?: unknown }).code === 'string'
  )
}

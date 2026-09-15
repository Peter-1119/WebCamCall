import type { BarcodeFormat, DecoderBackend } from './formats'
import type { ScannerAction, ScannerState } from './state'

/**
 * 錯誤代碼。**core 不輸出任何使用者可見文案**，App 依 code 自行對應 i18n 字串。
 *
 * | code                        | 典型 recoverable | 對應的瀏覽器錯誤 / 情境                                   |
 * |-----------------------------|------------------|-----------------------------------------------------------|
 * | `insecure-context`          | false            | 非 HTTPS / localhost，`navigator.mediaDevices` 不存在        |
 * | `permission-denied`         | true             | `NotAllowedError`；使用者可到設定重新允許後 `start()`        |
 * | `no-camera`                 | false            | `NotFoundError` / `enumerateDevices` 無 videoinput           |
 * | `camera-in-use`             | true             | `NotReadableError`；Android 常見於另一個 App 佔用相機        |
 * | `constraints-unsatisfiable` | true             | `OverconstrainedError`；通常是 deviceId 失效，可換鏡頭重試   |
 * | `camera-failed`             | true             | 其他未知的 gUM 錯誤，或 stream 開了但等不到第一幀（timeout）   |
 * | `track-ended`               | true             | track `ended` 且自動恢復失敗；iOS 分頁切換、拔除 USB 相機   |
 * | `decoder-init-failed`       | 視情況           | wasm 下載失敗（可重試）或 BarcodeDetector 建構失敗（不可）   |
 * | `decoder-crashed`           | true             | Worker 在執行期死掉（記憶體不足等），`start()` 會重建        |
 * | `unsupported-backend`       | false            | `backend: 'native'` 但平台沒有 BarcodeDetector               |
 * | `unsupported-format`        | false            | 要求的格式在選定後端不支援                                   |
 * | `capability-unsupported`    | false            | `setTorch()` / `setZoom()` 但 track 不支援                   |
 * | `invalid-state`             | —                | 在非法狀態呼叫方法（同步 throw，不會 emit 事件）             |
 *
 * `recoverable` 的意思是「使用者或 App 做某個動作後再次 `start()` 有機會成功」，
 * 不是「core 會自動重試」。core 自動重試的情況（例如 iOS 切回分頁）
 * 若成功就不會發任何 error。
 */
export type ErrorCode =
  | 'insecure-context'
  | 'permission-denied'
  | 'no-camera'
  | 'camera-in-use'
  | 'constraints-unsatisfiable'
  | 'camera-failed'
  | 'track-ended'
  | 'decoder-init-failed'
  | 'decoder-crashed'
  | 'unsupported-backend'
  | 'unsupported-format'
  | 'capability-unsupported'
  | 'invalid-state'

/**
 * 所有 ScannerError 的共同欄位。實際型別是 {@link ScannerError} 這個 union，
 * 用 `error.code` 窄化後可拿到各 code 專屬的欄位。
 *
 * 繼承 `Error` 是為了保留 stack、能直接被 promise reject、能被 `instanceof` 判斷。
 */
export interface ScannerErrorBase<C extends ErrorCode = ErrorCode> extends Error {
  readonly name: 'ScannerError'
  readonly code: C
  /** 見 {@link ErrorCode} 表格的說明。 */
  readonly recoverable: boolean
  /** 原始的瀏覽器錯誤（`DOMException` 等），除錯用；App 不應依賴其內容。 */
  readonly cause?: unknown
}

/** `unsupported-format`：列出不被支援的格式，以及當時選定的後端。 */
export interface UnsupportedFormatError extends ScannerErrorBase<'unsupported-format'> {
  readonly backend: DecoderBackend
  readonly formats: readonly BarcodeFormat[]
}

/** `unsupported-backend`：被強制指定但不可用的後端。 */
export interface UnsupportedBackendError extends ScannerErrorBase<'unsupported-backend'> {
  readonly backend: DecoderBackend
}

/** `capability-unsupported`：哪個能力不支援。 */
export interface CapabilityUnsupportedError extends ScannerErrorBase<'capability-unsupported'> {
  readonly capability: 'torch' | 'zoom' | 'focusMode'
}

/** `decoder-init-failed` / `decoder-crashed`：哪個後端出事。 */
export interface DecoderError extends ScannerErrorBase<'decoder-init-failed' | 'decoder-crashed'> {
  readonly backend: DecoderBackend
}

/**
 * `invalid-state`：在不允許的狀態呼叫了某方法。
 * 這是唯一**同步 throw** 而非透過事件發出的錯誤，因為它是程式邏輯錯誤。
 */
export interface InvalidStateError extends ScannerErrorBase<'invalid-state'> {
  readonly action: ScannerAction
  readonly state: ScannerState
}

/** 沒有專屬欄位的 code。 */
export type SimpleErrorCode = Exclude<
  ErrorCode,
  | 'unsupported-format'
  | 'unsupported-backend'
  | 'capability-unsupported'
  | 'decoder-init-failed'
  | 'decoder-crashed'
  | 'invalid-state'
>

/**
 * 掃描器錯誤。discriminated union by `code`。
 *
 * @example
 * ```js
 * scanner.on('error', ({ error }) => {
 *   switch (error.code) {
 *     case 'permission-denied':
 *       showHint(t('scanner.permissionDenied'))   // 文案由 App 決定
 *       break
 *     case 'unsupported-format':
 *       console.warn('not supported on', error.backend, error.formats)  // 已窄化
 *       break
 *   }
 * })
 * ```
 */
export type ScannerError =
  | ScannerErrorBase<SimpleErrorCode>
  | UnsupportedFormatError
  | UnsupportedBackendError
  | CapabilityUnsupportedError
  | DecoderError
  | InvalidStateError

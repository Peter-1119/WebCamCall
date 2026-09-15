import type { CameraCapabilities, CameraInfo, CameraSettings } from './capabilities'
import type { ScannerError } from './errors'
import type { BarcodeFormat, DecoderBackend } from './formats'
import type { Quad, Size } from './geometry'
import type { ScannerState } from './state'

/**
 * 成功解碼的結果。
 *
 * 座標一律是原始影像座標系（見 {@link Quad}），要畫到畫面上請用 `toElementSpace()`。
 */
export interface DecodedResult {
  readonly text: string
  readonly format: BarcodeFormat
  /** 影像座標系，左上 → 右上 → 右下 → 左下。 */
  readonly quad: Quad<'image'>
  /**
   * 原始 bytes。**native 後端為 `null`**：`BarcodeDetector` 只提供 `rawValue` 字串。
   * 需要 bytes（例如二進位 QR）請用 `backend: 'wasm'`。
   */
  readonly rawBytes: Uint8Array | null
  /** 產生此結果的那一幀的尺寸，等於 `videoWidth × videoHeight`。 */
  readonly imageSize: Size
  /** 同一幀內的多個結果共用同一個 frameId，多碼掃描時用來分組。 */
  readonly frameId: number
  /** `performance.now()` 時間戳，指幀被擷取的時間點（非解碼完成時間）。 */
  readonly timestamp: number
  readonly backend: DecoderBackend
}

/**
 * 「疑似條碼但尚未確認」。兩種情況都會發這個事件：
 *
 * 1. 解碼器找到了條碼位置但解不出內容（`text` 為 `undefined`）。
 *    目前只有 wasm 路徑會產生；native 的 BarcodeDetector 找不到就什麼都不回。
 * 2. 已解出內容，但 debounce 尚未累積到 `debounceFrames`（`text` 有值，`progress` 顯示進度）。
 *
 * `debounceFrames: 0` 時情況 2 不會出現，解出來直接發 `decoded`。
 */
export interface Candidate {
  readonly quad: Quad<'image'>
  readonly format?: BarcodeFormat
  readonly text?: string
  /** 信心值 `0..1`。**目前兩個後端都不提供**，欄位保留給未來的自訂解碼器。 */
  readonly confidence?: number
  /** debounce 進度；情況 1 時為 `undefined`。 */
  readonly progress?: { readonly seen: number; readonly required: number }
  readonly imageSize: Size
  readonly frameId: number
  readonly timestamp: number
}

/**
 * 效能統計，每秒發一次。開 `options.emitStats` 才會有。
 * Phase 7 的 benchmark 與 UI 的「對不到焦」提示都靠這個。
 */
export interface ScanStats {
  /** 過去一秒實際送進解碼器的幀數。 */
  readonly fps: number
  /** 過去一秒解碼耗時的 p50 / p95（毫秒，Worker 內量測，不含傳輸）。 */
  readonly decodeMs: { readonly p50: number; readonly p95: number }
  /** 過去一秒因為節流或解碼器忙碌而跳過的幀數。 */
  readonly droppedFrames: number
}

/**
 * 掃描器事件。discriminated union by `type`。
 *
 * - `state`     ：狀態轉移。`previous` 讓 UI 能區分「從 paused 回到 scanning」與「剛啟動」。
 * - `candidate` ：見 {@link Candidate}。高頻（每幀可能多個），UI 層要自己節流。
 * - `decoded`   ：見 {@link DecodedResult}。**每個條碼各發一次**，多碼時用 `frameId` 分組。
 * - `error`     ：見 {@link ScannerError}。`start()` 失敗時會同時 emit 此事件並 reject promise。
 * - `camera`    ：鏡頭或其能力/設定改變（啟動、`switchCamera()`、`setTorch()` 後）。
 * - `stats`     ：見 {@link ScanStats}。
 */
export type ScanEvent =
  | { readonly type: 'state'; readonly state: ScannerState; readonly previous: ScannerState }
  | { readonly type: 'candidate'; readonly candidate: Candidate }
  | { readonly type: 'decoded'; readonly result: DecodedResult }
  | { readonly type: 'error'; readonly error: ScannerError }
  | {
      readonly type: 'camera'
      readonly camera: CameraInfo
      readonly capabilities: CameraCapabilities
      readonly settings: CameraSettings
    }
  | { readonly type: 'stats'; readonly stats: ScanStats }

export type ScanEventType = ScanEvent['type']

/** 依 `type` 取出對應的事件型別，`on('decoded', e => e.result)` 就是靠這個窄化。 */
export type ScanEventOf<T extends ScanEventType> = Extract<ScanEvent, { readonly type: T }>

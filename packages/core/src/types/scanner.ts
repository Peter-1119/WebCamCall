import type { CameraCapabilities, CameraInfo, CameraSettings } from './capabilities'
import type { DecodedResult, ScanEvent, ScanEventOf, ScanEventType } from './events'
import type { BarcodeFormat, DecoderBackend } from './formats'
import type { HotUpdatableOptions, ResolvedScannerOptions, ScannerOptions } from './options'
import type { ScannerState } from './state'

/** `switchCamera()` 的目標。 */
export type CameraTarget =
  /** 指定 deviceId。 */
  | string
  /** 依 `listCameras()` 的順序切到下一個。 */
  | 'next'
  /** 依方向切換。 */
  | { readonly facingMode: 'environment' | 'user' }

/**
 * 掃描器主介面。由 `createScanner()` 建立。
 *
 * 所有方法的狀態限制見 `ScannerAction` 旁的表格（`./state.ts`）。
 */
export interface Scanner {
  /** 目前狀態。要即時反應請訂閱 `'state'` 事件。 */
  readonly state: ScannerState
  /** 套用預設值後的設定。 */
  readonly options: ResolvedScannerOptions
  /** 實際選定的後端。`start()` 之前為 `null`。 */
  readonly backend: DecoderBackend | null
  /** 目前使用的鏡頭。未啟動時為 `null`。 */
  readonly camera: CameraInfo | null
  /** 目前 track 的能力。未啟動時為 `null`。**每個欄位使用前都要檢查。** */
  readonly capabilities: CameraCapabilities | null
  /** 目前 track 的設定。未啟動時為 `null`。 */
  readonly settings: CameraSettings | null

  /**
   * 請求相機權限、開啟 stream、初始化解碼器、開始掃描。
   *
   * - 成功：state 變為 `'scanning'` 後 resolve。
   * - 失敗：emit `'error'` 事件**並** reject 同一個 `ScannerError`，state 變為 `'failed'`。
   * - 已在進行中或已在掃描：no-op，回傳同一個 promise。
   *
   * 瀏覽器差異：iOS Safari 要求 `start()` 必須在使用者手勢（click/touch）的
   * call stack 內呼叫，否則 `getUserMedia()` 可能靜默失敗或 `<video>` 不會自動播放。
   * TODO(實機驗證)：iOS 17/18 是否仍有此限制。
   */
  start(): Promise<void>

  /**
   * 停止掃描、停掉所有 track（除非 stream 是外部提供的）、終止 Worker、釋放 `<video>` 的 srcObject。
   * **可重入**：任何狀態下呼叫都不會報錯，重複呼叫是 no-op。
   */
  stop(): Promise<void>

  /** 暫停解碼迴圈，預覽維持。只允許在 `'scanning'` 呼叫。 */
  pause(): void

  /** 恢復解碼迴圈。只允許在 `'paused'` 呼叫。 */
  resume(): void

  /**
   * 列出可用相機。權限取得前 `label` 皆為空字串。
   * 可在任何狀態呼叫；`'idle'` 時呼叫可能會觸發權限對話框（視瀏覽器而定）。
   */
  listCameras(): Promise<readonly CameraInfo[]>

  /**
   * 切換鏡頭。會經過 `'starting'` 再回到 `'scanning'`（或 `'paused'`，維持切換前的狀態）。
   * 切換期間 `capabilities` 會短暫為 `null`。
   */
  switchCamera(target: CameraTarget): Promise<void>

  /**
   * 開關手電筒。不支援時 reject `capability-unsupported`；請先看 `capabilities.torch`。
   * 瀏覽器差異：iOS 上開啟 torch 後切換分頁可能被系統關掉，`settings.torch` 會跟著更新。
   */
  setTorch(on: boolean): Promise<void>

  /** 設定 zoom。不支援時 reject `capability-unsupported`；範圍見 `capabilities.zoom`。 */
  setZoom(value: number): Promise<void>

  /** 熱更新部分設定，不需重啟。見 {@link HotUpdatableOptions}。 */
  updateOptions(patch: HotUpdatableOptions): void

  /**
   * 訂閱單一類型的事件，回傳取消訂閱的函式。
   * listener 的參數型別會依 `type` 自動窄化。
   */
  on<T extends ScanEventType>(type: T, listener: (event: ScanEventOf<T>) => void): () => void

  /** 訂閱所有事件（給 adapter 層與除錯用）。 */
  subscribe(listener: (event: ScanEvent) => void): () => void
}

/**
 * 建立掃描器。**不會**立即請求權限，要等 `start()`。
 *
 * @param video   用來顯示預覽與擷取幀的 `<video>` 元素。core 會設定它的
 *                `srcObject`、`playsInline`、`muted`、`autoplay`；其他樣式由 App 負責。
 *                iOS Safari 要求 `playsInline`，否則會全螢幕播放。
 * @param options 見 {@link ScannerOptions}。
 */
export type CreateScanner = (video: HTMLVideoElement, options?: ScannerOptions) => Scanner

// ---------------------------------------------------------------------------
// 單張影像解碼（不經過相機）
// ---------------------------------------------------------------------------

/** {@link Decoder} 的設定：`ScannerOptions` 中與解碼有關的子集。 */
export type DecoderOptions = Pick<ScannerOptions, 'formats' | 'backend' | 'wasm' | 'multi'>

/**
 * 對單張影像解碼。用途：上傳圖片掃描、Phase 7 的整合測試（餵靜態圖片比對兩個後端）。
 *
 * 與 {@link Scanner} 共用同一套後端與座標換算，但沒有 debounce、ROI、節流。
 */
export interface Decoder {
  readonly backend: DecoderBackend
  /**
   * @param source 任何可畫到 canvas 的來源。座標以該影像的原始尺寸為準。
   * @returns 找到的所有條碼（`multi: false` 時最多一個），找不到回傳空陣列，**不會 reject**。
   */
  decode(source: ImageBitmapSource): Promise<readonly DecodedResult[]>
  /** 釋放 Worker 與 WASM 資源。可重入。 */
  dispose(): Promise<void>
}

/**
 * 建立單張影像解碼器。wasm 路徑下會在此時開始載入 WASM（不等第一次 `decode()`）。
 * 後端不可用或格式不支援時 reject 對應的 `ScannerError`。
 */
export type CreateDecoder = (options?: DecoderOptions) => Promise<Decoder>

// ---------------------------------------------------------------------------
// 能力探測
// ---------------------------------------------------------------------------

/** `probeSupport()` 的結果，讓 App 在 `start()` 之前就能決定 UI 該怎麼呈現。 */
export interface SupportReport {
  /** `window.isSecureContext`。false 時 `getUserMedia` 一定不可用。 */
  readonly secureContext: boolean
  /** `navigator.mediaDevices.getUserMedia` 是否存在。 */
  readonly getUserMedia: boolean
  /**
   * 原生 `BarcodeDetector`。
   * - `present`：建構子存在。
   * - `formats`：`getSupportedFormats()` 回報且我們認得的格式。
   * - `available`：`present && formats.length > 0`。
   *
   * 實機驗證：Windows Chrome 有建構子但 formats 為空；iPad Safari 兩者皆無。
   * 所以判斷可用性一定要看 `available`，不能只看 `'BarcodeDetector' in window`。
   */
  readonly native: {
    readonly present: boolean
    readonly available: boolean
    readonly formats: readonly BarcodeFormat[]
  }
  /** `Worker` 與 `WebAssembly` 是否都存在。 */
  readonly wasm: { readonly available: boolean }
  /** `HTMLVideoElement.prototype.requestVideoFrameCallback` 是否存在。 */
  readonly requestVideoFrameCallback: boolean
  /** `OffscreenCanvas` 是否存在（影響是否能在 Worker 內做裁切）。 */
  readonly offscreenCanvas: boolean
}

/**
 * 探測平台能力。**不會**請求權限、不會下載 WASM。
 * 會呼叫 `BarcodeDetector.getSupportedFormats()`（非同步）。
 */
export type ProbeSupport = () => Promise<SupportReport>

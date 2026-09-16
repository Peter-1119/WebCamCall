import type { BackendPreference, BarcodeFormat } from './formats'
import type { Roi } from './geometry'

/** 相機選擇與 constraints。 */
export interface CameraOptions {
  /**
   * 指定 deviceId（來自 `listCameras()`）。設了就忽略 `facingMode`。
   * deviceId 失效（拔除、iOS 重開機後可能變動）時會以 `constraints-unsatisfiable` 失敗。
   */
  readonly deviceId?: string
  /** 預設 `'environment'`。只是 ideal constraint，桌機沒有後鏡頭時會給前鏡頭。 */
  readonly facingMode?: 'environment' | 'user'
  /**
   * 理想解析度，預設 `1920 × 1080`。是 `ideal` 不是 `exact`，
   * 瀏覽器會給最接近的；實際值看 `settings.resolution`。
   *
   * 1D 條碼（EAN 等）需要較高水平解析度才好解，2D 碼 1280 通常就夠。
   */
  readonly idealWidth?: number
  readonly idealHeight?: number
  /**
   * Android 多鏡頭裝置上避開廣角 / 微距鏡頭，預設 `true`。
   * 判斷策略見 Phase 2 的 CameraController 說明。iOS 沒有這個問題（系統自動選主鏡頭）。
   */
  readonly preferMainCamera?: boolean
  /**
   * 直接提供現成的 `MediaStream`，跳過 `getUserMedia()`。
   * **core 不擁有這個 stream**：`stop()` 不會停它的 track。
   * 主要用途是測試，以及 App 已經自己管理相機的情況。
   */
  readonly stream?: MediaStream
}

/** wasm 後端的載入設定。native 路徑下完全不會用到。 */
export interface WasmOptions {
  /**
   * `.wasm` 檔的 URL 或目錄。**不設的話會從 jsDelivr CDN 下載**（zxing-wasm 的預設行為）。
   * 內網 / 無外網 / CSP 限制的環境**必須**自架並設定此值，否則 `start()` 會以
   * `decoder-init-failed` 失敗。檔案來源：`node_modules/zxing-wasm/dist/reader/zxing_reader.wasm`。
   */
  readonly wasmUrl?: string
  /** 自訂 Worker 的建立方式，給 bundler 處理不了 `new Worker(new URL(...))` 的情境。 */
  readonly createWorker?: () => Worker
}

/**
 * 解碼解析度策略：在「大碼要快」與「小碼/遠距要解得出來」之間自動取捨。
 *
 * 解碼成本與像素數成正比，但 QR 每個模組至少要 2–3 px 才解得出來。
 * 固定降採樣對近距大碼很快，對遠距小碼卻會把模組縮到 1 px 以下。
 * 這裡採三層策略，由便宜到貴：
 *
 * 1. **基準**（`base`）：每幀先縮到這個寬度解碼。
 * 2. **升級階梯**（`ladder`）：連續 `escalateAfterFrames` 幀沒結果，下一幀改用階梯的下一級；
 *    解出後記住成功的尺度並優先使用。`0` 代表全解析度。
 * 3. **候選放大**（`zoomToCandidate`）：解碼器「找到位置但解不出」時
 *    （見 `Candidate` 無 `text` 的情況），下一幀直接對該區域做全解析度局部裁切。
 *    **只有 wasm 後端支援**，native 的 BarcodeDetector 不會回報定位失敗。
 *
 * 全部關掉（固定降採樣）：`{ base: 640, ladder: [], zoomToCandidate: false }`。
 */
export interface DecodeScaleOptions {
  /** 基準寬度（px，保持比例），預設 `640`。`0` = 不降採樣。 */
  readonly base?: number
  /** 升級階梯，預設 `[960, 1280, 0]`。空陣列關閉升級。 */
  readonly ladder?: readonly number[]
  /** 連續幾幀無結果才升級，預設 `5`。 */
  readonly escalateAfterFrames?: number
  /** 對「找到位置但解不出」的候選做全解析度局部裁切，預設 `true`。 */
  readonly zoomToCandidate?: boolean
}

/**
 * 掃描器設定。所有欄位都是 optional，預設值見各欄位。
 *
 * 可在執行期用 `updateOptions()` 熱更新的欄位見 {@link HotUpdatableOptions}；
 * 其他欄位改了要 `stop()` 再 `start()`。
 */
export interface ScannerOptions {
  /**
   * 要辨識的格式，預設 `['qr_code']`。**格式越少解碼越快**（一維與二維是兩套演算法）。
   * 場景固定就給單一組合（`QR_FORMATS` / `LINEAR_FORMATS`），混合場景再合併；可用 `updateOptions()` 熱切換。
   */
  readonly formats?: readonly BarcodeFormat[]
  /** 見 {@link BackendPreference}，預設 `'auto'`。 */
  readonly backend?: BackendPreference
  readonly camera?: CameraOptions
  readonly wasm?: WasmOptions
  /**
   * 掃描區域（幀的比例）。預設 `null` = 整幀。
   * 設了之後 core 只把這塊送去解碼，速度明顯提升；UI 用 `rectToElementSpace()` 畫框。
   */
  readonly roi?: Roi | null
  /**
   * 解碼解析度策略。見 {@link DecodeScaleOptions}。
   * 預設：基準 640、階梯 `[960, 1280, 0]`、5 幀無結果升級、開啟候選放大。
   */
  readonly decodeScale?: DecodeScaleOptions
  /**
   * 連續幾幀解出相同值才發 `decoded`，預設 `2`。設 `0` 關閉（解出就發）。
   * 用來過濾單幀誤判（特別是 1D 條碼）；中間過程會發 `candidate`。
   */
  readonly debounceFrames?: number
  /**
   * 同一個值發出 `decoded` 後，多久內不再重複發，預設 `1500` 毫秒。設 `0` 關閉。
   * 沒有這個的話，對著同一張 QR 會以 targetFps 的頻率狂發事件。
   */
  readonly rescanDelayMs?: number
  /** 解碼幀率上限，預設 `15`。相機本身的幀率不受影響（預覽仍是 30/60fps）。 */
  readonly targetFps?: number
  /**
   * 多碼模式，預設 `false`：**畫面裡有多個碼時只回報離掃描框中心最近的一個**，
   * `decoded` 事件永遠只有一個結果，開發者只要讀 `result.text`，座標可以完全不理。
   * 使用者自然會學到「把要掃的碼對進框中間」。
   *
   * `true`：每幀可能發多個 `decoded`（每個碼一個事件），用 `frameId` 分組；
   * 這時座標才有意義（要告訴使用者哪個是哪個）。
   */
  readonly multi?: boolean
  /** 是否每秒發 `stats` 事件，預設 `false`。 */
  readonly emitStats?: boolean
}

/**
 * 套用預設值後的設定，`scanner.options` 回傳的是這個。
 * `camera.stream` / `camera.deviceId` 等本來就沒預設值的欄位維持 optional。
 */
export type ResolvedScannerOptions = Required<Omit<ScannerOptions, 'camera' | 'wasm' | 'decodeScale'>> & {
  readonly decodeScale: Required<DecodeScaleOptions>
  readonly camera: Required<
    Pick<CameraOptions, 'facingMode' | 'idealWidth' | 'idealHeight' | 'preferMainCamera'>
  > &
    Pick<CameraOptions, 'deviceId' | 'stream'>
  readonly wasm: WasmOptions
}

/** `updateOptions()` 允許的欄位。 */
export type HotUpdatableOptions = Pick<
  ScannerOptions,
  'formats' | 'roi' | 'targetFps' | 'debounceFrames' | 'rescanDelayMs' | 'multi' | 'decodeScale'
>

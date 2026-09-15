/**
 * 相機資訊，來自 `enumerateDevices()`。
 *
 * 瀏覽器差異：
 * - `label` 在**取得相機權限前**一律是空字串（所有平台）。
 * - `facing` 由 label 關鍵字與 `getSettings().facingMode` 推斷，推不出來就是 `'unknown'`。
 *   TODO(實機驗證)：iOS Safari 的 label 通常是 "Back Camera" / "Front Camera"，
 *   但多鏡頭 iPad 是否會分開列出廣角/超廣角要實測。
 */
export interface CameraInfo {
  readonly deviceId: string
  readonly label: string
  readonly facing: 'environment' | 'user' | 'unknown'
}

/** 對焦模式，對應 `MediaTrackCapabilities.focusMode`。 */
export type FocusMode = 'none' | 'manual' | 'single-shot' | 'continuous'

/**
 * 目前 track 的能力。**每個欄位都要在使用前檢查**，任何一項都可能不支援。
 *
 * 瀏覽器差異（需實機驗證）：
 * - `torch`：Android Chrome 後鏡頭通常支援；iOS Safari 17 起部分機型支援；桌機幾乎沒有。
 * - `zoom`：Android Chrome 支援；iOS Safari 目前不透過 constraints 支援（要用 CSS 放大或換鏡頭）。
 * - `focusModes`：Android Chrome 支援 `continuous`；iOS 不暴露此能力但預設就是連續對焦。
 */
export interface CameraCapabilities {
  readonly torch: boolean
  /** `null` 表示不支援 zoom。 */
  readonly zoom: { readonly min: number; readonly max: number; readonly step: number } | null
  /** 支援的對焦模式，空陣列表示不支援設定對焦。 */
  readonly focusModes: readonly FocusMode[]
}

/** 目前 track 的即時設定，隨 `setTorch()` / `setZoom()` 更新。 */
export interface CameraSettings {
  readonly torch: boolean
  readonly zoom: number | null
  readonly focusMode: FocusMode | null
  /** 實際協商到的解析度，可能與 `options.camera.idealWidth` 不同。 */
  readonly resolution: { readonly width: number; readonly height: number }
  readonly frameRate: number | null
}

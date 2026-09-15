/**
 * 座標系說明
 *
 * - `'image'`   ：原始影像座標系。原點在影片幀左上角，單位是像素，
 *                範圍是 `[0, videoWidth) × [0, videoHeight)`。
 *                **core 對外回傳的所有座標一律是這個座標系**，
 *                不受 ROI 裁切或降採樣影響（core 內部會換算回來）。
 * - `'element'` ：`<video>` 元素的 CSS 像素座標系，原點在元素左上角。
 *                只有經過 {@link ToElementSpace} 換算後才會得到這種座標。
 *
 * 兩者以 phantom type 區分：把 `Quad<'image'>` 傳給需要 `Quad<'element'>`
 * 的地方會是編譯錯誤，避免「把影像座標直接畫到 overlay 上」這種常見 bug。
 */
export type CoordinateSpace = 'image' | 'element'

/** 二維點。 */
export interface Point {
  readonly x: number
  readonly y: number
}

/** 寬高。 */
export interface Size {
  readonly width: number
  readonly height: number
}

/** 軸對齊矩形，單位依所在座標系而定。 */
export interface Rect extends Point, Size {}

/**
 * 四邊形，順序固定為 **左上 → 右上 → 右下 → 左下**（順時針）。
 *
 * 1D 條碼（EAN、Code128 等）也會回傳四個點：兩個後端都會給出
 * 條碼的包圍框，只是高度可能非常小。
 *
 * `S` 是 phantom brand，見 {@link CoordinateSpace}。
 */
export type Quad<S extends CoordinateSpace = 'image'> = readonly [Point, Point, Point, Point] & {
  readonly __space?: S
}

/**
 * ROI（掃描區域），**以幀的比例表示**，每個值都在 `0..1`。
 *
 * 用比例而非像素的原因：stream 起來之前不知道實際解析度，
 * 且同一份設定要能同時給 core 裁切與給 UI 畫掃描框。
 *
 * @example 置中 60% 寬、40% 高的區域
 * ```js
 * { x: 0.2, y: 0.3, width: 0.6, height: 0.4 }
 * ```
 */
export interface Roi {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/**
 * 影像座標 → 元素座標的仿射轉換參數。
 *
 * 由 {@link GetElementTransform} 產生，可以快取起來重複套用在同一幀的
 * 多個 quad / rect 上，避免每個 quad 都 `getBoundingClientRect()` 一次
 * （那會強制 layout）。
 */
export interface ElementTransform {
  /** 影像 → 元素的縮放比（cover / contain 下 X、Y 相同，fill 下可能不同）。 */
  readonly scaleX: number
  readonly scaleY: number
  /** 影像被 object-fit 裁切或留白後，在元素內的位移（CSS px）。 */
  readonly offsetX: number
  readonly offsetY: number
  /** 是否水平鏡像（前鏡頭 + `transform: scaleX(-1)` 的常見做法）。 */
  readonly mirrored: boolean
  /** 換算時假設的影像尺寸，若 `videoWidth` 之後變了要重算。 */
  readonly imageSize: Size
  /** 換算時假設的元素尺寸。 */
  readonly elementSize: Size
}

/**
 * `object-fit` 的三種常見值。`scale-down` / `none` 在相機預覽上幾乎不會用，
 * 若真的需要請自行用 {@link ElementTransform} 算。
 */
export type ObjectFit = 'cover' | 'contain' | 'fill'

/** {@link GetElementTransform} 的選項。 */
export interface ElementTransformOptions {
  /**
   * `<video>` 的 object-fit。預設 `'cover'`。
   *
   * 沒有預設去讀 `getComputedStyle` 是因為它會強制 style recalc；
   * 相機預覽的 object-fit 幾乎不會在執行期改變，由呼叫端明講即可。
   */
  readonly objectFit?: ObjectFit
  /** `object-position`，預設置中 `{ x: 0.5, y: 0.5 }`（比例）。 */
  readonly objectPosition?: Point
  /** 影像是否被 CSS 水平鏡像。預設 `false`。 */
  readonly mirrored?: boolean
}

/**
 * 計算影像 → 元素座標的轉換參數。
 *
 * @param videoEl   目標 `<video>` 元素。會讀 `videoWidth/videoHeight`
 *                  與 `getBoundingClientRect()`，**每幀只呼叫一次**，
 *                  然後把結果餵給 {@link ToElementSpace} / {@link RectToElementSpace}。
 * @param options   object-fit 等設定。
 * @returns         `null` 表示 video 尚無尺寸（`videoWidth === 0`，還沒開始播放）。
 */
export type GetElementTransform = (
  videoEl: HTMLVideoElement,
  options?: ElementTransformOptions,
) => ElementTransform | null

/**
 * 把影像座標的 quad 換算到元素座標，處理 `object-fit: cover` 造成的裁切。
 *
 * 第二個參數可以直接給 `<video>`（方便，但每次都會量測 DOM），
 * 或給預先算好的 {@link ElementTransform}（高頻更新時用這個）。
 */
export type ToElementSpace = (
  quad: Quad<'image'>,
  target: HTMLVideoElement | ElementTransform,
  options?: ElementTransformOptions,
) => Quad<'element'>

/**
 * 把 {@link Roi}（幀的比例）換算成元素座標的像素矩形。
 *
 * UI 層畫掃描框時**必須**用這個函式，才能保證畫出來的框與 core
 * 實際裁切的區域是同一塊。
 */
export type RectToElementSpace = (
  roi: Roi,
  target: HTMLVideoElement | ElementTransform,
  options?: ElementTransformOptions,
) => Rect

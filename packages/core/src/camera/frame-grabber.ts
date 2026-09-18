import type { Rect, Size } from '../types'

/** 送去解碼的一幀。座標回推需要 `crop` 與 `scale`（見 geometry.ts 的 `toImageSpace`）。 */
export interface GrabbedFrame {
  readonly bitmap: ImageBitmap
  /** 裁切區域（影像座標 px）。 */
  readonly crop: Rect
  /** 縮放比，`bitmap.width / crop.width`。 */
  readonly scale: number
  /** 原始幀尺寸。 */
  readonly imageSize: Size
  readonly frameId: number
  readonly timestamp: number
  /**
   * 附加的小裁切（原尺寸，不縮）：點陣模式追蹤上一次位置用。解碼器先解這塊（便宜），命中就不用解主幀。
   * 只有 wasm 後端會用；其他後端要負責 `close()`。
   */
  readonly aux?: AuxCrop
}

export interface AuxCrop {
  readonly bitmap: ImageBitmap
  readonly crop: Rect
  readonly scale: number
}

type AnyCanvas = OffscreenCanvas | HTMLCanvasElement
type AnyCtx = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D

/**
 * 把 `<video>` 的一部分裁切 + 縮放成 `ImageBitmap`。
 *
 * 每幀熱路徑上的配置：
 * - canvas 與 context **重用**，只在尺寸改變時重設（重設 canvas 尺寸會重新配置 backing store）
 * - `drawImage(video, sx, sy, sw, sh, 0, 0, dw, dh)` 一次完成裁切與縮放，GPU 執行
 * - `transferToImageBitmap()`（OffscreenCanvas）把 backing store **移交**成 bitmap，零複製；
 *   HTMLCanvas fallback 用 `createImageBitmap(canvas)`，會複製一次
 * - bitmap 是 Transferable：送 Worker 零複製；native 路徑直接餵 `BarcodeDetector.detect()`
 *
 * 像素讀回（`getImageData`）**不在這裡做**：wasm 路徑在 Worker 內做，主執行緒不碰像素。
 * 這是 Phase 2 研究後的決定：zxing-wasm 只吃 RGBA ImageData，在主執行緒轉灰階沒有意義。
 *
 * 呼叫端用完 bitmap 要 `close()`（或 transfer 出去），否則 GPU 記憶體會累積。
 */
export function createFrameGrabber() {
  // 主幀與附加裁切各一組 canvas（尺寸不同，共用會每幀重設 backing store）
  const main = { canvas: null as AnyCanvas | null, ctx: null as AnyCtx | null }
  const auxC = { canvas: null as AnyCanvas | null, ctx: null as AnyCtx | null }
  let frameId = 0

  function ensureCanvas(slot: typeof main, w: number, h: number): AnyCtx {
    if (!slot.canvas) {
      slot.canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : document.createElement('canvas')
      // alpha: false 讓瀏覽器少一個 compositing 步驟；willReadFrequently 只對 HTMLCanvas 有意義但無害
      slot.ctx = slot.canvas.getContext('2d', { alpha: false, willReadFrequently: false }) as AnyCtx | null
      if (!slot.ctx) throw new Error('2d context unavailable')
    }
    if (slot.canvas.width !== w || slot.canvas.height !== h) {
      slot.canvas.width = w
      slot.canvas.height = h
    }
    return slot.ctx!
  }

  async function draw(slot: typeof main, video: HTMLVideoElement, crop: Rect, targetWidth: number) {
    const scale = targetWidth > 0 && targetWidth < crop.width ? targetWidth / crop.width : 1
    const dw = Math.max(1, Math.round(crop.width * scale))
    const dh = Math.max(1, Math.round(crop.height * scale))
    const c = ensureCanvas(slot, dw, dh)
    c.drawImage(video, crop.x, crop.y, crop.width, crop.height, 0, 0, dw, dh)
    const bitmap =
      'transferToImageBitmap' in slot.canvas!
        ? (slot.canvas as OffscreenCanvas).transferToImageBitmap()
        : await createImageBitmap(slot.canvas as HTMLCanvasElement)
    return { bitmap, crop, scale: dw / crop.width }
  }

  async function grab(
    video: HTMLVideoElement,
    crop: Rect,
    targetWidth: number,
    timestamp: number,
    auxCrop?: Rect,
  ): Promise<GrabbedFrame> {
    const imageSize: Size = { width: video.videoWidth, height: video.videoHeight }
    const m = await draw(main, video, crop, targetWidth)
    const aux = auxCrop ? await draw(auxC, video, auxCrop, 0) : undefined
    return { ...m, imageSize, frameId: frameId++, timestamp, ...(aux ? { aux } : {}) }
  }

  return {
    grab,
    dispose() {
      main.canvas = null
      main.ctx = null
      auxC.canvas = null
      auxC.ctx = null
    },
  }
}

export type FrameGrabber = ReturnType<typeof createFrameGrabber>

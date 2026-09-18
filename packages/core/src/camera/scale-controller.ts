import { expandRect, quadBounds, roiToImageRect } from '../geometry'
import type { DecodeScaleOptions, Quad, Rect, Roi, Size } from '../types'

/** 每一幀要怎麼裁、縮到多寬。`targetWidth: 0` = 不縮。 */
export interface FramePlan {
  readonly crop: Rect
  readonly targetWidth: number
  /** `'base'` | 階梯索引 | `'zoom'`（候選放大，原尺寸小裁切），給 stats / 除錯用。 */
  readonly level: 'base' | number | 'zoom'
  /**
   * 追蹤中：上一次定位 / 解碼位置周圍的原尺寸小裁切，與主幀**同一幀**一起抓、解碼器先解它。
   * `symbolWidth` 是上次的符號寬度（原始影像 px），點陣模式用來挑膨脹核。
   */
  readonly aux?: { readonly crop: Rect; readonly symbolWidth: number }
}

export type DecodeOutcome = 'decoded' | 'located' | 'none'

/** 候選放大時 bbox 外擴的比例：quad 周圍多留 50%，讓 quiet zone 與定位圖案都在框內。 */
const ZOOM_PADDING = 0.5
/** 候選佇列上限（點密度定位一幀最多給 3 個）。 */
const MAX_ZOOM_QUEUE = 3
/** 追蹤裁切的邊長下限（原始影像 px）：遠拍符號 ~70 px，160 留得住 ±45 px 的移動。 */
const TRACK_MIN_SIDE = 160
/** 追蹤裁切邊長 = 符號寬 × 這個倍數（至少 TRACK_MIN_SIDE）。 */
const TRACK_SIDE_FACTOR = 2.5

/**
 * decodeScale 三層策略的狀態機（純邏輯，無 DOM）。
 *
 * - 階梯 `[base, ...ladder]`，索引 0 是基準。
 * - 連續 `escalateAfterFrames` 幀無結果 → 往下一級，到底繞回 0。
 * - `decoded` → 清零計數，停在成功的那一級。
 * - `located`（找到位置解不出）且 `zoomToCandidate` → **下一幀**對 quad 周圍做全解析度裁切，
 *   只做一幀，之後回到原本的階梯。也計入 miss。
 * - `report('none', …, undefined, candidates)`：點密度定位給的候選區域排進佇列，之後幾幀逐一裁切（`'zoom'`）。
 *
 * **追蹤**（`trackFrames > 0` 時）：任何一次 `decoded` / `located` 都記住位置，之後每幀的 plan 多帶一個
 * `aux` 裁切（上次位置周圍、原尺寸），解碼器先解它、命中就不用解主幀；主幀照常走階梯（保留發現能力）。
 * aux 連續 `trackFrames` 幀沒解出就放掉。這是給點陣碼用的：一旦找到，後續每幀都能在小裁切上多試幾個變體。
 */
export function createScaleController(options: Required<DecodeScaleOptions>, roi: Roi | null, trackFrames = 0) {
  const ladder = [options.base, ...options.ladder]
  let index = 0
  let misses = 0
  const zoomQueue: Rect[] = []
  let track: { rect: Rect; symbolWidth: number; misses: number } | null = null

  function plan(image: Size): FramePlan {
    const roiRect = roiToImageRect(roi, image)
    const aux = track ? { aux: { crop: track.rect, symbolWidth: track.symbolWidth } } : {}

    const zoom = zoomQueue.shift()
    if (zoom) return { crop: zoom, targetWidth: 0, level: 'zoom', ...aux }

    const width = ladder[index] ?? 0
    // 不放大：目標寬度已經比裁切區寬就不縮
    const targetWidth = width > 0 && width < roiRect.width ? width : 0
    return { crop: roiRect, targetWidth, level: index === 0 ? 'base' : index, ...aux }
  }

  function setTrack(quad: Quad<'image'>, image: Size) {
    if (trackFrames <= 0) return
    const b = quadBounds(quad)
    const side = Math.max(TRACK_MIN_SIDE, Math.max(b.width, b.height) * TRACK_SIDE_FACTOR)
    const bounds = roiToImageRect(roi, image)
    const rect = clampSquare({ x: b.x + b.width / 2 - side / 2, y: b.y + b.height / 2 - side / 2, width: side, height: side }, bounds)
    track = { rect, symbolWidth: b.width, misses: 0 }
  }

  /**
   * @param candidates 點密度定位給的候選（整幀沒結果時）
   * @param auxMiss 這幀有 aux 裁切但沒在裡面解出（追蹤 miss）
   */
  function report(outcome: DecodeOutcome, image: Size, quad?: Quad<'image'>, candidates?: readonly Rect[], auxMiss = false) {
    if (auxMiss && track && ++track.misses >= trackFrames) track = null
    if (outcome === 'decoded') {
      misses = 0
      if (quad) setTrack(quad, image)
      return
    }
    if (outcome === 'located' && quad) {
      if (options.zoomToCandidate) pushZoom(expandRect(quadBounds(quad), ZOOM_PADDING, roiToImageRect(roi, image)))
      setTrack(quad, image)
    }
    if (outcome === 'none' && candidates) for (const c of candidates) pushZoom(clampSquare(c, roiToImageRect(roi, image)))
    misses++
    if (ladder.length > 1 && misses >= options.escalateAfterFrames) {
      misses = 0
      index = (index + 1) % ladder.length
    }
  }

  function pushZoom(rect: Rect) {
    if (rect.width < 8 || rect.height < 8) return
    if (zoomQueue.length >= MAX_ZOOM_QUEUE) return
    zoomQueue.push(rect)
  }

  return {
    plan,
    report,
    get level() {
      return index
    },
    /** 目前有沒有在追蹤（給 stats / 測試）。 */
    get tracking() {
      return track !== null
    },
    reset() {
      index = 0
      misses = 0
      zoomQueue.length = 0
      track = null
    },
  }
}

/** 把矩形移進 bounds（保持大小；比 bounds 大就裁到 bounds）。 */
function clampSquare(rect: Rect, bounds: Rect): Rect {
  const width = Math.min(rect.width, bounds.width)
  const height = Math.min(rect.height, bounds.height)
  const x = Math.min(Math.max(rect.x, bounds.x), bounds.x + bounds.width - width)
  const y = Math.min(Math.max(rect.y, bounds.y), bounds.y + bounds.height - height)
  return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) }
}

export type ScaleController = ReturnType<typeof createScaleController>

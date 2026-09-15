import { expandRect, quadBounds, roiToImageRect } from '../geometry'
import type { DecodeScaleOptions, Quad, Rect, Roi, Size } from '../types'

/** 每一幀要怎麼裁、縮到多寬。`targetWidth: 0` = 不縮。 */
export interface FramePlan {
  readonly crop: Rect
  readonly targetWidth: number
  /** `'base'` | 階梯索引 | `'zoom'`（候選放大），給 stats / 除錯用。 */
  readonly level: 'base' | number | 'zoom'
}

export type DecodeOutcome = 'decoded' | 'located' | 'none'

/** 候選放大時 bbox 外擴的比例：quad 周圍多留 50%，讓 quiet zone 與定位圖案都在框內。 */
const ZOOM_PADDING = 0.5

/**
 * decodeScale 三層策略的狀態機（純邏輯，無 DOM）。
 *
 * - 階梯 `[base, ...ladder]`，索引 0 是基準。
 * - 連續 `escalateAfterFrames` 幀無結果 → 往下一級，到底繞回 0。
 * - `decoded` → 清零計數，停在成功的那一級。
 * - `located`（找到位置解不出）且 `zoomToCandidate` → **下一幀**對 quad 周圍做全解析度裁切，
 *   只做一幀，之後回到原本的階梯。也計入 miss。
 */
export function createScaleController(options: Required<DecodeScaleOptions>, roi: Roi | null) {
  const ladder = [options.base, ...options.ladder]
  let index = 0
  let misses = 0
  let zoomRect: Rect | null = null

  function plan(image: Size): FramePlan {
    const roiRect = roiToImageRect(roi, image)

    if (zoomRect) {
      const crop = zoomRect
      zoomRect = null
      return { crop, targetWidth: 0, level: 'zoom' }
    }

    const width = ladder[index] ?? 0
    // 不放大：目標寬度已經比裁切區寬就不縮
    const targetWidth = width > 0 && width < roiRect.width ? width : 0
    return { crop: roiRect, targetWidth, level: index === 0 ? 'base' : index }
  }

  function report(outcome: DecodeOutcome, image: Size, quad?: Quad<'image'>) {
    if (outcome === 'decoded') {
      misses = 0
      return
    }
    if (outcome === 'located' && options.zoomToCandidate && quad) {
      zoomRect = expandRect(quadBounds(quad), ZOOM_PADDING, roiToImageRect(roi, image))
    }
    misses++
    if (ladder.length > 1 && misses >= options.escalateAfterFrames) {
      misses = 0
      index = (index + 1) % ladder.length
    }
  }

  return {
    plan,
    report,
    get level() {
      return index
    },
    reset() {
      index = 0
      misses = 0
      zoomRect = null
    },
  }
}

export type ScaleController = ReturnType<typeof createScaleController>

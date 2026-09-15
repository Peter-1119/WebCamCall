import { describe, expect, it } from 'vitest'
import {
  expandRect,
  getElementTransform,
  quadBounds,
  rectToElementSpace,
  rectToQuad,
  roiToImageRect,
  toElementSpace,
  toImageSpace,
} from './geometry'
import type { ElementTransform, Quad } from './types'

/** 假 video：1920×1080 幀，顯示在 360×640 的直式元素裡（典型手機） */
function fakeVideo(vw = 1920, vh = 1080, cw = 360, ch = 640) {
  return { videoWidth: vw, videoHeight: vh, clientWidth: cw, clientHeight: ch } as HTMLVideoElement
}

describe('getElementTransform', () => {
  it('returns null before the video has dimensions', () => {
    expect(getElementTransform(fakeVideo(0, 0))).toBeNull()
  })

  it('cover: scales to fill and crops the overflow, centered', () => {
    const t = getElementTransform(fakeVideo())!
    // 640/1080 > 360/1920 → 用高度撐滿，左右被裁
    expect(t.scaleX).toBeCloseTo(640 / 1080)
    expect(t.scaleY).toBeCloseTo(640 / 1080)
    expect(t.offsetY).toBeCloseTo(0)
    expect(t.offsetX).toBeCloseTo((360 - 1920 * (640 / 1080)) / 2)
    expect(t.offsetX).toBeLessThan(0)
  })

  it('contain: scales to fit and letterboxes', () => {
    const t = getElementTransform(fakeVideo(), { objectFit: 'contain' })!
    expect(t.scaleX).toBeCloseTo(360 / 1920)
    expect(t.offsetX).toBeCloseTo(0)
    expect(t.offsetY).toBeGreaterThan(0)
  })

  it('fill: independent axes', () => {
    const t = getElementTransform(fakeVideo(), { objectFit: 'fill' })!
    expect(t.scaleX).toBeCloseTo(360 / 1920)
    expect(t.scaleY).toBeCloseTo(640 / 1080)
    expect(t.offsetX).toBe(0)
    expect(t.offsetY).toBe(0)
  })
})

describe('toElementSpace', () => {
  it('maps the image center to the element center under cover', () => {
    const c = { x: 960, y: 540 }
    const q = toElementSpace([c, c, c, c], fakeVideo())
    expect(q[0].x).toBeCloseTo(180)
    expect(q[0].y).toBeCloseTo(320)
  })

  it('accepts a precomputed transform and gives identical results', () => {
    const v = fakeVideo()
    const t = getElementTransform(v)!
    const quad: Quad<'image'> = rectToQuad({ x: 100, y: 200, width: 300, height: 300 })
    expect(toElementSpace(quad, t)).toEqual(toElementSpace(quad, v))
  })

  it('mirrored: flips x and restores clockwise order', () => {
    const t: ElementTransform = {
      scaleX: 1, scaleY: 1, offsetX: 0, offsetY: 0, mirrored: true,
      imageSize: { width: 100, height: 100 }, elementSize: { width: 100, height: 100 },
    }
    const q = toElementSpace(rectToQuad({ x: 10, y: 10, width: 20, height: 20 }), t)
    expect(q[0]).toEqual({ x: 70, y: 10 })
    expect(q[1]).toEqual({ x: 90, y: 10 })
    expect(q[2]).toEqual({ x: 90, y: 30 })
    expect(q[3]).toEqual({ x: 70, y: 30 })
  })

  it('returns zeros instead of throwing before first frame', () => {
    const q = toElementSpace(rectToQuad({ x: 0, y: 0, width: 1, height: 1 }), fakeVideo(0, 0))
    expect(q[2]).toEqual({ x: 0, y: 0 })
  })
})

describe('roi / rect helpers', () => {
  it('roiToImageRect: null roi = full frame', () => {
    expect(roiToImageRect(null, { width: 100, height: 50 })).toEqual({ x: 0, y: 0, width: 100, height: 50 })
  })

  it('roiToImageRect: fraction → rounded px, clamped', () => {
    const r = roiToImageRect({ x: 0.2, y: 0.3, width: 0.6, height: 0.4 }, { width: 1920, height: 1080 })
    expect(r).toEqual({ x: 384, y: 324, width: 1152, height: 432 })
    const over = roiToImageRect({ x: 0.9, y: 0.9, width: 0.5, height: 0.5 }, { width: 100, height: 100 })
    expect(over).toEqual({ x: 90, y: 90, width: 10, height: 10 })
  })

  it('rectToElementSpace and toElementSpace agree on the same ROI', () => {
    const v = fakeVideo()
    const roi = { x: 0.2, y: 0.3, width: 0.6, height: 0.4 }
    const rect = rectToElementSpace(roi, v)
    const quad = toElementSpace(rectToQuad(roiToImageRect(roi, { width: 1920, height: 1080 })), v)
    expect(rect.x).toBeCloseTo(quad[0].x)
    expect(rect.y).toBeCloseTo(quad[0].y)
    expect(rect.x + rect.width).toBeCloseTo(quad[2].x)
    expect(rect.y + rect.height).toBeCloseTo(quad[2].y)
  })
})

describe('toImageSpace (crop + downsample round trip)', () => {
  it('maps decoded coordinates back through crop and scale', () => {
    const crop = { x: 384, y: 324, width: 1152, height: 432 }
    const scale = 640 / 1152
    const img = toImageSpace(rectToQuad({ x: 100, y: 50, width: 200, height: 200 }), crop, scale)
    expect(img[0].x).toBeCloseTo(384 + 100 / scale)
    expect(img[0].y).toBeCloseTo(324 + 50 / scale)
    expect(img[2].x).toBeCloseTo(384 + 300 / scale)
  })

  it('full-frame, scale 1 is identity', () => {
    const q = rectToQuad({ x: 5, y: 6, width: 7, height: 8 })
    expect(toImageSpace(q, { x: 0, y: 0, width: 100, height: 100 }, 1)).toEqual(q)
  })
})

describe('quadBounds / expandRect', () => {
  it('bounds of a rotated quad', () => {
    const q: Quad<'image'> = [{ x: 50, y: 0 }, { x: 100, y: 50 }, { x: 50, y: 100 }, { x: 0, y: 50 }]
    expect(quadBounds(q)).toEqual({ x: 0, y: 0, width: 100, height: 100 })
  })

  it('expandRect pads and clamps to bounds', () => {
    const r = expandRect({ x: 10, y: 10, width: 20, height: 20 }, 0.5, { x: 0, y: 0, width: 25, height: 100 })
    expect(r.x).toBe(5)
    expect(r.y).toBe(5)
    expect(r.x + r.width).toBe(25)
    expect(r.y + r.height).toBe(35)
  })
})

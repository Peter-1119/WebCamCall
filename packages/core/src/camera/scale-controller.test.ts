import { describe, expect, it } from 'vitest'
import { rectToQuad } from '../geometry'
import { DEFAULT_DECODE_SCALE } from '../options'
import { createScaleController } from './scale-controller'

const image = { width: 1920, height: 1080 }
const opts = { ...DEFAULT_DECODE_SCALE, escalateAfterFrames: 3 }

describe('scale controller', () => {
  it('starts at base with full-frame crop when roi is null', () => {
    const sc = createScaleController(opts, null)
    const p = sc.plan(image)
    expect(p.level).toBe('base')
    expect(p.crop).toEqual({ x: 0, y: 0, width: 1920, height: 1080 })
    expect(p.targetWidth).toBe(640)
  })

  it('crops to roi', () => {
    const sc = createScaleController(opts, { x: 0.25, y: 0.25, width: 0.5, height: 0.5 })
    expect(sc.plan(image).crop).toEqual({ x: 480, y: 270, width: 960, height: 540 })
  })

  it('escalates through the ladder after N misses and wraps around', () => {
    const sc = createScaleController(opts, null)
    const widths: number[] = []
    for (let i = 0; i < 13; i++) {
      widths.push(sc.plan(image).targetWidth)
      sc.report('none', image)
    }
    // 3 幀 base(640) → 3 幀 960 → 3 幀 1280 → 3 幀 full(0) → 回到 640
    expect(widths).toEqual([640, 640, 640, 960, 960, 960, 1280, 1280, 1280, 0, 0, 0, 640])
  })

  it('never upscales: target wider than crop means no scaling', () => {
    const sc = createScaleController({ ...opts, base: 4000 }, null)
    expect(sc.plan(image).targetWidth).toBe(0)
  })

  it('decoded resets the miss counter and stays at the current level', () => {
    const sc = createScaleController(opts, null)
    sc.report('none', image)
    sc.report('none', image)
    sc.report('none', image) // → level 1
    expect(sc.level).toBe(1)
    sc.report('decoded', image)
    sc.report('none', image)
    sc.report('none', image)
    expect(sc.level).toBe(1) // 還差一幀才升級
  })

  it('located → next frame is a full-resolution zoom around the quad, then back to the ladder', () => {
    const sc = createScaleController(opts, null)
    const quad = rectToQuad({ x: 900, y: 500, width: 100, height: 100 })
    sc.report('located', image, quad)
    const zoom = sc.plan(image)
    expect(zoom.level).toBe('zoom')
    expect(zoom.targetWidth).toBe(0)
    // 外擴 50%：每邊各 25px
    expect(zoom.crop).toEqual({ x: 875, y: 475, width: 150, height: 150 })
    const next = sc.plan(image)
    expect(next.level).toBe('base')
  })

  it('zoom crop is clamped to the roi', () => {
    const sc = createScaleController(opts, { x: 0.5, y: 0.5, width: 0.5, height: 0.5 })
    sc.report('located', image, rectToQuad({ x: 960, y: 540, width: 40, height: 40 }))
    const z = sc.plan(image)
    expect(z.crop.x).toBe(960)
    expect(z.crop.y).toBe(540)
  })

  it('zoomToCandidate: false ignores located quads', () => {
    const sc = createScaleController({ ...opts, zoomToCandidate: false }, null)
    sc.report('located', image, rectToQuad({ x: 0, y: 0, width: 10, height: 10 }))
    expect(sc.plan(image).level).toBe('base')
  })

  it('empty ladder never escalates', () => {
    const sc = createScaleController({ ...opts, ladder: [] }, null)
    for (let i = 0; i < 20; i++) sc.report('none', image)
    expect(sc.level).toBe(0)
  })
})

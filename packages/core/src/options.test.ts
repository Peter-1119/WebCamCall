import { describe, expect, it } from 'vitest'
import { resolveOptions } from './options'

describe('resolveOptions', () => {
  it('applies documented defaults', () => {
    const o = resolveOptions()
    expect(o.formats).toEqual(['qr_code'])
    expect(o.backend).toBe('auto')
    expect(o.roi).toBeNull()
    expect(o.decodeScale).toEqual({ base: 640, ladder: [960, 1280, 0], escalateAfterFrames: 5, zoomToCandidate: true })
    expect(o.debounceFrames).toBe(2)
    expect(o.rescanDelayMs).toBe(1500)
    expect(o.targetFps).toBe(15)
    expect(o.camera).toEqual({ facingMode: 'environment', idealWidth: 1920, idealHeight: 1080, preferMainCamera: true })
  })

  it('merges partial decodeScale without losing defaults', () => {
    const o = resolveOptions({ decodeScale: { base: 800, ladder: [] } })
    expect(o.decodeScale).toEqual({ base: 800, ladder: [], escalateAfterFrames: 5, zoomToCandidate: true })
  })

  it('keeps deviceId / stream only when given', () => {
    expect('deviceId' in resolveOptions().camera).toBe(false)
    expect(resolveOptions({ camera: { deviceId: 'abc' } }).camera.deviceId).toBe('abc')
  })
})

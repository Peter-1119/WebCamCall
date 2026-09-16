import { describe, expect, expectTypeOf, it } from 'vitest'
import type {
  BarcodeFormat,
  Quad,
  ScanEventOf,
  ScannerError,
  ScannerState,
  ToElementSpace,
  UnsupportedFormatError,
} from './index'
import { ALL_FORMATS, LINEAR_FORMATS, MATRIX_FORMATS, QR_FORMATS, STATE_TRANSITIONS } from './index'

describe('types: narrowing contracts', () => {
  it('ScanEventOf narrows by type', () => {
    expectTypeOf<ScanEventOf<'decoded'>>().toHaveProperty('result')
    expectTypeOf<ScanEventOf<'error'>>().toHaveProperty('error')
    expectTypeOf<ScanEventOf<'state'>>().toHaveProperty('previous')
    // @ts-expect-error decoded 事件沒有 error 欄位
    expectTypeOf<ScanEventOf<'decoded'>>().toHaveProperty('error')
  })

  it('ScannerError narrows by code', () => {
    const handle = (e: ScannerError) => {
      if (e.code === 'unsupported-format') {
        expectTypeOf(e).toEqualTypeOf<UnsupportedFormatError>()
        expectTypeOf(e.formats).toEqualTypeOf<readonly BarcodeFormat[]>()
      }
      if (e.code === 'invalid-state') {
        expectTypeOf(e.action).toEqualTypeOf<
          'start' | 'stop' | 'pause' | 'resume' | 'switchCamera' | 'setTorch' | 'setZoom'
        >()
      }
      if (e.code === 'permission-denied') {
        // @ts-expect-error simple code 沒有 formats
        e.formats
      }
    }
    expect(handle).toBeTypeOf('function')
  })

  it('Quad brand rejects wrong coordinate space', () => {
    const p = { x: 0, y: 0 }
    const image: Quad<'image'> = [p, p, p, p]
    const element: Quad<'element'> = [p, p, p, p]
    const draw = (_q: Quad<'element'>) => {}

    draw(element)
    // @ts-expect-error 影像座標不可直接畫到元素上
    draw(image)

    const toElementSpace: ToElementSpace = () => element
    draw(toElementSpace(image, {} as HTMLVideoElement))
  })
})

describe('STATE_TRANSITIONS', () => {
  const states: ScannerState[] = [
    'idle',
    'requesting-permission',
    'starting',
    'scanning',
    'paused',
    'stopped',
    'failed',
  ]

  it('covers every state and only references known states', () => {
    for (const s of states) {
      expect(STATE_TRANSITIONS[s]).toBeDefined()
      for (const to of STATE_TRANSITIONS[s]) expect(states).toContain(to)
    }
  })

  it('never allows a self-transition', () => {
    for (const s of states) expect(STATE_TRANSITIONS[s]).not.toContain(s)
  })

  it('idle can only go to requesting-permission', () => {
    expect(STATE_TRANSITIONS.idle).toEqual(['requesting-permission'])
  })

  it('every non-idle state can reach stopped or is stopped', () => {
    for (const s of states) {
      if (s === 'idle' || s === 'stopped') continue
      expect(STATE_TRANSITIONS[s]).toContain('stopped')
    }
  })

  it('stopped and failed can restart', () => {
    expect(STATE_TRANSITIONS.stopped).toContain('requesting-permission')
    expect(STATE_TRANSITIONS.failed).toContain('requesting-permission')
  })
})

describe('format presets', () => {
  it('ALL_FORMATS has no duplicates', () => {
    expect(new Set(ALL_FORMATS).size).toBe(ALL_FORMATS.length)
  })

  it('LINEAR and MATRIX are disjoint and together cover ALL', () => {
    const linear = new Set(LINEAR_FORMATS)
    for (const f of MATRIX_FORMATS) expect(linear.has(f), f).toBe(false)
    expect(new Set([...LINEAR_FORMATS, ...MATRIX_FORMATS]).size).toBe(ALL_FORMATS.length)
    expect(QR_FORMATS).toEqual(['qr_code'])
  })
})

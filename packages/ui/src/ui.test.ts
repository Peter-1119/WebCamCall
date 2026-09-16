import { effectScope, nextTick, ref, shallowRef } from 'vue'
import { mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Candidate, DecodedResult, Quad, ScannerState } from '@scanner/core'
import BarcodeScanner from './BarcodeScanner.vue'
import ScannerOverlay from './ScannerOverlay.vue'
import { useHint } from './useHint'
import { useSmoothQuad } from './useSmoothQuad'

const quad = (x: number, s = 10): Quad<'element'> => [{ x, y: 0 }, { x: x + s, y: 0 }, { x: x + s, y: s }, { x, y: s }]

describe('useSmoothQuad', () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame'] }))
  afterEach(() => vi.useRealTimers())

  it('snaps to the first target, then interpolates toward new targets', () => {
    const scope = effectScope()
    const target = ref<Quad<'element'> | null>(null)
    const out = scope.run(() => useSmoothQuad(target, { factor: 0.5 }))!
    target.value = quad(0)
    vi.advanceTimersToNextFrame()
    expect(out.value?.[0].x).toBe(0)

    target.value = quad(100)
    vi.advanceTimersToNextFrame()
    expect(out.value?.[0].x).toBe(50) // 一半
    vi.advanceTimersToNextFrame()
    expect(out.value?.[0].x).toBe(75)
    for (let i = 0; i < 20; i++) vi.advanceTimersToNextFrame()
    expect(out.value?.[0].x).toBe(100) // snap 到位
    scope.stop()
  })

  it('holds the last quad for holdMs after the target disappears', () => {
    const scope = effectScope()
    const target = ref<Quad<'element'> | null>(quad(0))
    const out = scope.run(() => useSmoothQuad(target, { holdMs: 300 }))!
    vi.advanceTimersToNextFrame()
    target.value = null
    vi.advanceTimersByTime(200)
    expect(out.value).not.toBeNull()
    vi.advanceTimersByTime(150)
    expect(out.value).toBeNull()
    scope.stop()
  })
})

describe('useHint', () => {
  const cand = (text?: string): Candidate => ({
    quad: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }] as Quad<'image'>,
    imageSize: { width: 1, height: 1 },
    frameId: 0,
    timestamp: 0,
    ...(text !== undefined ? { text, progress: { seen: 1, required: 2 } } : {}),
  })

  function setup() {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] })
    const scope = effectScope()
    const state = ref<ScannerState>('idle')
    const candidates = ref<readonly Candidate[]>([])
    const lastResult = ref<DecodedResult | null>(null)
    const hint = scope.run(() => useHint({ state, candidates, lastResult }, { stuckAfterMs: 1000, alignAfterMs: 2000 }))!
    return { scope, state, candidates, lastResult, hint }
  }
  afterEach(() => vi.useRealTimers())

  it('align: scanning with no candidates for alignAfterMs', async () => {
    const { scope, state, hint } = setup()
    state.value = 'scanning'
    await nextTick()
    vi.advanceTimersByTime(1500)
    expect(hint.value).toBeNull()
    vi.advanceTimersByTime(750)
    expect(hint.value).toBe('align')
    state.value = 'paused'
    await nextTick()
    expect(hint.value).toBeNull()
    scope.stop()
  })

  it('move-closer vs hold-steady depends on candidate kind; a decode clears it', async () => {
    const { scope, state, candidates, lastResult, hint } = setup()
    state.value = 'scanning'
    await nextTick()
    // 持續看到「只有位置」的候選
    for (let i = 0; i < 6; i++) {
      candidates.value = [cand()]
      await nextTick()
      vi.advanceTimersByTime(250)
    }
    expect(hint.value).toBe('move-closer')

    for (let i = 0; i < 3; i++) {
      candidates.value = [cand('abc')]
      await nextTick()
      vi.advanceTimersByTime(250)
    }
    expect(hint.value).toBe('hold-steady')

    lastResult.value = { text: 'abc' } as DecodedResult
    await nextTick()
    expect(hint.value).toBeNull()
    vi.advanceTimersByTime(500)
    expect(hint.value).toBeNull() // quiet after decode
    scope.stop()
  })
})

vi.mock('@scanner/vue', () => ({
  useBarcodeScanner: () => ({
    state: shallowRef('scanning'),
    error: shallowRef(null),
    backend: shallowRef('wasm'),
    camera: shallowRef(null),
    capabilities: shallowRef(null),
    settings: shallowRef(null),
    lastResult: shallowRef(null),
    candidates: shallowRef([]),
    support: shallowRef(null),
    scanner: shallowRef(null),
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    pause: vi.fn(),
    resume: vi.fn(),
    toggleTorch: vi.fn(async () => {}),
    setZoom: vi.fn(async () => {}),
    switchCamera: vi.fn(async () => {}),
    updateOptions: vi.fn(),
  }),
}))

describe('<BarcodeScanner>', () => {
  it('default slot and template ref receive unwrapped values', async () => {
    const w = mount(BarcodeScanner, { slots: { default: '<i class="st">{{ params.state }}</i>' } })
    await nextTick()
    expect(w.find('.st').text()).toBe('scanning')
    expect((w.vm as unknown as { state: string }).state).toBe('scanning')
    expect(typeof (w.vm as unknown as { start: unknown }).start).toBe('function')
  })
})

describe('<ScannerOverlay>', () => {
  function fakeApi() {
    const state = shallowRef<ScannerState>('scanning')
    const candidates = shallowRef<readonly Candidate[]>([])
    const lastResult = shallowRef<DecodedResult | null>(null)
    const error = shallowRef(null)
    const scanner = shallowRef({ options: { roi: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 } } })
    return { state, candidates, lastResult, error, scanner } as never
  }
  function fakeVideo() {
    const v = document.createElement('video')
    Object.defineProperties(v, {
      videoWidth: { value: 200 },
      videoHeight: { value: 100 },
      clientWidth: { value: 200 },
      clientHeight: { value: 100 },
    })
    return v
  }

  it('renders no text of its own and draws the ROI from scanner options', async () => {
    const api = fakeApi()
    const w = mount(ScannerOverlay, { props: { api, video: fakeVideo() } })
    await nextTick()
    expect(w.text().trim()).toBe('')
    const mask = w.find('mask rect:nth-child(2)')
    expect(mask.attributes('x')).toBe('20')
    expect(mask.attributes('width')).toBe('160')
    expect(w.find('[role="status"][aria-live="polite"]').exists()).toBe(true)
  })

  it('exposes slots with codes, emits close on Escape and retry on Enter when failed', async () => {
    const api = fakeApi()
    const w = mount(ScannerOverlay, {
      props: { api, video: fakeVideo() },
      slots: { status: '<span class="s">{{ params.state }}</span>', error: '<b class="e">{{ params.error }}</b>' },
    })
    await nextTick()
    expect(w.find('.s').text()).toBe('scanning')

    await w.find('.so').trigger('keydown', { key: 'Escape' })
    expect(w.emitted('close')).toHaveLength(1)

    await w.find('.so').trigger('keydown', { key: 'Enter' })
    expect(w.emitted('retry')).toBeUndefined()
    ;(api as { state: { value: ScannerState } }).state.value = 'failed'
    await nextTick()
    expect(w.find('.so__fail').exists()).toBe(true)
    expect(w.find('.e').exists()).toBe(true)
    await w.find('.so').trigger('keydown', { key: 'Enter' })
    expect(w.emitted('retry')).toHaveLength(1)
  })

  it('shows the lock shape and vibrates on decode', async () => {
    const vibrate = vi.fn()
    Object.defineProperty(navigator, 'vibrate', { value: vibrate, configurable: true })
    const api = fakeApi()
    const w = mount(ScannerOverlay, { props: { api, video: fakeVideo(), vibrate: 42 } })
    await nextTick()
    ;(api as { lastResult: { value: unknown } }).lastResult.value = {
      text: 'x',
      quad: [{ x: 10, y: 10 }, { x: 50, y: 10 }, { x: 50, y: 50 }, { x: 10, y: 50 }],
    }
    await nextTick()
    expect(w.find('.so__lock').exists()).toBe(true)
    expect(w.find('.so__check').exists()).toBe(true)
    expect(vibrate).toHaveBeenCalledWith(42)
  })
})

import { effectScope, nextTick, ref } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BarcodeFormat, Candidate, DecodedResult, ScanEvent, Scanner, ScannerState } from '@scanner/core'

// 假的 core：記錄 createScanner 的呼叫，讓測試能對 listener 發事件
interface FakeScanner extends Scanner {
  emit: (e: ScanEvent) => void
  _state: ScannerState
}
const instances: FakeScanner[] = []
const createScannerMock = vi.fn((_video: HTMLVideoElement, options: unknown): FakeScanner => {
  const listeners = new Set<(e: ScanEvent) => void>()
  const inst = {
    _state: 'idle' as ScannerState,
    get state() {
      return inst._state
    },
    options,
    backend: 'wasm',
    camera: null,
    capabilities: null,
    settings: { torch: false, zoom: null, focusMode: null, resolution: { width: 1, height: 1 }, frameRate: null },
    start: vi.fn(async () => {
      inst._state = 'scanning'
    }),
    stop: vi.fn(async () => {
      inst._state = 'stopped'
    }),
    pause: vi.fn(),
    resume: vi.fn(),
    listCameras: vi.fn(async () => []),
    switchCamera: vi.fn(async () => {}),
    setTorch: vi.fn(async () => {}),
    setZoom: vi.fn(async () => {}),
    updateOptions: vi.fn(),
    on: vi.fn(() => () => {}),
    subscribe: (l: (e: ScanEvent) => void) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    emit: (e: ScanEvent) => {
      for (const l of listeners) l(e)
    },
  } as unknown as FakeScanner
  instances.push(inst)
  return inst
})
vi.mock('@scanner/core', () => ({
  createScanner: (v: HTMLVideoElement, o: unknown) => createScannerMock(v, o),
  probeSupport: vi.fn(async () => ({ secureContext: true })),
}))

import { useBarcodeScanner } from './useBarcodeScanner'

const video = () => document.createElement('video')
const result = (text: string): DecodedResult => ({
  text,
  format: 'qr_code',
  quad: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }],
  rawBytes: null,
  imageSize: { width: 10, height: 10 },
  frameId: 1,
  timestamp: 0,
  backend: 'wasm',
})
const candidate = (frameId: number): Candidate => ({
  quad: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }],
  imageSize: { width: 10, height: 10 },
  frameId,
  timestamp: 0,
})

beforeEach(() => {
  instances.length = 0
  createScannerMock.mockClear()
})

describe('useBarcodeScanner', () => {
  it('creates the scanner lazily when the video ref appears, and rebuilds if it changes', async () => {
    const scope = effectScope()
    const v = ref<HTMLVideoElement | null>(null)
    const api = scope.run(() => useBarcodeScanner(v))!
    await nextTick()
    expect(createScannerMock).not.toHaveBeenCalled()
    expect(api.scanner.value).toBeNull()

    v.value = video()
    await nextTick()
    expect(createScannerMock).toHaveBeenCalledTimes(1)
    expect(api.scanner.value).toBe(instances[0])

    v.value = video()
    await nextTick()
    expect(instances[0]!.stop).toHaveBeenCalled()
    expect(createScannerMock).toHaveBeenCalledTimes(2)
    scope.stop()
  })

  it('strips callbacks from the options passed to core', async () => {
    const scope = effectScope()
    const v = ref<HTMLVideoElement | null>(video())
    scope.run(() => useBarcodeScanner(v, { formats: ['qr_code'], onDecoded: () => {}, autoStart: false }))
    await nextTick()
    expect(createScannerMock.mock.calls[0]![1]).toEqual({ formats: ['qr_code'] })
    scope.stop()
  })

  it('start() before the element exists waits and then starts', async () => {
    const scope = effectScope()
    const v = ref<HTMLVideoElement | null>(null)
    const api = scope.run(() => useBarcodeScanner(v))!
    const p = api.start()
    v.value = video()
    await nextTick()
    await p
    expect(instances[0]!.start).toHaveBeenCalledTimes(1)
    scope.stop()
  })

  it('autoStart starts once the element appears', async () => {
    const scope = effectScope()
    const v = ref<HTMLVideoElement | null>(video())
    scope.run(() => useBarcodeScanner(v, { autoStart: true }))
    await nextTick()
    expect(instances[0]!.start).toHaveBeenCalled()
    scope.stop()
  })

  it('mirrors events into refs and callbacks', async () => {
    const scope = effectScope()
    const v = ref<HTMLVideoElement | null>(video())
    const onDecoded = vi.fn()
    const onError = vi.fn()
    const onStateChange = vi.fn()
    const api = scope.run(() => useBarcodeScanner(v, { onDecoded, onError, onStateChange }))!
    await nextTick()
    const inst = instances[0]!

    inst.emit({ type: 'state', state: 'scanning', previous: 'starting' })
    expect(api.state.value).toBe('scanning')
    expect(api.backend.value).toBe('wasm')
    expect(onStateChange).toHaveBeenCalledWith('scanning', 'starting')

    inst.emit({ type: 'decoded', result: result('A') })
    expect(api.lastResult.value?.text).toBe('A')
    expect(onDecoded).toHaveBeenCalledWith(expect.objectContaining({ text: 'A' }))

    const err = Object.assign(new Error('permission-denied'), { name: 'ScannerError', code: 'permission-denied', recoverable: true })
    inst.emit({ type: 'error', error: err as never })
    expect(api.error.value?.code).toBe('permission-denied')
    expect(onError).toHaveBeenCalled()

    // 重新進入 scanning 會清掉 error
    inst.emit({ type: 'state', state: 'starting', previous: 'failed' })
    expect(api.error.value).toBeNull()

    inst.emit({
      type: 'camera',
      camera: { deviceId: 'x', label: 'Back', facing: 'environment' },
      capabilities: { torch: true, zoom: null, focusModes: [] },
      settings: { torch: false, zoom: null, focusMode: null, resolution: { width: 1, height: 1 }, frameRate: null },
    })
    expect(api.camera.value?.label).toBe('Back')
    expect(api.capabilities.value?.torch).toBe(true)
    scope.stop()
  })

  it('coalesces candidates per frame with rAF and clears them after the TTL', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame'] })
    try {
      const scope = effectScope()
      const v = ref<HTMLVideoElement | null>(video())
      const onCandidate = vi.fn()
      const api = scope.run(() => useBarcodeScanner(v, { onCandidate }))!
      await nextTick()
      const inst = instances[0]!

      inst.emit({ type: 'candidate', candidate: candidate(1) })
      inst.emit({ type: 'candidate', candidate: candidate(1) })
      inst.emit({ type: 'candidate', candidate: candidate(1) })
      expect(onCandidate).toHaveBeenCalledTimes(3)
      expect(api.candidates.value).toEqual([]) // 還沒 flush

      vi.advanceTimersToNextFrame()
      expect(api.candidates.value).toHaveLength(3) // 一次更新，三個候選

      inst.emit({ type: 'candidate', candidate: candidate(2) })
      vi.advanceTimersToNextFrame()
      expect(api.candidates.value).toHaveLength(1) // 新的一幀取代舊的

      vi.advanceTimersByTime(400)
      expect(api.candidates.value).toEqual([]) // TTL 到了清空
      scope.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('hot options changes flow into updateOptions', async () => {
    const scope = effectScope()
    const v = ref<HTMLVideoElement | null>(video())
    const opts = ref<{ formats: readonly BarcodeFormat[]; targetFps: number }>({ formats: ['qr_code'], targetFps: 15 })
    scope.run(() => useBarcodeScanner(v, opts))
    await nextTick()
    opts.value = { formats: ['ean_13'], targetFps: 15 }
    await nextTick()
    expect(instances[0]!.updateOptions).toHaveBeenLastCalledWith({ formats: ['ean_13'], targetFps: 15 })
    scope.stop()
  })

  it('delegates actions; toggleTorch flips the current setting', async () => {
    const scope = effectScope()
    const v = ref<HTMLVideoElement | null>(video())
    const api = scope.run(() => useBarcodeScanner(v))!
    await nextTick()
    const inst = instances[0]!
    api.pause()
    api.resume()
    await api.toggleTorch()
    await api.switchCamera()
    await api.setZoom(2)
    expect(inst.pause).toHaveBeenCalled()
    expect(inst.resume).toHaveBeenCalled()
    expect(inst.setTorch).toHaveBeenCalledWith(true)
    expect(inst.switchCamera).toHaveBeenCalledWith('next')
    expect(inst.setZoom).toHaveBeenCalledWith(2)
    scope.stop()
  })

  it('stops the scanner when the scope is disposed', async () => {
    const scope = effectScope()
    const v = ref<HTMLVideoElement | null>(video())
    const api = scope.run(() => useBarcodeScanner(v))!
    await nextTick()
    scope.stop()
    expect(instances[0]!.stop).toHaveBeenCalled()
    expect(api.scanner.value).toBeNull()
    expect(api.state.value).toBe('idle')
  })

  it('is safe without a scope and without a DOM (SSR-like import)', () => {
    const v = ref<HTMLVideoElement | null>(null)
    expect(() => useBarcodeScanner(v)).not.toThrow()
    expect(createScannerMock).not.toHaveBeenCalled()
  })
})

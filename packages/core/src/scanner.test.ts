import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeStream, fakeTrack, fakeVideoElement, installMediaDevices, domError } from './camera/test-fakes'
import type { DecodeOutput, DecoderPort } from './decoder/port'
import { rectToQuad } from './geometry'
import type { ScanEvent } from './types'

// 解碼器與 grabber 換成可控的假貨；相機層用 Phase 2 的 fake mediaDevices
const decodeMock = vi.fn<() => Promise<DecodeOutput>>()
const disposeMock = vi.fn(async () => {})
vi.mock('./decoder/select', () => ({
  selectBackend: vi.fn(async () => 'wasm'),
  createDecoderPort: vi.fn(async (): Promise<DecoderPort> => ({ backend: 'wasm', decode: decodeMock, dispose: disposeMock })),
}))
vi.mock('./camera/frame-grabber', () => ({
  createFrameGrabber: () => ({
    grab: vi.fn(async (_v: unknown, crop: unknown, _w: number, timestamp: number) => ({
      bitmap: { close: vi.fn() },
      crop,
      scale: 1,
      imageSize: { width: 1280, height: 720 },
      frameId: 0,
      timestamp,
    })),
    dispose: vi.fn(),
  }),
}))

import { createScanner } from './scanner'

export const empty: DecodeOutput = { results: [], located: [], decodeMs: 1 }
export const hit = (text: string): DecodeOutput => ({
  results: [{ text, format: 'qr_code', quad: rectToQuad({ x: 10, y: 10, width: 50, height: 50 }), rawBytes: null }],
  located: [],
  decodeMs: 2,
})

function setup(options = {}) {
  const md = installMediaDevices([{ deviceId: 'dev-main', label: 'Back Camera' }, { deviceId: 'front', label: 'Front Camera' }])
  md.getUserMedia.mockImplementation(async (c) => {
    const id = (c.video as MediaTrackConstraints).deviceId as { exact: string } | undefined
    return fakeStream(fakeTrack({ deviceId: id?.exact ?? 'dev-main', label: id?.exact === 'front' ? 'Front Camera' : 'Back Camera' }))
  })
  const video = fakeVideoElement()
  const scanner = createScanner(video, options)
  const events: ScanEvent[] = []
  scanner.subscribe((e) => events.push(e))
  const states = () => events.filter((e): e is Extract<ScanEvent, { type: 'state' }> => e.type === 'state').map((e) => e.state)
  const waitFor = (pred: () => boolean, ms = 500) =>
    new Promise<void>((resolve, reject) => {
      const t0 = Date.now()
      const tick = () => (pred() ? resolve() : Date.now() - t0 > ms ? reject(new Error('timeout')) : setTimeout(tick, 5))
      tick()
    })
  return { md, video, scanner, events, states, waitFor }
}

beforeEach(() => {
  decodeMock.mockReset()
  decodeMock.mockResolvedValue(empty)
  disposeMock.mockClear()
})

describe('scanner lifecycle', () => {
  it('start walks idle → requesting-permission → starting → scanning and exposes camera/backend', async () => {
    const { scanner, states, events } = setup()
    expect(scanner.state).toBe('idle')
    await scanner.start()
    expect(states()).toEqual(['requesting-permission', 'starting', 'scanning'])
    expect(scanner.backend).toBe('wasm')
    expect(scanner.camera?.deviceId).toBe('dev-main')
    expect(scanner.capabilities?.torch).toBe(true)
    expect(events.some((e) => e.type === 'camera')).toBe(true)
    await scanner.stop()
  })

  it('start is idempotent while starting/scanning', async () => {
    const { scanner } = setup()
    const p1 = scanner.start()
    const p2 = scanner.start()
    expect(p1).toBe(p2)
    await p1
    await expect(scanner.start()).resolves.toBeUndefined()
    await scanner.stop()
  })

  it('permission denied → failed, error event, and the same error rejects start()', async () => {
    const { scanner, md, events, states } = setup()
    md.getUserMedia.mockRejectedValueOnce(domError('NotAllowedError'))
    let thrown: unknown
    await scanner.start().catch((e) => (thrown = e))
    expect(states()).toEqual(['requesting-permission', 'failed'])
    const errEvent = events.find((e) => e.type === 'error')
    expect(errEvent && errEvent.type === 'error' && errEvent.error).toBe(thrown)
    expect((thrown as { code: string }).code).toBe('permission-denied')
    await scanner.start()
    expect(scanner.state).toBe('scanning')
    await scanner.stop()
  })

  it('stop is reentrant; stop during start aborts silently', async () => {
    const { scanner, events } = setup()
    await scanner.stop()
    expect(scanner.state).toBe('idle')
    const p = scanner.start()
    await scanner.stop()
    await p
    expect(scanner.state).toBe('stopped')
    expect(events.some((e) => e.type === 'error')).toBe(false)
    await scanner.stop()
    expect(scanner.state).toBe('stopped')
  })

  it('pause / resume are strict', async () => {
    const { scanner } = setup()
    expect(() => scanner.pause()).toThrow()
    expect(() => scanner.resume()).toThrow()
    await scanner.start()
    scanner.pause()
    expect(scanner.state).toBe('paused')
    expect(() => scanner.pause()).toThrowError(expect.objectContaining({ code: 'invalid-state', action: 'pause', state: 'paused' }))
    scanner.resume()
    expect(scanner.state).toBe('scanning')
    await scanner.stop()
  })

  it('switchCamera("next") goes through starting and back, keeping paused state', async () => {
    const { scanner, states } = setup()
    await scanner.start()
    scanner.pause()
    await scanner.switchCamera('next')
    expect(scanner.camera?.deviceId).toBe('front')
    expect(states().slice(-3)).toEqual(['starting', 'scanning', 'paused'])
    await scanner.stop()
  })
})

describe('scanner decoding pipeline', () => {
  it('emits decoded after debounceFrames consecutive hits, with candidates in between', async () => {
    const { scanner, events, waitFor } = setup({ debounceFrames: 2, targetFps: 0 })
    decodeMock.mockResolvedValue(hit('A'))
    await scanner.start()
    await waitFor(() => events.some((e) => e.type === 'decoded'))
    const cand = events.find((e) => e.type === 'candidate')
    expect(cand && cand.type === 'candidate' && cand.candidate.progress).toEqual({ seen: 1, required: 2 })
    const dec = events.find((e) => e.type === 'decoded')
    expect(dec && dec.type === 'decoded' && dec.result).toMatchObject({
      text: 'A',
      format: 'qr_code',
      backend: 'wasm',
      imageSize: { width: 1280, height: 720 },
    })
    await scanner.stop()
  })

  it('single mode picks the code closest to the ROI centre; multi reports all', async () => {
    const far = { text: 'far', format: 'qr_code' as const, quad: rectToQuad({ x: 0, y: 0, width: 40, height: 40 }), rawBytes: null }
    const near = { text: 'near', format: 'qr_code' as const, quad: rectToQuad({ x: 600, y: 320, width: 80, height: 80 }), rawBytes: null }
    decodeMock.mockResolvedValue({ results: [far, near], located: [], decodeMs: 1 })

    const single = setup({ debounceFrames: 0, targetFps: 0 })
    await single.scanner.start()
    await single.waitFor(() => single.events.some((e) => e.type === 'decoded'))
    await single.scanner.stop()
    const texts = single.events.filter((e) => e.type === 'decoded').map((e) => e.type === 'decoded' && e.result.text)
    expect(new Set(texts)).toEqual(new Set(['near']))

    const multi = setup({ debounceFrames: 0, targetFps: 0, multi: true })
    await multi.scanner.start()
    await multi.waitFor(() => multi.events.filter((e) => e.type === 'decoded').length >= 2)
    await multi.scanner.stop()
    const all = multi.events.filter((e) => e.type === 'decoded').map((e) => e.type === 'decoded' && e.result.text)
    expect(new Set(all)).toEqual(new Set(['far', 'near']))
  })

  it('located quads become text-less candidates', async () => {
    const { scanner, events, waitFor } = setup({ targetFps: 0 })
    decodeMock.mockResolvedValue({ results: [], located: [rectToQuad({ x: 0, y: 0, width: 5, height: 5 })], decodeMs: 1 })
    await scanner.start()
    await waitFor(() => events.some((e) => e.type === 'candidate'))
    const c = events.find((e) => e.type === 'candidate')
    expect(c && c.type === 'candidate' && c.candidate.text).toBeUndefined()
    await scanner.stop()
  })

  it('decoder crash → failed + error event, decoder disposed', async () => {
    const { scanner, events, waitFor } = setup({ targetFps: 0 })
    const { createDecoderError } = await import('./errors')
    decodeMock.mockRejectedValue(createDecoderError('decoder-crashed', 'wasm', true))
    await scanner.start()
    await waitFor(() => scanner.state === 'failed')
    const err = events.find((e) => e.type === 'error')
    expect(err && err.type === 'error' && err.error.code).toBe('decoder-crashed')
    expect(disposeMock).toHaveBeenCalled()
  })

  it('stats event when emitStats is on', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    try {
      const { scanner, events } = setup({ emitStats: true })
      await scanner.start()
      vi.advanceTimersByTime(1000)
      expect(events.some((e) => e.type === 'stats')).toBe(true)
      await scanner.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('updateOptions swaps roi/debounce without restart', async () => {
    const { scanner } = setup()
    await scanner.start()
    scanner.updateOptions({ roi: { x: 0.1, y: 0.1, width: 0.5, height: 0.5 }, debounceFrames: 0, targetFps: 5 })
    expect(scanner.options.roi).toEqual({ x: 0.1, y: 0.1, width: 0.5, height: 0.5 })
    expect(scanner.options.targetFps).toBe(5)
    expect(scanner.state).toBe('scanning')
    await scanner.stop()
  })
})

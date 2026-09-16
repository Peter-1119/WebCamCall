import { describe, expect, it, vi } from 'vitest'
import type { GrabbedFrame } from '../camera/frame-grabber'
import { createWasmDecoder } from './wasm'
import type { WorkerLike } from './wasm'
import type { RawResult, WorkerRequest, WorkerResponse } from './protocol'

/** 假 Worker：記錄收到的訊息，讓測試決定何時回什麼。 */
function fakeWorker(autoReady = true) {
  const sent: Array<{ msg: WorkerRequest; transfer?: Transferable[] }> = []
  const w: WorkerLike & { reply: (r: WorkerResponse) => void; crash: (m: string) => void; sent: typeof sent } = {
    sent,
    onmessage: null,
    onerror: null,
    terminate: vi.fn(),
    postMessage(msg, transfer) {
      sent.push(transfer ? { msg, transfer } : { msg })
      if (msg.type === 'init' && autoReady) queueMicrotask(() => w.reply({ type: 'ready' }))
    },
    reply(r) {
      w.onmessage?.({ data: r } as MessageEvent<WorkerResponse>)
    },
    crash(message) {
      w.onerror?.({ message } as ErrorEvent)
    },
  }
  return w
}

function fakeBitmap(w = 640, h = 360): ImageBitmap {
  return { width: w, height: h, close: vi.fn() } as unknown as ImageBitmap
}

function frame(overrides: Partial<GrabbedFrame> = {}): GrabbedFrame {
  return {
    bitmap: fakeBitmap(),
    crop: { x: 384, y: 324, width: 1152, height: 432 },
    scale: 640 / 1152,
    imageSize: { width: 1920, height: 1080 },
    frameId: 1,
    timestamp: 0,
    ...overrides,
  }
}

const raw = (over: Partial<RawResult> = {}): RawResult => ({
  text: 'hello',
  format: 'QRCode',
  isValid: true,
  topLeft: { x: 100, y: 50 },
  topRight: { x: 300, y: 50 },
  bottomRight: { x: 300, y: 250 },
  bottomLeft: { x: 100, y: 250 },
  bytes: new Uint8Array([1, 2]),
  ...over,
})

describe('wasm decoder', () => {
  it('sends init (with wasmUrl) and resolves once the worker is ready', async () => {
    const w = fakeWorker()
    const port = await createWasmDecoder({ wasmUrl: '/wasm/' }, { createWorker: () => w, offscreenCanvas: true })
    expect(w.sent[0]?.msg).toEqual({ type: 'init', wasmUrl: '/wasm/' })
    expect(port.backend).toBe('wasm')
  })

  it('init-error rejects with decoder-init-failed', async () => {
    const w = fakeWorker(false)
    const p = createWasmDecoder({}, { createWorker: () => w, offscreenCanvas: true })
    await Promise.resolve()
    w.reply({ type: 'init-error', message: 'fetch failed' })
    await expect(p).rejects.toMatchObject({ code: 'decoder-init-failed', backend: 'wasm', recoverable: true })
  })

  it('transfers the bitmap and maps results back to image space', async () => {
    const w = fakeWorker()
    const port = await createWasmDecoder({}, { createWorker: () => w, offscreenCanvas: true })
    const f = frame()
    const p = port.decode(f, { formats: ['qr_code', 'ean_13'], multi: false, tryHarder: false })

    const req = w.sent[1]!
    expect(req.msg).toMatchObject({ type: 'decode', formats: ['QRCode', 'EAN13'], maxSymbols: 4, tryHarder: false })
    expect(req.msg.type === 'decode' && req.msg.source.kind).toBe('bitmap')
    expect(req.transfer).toEqual([f.bitmap])

    const id = req.msg.type === 'decode' ? req.msg.id : -1
    w.reply({ type: 'result', id, results: [raw()], decodeMs: 12, dottedHit: false })
    const out = await p

    expect(out.decodeMs).toBe(12)
    expect(out.results).toHaveLength(1)
    const r = out.results[0]!
    expect(r.text).toBe('hello')
    expect(r.format).toBe('qr_code')
    expect(r.rawBytes).toEqual(new Uint8Array([1, 2]))
    // 100 / scale + crop.x
    expect(r.quad[0].x).toBeCloseTo(384 + 100 / f.scale)
    expect(r.quad[0].y).toBeCloseTo(324 + 50 / f.scale)
    expect(r.quad[2].x).toBeCloseTo(384 + 300 / f.scale)
  })

  it('invalid results become located quads; unknown formats are dropped', async () => {
    const w = fakeWorker()
    const port = await createWasmDecoder({}, { createWorker: () => w, offscreenCanvas: true })
    const p = port.decode(frame(), { formats: ['qr_code'], multi: true, tryHarder: true })
    const id = (w.sent[1]!.msg as { id: number }).id
    w.reply({
      type: 'result',
      id,
      results: [raw({ isValid: false, text: '', bytes: null }), raw({ format: 'DXFilmEdge' }), raw({ text: 'ok' })],
      decodeMs: 1,
      dottedHit: false,
    })
    const out = await p
    expect(out.located).toHaveLength(1)
    expect(out.results.map((r) => r.text)).toEqual(['ok'])
  })

  it('returns every valid result; single-mode selection happens in the scanner', async () => {
    const w = fakeWorker()
    const port = await createWasmDecoder({}, { createWorker: () => w, offscreenCanvas: true })
    const p = port.decode(frame(), { formats: ['qr_code'], multi: false, tryHarder: false })
    const id = (w.sent[1]!.msg as { id: number }).id
    w.reply({ type: 'result', id, results: [raw({ text: 'a' }), raw({ text: 'b' })], decodeMs: 1, dottedHit: false })
    expect((await p).results.map((r) => r.text)).toEqual(['a', 'b'])
  })

  it('decode-error for a frame yields an empty result, not a rejection', async () => {
    const w = fakeWorker()
    const port = await createWasmDecoder({}, { createWorker: () => w, offscreenCanvas: true })
    const p = port.decode(frame(), { formats: ['qr_code'], multi: false, tryHarder: false })
    const id = (w.sent[1]!.msg as { id: number }).id
    w.reply({ type: 'decode-error', id, message: 'bad image' })
    expect((await p).results).toEqual([])
  })

  it('worker crash rejects pending decodes with decoder-crashed and poisons the port', async () => {
    const w = fakeWorker()
    const port = await createWasmDecoder({}, { createWorker: () => w, offscreenCanvas: true })
    const p = port.decode(frame(), { formats: ['qr_code'], multi: false, tryHarder: false })
    w.crash('boom')
    await expect(p).rejects.toMatchObject({ code: 'decoder-crashed' })
    const f = frame()
    await expect(port.decode(f, { formats: ['qr_code'], multi: false, tryHarder: false })).rejects.toMatchObject({ code: 'decoder-crashed' })
    expect(f.bitmap.close).toHaveBeenCalled()
  })

  it('dispose terminates the worker and is reentrant', async () => {
    const w = fakeWorker()
    const port = await createWasmDecoder({}, { createWorker: () => w, offscreenCanvas: true })
    await port.dispose()
    await port.dispose()
    expect(w.terminate).toHaveBeenCalledTimes(1)
    expect(w.sent.at(-1)?.msg).toEqual({ type: 'dispose' })
  })
})

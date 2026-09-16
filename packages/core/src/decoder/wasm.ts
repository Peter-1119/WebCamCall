import type { GrabbedFrame } from '../camera/frame-grabber'
import { createDecoderError } from '../errors'
import { toImageSpace } from '../geometry'
import type { Quad, WasmOptions } from '../types'
import { fromZxingFormat, toZxingFormats } from './format-map'
import type { DecodedSymbol, DecodeOutput, DecoderPort, DecodeRequest } from './port'
import type { DecodeSource, RawResult, WorkerRequest, WorkerResponse } from './protocol'

/** Worker 沒回應多久算掛掉。wasm 解一幀通常 < 100ms；5 秒是 Worker 死掉或 OOM 的訊號。 */
const DECODE_TIMEOUT_MS = 5000
/** 首次載入 WASM 的上限（含下載 ~1 MB）。 */
const INIT_TIMEOUT_MS = 30000

/** 最小化的 Worker 介面，方便測試注入假 Worker。 */
export interface WorkerLike {
  postMessage(message: WorkerRequest, transfer?: Transferable[]): void
  terminate(): void
  onmessage: ((event: MessageEvent<WorkerResponse>) => void) | null
  onerror: ((event: ErrorEvent) => void) | null
}

export interface WasmDecoderDeps {
  readonly createWorker: () => WorkerLike
  /** 主執行緒能否指望 Worker 內有 OffscreenCanvas。 */
  readonly offscreenCanvas: boolean
}

/**
 * 預設的 Worker 建立方式。`./wasm-worker.js` 由 tsup 輸出在 dist/index.js 旁邊；
 * Vite / webpack 5 / Rollup 都認得 `new URL(..., import.meta.url)`。
 * bundler 搞不定時用 `wasm.createWorker` 自行提供。
 */
function defaultCreateWorker(): WorkerLike {
  let url: URL
  try {
    // 必須維持這個字面寫法：Vite / webpack 5 / Rollup 靠靜態分析把 worker 檔當資源打包
    url = new URL('./wasm-worker.js', import.meta.url)
  } catch (err) {
    // CJS bundle 沒有 import.meta.url（esbuild 會換成空物件）：沒辦法定位 worker 檔
    throw createDecoderError('decoder-init-failed', 'wasm', false, 'import.meta.url unavailable; provide options.wasm.createWorker')
  }
  return new Worker(url, { type: 'module' }) as unknown as WorkerLike
}

function rawToQuad(r: RawResult, frame: GrabbedFrame): Quad<'image'> {
  const q: Quad<'image'> = [r.topLeft, r.topRight, r.bottomRight, r.bottomLeft]
  return toImageSpace(q, frame.crop, frame.scale)
}

/**
 * fallback 用：主執行緒把 bitmap 讀成像素。只在 Worker 沒有 OffscreenCanvas 時走到這裡。
 * canvas 重用；`getImageData` 的配置無法避免，但 buffer 會 transfer 出去，不留在主執行緒。
 */
function createPixelReader() {
  let canvas: HTMLCanvasElement | null = null
  let ctx: CanvasRenderingContext2D | null = null
  return (bitmap: ImageBitmap): DecodeSource => {
    if (!canvas) {
      canvas = document.createElement('canvas')
      ctx = canvas.getContext('2d', { alpha: false, willReadFrequently: true })
    }
    if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
      canvas.width = bitmap.width
      canvas.height = bitmap.height
    }
    ctx!.drawImage(bitmap, 0, 0)
    bitmap.close()
    const data = ctx!.getImageData(0, 0, canvas.width, canvas.height)
    return { kind: 'pixels', data: data.data.buffer, width: canvas.width, height: canvas.height }
  }
}

export async function createWasmDecoder(
  options: WasmOptions,
  deps: WasmDecoderDeps = {
    createWorker: options.createWorker ? () => options.createWorker!() as unknown as WorkerLike : defaultCreateWorker,
    offscreenCanvas: typeof OffscreenCanvas !== 'undefined',
  },
): Promise<DecoderPort> {
  const worker = deps.createWorker()
  const readPixels = deps.offscreenCanvas ? null : createPixelReader()
  let nextId = 1
  let dead = false
  const pending = new Map<number, { resolve: (r: WorkerResponse) => void; reject: (e: unknown) => void; timer: ReturnType<typeof setTimeout> }>()
  let onReady: { resolve: () => void; reject: (e: unknown) => void } | null = null

  function failAll(err: unknown) {
    dead = true
    for (const [, p] of pending) {
      clearTimeout(p.timer)
      p.reject(err)
    }
    pending.clear()
    onReady?.reject(err)
    onReady = null
  }

  worker.onmessage = (event) => {
    const msg = event.data
    switch (msg.type) {
      case 'ready':
        onReady?.resolve()
        onReady = null
        break
      case 'init-error':
        onReady?.reject(createDecoderError('decoder-init-failed', 'wasm', true, msg.message))
        onReady = null
        break
      case 'result':
      case 'decode-error': {
        const p = pending.get(msg.id)
        if (!p) return
        pending.delete(msg.id)
        clearTimeout(p.timer)
        p.resolve(msg)
        break
      }
    }
  }
  worker.onerror = (event) => {
    failAll(createDecoderError('decoder-crashed', 'wasm', true, event.message ?? event))
  }

  // init：等 WASM 載好才把 port 交出去，讓 'starting' 狀態涵蓋下載時間
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => {
        onReady = null
        reject(createDecoderError('decoder-init-failed', 'wasm', true, 'timeout'))
      },
      INIT_TIMEOUT_MS,
    )
    onReady = {
      resolve: () => {
        clearTimeout(timer)
        resolve()
      },
      reject: (e) => {
        clearTimeout(timer)
        reject(e)
      },
    }
    const init: WorkerRequest = options.wasmUrl ? { type: 'init', wasmUrl: options.wasmUrl } : { type: 'init' }
    worker.postMessage(init)
  })

  async function decode(frame: GrabbedFrame, request: DecodeRequest): Promise<DecodeOutput> {
    if (dead) {
      frame.bitmap.close()
      throw createDecoderError('decoder-crashed', 'wasm', true)
    }
    const id = nextId++
    const source: DecodeSource = readPixels ? readPixels(frame.bitmap) : { kind: 'bitmap', bitmap: frame.bitmap }
    const transfer: Transferable[] = source.kind === 'bitmap' ? [source.bitmap] : [source.data]

    const response = await new Promise<WorkerResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        failAll(createDecoderError('decoder-crashed', 'wasm', true, 'timeout'))
      }, DECODE_TIMEOUT_MS)
      pending.set(id, { resolve, reject, timer })
      worker.postMessage(
        { type: 'decode', id, source, formats: toZxingFormats(request.formats), maxSymbols: request.multi ? 255 : 4, tryHarder: request.tryHarder },
        transfer,
      )
    })

    if (response.type !== 'result') {
      // 單幀解碼錯誤（例如影像壞掉）不是致命錯誤：當成沒結果
      return { results: [], located: [], decodeMs: 0 }
    }

    const results: DecodedSymbol[] = []
    const located: Quad<'image'>[] = []
    for (const r of response.results) {
      const quad = rawToQuad(r, frame)
      if (!r.isValid) {
        located.push(quad)
        continue
      }
      const format = fromZxingFormat(r.format)
      if (!format) continue
      results.push({ text: r.text, format, quad, rawBytes: r.bytes })
    }
    return { results, located, decodeMs: response.decodeMs }
  }

  let disposed = false
  async function dispose() {
    if (disposed) return
    disposed = true
    failAll(createDecoderError('decoder-crashed', 'wasm', true, 'disposed'))
    try {
      worker.postMessage({ type: 'dispose' })
    } catch {
      /* worker 已死 */
    }
    worker.terminate()
  }

  return { backend: 'wasm', decode, dispose }
}

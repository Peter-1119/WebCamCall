import type { GrabbedFrame } from '../camera/frame-grabber'
import { createDecoderError } from '../errors'
import { toImageSpace } from '../geometry'
import type { Quad, Rect, WasmOptions } from '../types'
import { fromZxingFormat, toZxingFormats } from './format-map'
import type { DottedVariant } from './morphology'
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
  /**
   * 第一順位的 Worker 載不起來（檔案 404 等）時依序再試的候選。
   * 預設只有一個：Vite dev 的 pre-bundle 備援路徑（見 devDepsWorkerUrl）。
   */
  readonly fallbackWorkers?: readonly { readonly label: string; readonly create: () => WorkerLike }[]
  /** 主執行緒能否指望 Worker 內有 OffscreenCanvas。 */
  readonly offscreenCanvas: boolean
}

/**
 * 預設的 Worker 位置：`./wasm-worker.js` 由 tsup 輸出在 dist/index.js 旁邊；
 * Vite / webpack 5 / Rollup 都認得 `new URL(..., import.meta.url)`。
 * bundler 搞不定時用 `wasm.workerUrl` 或 `wasm.createWorker` 自行提供。
 */
function siblingWorkerUrl(): URL {
  try {
    // 必須維持這個字面寫法：Vite / webpack 5 / Rollup 靠靜態分析把 worker 檔當資源打包
    return new URL('./wasm-worker.js', import.meta.url)
  } catch {
    // CJS bundle 沒有 import.meta.url（esbuild 會換成空物件）：沒辦法定位 worker 檔
    throw createDecoderError('decoder-init-failed', 'wasm', false, 'import.meta.url unavailable; set options.wasm.workerUrl or options.wasm.createWorker')
  }
}

/**
 * Vite **dev 模式**的備援路徑。
 *
 * Vite 會把 node_modules 的套件 pre-bundle 到 `node_modules/.vite/deps/`，但**不會**把
 * `wasm-worker.js` 一起複製過去；`new URL('./wasm-worker.js', import.meta.url)` 於是指向
 * `/node_modules/.vite/deps/wasm-worker.js` → 404 → Worker 載入失敗。
 * production build 不受影響（Rollup 會把 Worker 正確打包）。
 *
 * 偵測到自己正在 `.vite/deps/` 裡執行時，改指回套件真正的 dist 路徑再試一次。
 * 正解仍是在 vite.config 加 `optimizeDeps.exclude`，這裡只是讓它不要直接壞掉。
 */
function devDepsWorkerUrl(): URL | null {
  let here: string
  try {
    here = import.meta.url
  } catch {
    return null
  }
  if (!here.includes('/.vite/deps/')) return null
  try {
    return new URL('../../@cclemon/scanner-core/dist/wasm-worker.js', here)
  } catch {
    return null
  }
}

function newModuleWorker(url: string | URL): WorkerLike {
  return new Worker(url, { type: 'module' }) as unknown as WorkerLike
}

function rawToQuad(r: RawResult, frame: { readonly crop: Rect; readonly scale: number }): Quad<'image'> {
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

function defaultDeps(options: WasmOptions): WasmDecoderDeps {
  const fallbacks: { label: string; create: () => WorkerLike }[] = []
  if (!options.createWorker && !options.workerUrl) {
    const dev = devDepsWorkerUrl()
    if (dev) fallbacks.push({ label: dev.href, create: () => newModuleWorker(dev) })
  }
  const create = options.createWorker
    ? () => options.createWorker!() as unknown as WorkerLike
    : options.workerUrl
      ? () => newModuleWorker(options.workerUrl!)
      : () => newModuleWorker(siblingWorkerUrl())
  return { createWorker: create, fallbackWorkers: fallbacks, offscreenCanvas: typeof OffscreenCanvas !== 'undefined' }
}

export async function createWasmDecoder(options: WasmOptions, deps: WasmDecoderDeps = defaultDeps(options)): Promise<DecoderPort> {
  const readPixels = deps.offscreenCanvas ? null : createPixelReader()
  let worker: WorkerLike
  let nextId = 1
  let dead = false
  let ready = false
  const pending = new Map<number, { resolve: (r: WorkerResponse) => void; reject: (e: unknown) => void; timer: ReturnType<typeof setTimeout> }>()
  let onReady: { resolve: () => void; reject: (e: unknown) => void } | null = null
  let onLoadError: ((detail: string) => void) | null = null

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

  const onMessage = (event: MessageEvent<WorkerResponse>) => {
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
  /**
   * Worker 自己出錯。**init 完成前**幾乎都是「Worker 檔案載不起來」（404、MIME 不對、語法錯），
   * 那是**載入失敗**不是 crash：回報 `decoder-init-failed` 並換下一個候選路徑。
   * init 之後才是真的跑掛了 → `decoder-crashed`。
   */
  const onError = (event: ErrorEvent) => {
    const detail = event?.message ?? String(event ?? 'worker error')
    if (ready) failAll(createDecoderError('decoder-crashed', 'wasm', true, detail))
    else onLoadError?.(detail)
  }

  function attach(w: WorkerLike) {
    w.onmessage = onMessage
    w.onerror = onError
  }

  /** 用一個候選建立 Worker 並跑 init；回傳 null = Worker 檔載不起來，可以換下一個候選。 */
  async function tryStart(create: () => WorkerLike): Promise<WorkerLike | null> {
    const w = create()
    attach(w)
    const loadError = await new Promise<string | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        onReady = null
        onLoadError = null
        reject(createDecoderError('decoder-init-failed', 'wasm', true, 'timeout'))
      }, INIT_TIMEOUT_MS)
      const done = () => {
        clearTimeout(timer)
        onReady = null
        onLoadError = null
      }
      onReady = {
        resolve: () => {
          done()
          resolve(null)
        },
        reject: (e) => {
          done()
          reject(e)
        },
      }
      onLoadError = (detail) => {
        done()
        resolve(detail)
      }
      const init: WorkerRequest = options.wasmUrl ? { type: 'init', wasmUrl: options.wasmUrl } : { type: 'init' }
      w.postMessage(init)
    })
    if (loadError === null) return w
    w.terminate()
    return null
  }

  // init：等 WASM 載好才把 port 交出去，讓 'starting' 狀態涵蓋下載時間。
  // Worker 檔載不起來時依序試備援路徑（Vite dev 的 pre-bundle 會讓同目錄路徑 404）。
  {
    const candidates = [{ label: 'sibling of core dist', create: deps.createWorker }, ...(deps.fallbackWorkers ?? [])]
    const tried: string[] = []
    let started: WorkerLike | null = null
    for (const c of candidates) {
      started = await tryStart(c.create)
      if (started) {
        if (tried.length) {
          // 開發者警告（非使用者文案）：能跑，但靠的是備援路徑
          console.warn(
            `[scanner] worker script not found at ${tried.join(', ')}; using ${c.label}. ` +
              "Vite dev: add optimizeDeps: { exclude: ['@cclemon/scanner-core', '@cclemon/scanner-vue', '@cclemon/scanner-ui'] }, or set options.wasm.workerUrl.",
          )
        }
        break
      }
      tried.push(c.label)
    }
    if (!started) {
      throw createDecoderError(
        'decoder-init-failed',
        'wasm',
        false,
        `worker script failed to load [tried: ${tried.join(' -> ')}]. ` +
          "Vite dev: add optimizeDeps: { exclude: ['@cclemon/scanner-core', '@cclemon/scanner-vue', '@cclemon/scanner-ui'] }; otherwise set options.wasm.workerUrl or options.wasm.createWorker.",
      )
    }
    worker = started
    ready = true
  }

  async function decode(frame: GrabbedFrame, request: DecodeRequest): Promise<DecodeOutput> {
    if (dead) {
      frame.bitmap.close()
      throw createDecoderError('decoder-crashed', 'wasm', true)
    }
    const id = nextId++
    const source: DecodeSource = readPixels ? readPixels(frame.bitmap) : { kind: 'bitmap', bitmap: frame.bitmap }
    const transfer: Transferable[] = source.kind === 'bitmap' ? [source.bitmap] : [source.data]
    let aux: { source: DecodeSource; variants: readonly DottedVariant[]; maxMs: number } | undefined
    if (frame.aux) {
      if (request.aux) {
        const auxSource: DecodeSource = readPixels ? readPixels(frame.aux.bitmap) : { kind: 'bitmap', bitmap: frame.aux.bitmap }
        transfer.push(auxSource.kind === 'bitmap' ? auxSource.bitmap : auxSource.data)
        aux = { source: auxSource, variants: request.aux.variants, maxMs: request.aux.maxMs }
      } else frame.aux.bitmap.close()
    }

    const response = await new Promise<WorkerResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        failAll(createDecoderError('decoder-crashed', 'wasm', true, 'timeout'))
      }, DECODE_TIMEOUT_MS)
      pending.set(id, { resolve, reject, timer })
      worker.postMessage(
        {
          type: 'decode',
          id,
          source,
          formats: toZxingFormats(request.formats),
          maxSymbols: request.multi ? 255 : 4,
          tryHarder: request.tryHarder,
          ...(request.dotted ? { dotted: Array.isArray(request.dotted) ? request.dotted : [request.dotted] } : {}),
          ...(request.maxMs !== undefined ? { maxMs: request.maxMs } : {}),
          ...(request.locate ? { locate: request.locate } : {}),
          ...(aux ? { aux } : {}),
        },
        transfer,
      )
    })

    if (response.type !== 'result') {
      // 單幀解碼錯誤（例如影像壞掉）不是致命錯誤：當成沒結果
      return { results: [], located: [], decodeMs: 0 }
    }

    const results: DecodedSymbol[] = []
    const located: Quad<'image'>[] = []
    // aux 的結果用 aux 的 crop / scale 換算
    const space = response.fromAux && frame.aux ? frame.aux : frame
    for (const r of response.results) {
      const quad = rawToQuad(r, space)
      if (!r.isValid) {
        located.push(quad)
        continue
      }
      const format = fromZxingFormat(r.format)
      if (!format) continue
      results.push({ text: r.text, format, quad, rawBytes: r.bytes })
    }
    // 點密度候選：解碼影像座標 → 原始影像座標（正方形，邊長 2.4 × window）
    let candidates: Rect[] | undefined
    if (response.candidates && request.locate) {
      const side = (2.4 * request.locate.window) / frame.scale
      candidates = response.candidates.map((c) => ({
        x: frame.crop.x + c.cx / frame.scale - side / 2,
        y: frame.crop.y + c.cy / frame.scale - side / 2,
        width: side,
        height: side,
      }))
    }
    return {
      results,
      located,
      decodeMs: response.decodeMs,
      dottedHit: response.dottedHit,
      ...(response.dottedVariant ? { dottedVariant: response.dottedVariant } : {}),
      ...(candidates ? { candidates } : {}),
      ...(response.fromAux ? { fromAux: true } : {}),
      ...(response.auxMiss ? { auxMiss: true } : {}),
    }
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

/**
 * wasm 解碼 Worker。獨立 entry，build 時把 zxing-wasm 的 JS glue 一起 bundle 進來
 * （module worker 不能 import bare specifier）。`.wasm` 檔由 `wasmUrl` 或 zxing-wasm 預設的 CDN 提供。
 *
 * 每幀熱路徑：
 * - OffscreenCanvas 重用，只在尺寸改變時重設
 * - `drawImage(bitmap)` + `getImageData()`：唯一的 GPU→CPU 讀回，已離開主執行緒
 * - `readBarcodes(ImageData)`：zxing-wasm 內部會 copy 進 WASM heap，這步無法避免（它的 API 如此）
 * - 結果的 `bytes` buffer transfer 回主執行緒
 */
import { prepareZXingModule, readBarcodes } from 'zxing-wasm/reader'
import type { ReaderOptions, ReadResult } from 'zxing-wasm/reader'
import type { DecodeSource, RawResult, WorkerRequest, WorkerResponse } from './protocol'
import { resolveWasmFile } from './protocol'

// 不引入 webworker lib（會與 DOM lib 衝突），只宣告用到的部分
interface WorkerScope {
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null
  postMessage(message: WorkerResponse, transfer?: Transferable[]): void
  close(): void
}
const scope = self as unknown as WorkerScope

let canvas: OffscreenCanvas | null = null
let ctx: OffscreenCanvasRenderingContext2D | null = null

function toImageData(source: DecodeSource): ImageData {
  if (source.kind === 'pixels') {
    return new ImageData(new Uint8ClampedArray(source.data), source.width, source.height)
  }
  const { bitmap } = source
  const w = bitmap.width
  const h = bitmap.height
  if (!canvas) {
    canvas = new OffscreenCanvas(w, h)
    ctx = canvas.getContext('2d', { alpha: false, willReadFrequently: true })
  }
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w
    canvas.height = h
  }
  ctx!.drawImage(bitmap, 0, 0)
  bitmap.close()
  return ctx!.getImageData(0, 0, w, h)
}

function toRaw(r: ReadResult): RawResult {
  const p = r.position
  return {
    text: r.text,
    format: r.format,
    isValid: r.isValid,
    topLeft: { x: p.topLeft.x, y: p.topLeft.y },
    topRight: { x: p.topRight.x, y: p.topRight.y },
    bottomRight: { x: p.bottomRight.x, y: p.bottomRight.y },
    bottomLeft: { x: p.bottomLeft.x, y: p.bottomLeft.y },
    bytes: r.isValid && r.bytes.length > 0 ? r.bytes : null,
  }
}

async function handleInit(wasmUrl: string | undefined) {
  const file = resolveWasmFile(wasmUrl, 'zxing_reader.wasm')
  try {
    await prepareZXingModule({
      overrides: file
        ? { locateFile: (path: string, prefix: string) => (path.endsWith('.wasm') ? file : prefix + path) }
        : {},
      fireImmediately: true,
    })
    scope.postMessage({ type: 'ready' })
  } catch (err) {
    scope.postMessage({ type: 'init-error', message: err instanceof Error ? err.message : String(err) })
  }
}

async function handleDecode(req: Extract<WorkerRequest, { type: 'decode' }>) {
  try {
    const image = toImageData(req.source)
    const options: ReaderOptions = {
      formats: [...req.formats] as NonNullable<ReaderOptions['formats']>,
      tryHarder: req.tryHarder,
      tryRotate: true,
      tryInvert: true,
      // 縮放由主執行緒的 decodeScale 階梯負責，不讓 zxing 自己再縮一次
      tryDownscale: false,
      // 要「找到位置但解不出」的結果，餵給候選放大
      returnErrors: true,
      maxNumberOfSymbols: req.maxSymbols,
    }
    const t0 = performance.now()
    const raw = await readBarcodes(image, options)
    const decodeMs = performance.now() - t0
    const results = raw.map(toRaw)
    const transfer: Transferable[] = []
    for (const r of results) if (r.bytes) transfer.push(r.bytes.buffer)
    scope.postMessage({ type: 'result', id: req.id, results, decodeMs }, transfer)
  } catch (err) {
    scope.postMessage({ type: 'decode-error', id: req.id, message: err instanceof Error ? err.message : String(err) })
  }
}

scope.onmessage = (event) => {
  const msg = event.data
  switch (msg.type) {
    case 'init':
      void handleInit(msg.wasmUrl)
      break
    case 'decode':
      void handleDecode(msg)
      break
    case 'dispose':
      canvas = null
      ctx = null
      scope.close()
      break
  }
}

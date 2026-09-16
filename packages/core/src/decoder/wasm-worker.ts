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
import { prepareZXingModule, purgeZXingModule, readBarcodes } from 'zxing-wasm/reader'
import type { ReaderOptions, ReadResult } from 'zxing-wasm/reader'
import { dilateDots, grayToRgba, rgbaToGray } from './morphology'
import type { MorphScratch } from './morphology'
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

// 點陣膨脹用的重用 buffer（避免每幀配置）
let grayBuf: Uint8Array | undefined
let morphScratch: MorphScratch | undefined
let rgbaBuf: Uint8ClampedArray | undefined

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

/**
 * wasm 檔的位置，依序嘗試：
 * 1. 呼叫端指定的 `wasmUrl`
 * 2. **與這個 worker 檔同目錄的 `zxing_reader.wasm`**（core 0.1.2+ 的 dist 內附；
 *    Vite / webpack 打包 worker 時會連帶把它當資源打進去，使用者零設定）
 * 3. zxing-wasm 預設的 jsDelivr CDN（有外網的環境才會成功）
 */
function candidateWasmFiles(wasmUrl: string | undefined): Array<string | undefined> {
  const explicit = resolveWasmFile(wasmUrl, 'zxing_reader.wasm')
  if (explicit) return [explicit]
  let sibling: string | undefined
  try {
    // 必須維持字面寫法，bundler 才會把 wasm 當資源處理
    sibling = new URL('./zxing_reader.wasm', import.meta.url).href
  } catch {
    sibling = undefined
  }
  return [sibling, undefined] // undefined = CDN 預設
}

async function tryPrepare(file: string | undefined) {
  await prepareZXingModule({
    overrides: file
      ? { locateFile: (path: string, prefix: string) => (path.endsWith('.wasm') ? file : prefix + path) }
      : {},
    fireImmediately: true,
  })
}

async function handleInit(wasmUrl: string | undefined) {
  const tried: string[] = []
  let lastErr: unknown
  for (const file of candidateWasmFiles(wasmUrl)) {
    const label = file ?? 'default CDN'
    try {
      await tryPrepare(file)
      if (!file && tried.length) {
        // 開發者警告（非使用者文案）：能跑但靠的是外網 CDN，內網部署會失敗。
        // Vite 專案請 `import wasmUrl from '@cclemon/scanner-core/zxing_reader.wasm?url'` 傳進 wasmUrl。
        console.warn(`[scanner] zxing_reader.wasm not found at ${tried.join(', ')}; fell back to CDN. Set options.wasm.wasmUrl for offline deployments.`)
      }
      scope.postMessage({ type: 'ready' })
      return
    } catch (err) {
      lastErr = err
      tried.push(label)
      purgeZXingModule() // 清掉失敗的實例才能換位置重試
    }
  }
  scope.postMessage({
    type: 'init-error',
    message: `${lastErr instanceof Error ? lastErr.message : String(lastErr)} [wasm tried: ${tried.join(' → ')}; set options.wasm.wasmUrl to self-host]`,
  })
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
    let raw = await readBarcodes(image, options)
    let dottedHit = false

    // 點陣式（DPM）第二次嘗試：正常解不出時，膨脹圓點成方塊再解一次
    if (req.dotted && !raw.some((r) => r.isValid)) {
      const n = image.width * image.height
      grayBuf = rgbaToGray(image.data, grayBuf && grayBuf.length === n ? grayBuf : undefined)
      if (!morphScratch || morphScratch.a.length !== n) morphScratch = { a: new Uint8Array(n), b: new Uint8Array(n) }
      const dilated = dilateDots(grayBuf, image.width, image.height, req.dotted, morphScratch)
      rgbaBuf = grayToRgba(dilated, rgbaBuf && rgbaBuf.length === n * 4 ? rgbaBuf : undefined)
      // TS 5.9 的 ImageData 要求 ArrayBuffer-backed 陣列；我們的 buffer 就是，這裡只是型別收窄
      const second = await readBarcodes(new ImageData(rgbaBuf as Uint8ClampedArray<ArrayBuffer>, image.width, image.height), options)
      if (second.some((r) => r.isValid)) {
        raw = second
        dottedHit = true
      } else if (raw.length === 0) {
        raw = second // 至少把「有定位」的候選帶回去
      }
    }

    const decodeMs = performance.now() - t0
    const results = raw.map(toRaw)
    const transfer: Transferable[] = []
    for (const r of results) if (r.bytes) transfer.push(r.bytes.buffer)
    scope.postMessage({ type: 'result', id: req.id, results, decodeMs, dottedHit }, transfer)
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

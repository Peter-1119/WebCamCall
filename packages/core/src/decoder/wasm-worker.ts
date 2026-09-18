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
import { dilateDots, grayToRgba, locateDotClusters, rgbaToGray } from './morphology'
import type { DotCluster, DottedVariant, MorphScratch } from './morphology'
import type { DecodeSource, RawResult, WorkerRequest, WorkerResponse } from './protocol'
import { resolveWasmFile } from './protocol'

// 不引入 webworker lib（會與 DOM lib 衝突），只宣告用到的部分
interface WorkerScope {
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null
  postMessage(message: WorkerResponse, transfer?: Transferable[]): void
  close(): void
}
const scope = self as unknown as WorkerScope

// 主幀與 aux 裁切各一組 canvas（尺寸不同，共用會每幀重設 backing store）
interface CanvasSlot {
  canvas: OffscreenCanvas | null
  ctx: OffscreenCanvasRenderingContext2D | null
}
const mainSlot: CanvasSlot = { canvas: null, ctx: null }
const auxSlot: CanvasSlot = { canvas: null, ctx: null }

// 點陣膨脹用的重用 buffer（避免每幀配置）
let grayBuf: Uint8Array | undefined
let morphScratch: MorphScratch | undefined
let rgbaBuf: Uint8ClampedArray | undefined

function toImageData(source: DecodeSource, slot: CanvasSlot = mainSlot): ImageData {
  if (source.kind === 'pixels') {
    return new ImageData(new Uint8ClampedArray(source.data), source.width, source.height)
  }
  const { bitmap } = source
  const w = bitmap.width
  const h = bitmap.height
  if (!slot.canvas) {
    slot.canvas = new OffscreenCanvas(w, h)
    slot.ctx = slot.canvas.getContext('2d', { alpha: false, willReadFrequently: true })
  }
  if (slot.canvas.width !== w || slot.canvas.height !== h) {
    slot.canvas.width = w
    slot.canvas.height = h
  }
  slot.ctx!.drawImage(bitmap, 0, 0)
  bitmap.close()
  return slot.ctx!.getImageData(0, 0, w, h)
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

/** 候選裁切用的小 buffer（尺寸隨候選變，重用） */
let cropGray: Uint8Array | undefined
let cropScratch: MorphScratch | undefined
let cropRgba: Uint8ClampedArray | undefined

/**
 * 對每個候選以 `side` 邊長從 `gray` 裁一塊，原圖 + 各變體依序解；命中就把座標加回裁切位移後回傳。
 * 裁切很小（~160²），每個變體 < 5 ms；`deadline` 到就停。
 */
async function decodeCandidates(
  gray: Uint8Array,
  width: number,
  height: number,
  candidates: readonly DotCluster[],
  side: number,
  variants: readonly DottedVariant[],
  options: ReaderOptions,
  deadline: number,
): Promise<{ results: ReadResult[]; variant?: DottedVariant } | null> {
  const s = Math.min(side, width, height)
  const n = s * s
  if (!cropGray || cropGray.length !== n) {
    cropGray = new Uint8Array(n)
    cropScratch = { a: new Uint8Array(n), b: new Uint8Array(n) }
    cropRgba = new Uint8ClampedArray(n * 4)
  }
  for (const c of candidates) {
    const x0 = Math.min(Math.max(0, Math.round(c.cx - s / 2)), width - s)
    const y0 = Math.min(Math.max(0, Math.round(c.cy - s / 2)), height - s)
    for (let y = 0; y < s; y++) cropGray.set(gray.subarray((y0 + y) * width + x0, (y0 + y) * width + x0 + s), y * s)
    const tryRead = async (g: Uint8Array) => {
      const rgba = grayToRgba(g, cropRgba)
      const res = await readBarcodes(new ImageData(rgba as Uint8ClampedArray<ArrayBuffer>, s, s), options)
      return res.filter((r) => r.isValid)
    }
    const offset = (r: ReadResult): ReadResult => ({
      ...r,
      position: {
        topLeft: { x: r.position.topLeft.x + x0, y: r.position.topLeft.y + y0 },
        topRight: { x: r.position.topRight.x + x0, y: r.position.topRight.y + y0 },
        bottomRight: { x: r.position.bottomRight.x + x0, y: r.position.bottomRight.y + y0 },
        bottomLeft: { x: r.position.bottomLeft.x + x0, y: r.position.bottomLeft.y + y0 },
      },
    })
    let ok = await tryRead(cropGray)
    if (ok.length) return { results: ok.map(offset) }
    for (const variant of variants) {
      if (performance.now() > deadline) return null
      ok = await tryRead(dilateDots(cropGray, s, s, variant, cropScratch))
      if (ok.length) return { results: ok.map(offset), variant }
    }
  }
  return null
}

/** aux 裁切用的重用 buffer */
let auxGray: Uint8Array | undefined
let auxScratch: MorphScratch | undefined
let auxRgba: Uint8ClampedArray | undefined

async function handleDecode(req: Extract<WorkerRequest, { type: 'decode' }>) {
  try {
    const options: ReaderOptions = {
      formats: [...req.formats] as NonNullable<ReaderOptions['formats']>,
      tryHarder: req.tryHarder,
      tryRotate: true,
      tryInvert: true,
      // 縮放由主執行緒的 decodeScale 階梯負責，不讓 zxing 自己再縮一次
      tryDownscale: false,
      // 要「找到位置但解不出」的結果，餵給候選放大
      returnErrors: true,
      // 點陣模式下放寬候選數：PCB 上大量方形焊墊會搶走「第一個候選」
      maxNumberOfSymbols: req.dotted ? Math.max(req.maxSymbols, 4) : req.maxSymbols,
    }
    const t0 = performance.now()

    // 追蹤裁切（aux）先解：很小（~160²），原圖 + 帽濾波變體，命中就不碰主幀（主幀 bitmap 仍要 close）
    if (req.aux) {
      const auxImage = toImageData(req.aux.source, auxSlot)
      const n = auxImage.width * auxImage.height
      auxGray = rgbaToGray(auxImage.data, auxGray && auxGray.length === n ? auxGray : undefined)
      if (!auxScratch || auxScratch.a.length !== n) auxScratch = { a: new Uint8Array(n), b: new Uint8Array(n) }
      const deadline = performance.now() + req.aux.maxMs
      let hit = (await readBarcodes(auxImage, options)).filter((r) => r.isValid)
      let variant: DottedVariant | undefined
      if (!hit.length) {
        for (const v of req.aux.variants) {
          if (performance.now() > deadline) break
          auxRgba = grayToRgba(dilateDots(auxGray, auxImage.width, auxImage.height, v, auxScratch), auxRgba && auxRgba.length === n * 4 ? auxRgba : undefined)
          hit = (await readBarcodes(new ImageData(auxRgba as Uint8ClampedArray<ArrayBuffer>, auxImage.width, auxImage.height), options)).filter((r) => r.isValid)
          if (hit.length) {
            variant = v
            break
          }
        }
      }
      if (hit.length) {
        if (req.source.kind === 'bitmap') req.source.bitmap.close()
        const results = hit.map(toRaw)
        const transfer: Transferable[] = []
        for (const r of results) if (r.bytes) transfer.push(r.bytes.buffer)
        scope.postMessage({ type: 'result', id: req.id, results, decodeMs: performance.now() - t0, dottedHit: !!variant, ...(variant ? { dottedVariant: variant } : {}), fromAux: true }, transfer)
        return
      }
    }

    const image = toImageData(req.source)
    let raw = await readBarcodes(image, options)
    let dottedHit = false
    let grayFresh = false

    // 點陣式（DPM）第二次嘗試：正常解不出時，膨脹圓點成方塊再解。
    // 可能有多個變體（拍照模式一次傳全部）：灰階只轉一次，逐一膨脹 → 解，成功即停。
    let dottedVariant: DottedVariant | undefined
    if (req.dotted?.length && !raw.some((r) => r.isValid)) {
      const n = image.width * image.height
      grayBuf = rgbaToGray(image.data, grayBuf && grayBuf.length === n ? grayBuf : undefined)
      grayFresh = true
      if (!morphScratch || morphScratch.a.length !== n) morphScratch = { a: new Uint8Array(n), b: new Uint8Array(n) }
      for (const variant of req.dotted) {
        if (req.maxMs !== undefined && performance.now() - t0 > req.maxMs) break
        const dilated = dilateDots(grayBuf, image.width, image.height, variant, morphScratch)
        rgbaBuf = grayToRgba(dilated, rgbaBuf && rgbaBuf.length === n * 4 ? rgbaBuf : undefined)
        // TS 5.9 的 ImageData 要求 ArrayBuffer-backed 陣列；我們的 buffer 就是，這裡只是型別收窄
        const second = await readBarcodes(new ImageData(rgbaBuf as Uint8ClampedArray<ArrayBuffer>, image.width, image.height), options)
        if (second.some((r) => r.isValid)) {
          raw = second
          dottedHit = true
          dottedVariant = variant
          break
        }
        // 累積「有定位」的候選（去重交給主執行緒）
        if (second.length) raw = raw.concat(second)
      }
    }

    // 點密度定位：整幀完全沒結果（連候選都沒有）時，找「擠滿小點」的區域。
    // 解析度夠（inPlace）就直接在這張影像上裁候選、多變體再解；否則交給主執行緒下一幀裁原尺寸。
    let candidates: DotCluster[] | undefined
    if (req.locate && raw.length === 0) {
      const n = image.width * image.height
      const gray = grayFresh && grayBuf ? grayBuf : (grayBuf = rgbaToGray(image.data, grayBuf && grayBuf.length === n ? grayBuf : undefined))
      if (!morphScratch || morphScratch.a.length !== n) morphScratch = { a: new Uint8Array(n), b: new Uint8Array(n) }
      candidates = locateDotClusters(gray, image.width, image.height, req.locate, morphScratch)
      const inPlace = req.locate.inPlace
      if (inPlace && candidates.length) {
        // 2.4 × window（遠拍符號的假設大小）。實測放大到 160 反而掉命中（裁進更多板面結構）；近的碼主幀本來就解得出
        const side = Math.round(2.4 * req.locate.window)
        const hit = await decodeCandidates(gray, image.width, image.height, candidates, side, inPlace.variants, options, performance.now() + inPlace.maxMs)
        if (hit) {
          raw = hit.results
          dottedHit = true
          dottedVariant = hit.variant
        }
        // 已經在這張圖上試過了：失敗的候選不再交給下一幀裁原尺寸（解析度差不多，幾乎不會翻盤，只會吃掉發現幀）
        candidates = undefined
      }
    }

    const decodeMs = performance.now() - t0
    const results = raw.map(toRaw)
    const transfer: Transferable[] = []
    for (const r of results) if (r.bytes) transfer.push(r.bytes.buffer)
    scope.postMessage(
      {
        type: 'result',
        id: req.id,
        results,
        decodeMs,
        dottedHit,
        ...(dottedVariant ? { dottedVariant } : {}),
        ...(candidates ? { candidates } : {}),
        ...(req.aux ? { auxMiss: true } : {}),
      },
      transfer,
    )
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
      mainSlot.canvas = mainSlot.ctx = null
      auxSlot.canvas = auxSlot.ctx = null
      scope.close()
      break
  }
}

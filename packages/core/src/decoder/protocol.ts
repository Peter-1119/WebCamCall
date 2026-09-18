import type { DotCluster, DottedVariant } from './morphology'

/**
 * 主執行緒 ↔ wasm Worker 的訊息協定。
 * 座標在這一層是「解碼影像座標」（裁切+縮放後），換算回原始影像座標是主執行緒的事
 * （Worker 不需要知道 crop / scale）。
 */

export interface RawPoint {
  readonly x: number
  readonly y: number
}

export interface RawResult {
  readonly text: string
  /** zxing 的格式名稱（`QRCode`、`EAN13`…）。 */
  readonly format: string
  readonly isValid: boolean
  readonly topLeft: RawPoint
  readonly topRight: RawPoint
  readonly bottomRight: RawPoint
  readonly bottomLeft: RawPoint
  /** 有效結果才有；buffer 會 transfer。 */
  readonly bytes: Uint8Array | null
}

export type DecodeSource =
  /** 主要路徑：Worker 內有 OffscreenCanvas，直接收 bitmap（transfer）。 */
  | { readonly kind: 'bitmap'; readonly bitmap: ImageBitmap }
  /** fallback：主執行緒已讀回像素（Safari < 16.4 的 Worker 沒有 OffscreenCanvas）。 */
  | { readonly kind: 'pixels'; readonly data: ArrayBuffer; readonly width: number; readonly height: number }

export type WorkerRequest =
  | { readonly type: 'init'; readonly wasmUrl?: string }
  | {
      readonly type: 'decode'
      readonly id: number
      readonly source: DecodeSource
      readonly formats: readonly string[]
      readonly maxSymbols: number
      readonly tryHarder: boolean
      /** 沒解出時用這些變體膨脹後依序再試（即時掃描每幀傳一個；拍照模式一次傳全部，像素只讀回一次）。 */
      readonly dotted?: readonly DottedVariant[]
      /** 這次請求的時間上限（毫秒，Worker 內計時）：超過就不再試下一個變體。拍照模式用。 */
      readonly maxMs?: number
      /**
       * 沒結果時跑點密度定位（`locateDotClusters`）。點陣模式的整幀才帶。
       * `inPlace` 有給：直接在這張影像上裁候選（邊長 2.4 × window）、用這組變體再解，命中就當一般結果回傳
       * （影像解析度夠時，省掉「下一幀再裁」的一幀）；沒命中或沒給 `inPlace` 才回傳 `candidates`。
       */
      readonly locate?: {
        readonly k: number
        readonly window: number
        readonly inPlace?: { readonly variants: readonly DottedVariant[]; readonly maxMs: number }
      }
      /**
       * 附加的小裁切（追蹤上一次位置）：**先**解這塊（原圖 + 這組變體，預算內），命中就直接回傳、不解主幀。
       * 回應的 `fromAux` 標記結果座標屬於哪一張。
       */
      readonly aux?: { readonly source: DecodeSource; readonly variants: readonly DottedVariant[]; readonly maxMs: number }
    }
  | { readonly type: 'dispose' }

export type WorkerResponse =
  | { readonly type: 'ready' }
  | { readonly type: 'init-error'; readonly message: string }
  | {
      readonly type: 'result'
      readonly id: number
      readonly results: readonly RawResult[]
      readonly decodeMs: number
      /** 結果來自膨脹後的第二次嘗試。 */
      readonly dottedHit: boolean
      readonly dottedVariant?: DottedVariant
      /** 點密度定位的候選（解碼影像座標）；只有帶 `locate` 且沒結果時才有。 */
      readonly candidates?: readonly DotCluster[]
      /** 結果來自 `aux` 裁切（座標是 aux 影像座標）。 */
      readonly fromAux?: boolean
      /** 有 `aux` 但 aux 沒解出（追蹤 miss）。 */
      readonly auxMiss?: boolean
    }
  | { readonly type: 'decode-error'; readonly id: number; readonly message: string }

/** `wasmUrl` 可以是 `.wasm` 檔或目錄。 */
export function resolveWasmFile(wasmUrl: string | undefined, fileName: string): string | undefined {
  if (!wasmUrl) return undefined
  if (wasmUrl.endsWith('.wasm')) return wasmUrl
  return `${wasmUrl.replace(/\/$/, '')}/${fileName}`
}

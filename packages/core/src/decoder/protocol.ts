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
    }
  | { readonly type: 'dispose' }

export type WorkerResponse =
  | { readonly type: 'ready' }
  | { readonly type: 'init-error'; readonly message: string }
  | { readonly type: 'result'; readonly id: number; readonly results: readonly RawResult[]; readonly decodeMs: number }
  | { readonly type: 'decode-error'; readonly id: number; readonly message: string }

/** `wasmUrl` 可以是 `.wasm` 檔或目錄。 */
export function resolveWasmFile(wasmUrl: string | undefined, fileName: string): string | undefined {
  if (!wasmUrl) return undefined
  if (wasmUrl.endsWith('.wasm')) return wasmUrl
  return `${wasmUrl.replace(/\/$/, '')}/${fileName}`
}

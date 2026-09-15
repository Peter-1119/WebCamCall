import type { GrabbedFrame } from '../camera/frame-grabber'
import type { BarcodeFormat, DecoderBackend, Quad } from '../types'

/**
 * 解碼器對「一幀」的輸出。座標**已換算回原始影像座標系**（port 實作負責用 frame.crop / scale 換算）。
 */
export interface DecodeOutput {
  /** 成功解碼的結果。 */
  readonly results: readonly DecodedSymbol[]
  /** 找到位置但解不出內容（只有 wasm 會有）。 */
  readonly located: readonly Quad<'image'>[]
  /** 解碼器內部耗時（毫秒，不含傳輸）。 */
  readonly decodeMs: number
}

export interface DecodedSymbol {
  readonly text: string
  readonly format: BarcodeFormat
  readonly quad: Quad<'image'>
  readonly rawBytes: Uint8Array | null
}

/** 解碼請求的執行期參數（可熱更新的部分）。 */
export interface DecodeRequest {
  readonly formats: readonly BarcodeFormat[]
  readonly multi: boolean
  /** 階梯升級後才開 tryHarder，base 級保持快。 */
  readonly tryHarder: boolean
}

/**
 * 兩個後端共用的介面。呼叫端保證一次只有一個 `decode()` 在飛（FrameSource 的背壓）。
 * `decode()` 取得 frame.bitmap 的所有權：實作要負責 `close()` 或 transfer 出去。
 */
export interface DecoderPort {
  readonly backend: DecoderBackend
  decode(frame: GrabbedFrame, request: DecodeRequest): Promise<DecodeOutput>
  dispose(): Promise<void>
}

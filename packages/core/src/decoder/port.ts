import type { GrabbedFrame } from '../camera/frame-grabber'
import type { BarcodeFormat, DecoderBackend, Quad, Rect } from '../types'
import type { DottedVariant } from './morphology'

/**
 * 解碼器對「一幀」的輸出。座標**已換算回原始影像座標系**（port 實作負責用 frame.crop / scale 換算）。
 */
export interface DecodeOutput {
  /**
   * 成功解碼的結果。port 回傳**全部**找到的；單一模式（`multi: false`）下
   * 由呼叫端挑最靠近掃描框中心的一個（見 scanner.ts / decoder.ts）。
   */
  readonly results: readonly DecodedSymbol[]
  /** 找到位置但解不出內容（只有 wasm 會有）。 */
  readonly located: readonly Quad<'image'>[]
  /** 解碼器內部耗時（毫秒，不含傳輸）。 */
  readonly decodeMs: number
  /** 結果是否來自點陣膨脹的第二次嘗試（給輪替器記住有效的核）。 */
  readonly dottedHit?: boolean
  /** 命中的變體（`dottedHit` 為 true 時）。 */
  readonly dottedVariant?: DottedVariant
  /** 點密度定位的候選區域（原始影像座標）；只有 `DecodeRequest.locate` 且整幀沒結果時才有。 */
  readonly candidates?: readonly Rect[]
  /** 結果來自 `frame.aux`（追蹤裁切）。 */
  readonly fromAux?: boolean
  /** 有 `frame.aux` 但沒在裡面解出。 */
  readonly auxMiss?: boolean
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
  /** 本幀要嘗試的點陣膨脹變體（依序試到成功為止）；`null` / 空陣列不做。只有 wasm 後端支援。 */
  readonly dotted?: DottedVariant | readonly DottedVariant[] | null
  /** 這次 decode 的時間上限（毫秒）；超過就不再試更多變體。拍照模式用。 */
  readonly maxMs?: number
  /**
   * 整幀沒結果時跑點密度定位，`window` 是符號邊長估計（解碼影像 px）。
   * 回傳的候選是以 `cx, cy` 為中心、邊長 `2.4 × window` 的正方形（換回原始影像座標）。只有 wasm 後端支援。
   */
  readonly locate?: {
    readonly k: number
    readonly window: number
    /** 影像解析度夠時直接在 Worker 內裁候選再解（見 protocol.ts）。 */
    readonly inPlace?: { readonly variants: readonly DottedVariant[]; readonly maxMs: number }
  }
  /** `frame.aux` 要用的變體與預算；沒給就不解 aux（但仍會 close 它）。只有 wasm 後端支援。 */
  readonly aux?: { readonly variants: readonly DottedVariant[]; readonly maxMs: number }
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

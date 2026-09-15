import type { BarcodeFormat } from '../types'

/**
 * 我們的 `BarcodeFormat`（W3C 命名）↔ zxing-wasm 的格式名稱。
 * zxing 有更細的變體（`Code39Ext`、`DataBarExp` 等），輸出時全部收斂回我們的名稱。
 */
const TO_ZXING: Record<BarcodeFormat, string> = {
  qr_code: 'QRCode',
  micro_qr: 'MicroQRCode',
  aztec: 'Aztec',
  data_matrix: 'DataMatrix',
  pdf417: 'PDF417',
  ean_13: 'EAN13',
  ean_8: 'EAN8',
  upc_a: 'UPCA',
  upc_e: 'UPCE',
  code_128: 'Code128',
  code_39: 'Code39',
  code_93: 'Code93',
  codabar: 'Codabar',
  itf: 'ITF',
  databar: 'DataBar',
  databar_expanded: 'DataBarExp',
  maxicode: 'MaxiCode',
}

/** zxing 輸出名稱（含變體）→ 我們的名稱。認不得的回 `undefined`，呼叫端要丟掉該結果。 */
const FROM_ZXING: Record<string, BarcodeFormat> = {
  QRCode: 'qr_code',
  QRCodeModel1: 'qr_code',
  QRCodeModel2: 'qr_code',
  MicroQRCode: 'micro_qr',
  RMQRCode: 'micro_qr',
  Aztec: 'aztec',
  AztecCode: 'aztec',
  AztecRune: 'aztec',
  DataMatrix: 'data_matrix',
  PDF417: 'pdf417',
  CompactPDF417: 'pdf417',
  MicroPDF417: 'pdf417',
  EAN13: 'ean_13',
  ISBN: 'ean_13',
  EAN8: 'ean_8',
  UPCA: 'upc_a',
  UPCE: 'upc_e',
  Code128: 'code_128',
  Code39: 'code_39',
  Code39Std: 'code_39',
  Code39Ext: 'code_39',
  Code32: 'code_39',
  PZN: 'code_39',
  Code93: 'code_93',
  Codabar: 'codabar',
  ITF: 'itf',
  ITF14: 'itf',
  DataBar: 'databar',
  DataBarOmni: 'databar',
  DataBarStk: 'databar',
  DataBarStkOmni: 'databar',
  DataBarLtd: 'databar',
  DataBarExp: 'databar_expanded',
  DataBarExpStk: 'databar_expanded',
  MaxiCode: 'maxicode',
}

export function toZxingFormats(formats: readonly BarcodeFormat[]): string[] {
  return formats.map((f) => TO_ZXING[f])
}

export function fromZxingFormat(name: string): BarcodeFormat | undefined {
  return FROM_ZXING[name]
}

/**
 * BarcodeDetector 的格式名稱與我們相同（都是 W3C 命名），只是它沒有 micro_qr / databar / maxicode。
 * 這裡只做「它認得嗎」的過濾。
 */
export function toNativeFormats(formats: readonly BarcodeFormat[], supported: readonly string[]): BarcodeFormat[] {
  const set = new Set(supported)
  return formats.filter((f) => set.has(f))
}

export function fromNativeFormat(name: string, known: ReadonlySet<string>): BarcodeFormat | undefined {
  return known.has(name) ? (name as BarcodeFormat) : undefined
}

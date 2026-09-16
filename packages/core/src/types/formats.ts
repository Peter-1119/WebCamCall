/**
 * 支援的條碼格式。命名沿用 W3C Shape Detection API 的 `BarcodeFormat`
 * （snake_case），wasm 路徑會在內部做對應。
 *
 * 支援度（需實機驗證，見下方註解）：
 *
 * | format           | BarcodeDetector (Android Chrome) | BarcodeDetector (iOS 17+ Safari) | zxing-wasm |
 * |------------------|----------------------------------|----------------------------------|------------|
 * | qr_code          | yes                              | yes                              | yes        |
 * | micro_qr         | no                               | no                               | yes        |
 * | aztec            | yes                              | yes                              | yes        |
 * | data_matrix      | yes                              | yes                              | yes        |
 * | pdf417           | yes                              | yes                              | yes        |
 * | ean_13 / ean_8   | yes                              | yes                              | yes        |
 * | upc_a / upc_e    | yes                              | yes                              | yes        |
 * | code_128/39/93   | yes                              | yes                              | yes        |
 * | codabar          | yes                              | yes                              | yes        |
 * | itf              | yes                              | yes                              | yes        |
 * | databar(_expanded)| no                              | no                               | yes        |
 * | maxicode         | no                               | no                               | partial    |
 *
 * TODO(實機驗證)：iOS Safari 的 BarcodeDetector 實際支援清單需用
 * `BarcodeDetector.getSupportedFormats()` 在裝置上確認；Android 端依賴
 * Google Play Services，非 Play 裝置可能完全沒有此 API。
 */
export type BarcodeFormat =
  | 'qr_code'
  | 'micro_qr'
  | 'aztec'
  | 'data_matrix'
  | 'pdf417'
  | 'ean_13'
  | 'ean_8'
  | 'upc_a'
  | 'upc_e'
  | 'code_128'
  | 'code_39'
  | 'code_93'
  | 'codabar'
  | 'itf'
  | 'databar'
  | 'databar_expanded'
  | 'maxicode'

/** 所有格式的清單，供 `formats: ALL_FORMATS` 這種用法。 */
export const ALL_FORMATS: readonly BarcodeFormat[] = [
  'qr_code',
  'micro_qr',
  'aztec',
  'data_matrix',
  'pdf417',
  'ean_13',
  'ean_8',
  'upc_a',
  'upc_e',
  'code_128',
  'code_39',
  'code_93',
  'codabar',
  'itf',
  'databar',
  'databar_expanded',
  'maxicode',
]

/**
 * 常用的格式組合。**格式越少解碼越快**：zxing 對一維（掃線）與二維（定位圖案）是兩套演算法，
 * 只給一種就只跑一套。場景固定時請用單一組合，混合場景再用 `[...QR_FORMATS, ...LINEAR_FORMATS]`。
 * 執行期可用 `scanner.updateOptions({ formats })` 熱切換。
 */
export const QR_FORMATS: readonly BarcodeFormat[] = ['qr_code']

/** 所有一維條碼（商品 EAN/UPC、物流 Code 128/39/93、ITF、Codabar、DataBar）。 */
export const LINEAR_FORMATS: readonly BarcodeFormat[] = [
  'ean_13',
  'ean_8',
  'upc_a',
  'upc_e',
  'code_128',
  'code_39',
  'code_93',
  'codabar',
  'itf',
  'databar',
  'databar_expanded',
]

/** 所有二維碼（QR、Micro QR、Aztec、Data Matrix、PDF417、MaxiCode）。 */
export const MATRIX_FORMATS: readonly BarcodeFormat[] = ['qr_code', 'micro_qr', 'aztec', 'data_matrix', 'pdf417', 'maxicode']

/** 解碼後端識別。 */
export type DecoderBackend = 'native' | 'wasm'

/**
 * `options.backend` 的可選值。
 *
 * - `'auto'`   ：有 `BarcodeDetector` 且要求的格式全部支援就用 native，否則載入 wasm。
 *                native 路徑下 **wasm 不會被下載**。
 * - `'native'` ：強制 native；不可用時 `start()` 以 `unsupported-backend` 失敗。
 * - `'wasm'`   ：強制 wasm（例如想拿 rawBytes、或想避開平台實作差異）。
 */
export type BackendPreference = 'auto' | DecoderBackend

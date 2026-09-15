import { createUnsupportedBackendError, createUnsupportedFormatError } from '../errors'
import { probeSupport } from '../support'
import type { BackendPreference, BarcodeFormat, DecoderBackend, WasmOptions } from '../types'
import type { DecoderPort } from './port'

/**
 * 依 `options.backend` 決定後端。
 *
 * - `auto`：有可用的 BarcodeDetector **且**要求的格式全部支援 → native，否則 wasm
 * - `native`：不可用 → `unsupported-backend`；格式不齊 → `unsupported-format`
 * - `wasm`：沒有 Worker / WebAssembly → `unsupported-backend`
 *
 * 實機驗證：iPad Safari 沒有 BarcodeDetector；Windows Chrome 有建構子但格式為空。
 * 兩者在 `auto` 下都會走 wasm。
 */
export async function selectBackend(pref: BackendPreference, formats: readonly BarcodeFormat[]): Promise<DecoderBackend> {
  const support = await probeSupport()
  const nativeSet = new Set(support.native.formats)
  const nativeCovers = support.native.available && formats.every((f) => nativeSet.has(f))

  if (pref === 'native') {
    if (!support.native.available) throw createUnsupportedBackendError('native')
    if (!nativeCovers) throw createUnsupportedFormatError('native', formats.filter((f) => !nativeSet.has(f)))
    return 'native'
  }
  if (pref === 'auto' && nativeCovers) return 'native'
  if (!support.wasm.available) throw createUnsupportedBackendError('wasm')
  return 'wasm'
}

/**
 * 建立選定後端的 port。wasm 模組用動態 import：native 路徑下這段程式碼（含 Worker 建立）
 * 不會被載入；Worker 檔與 .wasm 更是只有真的建 Worker 時才會下載。
 */
export async function createDecoderPort(
  backend: DecoderBackend,
  formats: readonly BarcodeFormat[],
  wasm: WasmOptions,
): Promise<DecoderPort> {
  if (backend === 'native') {
    const { createNativeDecoder } = await import('./native')
    return createNativeDecoder(formats)
  }
  const { createWasmDecoder } = await import('./wasm')
  return createWasmDecoder(wasm)
}

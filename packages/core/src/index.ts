/**
 * @scanner/core
 *
 * Headless barcode / QR scanner. 零依賴、不綁框架、不含 UI。
 * 這個檔案只做 re-export，讓 bundler 能 tree-shake。
 *
 * - Phase 1：型別（`./types`）
 * - Phase 2+：`createScanner()`、`createDecoder()`、`probeSupport()`、座標 helper
 */
export * from './types'

export const VERSION = '0.0.0' as const

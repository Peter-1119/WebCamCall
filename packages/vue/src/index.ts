/**
 * @cclemon/scanner-vue — `useBarcodeScanner()` composable。
 * 同時 re-export core 的所有型別與 helper，App 端只要 import 這一個套件。
 */
export { useBarcodeScanner } from './useBarcodeScanner'
export type { UseBarcodeScannerOptions, UseBarcodeScannerReturn } from './useBarcodeScanner'
export * from '@cclemon/scanner-core'

/**
 * @cclemon/scanner-core
 *
 * Headless barcode / QR scanner. 零依賴、不綁框架、不含 UI。
 * 這個檔案只做 re-export，讓 bundler 能 tree-shake。
 */
export * from './types'

// 主要 API
export { createScanner } from './scanner'
export { createDecoder } from './decoder'

// 座標 helper
export { getElementTransform, toElementSpace, rectToElementSpace, roiToImageRect } from './geometry'

// 能力探測
export { probeSupport } from './support'

// 點陣式（DPM）前處理，進階用途 / 除錯
export { dilateDots, hatFilter, locateDotClusters, stretchContrast, rgbaToGray, grayToRgba, dottedKernels, createDottedCycler, kernelFromSymbolWidth } from './decoder/morphology'
export type { DottedVariant, DotPolarity } from './decoder/morphology'

// 錯誤
export { isScannerError } from './errors'

// 設定
export { resolveOptions, DEFAULT_DECODE_SCALE } from './options'

// 相機管線（進階用法：自行組裝，或 Phase 3 之前的 playground）
export { createCameraController } from './camera/controller'
export type { CameraController, CameraControllerEvent, CameraControllerOptions, OpenedCamera } from './camera/controller'
export { createFrameSource } from './camera/frame-source'
export type { FrameSource, FrameMeta, FrameSourceStats } from './camera/frame-source'
export { createFrameGrabber } from './camera/frame-grabber'
export type { FrameGrabber, GrabbedFrame } from './camera/frame-grabber'
export { createScaleController } from './camera/scale-controller'
export type { ScaleController, FramePlan, DecodeOutcome } from './camera/scale-controller'

export const VERSION = '0.0.0' as const

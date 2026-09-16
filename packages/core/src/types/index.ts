export type {
  CoordinateSpace,
  Point,
  Size,
  Rect,
  Quad,
  Roi,
  ElementTransform,
  ObjectFit,
  ElementTransformOptions,
  GetElementTransform,
  ToElementSpace,
  RectToElementSpace,
} from './geometry'

export type { BarcodeFormat, DecoderBackend, BackendPreference } from './formats'
export { ALL_FORMATS, QR_FORMATS, LINEAR_FORMATS, MATRIX_FORMATS } from './formats'

export type { ScannerState, ScannerAction } from './state'
export { STATE_TRANSITIONS } from './state'

export type {
  ErrorCode,
  ScannerError,
  ScannerErrorBase,
  SimpleErrorCode,
  UnsupportedFormatError,
  UnsupportedBackendError,
  CapabilityUnsupportedError,
  DecoderError,
  InvalidStateError,
} from './errors'

export type { CameraInfo, CameraCapabilities, CameraSettings, FocusMode } from './capabilities'

export type { DecodedResult, Candidate, ScanStats, ScanEvent, ScanEventType, ScanEventOf } from './events'

export type {
  CameraOptions,
  WasmOptions,
  DecodeScaleOptions,
  ScannerOptions,
  ResolvedScannerOptions,
  HotUpdatableOptions,
} from './options'

export type {
  Scanner,
  CameraTarget,
  CreateScanner,
  Decoder,
  DecoderOptions,
  CreateDecoder,
  SupportReport,
  ProbeSupport,
} from './scanner'

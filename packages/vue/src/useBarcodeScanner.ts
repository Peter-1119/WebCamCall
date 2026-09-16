import { getCurrentScope, onScopeDispose, shallowReadonly, shallowRef, toValue, watch } from 'vue'
import type { MaybeRefOrGetter, Ref, ShallowRef } from 'vue'
import { createScanner, probeSupport } from '@scanner/core'
import type {
  CameraCapabilities,
  CameraInfo,
  CameraSettings,
  CameraTarget,
  Candidate,
  DecodedResult,
  DecoderBackend,
  HotUpdatableOptions,
  ScanEvent,
  Scanner,
  ScannerError,
  ScannerOptions,
  ScannerState,
  SupportReport,
} from '@scanner/core'

export interface UseBarcodeScannerOptions extends ScannerOptions {
  /** 與 `lastResult` ref 並行；兩者可同時用。 */
  readonly onDecoded?: (result: DecodedResult) => void
  /** 每個候選各呼叫一次（高頻）；`candidates` ref 則是每幀合併一次。 */
  readonly onCandidate?: (candidate: Candidate) => void
  readonly onError?: (error: ScannerError) => void
  readonly onStateChange?: (state: ScannerState, previous: ScannerState) => void
  /** `<video>` 元素出現後自動 `start()`。預設 `false`（iOS 需要使用者手勢才能開相機）。 */
  readonly autoStart?: boolean
}

/** `candidates` 在多久沒有新候選後清空（毫秒）。 */
const CANDIDATE_TTL_MS = 300

const HOT_KEYS = ['formats', 'roi', 'targetFps', 'debounceFrames', 'rescanDelayMs', 'multi', 'decodeScale'] as const

function pickHot(o: ScannerOptions): HotUpdatableOptions {
  const out: Record<string, unknown> = {}
  for (const k of HOT_KEYS) if (o[k] !== undefined) out[k] = o[k]
  return out as HotUpdatableOptions
}

function stripCallbacks(o: UseBarcodeScannerOptions): ScannerOptions {
  const { onDecoded: _d, onCandidate: _c, onError: _e, onStateChange: _s, autoStart: _a, ...rest } = o
  return rest
}

/**
 * Vue 3 composable。
 *
 * - scanner 在 `videoRef` 有值時才建立（`v-if` 拿掉再放回會重建），import 時完全不碰 DOM → SSR 安全
 * - 所有 ref 都是 `shallowRef` + `shallowReadonly`：結果物件含 `Uint8Array` 與巢狀座標，深層 reactive 只是浪費
 * - `candidates` 以 rAF 合併：同一幀的多個候選只觸發一次更新，且只在有候選時才動
 * - scope 銷毀時自動 `stop()`；在 setup 之外呼叫（沒有 scope）就要自己 `stop()`
 *
 * @example
 * ```vue
 * <script setup>
 * const video = ref(null)
 * const { state, lastResult, start } = useBarcodeScanner(video, { formats: ['qr_code'] })
 * </script>
 * <template>
 *   <video ref="video" />
 *   <button @click="start">Scan</button>
 *   <p>{{ lastResult?.text }}</p>
 * </template>
 * ```
 */
export function useBarcodeScanner(
  videoRef: Ref<HTMLVideoElement | null | undefined>,
  options: MaybeRefOrGetter<UseBarcodeScannerOptions> = {},
) {
  const state = shallowRef<ScannerState>('idle')
  const error = shallowRef<ScannerError | null>(null)
  const backend = shallowRef<DecoderBackend | null>(null)
  const camera = shallowRef<CameraInfo | null>(null)
  const capabilities = shallowRef<CameraCapabilities | null>(null)
  const settings = shallowRef<CameraSettings | null>(null)
  const lastResult = shallowRef<DecodedResult | null>(null)
  const candidates = shallowRef<readonly Candidate[]>([])
  const support = shallowRef<SupportReport | null>(null)
  const scanner: ShallowRef<Scanner | null> = shallowRef(null)

  let unsubscribe: (() => void) | null = null
  /** `start()` 在元素出現前被呼叫：先記著，建好就跑。 */
  let pendingStart: { resolve: () => void; reject: (e: unknown) => void } | null = null

  // ---- candidates：每幀合併 ----
  let buffer: Candidate[] = []
  let bufferFrame = -1
  let rafId = 0
  let ttlTimer: ReturnType<typeof setTimeout> | null = null

  function flushCandidates() {
    rafId = 0
    candidates.value = buffer.slice()
  }
  function pushCandidate(c: Candidate) {
    if (c.frameId !== bufferFrame) {
      buffer = []
      bufferFrame = c.frameId
    }
    buffer.push(c)
    if (!rafId) rafId = requestAnimationFrame(flushCandidates)
    if (ttlTimer) clearTimeout(ttlTimer)
    ttlTimer = setTimeout(() => {
      buffer = []
      bufferFrame = -1
      if (candidates.value.length) candidates.value = []
    }, CANDIDATE_TTL_MS)
  }

  function handle(event: ScanEvent) {
    const o = toValue(options)
    switch (event.type) {
      case 'state':
        state.value = event.state
        if (event.state === 'scanning' || event.state === 'starting') error.value = null
        backend.value = scanner.value?.backend ?? null
        o.onStateChange?.(event.state, event.previous)
        break
      case 'decoded':
        lastResult.value = event.result
        o.onDecoded?.(event.result)
        break
      case 'candidate':
        pushCandidate(event.candidate)
        o.onCandidate?.(event.candidate)
        break
      case 'error':
        error.value = event.error
        o.onError?.(event.error)
        break
      case 'camera':
        camera.value = event.camera
        capabilities.value = event.capabilities
        settings.value = event.settings
        break
      case 'stats':
        break
    }
  }

  function teardown() {
    const inst = scanner.value
    unsubscribe?.()
    unsubscribe = null
    scanner.value = null
    if (inst) void inst.stop()
    if (rafId) cancelAnimationFrame(rafId)
    rafId = 0
    if (ttlTimer) clearTimeout(ttlTimer)
    ttlTimer = null
    state.value = 'idle'
    camera.value = null
    capabilities.value = null
    settings.value = null
    backend.value = null
    candidates.value = []
  }

  function build(el: HTMLVideoElement) {
    const o = toValue(options)
    const inst = createScanner(el, stripCallbacks(o))
    unsubscribe = inst.subscribe(handle)
    scanner.value = inst
    if (pendingStart) {
      const p = pendingStart
      pendingStart = null
      inst.start().then(p.resolve, p.reject)
    } else if (o.autoStart) {
      void inst.start().catch(() => {})
    }
  }

  watch(
    videoRef,
    (el) => {
      teardown()
      if (el) build(el)
    },
    { immediate: true, flush: 'post' },
  )

  // 可熱更新的欄位改了就套用，不需重啟；其他欄位改了要 stop() 再 start()
  watch(
    () => pickHot(toValue(options)),
    (hot) => scanner.value?.updateOptions(hot),
    { deep: true },
  )

  if (typeof window !== 'undefined') {
    void probeSupport().then((r) => {
      support.value = r
    })
  }

  if (getCurrentScope()) {
    onScopeDispose(() => {
      teardown()
      pendingStart?.reject(new Error('scope disposed'))
      pendingStart = null
    })
  }

  return {
    state: shallowReadonly(state),
    error: shallowReadonly(error),
    backend: shallowReadonly(backend),
    camera: shallowReadonly(camera),
    capabilities: shallowReadonly(capabilities),
    settings: shallowReadonly(settings),
    lastResult: shallowReadonly(lastResult),
    candidates: shallowReadonly(candidates),
    support: shallowReadonly(support),
    /** 底層實例，進階用（例如 `on('stats')`）。元素尚未出現時為 `null`。 */
    scanner: shallowReadonly(scanner),

    start(): Promise<void> {
      if (scanner.value) return scanner.value.start()
      return new Promise<void>((resolve, reject) => {
        pendingStart = { resolve, reject }
      })
    },
    stop(): Promise<void> {
      pendingStart = null
      return scanner.value?.stop() ?? Promise.resolve()
    },
    pause() {
      scanner.value?.pause()
    },
    resume() {
      scanner.value?.resume()
    },
    toggleTorch(): Promise<void> {
      const inst = scanner.value
      if (!inst) return Promise.resolve()
      return inst.setTorch(!(inst.settings?.torch ?? false))
    },
    setZoom(value: number): Promise<void> {
      return scanner.value?.setZoom(value) ?? Promise.resolve()
    },
    switchCamera(target: CameraTarget = 'next'): Promise<void> {
      return scanner.value?.switchCamera(target) ?? Promise.resolve()
    },
    updateOptions(patch: HotUpdatableOptions) {
      scanner.value?.updateOptions(patch)
    },
  }
}

export type UseBarcodeScannerReturn = ReturnType<typeof useBarcodeScanner>

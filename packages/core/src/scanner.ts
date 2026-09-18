import { createCameraController } from './camera/controller'
import type { OpenedCamera } from './camera/controller'
import { nextCamera } from './camera/devices'
import { createFrameGrabber } from './camera/frame-grabber'
import { createFrameSource } from './camera/frame-source'
import type { FrameMeta, FrameSource } from './camera/frame-source'
import { createScaleController } from './camera/scale-controller'
import type { ScaleController } from './camera/scale-controller'
import { createDebouncer } from './decoder/debounce'
import { createDottedCycler, kernelFromSymbolWidth } from './decoder/morphology'
import type { DottedVariant } from './decoder/morphology'
import { quadBounds } from './geometry'
import type { DecoderPort, DecodeRequest } from './decoder/port'
import { createDecoderPort, selectBackend } from './decoder/select'
import { createEmitter } from './emitter'
import { createScannerError, isScannerError } from './errors'
import { pickClosest } from './geometry'
import { resolveOptions } from './options'
import { createStateMachine } from './state-machine'
import type {
  CameraTarget,
  CreateScanner,
  DecodedResult,
  DecoderBackend,
  HotUpdatableOptions,
  ResolvedScannerOptions,
  ScanEvent,
  Scanner,
  ScannerError,
  Size,
} from './types'

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const i = Math.min(sorted.length - 1, Math.floor(p * sorted.length))
  return sorted[i] ?? 0
}

/**
 * 掃描器門面：把狀態機、相機、幀來源、裁切縮放、解碼器、debounce 接起來。
 * 各模組的細節見各自檔案；這裡只負責生命週期與事件。
 */
/** 點陣模式：找到位置後，追蹤裁切連續幾幀沒解出才放掉。 */
const DOTTED_TRACK_FRAMES = 10
/** 點密度定位一幀最多給幾個候選。 */
const DOTTED_LOCATE_K = 3
/** 點密度定位假設的符號邊長（原始影像 px）：22 模組 × 3 px，遠拍的量級。 */
const DOTTED_SYMBOL_PX = 66
/** 裁切幀多變體嘗試的預算（毫秒）。160² 的裁切一個變體 < 5 ms。 */
const DOTTED_CROP_BUDGET_MS = 40
/** 整幀的縮放比至少這麼大，點密度候選才直接在 Worker 內裁切解碼（模組 ≥ ~2.3 px）。 */
const DOTTED_INPLACE_MIN_SCALE = 0.75

/**
 * 裁切幀（zoom / track）要試的變體：帽濾波去背景 + 膨脹，核依預期符號寬度挑（沒有就假設遠拍小碼）。
 * 影片實測（PCB 遠拍、模組 3 px）：oracle 裁切上帽濾波 4% → 20%，核 3 / 5 佔全部命中。
 */
function cropVariants(symbolWidth?: number): DottedVariant[] {
  const k = symbolWidth !== undefined ? kernelFromSymbolWidth(symbolWidth) : 3
  const kernels = [...new Set([k, Math.min(17, k + 2), Math.max(3, k - 2)])]
  const out: DottedVariant[] = []
  for (const kernel of kernels) for (const polarity of ['dark', 'light'] as const) out.push({ kernel, polarity, hat: kernel })
  return out
}

export const createScanner: CreateScanner = (video, options = {}) => {
  let opts: ResolvedScannerOptions = resolveOptions(options)
  const emitter = createEmitter()
  const emit = (e: ScanEvent) => emitter.emit(e)
  const sm = createStateMachine(emit)
  const grabber = createFrameGrabber()
  const debouncer = createDebouncer({ debounceFrames: opts.debounceFrames, rescanDelayMs: opts.rescanDelayMs })
  const dottedEnabled = () => (opts.dotted === 'auto' ? opts.formats.includes('data_matrix') : opts.dotted)
  // 點陣模式才開追蹤（交替出「追蹤裁切」幀）；一般 QR / 1D 的每幀流程完全不變
  const makeScale = () => createScaleController(opts.decodeScale, opts.roi, dottedEnabled() ? DOTTED_TRACK_FRAMES : 0)
  let scale: ScaleController = makeScale()
  const dottedCycler = createDottedCycler()
  /** 上一幀定位到的候選寬度（影像座標 px），用來估膨脹核；沒有就盲目輪替。 */
  let lastLocatedWidth: number | null = null

  let camera: OpenedCamera | null = null
  let backend: DecoderBackend | null = null
  let port: DecoderPort | null = null
  let source: FrameSource | null = null
  let startPromise: Promise<void> | null = null
  /** 每次 start / stop 遞增；await 之後對不上就代表已被 stop()，靜默收工。 */
  let generation = 0
  let statsTimer: ReturnType<typeof setInterval> | null = null
  let decodeTimes: number[] = []

  const cameraCtrl = createCameraController((e) => {
    if (e.type === 'camera') {
      const trackChanged = camera !== null && camera.track !== e.camera.track
      camera = e.camera
      emit({ type: 'camera', camera: e.camera.info, capabilities: e.camera.capabilities, settings: e.camera.settings })
      // track 換了（自動恢復）而我們正在掃：重建幀來源。
      // iOS 上 detachVideo() 的 video.load() 會作廢 pending 的 rVFC，舊的迴圈鏈會悄悄斷掉。
      if (trackChanged && source && sm.is('scanning', 'paused')) {
        const wasPaused = sm.is('paused')
        const s = attachSource()
        if (wasPaused) s.pause()
      }
    } else {
      // 自動恢復失敗：這是不可恢復的執行期錯誤
      void fail(e.error)
    }
  })

  /** 暖機中的解碼器：stop() 後保留，start() 重用；dispose() / 解碼器出錯才丟掉。 */
  let warmPort: { backend: DecoderBackend; port: DecoderPort } | null = null

  async function releaseResources(keepDecoder: boolean) {
    stopStats()
    source?.stop()
    source = null
    const p = port
    const b = backend
    port = null
    backend = null
    await cameraCtrl.close()
    camera = null
    if (p) {
      if (keepDecoder && b) warmPort = { backend: b, port: p }
      else await p.dispose()
    }
    if (!keepDecoder && warmPort) {
      await warmPort.port.dispose()
      warmPort = null
    }
    debouncer.reset()
    scale.reset()
    dottedCycler.reset()
    lastLocatedWidth = null
  }

  async function fail(error: ScannerError) {
    generation++
    // 解碼器出錯就不留；其他錯誤（相機）保留暖機的解碼器
    await releaseResources(error.code !== 'decoder-crashed' && error.code !== 'decoder-init-failed')
    if (sm.can('failed')) sm.transition('failed', 'stop')
    emit({ type: 'error', error })
  }

  // ---- 掃描迴圈 ----------------------------------------------------------

  async function onFrame(meta: FrameMeta) {
    const p = port
    if (!p || video.videoWidth === 0) return
    const imageSize: Size = { width: video.videoWidth, height: video.videoHeight }
    const plan = scale.plan(imageSize)
    const myGen = generation

    let out: Awaited<ReturnType<DecoderPort['decode']>>
    let frameId: number
    let dotted: ReturnType<typeof dottedCycler.next> | null = null
    try {
      const dottedWasm = dottedEnabled() && p.backend === 'wasm'
      const frame = await grabber.grab(video, plan.crop, plan.targetWidth, meta.timestamp, dottedWasm ? plan.aux?.crop : undefined)
      frameId = frame.frameId
      // 點陣式加強（只在 dotted 模式、wasm 後端）：
      // - 追蹤裁切（aux，原尺寸小圖）：解碼器先解它，一組帽濾波變體；命中就不解主幀
      // - 整幀：每幀一個膨脹變體（上一幀有定位框就用它的寬度估核，否則輪替）+ 沒結果時跑點密度定位
      // - 候選放大幀（zoom，原尺寸小圖）：一次試一組帽濾波變體，小圖便宜
      let request: DecodeRequest = { formats: opts.formats, multi: opts.multi, tryHarder: plan.level !== 'base' }
      if (dottedWasm) {
        if (plan.aux) request = { ...request, aux: { variants: cropVariants(plan.aux.symbolWidth), maxMs: DOTTED_CROP_BUDGET_MS } }
        if (plan.level === 'zoom') {
          request = { ...request, tryHarder: true, dotted: cropVariants(), maxMs: DOTTED_CROP_BUDGET_MS }
        } else {
          const hint = lastLocatedWidth !== null ? kernelFromSymbolWidth(lastLocatedWidth * frame.scale) : undefined
          dotted = dottedCycler.next(frame.bitmap.width, hint)
          // 解析度夠（≥ 0.75×原圖）就讓 Worker 直接在這張圖上裁候選再解，省掉下一幀；base 級太小，交下一幀裁原尺寸
          const inPlace = frame.scale >= DOTTED_INPLACE_MIN_SCALE ? { variants: cropVariants(), maxMs: DOTTED_CROP_BUDGET_MS } : undefined
          request = {
            ...request,
            dotted,
            locate: { k: DOTTED_LOCATE_K, window: Math.max(24, Math.round(DOTTED_SYMBOL_PX * frame.scale)), ...(inPlace ? { inPlace } : {}) },
          }
        }
      }
      out = await p.decode(frame, request)
      if (myGen !== generation) return
    } catch (err) {
      if (myGen !== generation) return
      if (isScannerError(err) && err.code === 'decoder-crashed') void fail(err)
      return // 其他單幀錯誤（grab 失敗等）跳過即可
    }

    decodeTimes.push(out.decodeMs)
    if (dotted) {
      if (out.dottedHit) dottedCycler.report(dotted, true)
      else if (out.results.length === 0) dottedCycler.report(dotted, false)
    }

    // 單一模式：畫面裡有多個碼時只取離掃描框中心最近的一個，行為可預期，
    // 使用者會學到「把要掃的碼對進框中間」。多碼模式才全部回報。
    let results = out.results
    let located = out.located
    if (!opts.multi) {
      const center = { x: plan.crop.x + plan.crop.width / 2, y: plan.crop.y + plan.crop.height / 2 }
      const r = pickClosest(results, (x) => x.quad, center)
      results = r ? [r] : []
      const l = pickClosest(located, (q) => q, center)
      located = l ? [l] : []
    }

    if (results.length > 0) scale.report('decoded', imageSize, results[0]!.quad, undefined, out.auxMiss)
    else if (located.length > 0) scale.report('located', imageSize, located[0], undefined, out.auxMiss)
    else scale.report('none', imageSize, undefined, out.candidates, out.auxMiss)
    lastLocatedWidth = located.length > 0 ? quadBounds(located[0]!).width : results.length > 0 ? quadBounds(results[0]!.quad).width : null

    for (const quad of located) {
      emit({ type: 'candidate', candidate: { quad, imageSize, frameId, timestamp: meta.timestamp } })
    }

    const { decoded, pending } = debouncer.process(results)
    for (const { symbol, progress } of pending) {
      emit({
        type: 'candidate',
        candidate: { quad: symbol.quad, format: symbol.format, text: symbol.text, progress, imageSize, frameId, timestamp: meta.timestamp },
      })
    }
    for (const s of decoded) {
      const result: DecodedResult = {
        text: s.text,
        format: s.format,
        quad: s.quad,
        rawBytes: s.rawBytes,
        imageSize,
        frameId,
        timestamp: meta.timestamp,
        backend: p.backend,
      }
      emit({ type: 'decoded', result })
    }
  }

  function startStats() {
    if (!opts.emitStats || statsTimer) return
    statsTimer = setInterval(() => {
      const src = source
      if (!src) return
      const sorted = [...decodeTimes].sort((a, b) => a - b)
      emit({
        type: 'stats',
        stats: {
          fps: src.stats.delivered,
          decodeMs: { p50: percentile(sorted, 0.5), p95: percentile(sorted, 0.95) },
          droppedFrames: src.stats.dropped,
        },
      })
      decodeTimes = []
      src.resetStats()
    }, 1000)
  }

  function stopStats() {
    if (statsTimer) clearInterval(statsTimer)
    statsTimer = null
    decodeTimes = []
  }

  function attachSource(): FrameSource {
    source?.stop()
    const s = createFrameSource(video, onFrame, opts.targetFps)
    source = s
    s.start()
    startStats()
    return s
  }

  // ---- 生命週期 ----------------------------------------------------------

  async function run(myGen: number): Promise<void> {
    const aborted = () => myGen !== generation
    try {
      sm.transition('requesting-permission', 'start')

      // 解碼器初始化（wasm 要下載 ~1 MB）與相機權限並行；相機失敗時解碼器的 rejection 要接住。
      // 上次 stop() 留下的暖機解碼器直接重用，第二次 start 只剩相機時間。
      const decoderP = warmPort
        ? Promise.resolve(warmPort)
        : selectBackend(opts.backend, opts.formats).then(async (b) => {
            const p = await createDecoderPort(b, opts.formats, opts.wasm)
            return { backend: b, port: p }
          })
      warmPort = null
      decoderP.catch(() => {})

      await cameraCtrl.open(video, opts.camera)
      if (aborted()) return
      sm.transition('starting', 'start')

      const d = await decoderP
      if (aborted()) {
        warmPort = d // 被 stop() 中斷：留著下次用
        return
      }
      backend = d.backend
      port = d.port

      attachSource()
      sm.transition('scanning', 'start')
    } catch (err) {
      if (aborted()) return
      const error = isScannerError(err) ? err : createScannerError('camera-failed', { cause: err })
      await fail(error)
      throw error
    }
  }

  const scanner: Scanner = {
    get state() {
      return sm.state
    },
    get options() {
      return opts
    },
    get backend() {
      return backend
    },
    get camera() {
      return camera?.info ?? null
    },
    get capabilities() {
      return camera?.capabilities ?? null
    },
    get settings() {
      return camera?.settings ?? null
    },

    start() {
      if (startPromise) return startPromise
      if (sm.is('scanning', 'paused')) return Promise.resolve()
      sm.assert('start', 'idle', 'stopped', 'failed')
      const myGen = ++generation
      startPromise = run(myGen).finally(() => {
        startPromise = null
      })
      return startPromise
    },

    async stop() {
      if (sm.is('idle', 'stopped')) return
      generation++
      await releaseResources(true)
      if (sm.can('stopped')) sm.transition('stopped', 'stop')
    },

    async dispose() {
      generation++
      await releaseResources(false)
      if (sm.can('stopped')) sm.transition('stopped', 'stop')
    },

    pause() {
      sm.assert('pause', 'scanning')
      source?.pause()
      sm.transition('paused', 'pause')
    },

    resume() {
      sm.assert('resume', 'paused')
      source?.resume()
      sm.transition('scanning', 'resume')
    },

    listCameras() {
      return cameraCtrl.listCameras()
    },

    async switchCamera(target: CameraTarget) {
      sm.assert('switchCamera', 'scanning', 'paused')
      const wasPaused = sm.is('paused')
      const myGen = generation

      let deviceId: string | undefined
      if (typeof target === 'string' && target !== 'next') {
        deviceId = target
      } else {
        const list = await cameraCtrl.listCameras()
        if (target === 'next') {
          deviceId = nextCamera(list, camera?.info ?? null)?.deviceId
        } else {
          deviceId = list.find((c) => c.facing === target.facingMode)?.deviceId
        }
        if (!deviceId) throw createScannerError('no-camera')
      }
      if (myGen !== generation) return

      sm.transition('starting', 'switchCamera')
      source?.stop()
      source = null
      try {
        await cameraCtrl.open(video, opts.camera, deviceId)
      } catch (err) {
        if (myGen !== generation) return
        const error = isScannerError(err) ? err : createScannerError('camera-failed', { cause: err })
        await fail(error)
        throw error
      }
      if (myGen !== generation) return
      scale.reset()
      debouncer.reset()
      const s = attachSource()
      sm.transition('scanning', 'switchCamera')
      if (wasPaused) {
        s.pause()
        sm.transition('paused', 'pause')
      }
    },

    async setTorch(on) {
      sm.assert('setTorch', 'scanning', 'paused')
      await cameraCtrl.setTorch(on)
    },

    async setZoom(value) {
      sm.assert('setZoom', 'scanning', 'paused')
      await cameraCtrl.setZoom(value)
    },

    updateOptions(patch: HotUpdatableOptions) {
      const next: ResolvedScannerOptions = {
        ...opts,
        ...(patch.formats !== undefined ? { formats: patch.formats } : {}),
        ...(patch.roi !== undefined ? { roi: patch.roi } : {}),
        ...(patch.targetFps !== undefined ? { targetFps: patch.targetFps } : {}),
        ...(patch.debounceFrames !== undefined ? { debounceFrames: patch.debounceFrames } : {}),
        ...(patch.rescanDelayMs !== undefined ? { rescanDelayMs: patch.rescanDelayMs } : {}),
        ...(patch.multi !== undefined ? { multi: patch.multi } : {}),
        ...(patch.decodeScale !== undefined ? { decodeScale: { ...opts.decodeScale, ...patch.decodeScale } } : {}),
        ...(patch.dotted !== undefined ? { dotted: patch.dotted } : {}),
      }
      const roiChanged = next.roi !== opts.roi
      const scaleChanged = next.decodeScale !== opts.decodeScale
      const dottedBefore = dottedEnabled()
      opts = next
      if (roiChanged || scaleChanged || dottedEnabled() !== dottedBefore) scale = makeScale()
      debouncer.update({ debounceFrames: opts.debounceFrames, rescanDelayMs: opts.rescanDelayMs })
      source?.setTargetFps(opts.targetFps)
    },

    on(type, listener) {
      return emitter.on(type, listener)
    },

    subscribe(listener) {
      return emitter.subscribe(listener)
    },
  }

  return scanner
}

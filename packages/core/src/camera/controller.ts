import { createCapabilityError, createScannerError } from '../errors'
import type { CameraCapabilities, CameraInfo, CameraSettings, FocusMode, ScannerError } from '../types'
import { buildConstraints, constraintLadder, isOverconstrained, mapGetUserMediaError } from './constraints'
import type { ResolvedCameraOptions } from './constraints'
import { inferFacing, isLikelyMainLens, listVideoInputs, pickByFacing, pickMainCamera } from './devices'
import { attachVideo, detachVideo, waitForFrame } from './video'

/** lib.dom 尚未收錄的 constraint / capability 欄位（Image Capture spec）。 */
interface ExtCapabilities extends MediaTrackCapabilities {
  torch?: boolean
  zoom?: { min: number; max: number; step: number }
  focusMode?: string[]
}
interface ExtSettings extends MediaTrackSettings {
  torch?: boolean
  zoom?: number
  focusMode?: string
}
type ExtConstraintSet = MediaTrackConstraintSet & { torch?: boolean; zoom?: number; focusMode?: string }

export interface OpenedCamera {
  readonly stream: MediaStream
  readonly track: MediaStreamTrack
  readonly info: CameraInfo
  readonly capabilities: CameraCapabilities
  readonly settings: CameraSettings
  /** stream 由外部提供，`close()` 不會停它。 */
  readonly external: boolean
}

export type CameraControllerEvent =
  /** 開啟、切換、自動恢復、設定改變（torch/zoom）後都會發，帶最新的 OpenedCamera。 */
  | { readonly type: 'camera'; readonly camera: OpenedCamera }
  /** track 結束且自動恢復失敗。 */
  | { readonly type: 'lost'; readonly error: ScannerError }

export interface CameraController {
  readonly current: OpenedCamera | null
  /** 開啟相機並接到 video。已開啟時會先關掉再開（切鏡頭就是這樣做）。 */
  open(video: HTMLVideoElement, options: ResolvedCameraOptions, deviceId?: string): Promise<OpenedCamera>
  /** 可重入。 */
  close(): Promise<void>
  setTorch(on: boolean): Promise<void>
  setZoom(value: number): Promise<void>
  listCameras(): Promise<readonly CameraInfo[]>
}

const FOCUS_MODES: readonly FocusMode[] = ['none', 'manual', 'single-shot', 'continuous']

function readCapabilities(track: MediaStreamTrack): CameraCapabilities {
  // Firefox 沒有 getCapabilities；Safari 舊版也沒有。一律視為不支援。
  const raw: ExtCapabilities = typeof track.getCapabilities === 'function' ? track.getCapabilities() : {}
  const zoom = raw.zoom && typeof raw.zoom.min === 'number' ? { min: raw.zoom.min, max: raw.zoom.max, step: raw.zoom.step } : null
  return {
    torch: raw.torch === true,
    zoom,
    focusModes: (raw.focusMode ?? []).filter((m): m is FocusMode => (FOCUS_MODES as readonly string[]).includes(m)),
  }
}

/**
 * iOS Safari workaround：track 剛建立時 `getCapabilities()` 回空物件，
 * 大約 500ms 後才有內容（vue-qrcode-reader 的實測經驗）。
 * 輪詢到有內容或超過 1 秒為止；桌機 Chrome 第一次就有，不會多等。
 * TODO(實機驗證)：iOS 17/18 是否仍需要。
 */
async function readCapabilitiesWithRetry(track: MediaStreamTrack): Promise<CameraCapabilities> {
  const delays = [0, 250, 250, 500]
  let caps = readCapabilities(track)
  for (const d of delays) {
    if (typeof track.getCapabilities !== 'function') break
    const raw = track.getCapabilities() as ExtCapabilities
    if (Object.keys(raw).length > 0) {
      caps = readCapabilities(track)
      break
    }
    await new Promise((r) => setTimeout(r, d))
  }
  return caps
}

function readSettings(track: MediaStreamTrack): CameraSettings {
  const s: ExtSettings = track.getSettings()
  return {
    torch: s.torch === true,
    zoom: typeof s.zoom === 'number' ? s.zoom : null,
    focusMode: (FOCUS_MODES as readonly string[]).includes(s.focusMode ?? '') ? (s.focusMode as FocusMode) : null,
    resolution: { width: s.width ?? 0, height: s.height ?? 0 },
    frameRate: typeof s.frameRate === 'number' ? s.frameRate : null,
  }
}

function infoFromTrack(track: MediaStreamTrack, cameras: readonly CameraInfo[]): CameraInfo {
  const s: ExtSettings = track.getSettings()
  const known = cameras.find((c) => c.deviceId === s.deviceId)
  if (known) {
    return known.facing === 'unknown' && s.facingMode
      ? { ...known, facing: s.facingMode === 'user' ? 'user' : 'environment' }
      : known
  }
  const label = track.label ?? ''
  const facing = s.facingMode === 'user' || s.facingMode === 'environment' ? s.facingMode : inferFacing(label)
  return { deviceId: s.deviceId ?? '', label, facing }
}

async function applyAdvanced(track: MediaStreamTrack, set: ExtConstraintSet): Promise<void> {
  await track.applyConstraints({ advanced: [set] })
}

async function getUserMediaWithLadder(options: ResolvedCameraOptions, deviceId?: string): Promise<MediaStream> {
  const md = typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined
  if (!md?.getUserMedia) {
    const insecure = typeof window === 'undefined' || !window.isSecureContext
    throw createScannerError(insecure ? 'insecure-context' : 'no-camera')
  }
  let lastErr: unknown
  for (const level of constraintLadder(options, deviceId)) {
    try {
      return await md.getUserMedia(buildConstraints(options, level, deviceId))
    } catch (err) {
      lastErr = err
      if (!isOverconstrained(err)) break
    }
  }
  throw mapGetUserMediaError(lastErr)
}

export interface CameraControllerOptions {
  /** 除錯輸出：每次 getUserMedia 的 constraints、拿到的 track、鏡頭選擇的決策。 */
  readonly debug?: (message: string) => void
}

export function createCameraController(
  emit: (event: CameraControllerEvent) => void,
  { debug }: CameraControllerOptions = {},
): CameraController {
  const log = debug ?? (() => {})
  let current: OpenedCamera | null = null
  let video: HTMLVideoElement | null = null
  let options: ResolvedCameraOptions | null = null
  let closing = false
  let recovering: Promise<void> | null = null
  let cleanupListeners: (() => void) | null = null

  const listCameras = () => listVideoInputs()

  async function acquire(opts: ResolvedCameraOptions, deviceId?: string): Promise<{ stream: MediaStream; external: boolean }> {
    if (opts.stream && !deviceId) return { stream: opts.stream, external: true }
    log(`gUM request: ${deviceId ? `deviceId=${deviceId.slice(0, 8)}` : `facingMode=${opts.facingMode}`}`)
    try {
      const stream = await getUserMediaWithLadder(opts, deviceId)
      const t = stream.getVideoTracks()[0]
      // 實機驗證（iPad Safari）：gUM 剛 resolve 時 getSettings() 還沒有 width/height，
      // 要等 track 開始流動。所以正式的 settings 在 attachVideo 之後才讀（見 openInternal）。
      const st = (t?.getSettings() ?? {}) as ExtSettings
      log(`gUM result: "${t?.label}" deviceId=${st.deviceId?.slice(0, 8)} facingMode=${st.facingMode}`)
      return { stream, external: false }
    } catch (err) {
      log(`gUM failed: ${(err as { code?: string }).code ?? String(err)}`)
      throw err
    }
  }

  function stopStream(stream: MediaStream, external: boolean) {
    if (external) return
    for (const t of stream.getTracks()) t.stop()
  }

  async function openInternal(v: HTMLVideoElement, opts: ResolvedCameraOptions, deviceId?: string): Promise<OpenedCamera> {
    let { stream, external } = await acquire(opts, deviceId)
    let track = stream.getVideoTracks()[0]
    if (!track) {
      stopStream(stream, external)
      throw createScannerError('no-camera')
    }

    try {
      await attachVideo(v, stream)
    } catch (err) {
      stopStream(stream, external)
      throw err
    }

    // 現在有權限了、label 也有了，才判斷得出開到的鏡頭對不對。只在必要時重開一次：
    // 1. 方向不符（實機驗證：iPad Safari 對 ideal: 'environment' 可能給前鏡頭）
    // 2. Android 多鏡頭開到超廣角 / 望遠等非主鏡頭（preferMainCamera）
    // 正常裝置零成本。
    let cameras = await listCameras()
    let info = infoFromTrack(track, cameras)
    log(`cameras: ${cameras.map((c) => `"${c.label}"[${c.facing}]`).join(', ') || '(none)'}`)
    log(`opened: "${info.label}"[${info.facing}] want=${opts.facingMode}`)
    if (!deviceId && !opts.deviceId && !external) {
      const byFacing = pickByFacing(cameras, info, opts.facingMode)
      const better =
        byFacing ??
        (opts.preferMainCamera && !isLikelyMainLens(info.label) ? pickMainCamera(cameras, info, opts.facingMode) : null)
      log(`decision: ${better ? `reopen "${better.label}" (${byFacing ? 'facing mismatch' : 'non-main lens'})` : 'keep'}`)
      if (better) {
        stopStream(stream, external)
        detachVideo(v)
        const re = await acquire(opts, better.deviceId)
        stream = re.stream
        external = re.external
        track = stream.getVideoTracks()[0]!
        await attachVideo(v, stream)
        cameras = await listCameras()
        info = infoFromTrack(track, cameras)
      }
    }

    const capabilities = await readCapabilitiesWithRetry(track)
    if (capabilities.focusModes.includes('continuous')) {
      // 不支援就靜默：這只是最佳化，不是必要條件
      await applyAdvanced(track, { focusMode: 'continuous' }).catch(() => {})
    }

    return { stream, track, info, capabilities, settings: readSettings(track), external }
  }

  function attachLifecycle(cam: OpenedCamera) {
    const onEnded = () => {
      if (closing) return
      void recover()
    }
    const onVisible = () => {
      if (document.visibilityState === 'visible') void ensureAlive()
    }
    const onPageShow = () => void ensureAlive()

    cam.track.addEventListener('ended', onEnded)
    // iOS：切分頁回來 track 常是 muted + 畫面凍結，而不是 ended；pageshow 涵蓋 bfcache 還原
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('pageshow', onPageShow)

    cleanupListeners = () => {
      cam.track.removeEventListener('ended', onEnded)
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('pageshow', onPageShow)
      cleanupListeners = null
    }
  }

  /**
   * 回到前景後確認 stream 還活著：
   * 1. track 已 ended → 直接重開
   * 2. 否則 re-play，1 秒內沒有新幀 → 重開（iOS 凍結畫面的典型症狀）
   * 3. 活著的話重讀 settings（iOS 會在背景時關掉 torch）並通知
   */
  async function ensureAlive(): Promise<void> {
    if (!current || !video || closing || recovering) return
    if (current.track.readyState === 'ended') return recover()
    void video.play().catch(() => {})
    try {
      await waitForFrame(video, 1000)
    } catch {
      return recover()
    }
    const settings = readSettings(current.track)
    if (settings.torch !== current.settings.torch || settings.zoom !== current.settings.zoom) {
      current = { ...current, settings }
      emit({ type: 'camera', camera: current })
    }
  }

  /** 用同一顆鏡頭重開；失敗發 `lost`。同時只會有一個 recovery 在跑。 */
  function recover(): Promise<void> {
    if (recovering) return recovering
    recovering = (async () => {
      const prev = current
      const v = video
      const opts = options
      if (!prev || !v || !opts) return
      const wantTorch = prev.settings.torch
      cleanupListeners?.()
      stopStream(prev.stream, prev.external)
      detachVideo(v)
      current = null
      try {
        // 外部 stream 沒辦法幫它重開；直接視為失去
        if (prev.external) throw createScannerError('track-ended')
        const cam = await openInternal(v, opts, prev.info.deviceId || undefined)
        if (closing) {
          // 恢復期間被 close()：把剛開的丟掉，不發事件
          stopStream(cam.stream, cam.external)
          detachVideo(v)
          return
        }
        current = cam
        attachLifecycle(cam)
        if (wantTorch && cam.capabilities.torch) await setTorch(true).catch(() => {})
        emit({ type: 'camera', camera: current })
      } catch (err) {
        emit({ type: 'lost', error: createScannerError('track-ended', { cause: err }) })
      }
    })().finally(() => {
      recovering = null
    })
    return recovering
  }

  async function open(v: HTMLVideoElement, opts: ResolvedCameraOptions, deviceId?: string): Promise<OpenedCamera> {
    // 防呆：JS 呼叫端很容易把整個 ScannerOptions 傳進來（實機 debug 時就發生過），
    // 那會變成 facingMode: undefined → 瀏覽器開預設鏡頭，且不會有任何錯誤。
    if (typeof opts?.facingMode !== 'string') {
      throw new TypeError('CameraController.open(): expected resolved camera options (options.camera)')
    }
    await close()
    closing = false
    video = v
    options = opts
    const cam = await openInternal(v, opts, deviceId)
    current = cam
    attachLifecycle(cam)
    emit({ type: 'camera', camera: cam })
    return cam
  }

  async function close(): Promise<void> {
    if (!current) return
    closing = true
    const cam = current
    current = null
    cleanupListeners?.()
    if (recovering) await recovering.catch(() => {})
    stopStream(cam.stream, cam.external)
    if (video) detachVideo(video)
  }

  async function setTorch(on: boolean): Promise<void> {
    if (!current) throw createScannerError('camera-failed')
    if (!current.capabilities.torch) throw createCapabilityError('torch')
    await applyAdvanced(current.track, { torch: on })
    current = { ...current, settings: readSettings(current.track) }
    emit({ type: 'camera', camera: current })
  }

  async function setZoom(value: number): Promise<void> {
    if (!current) throw createScannerError('camera-failed')
    const z = current.capabilities.zoom
    if (!z) throw createCapabilityError('zoom')
    const clamped = Math.min(z.max, Math.max(z.min, value))
    await applyAdvanced(current.track, { zoom: clamped })
    current = { ...current, settings: readSettings(current.track) }
    emit({ type: 'camera', camera: current })
  }

  return {
    get current() {
      return current
    },
    open,
    close,
    setTorch,
    setZoom,
    listCameras,
  }
}

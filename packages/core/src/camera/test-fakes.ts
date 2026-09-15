/* 測試用的假 MediaStream / track / video。只實作 controller 會碰到的部分。 */
import { vi } from 'vitest'

export interface FakeTrackInit {
  deviceId?: string
  label?: string
  facingMode?: string
  capabilities?: Record<string, unknown> | null // null = 沒有 getCapabilities（Firefox）
}

export function fakeTrack(init: FakeTrackInit = {}) {
  const target = new EventTarget()
  const settings: Record<string, unknown> = {
    deviceId: init.deviceId ?? 'dev-main',
    facingMode: init.facingMode ?? 'environment',
    width: 1280,
    height: 720,
    frameRate: 30,
  }
  const state = { readyState: 'live' as 'live' | 'ended' }
  const track = {
    kind: 'video',
    label: init.label ?? 'Back Camera',
    get readyState() {
      return state.readyState
    },
    stop: vi.fn(() => {
      state.readyState = 'ended'
    }),
    getSettings: () => ({ ...settings }),
    applyConstraints: vi.fn(async (c: MediaTrackConstraints) => {
      for (const set of (c.advanced ?? []) as Record<string, unknown>[]) Object.assign(settings, set)
    }),
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
    /** 模擬相機被系統收走 */
    end() {
      state.readyState = 'ended'
      target.dispatchEvent(new Event('ended'))
    },
  } as unknown as MediaStreamTrack & { end(): void; stop: ReturnType<typeof vi.fn> }
  if (init.capabilities !== null) {
    ;(track as { getCapabilities?: () => unknown }).getCapabilities = () =>
      init.capabilities ?? { torch: true, focusMode: ['continuous', 'manual'], zoom: { min: 1, max: 4, step: 0.1 } }
  }
  return track
}

export function fakeStream(track = fakeTrack()) {
  return {
    id: 'stream',
    getVideoTracks: () => [track],
    getTracks: () => [track],
  } as unknown as MediaStream & { getVideoTracks(): (typeof track)[] }
}

export interface FakeVideo {
  playsInline: boolean
  muted: boolean
  autoplay: boolean
  srcObject: MediaStream | null
  videoWidth: number
  videoHeight: number
  clientWidth: number
  clientHeight: number
  currentTime: number
  readyState: number
  setAttribute: ReturnType<typeof vi.fn>
  removeAttribute: ReturnType<typeof vi.fn>
  play: ReturnType<typeof vi.fn<() => Promise<void>>>
  pause: ReturnType<typeof vi.fn>
  load: ReturnType<typeof vi.fn>
  requestVideoFrameCallback: ReturnType<typeof vi.fn>
  cancelVideoFrameCallback: ReturnType<typeof vi.fn>
}

export function fakeVideoElement(): HTMLVideoElement & FakeVideo {
  const listeners = new Map<string, Set<() => void>>()
  const v = {
    playsInline: false,
    muted: false,
    autoplay: false,
    srcObject: null as MediaStream | null,
    videoWidth: 1280,
    videoHeight: 720,
    clientWidth: 360,
    clientHeight: 640,
    currentTime: 0,
    readyState: 4,
    setAttribute: vi.fn(),
    removeAttribute: vi.fn(),
    play: vi.fn(() => Promise.resolve()),
    pause: vi.fn(),
    load: vi.fn(),
    requestVideoFrameCallback: vi.fn((cb: (now: number, meta: { mediaTime: number }) => void) => {
      setTimeout(() => cb(performance.now(), { mediaTime: v.currentTime }), 0)
      return 1
    }),
    cancelVideoFrameCallback: vi.fn(),
    addEventListener: (t: string, l: () => void) => listeners.get(t)?.add(l) ?? listeners.set(t, new Set([l])),
    removeEventListener: (t: string, l: () => void) => listeners.get(t)?.delete(l),
  }
  return v as unknown as HTMLVideoElement & FakeVideo
}

/** 安裝假的 navigator.mediaDevices，回傳可操控的 mock。 */
export function installMediaDevices(devices: Array<{ deviceId: string; label: string }> = []) {
  const getUserMedia = vi.fn<(c: MediaStreamConstraints) => Promise<MediaStream>>()
  const enumerateDevices = vi.fn(async () =>
    devices.map((d) => ({ ...d, kind: 'videoinput', groupId: '' }) as MediaDeviceInfo),
  )
  Object.defineProperty(navigator, 'mediaDevices', {
    value: { getUserMedia, enumerateDevices },
    configurable: true,
  })
  Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true })
  return { getUserMedia, enumerateDevices }
}

export function domError(name: string) {
  const e = new Error(name)
  e.name = name
  return e
}

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resolveOptions } from '../options'
import { createCameraController } from './controller'
import type { CameraControllerEvent } from './controller'
import { domError, fakeStream, fakeTrack, fakeVideoElement, installMediaDevices } from './test-fakes'

const cam = resolveOptions().camera

function setup(devices?: Array<{ deviceId: string; label: string }>) {
  const md = installMediaDevices(devices)
  const events: CameraControllerEvent[] = []
  const ctrl = createCameraController((e) => events.push(e))
  const video = fakeVideoElement()
  return { md, events, ctrl, video }
}

describe('camera controller: open', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('opens, attaches video, reads capabilities, applies continuous focus, emits camera', async () => {
    const { md, events, ctrl, video } = setup([{ deviceId: 'dev-main', label: 'Back Camera' }])
    const track = fakeTrack()
    md.getUserMedia.mockResolvedValueOnce(fakeStream(track))

    const opened = await ctrl.open(video, cam)

    expect(video.playsInline).toBe(true)
    expect(video.muted).toBe(true)
    expect(video.srcObject).not.toBeNull()
    expect(video.play).toHaveBeenCalled()
    expect(opened.capabilities).toEqual({ torch: true, zoom: { min: 1, max: 4, step: 0.1 }, focusModes: ['continuous', 'manual'] })
    expect(track.applyConstraints).toHaveBeenCalledWith({ advanced: [{ focusMode: 'continuous' }] })
    expect(opened.info).toEqual({ deviceId: 'dev-main', label: 'Back Camera', facing: 'environment' })
    expect(opened.settings.resolution).toEqual({ width: 1280, height: 720 })
    expect(events).toEqual([{ type: 'camera', camera: opened }])
    expect(ctrl.current).toBe(opened)
  })

  it('walks the constraint ladder on OverconstrainedError', async () => {
    const { md, ctrl, video } = setup()
    md.getUserMedia.mockRejectedValueOnce(domError('OverconstrainedError'))
    md.getUserMedia.mockRejectedValueOnce(domError('OverconstrainedError'))
    md.getUserMedia.mockResolvedValueOnce(fakeStream())

    await ctrl.open(video, { ...cam, deviceId: 'stale' })

    expect(md.getUserMedia).toHaveBeenCalledTimes(3)
    const [c1, c2, c3] = md.getUserMedia.mock.calls.map((c) => c[0].video as MediaTrackConstraints)
    expect(c1?.deviceId).toEqual({ exact: 'stale' })
    expect(c2?.deviceId).toBeUndefined()
    expect(c2?.width).toBeDefined()
    expect(c3?.width).toBeUndefined()
  })

  it('does not retry on permission errors and maps them', async () => {
    const { md, ctrl, video } = setup()
    md.getUserMedia.mockRejectedValueOnce(domError('NotAllowedError'))
    await expect(ctrl.open(video, cam)).rejects.toMatchObject({ code: 'permission-denied', recoverable: true })
    expect(md.getUserMedia).toHaveBeenCalledTimes(1)
    expect(ctrl.current).toBeNull()
  })

  it('reports insecure-context when mediaDevices is missing', async () => {
    const { ctrl, video } = setup()
    Object.defineProperty(navigator, 'mediaDevices', { value: undefined, configurable: true })
    Object.defineProperty(window, 'isSecureContext', { value: false, configurable: true })
    await expect(ctrl.open(video, cam)).rejects.toMatchObject({ code: 'insecure-context' })
  })

  it('treats a track without getCapabilities (Firefox) as no capabilities', async () => {
    const { md, ctrl, video } = setup()
    md.getUserMedia.mockResolvedValueOnce(fakeStream(fakeTrack({ capabilities: null })))
    const opened = await ctrl.open(video, cam)
    expect(opened.capabilities).toEqual({ torch: false, zoom: null, focusModes: [] })
  })

  it('preferMainCamera: reopens with the main lens when it landed on ultra-wide', async () => {
    const { md, ctrl, video } = setup([
      { deviceId: 'uw', label: 'Back Ultra Wide Camera' },
      { deviceId: 'main', label: 'Back Camera' },
    ])
    const first = fakeTrack({ deviceId: 'uw', label: 'Back Ultra Wide Camera' })
    const second = fakeTrack({ deviceId: 'main', label: 'Back Camera' })
    md.getUserMedia.mockResolvedValueOnce(fakeStream(first)).mockResolvedValueOnce(fakeStream(second))

    const opened = await ctrl.open(video, cam)

    expect(md.getUserMedia).toHaveBeenCalledTimes(2)
    expect((md.getUserMedia.mock.calls[1]![0].video as MediaTrackConstraints).deviceId).toEqual({ exact: 'main' })
    expect(first.stop).toHaveBeenCalled()
    expect(opened.info.deviceId).toBe('main')
  })

  it('preferMainCamera: no reopen when already on a main lens or when disabled', async () => {
    const { md, ctrl, video } = setup([
      { deviceId: 'uw', label: 'Back Ultra Wide Camera' },
      { deviceId: 'main', label: 'Back Camera' },
    ])
    md.getUserMedia.mockResolvedValue(fakeStream(fakeTrack({ deviceId: 'main' })))
    await ctrl.open(video, cam)
    expect(md.getUserMedia).toHaveBeenCalledTimes(1)

    md.getUserMedia.mockClear()
    md.getUserMedia.mockResolvedValue(fakeStream(fakeTrack({ deviceId: 'uw', label: 'Back Ultra Wide Camera' })))
    await ctrl.open(video, { ...cam, preferMainCamera: false })
    expect(md.getUserMedia).toHaveBeenCalledTimes(1)
  })

  it('uses an external stream without calling getUserMedia and never stops it', async () => {
    const { md, ctrl, video } = setup()
    const track = fakeTrack()
    const opened = await ctrl.open(video, { ...cam, stream: fakeStream(track) })
    expect(md.getUserMedia).not.toHaveBeenCalled()
    expect(opened.external).toBe(true)
    await ctrl.close()
    expect(track.stop).not.toHaveBeenCalled()
  })
})

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resolveOptions } from '../options'
import { createCameraController } from './controller'
import type { CameraControllerEvent } from './controller'
import { domError, fakeStream, fakeTrack, fakeVideoElement, installMediaDevices } from './test-fakes'

const cam = resolveOptions().camera
const tick = () => new Promise((r) => setTimeout(r, 5))

function setup() {
  const md = installMediaDevices([{ deviceId: 'dev-main', label: 'Back Camera' }])
  const events: CameraControllerEvent[] = []
  const ctrl = createCameraController((e) => events.push(e))
  const video = fakeVideoElement()
  return { md, events, ctrl, video }
}

describe('camera controller: close / torch / zoom', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('close stops tracks, detaches video, and is reentrant', async () => {
    const { md, ctrl, video } = setup()
    const track = fakeTrack()
    md.getUserMedia.mockResolvedValueOnce(fakeStream(track))
    await ctrl.open(video, cam)

    await ctrl.close()
    await ctrl.close()
    await ctrl.close()

    expect(track.stop).toHaveBeenCalledTimes(1)
    expect(video.srcObject).toBeNull()
    expect(video.pause).toHaveBeenCalled()
    expect(ctrl.current).toBeNull()
  })

  it('setTorch applies the constraint and emits updated settings', async () => {
    const { md, ctrl, video, events } = setup()
    const track = fakeTrack()
    md.getUserMedia.mockResolvedValueOnce(fakeStream(track))
    await ctrl.open(video, cam)

    await ctrl.setTorch(true)
    expect(track.applyConstraints).toHaveBeenLastCalledWith({ advanced: [{ torch: true }] })
    expect(ctrl.current?.settings.torch).toBe(true)
    const last = events.at(-1)
    expect(last?.type === 'camera' && last.camera.settings.torch).toBe(true)
  })

  it('setTorch / setZoom reject with capability-unsupported when missing', async () => {
    const { md, ctrl, video } = setup()
    md.getUserMedia.mockResolvedValueOnce(fakeStream(fakeTrack({ capabilities: { focusMode: [] } })))
    await ctrl.open(video, cam)
    await expect(ctrl.setTorch(true)).rejects.toMatchObject({ code: 'capability-unsupported', capability: 'torch' })
    await expect(ctrl.setZoom(2)).rejects.toMatchObject({ code: 'capability-unsupported', capability: 'zoom' })
  })

  it('setZoom clamps to the capability range', async () => {
    const { md, ctrl, video } = setup()
    const track = fakeTrack()
    md.getUserMedia.mockResolvedValueOnce(fakeStream(track))
    await ctrl.open(video, cam)
    await ctrl.setZoom(99)
    expect(track.applyConstraints).toHaveBeenLastCalledWith({ advanced: [{ zoom: 4 }] })
  })
})

describe('camera controller: recovery', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('track ended → reopens the same deviceId and emits camera', async () => {
    const { md, ctrl, video, events } = setup()
    const first = fakeTrack({ deviceId: 'dev-main' })
    const second = fakeTrack({ deviceId: 'dev-main' })
    md.getUserMedia.mockResolvedValueOnce(fakeStream(first)).mockResolvedValueOnce(fakeStream(second))
    await ctrl.open(video, cam)

    first.end()
    await tick()
    await tick()

    expect(md.getUserMedia).toHaveBeenCalledTimes(2)
    expect((md.getUserMedia.mock.calls[1]![0].video as MediaTrackConstraints).deviceId).toEqual({ exact: 'dev-main' })
    expect(ctrl.current?.track).toBe(second)
    expect(events.filter((e) => e.type === 'camera')).toHaveLength(2)
    expect(events.some((e) => e.type === 'lost')).toBe(false)
  })

  it('track ended and reopen fails → emits lost with track-ended', async () => {
    const { md, ctrl, video, events } = setup()
    const first = fakeTrack()
    md.getUserMedia.mockResolvedValueOnce(fakeStream(first)).mockRejectedValueOnce(domError('NotReadableError'))
    await ctrl.open(video, cam)

    first.end()
    await tick()
    await tick()

    const lost = events.find((e) => e.type === 'lost')
    expect(lost && lost.type === 'lost' && lost.error.code).toBe('track-ended')
    expect(ctrl.current).toBeNull()
  })

  it('re-enables torch after recovery if it was on', async () => {
    const { md, ctrl, video } = setup()
    const first = fakeTrack()
    const second = fakeTrack()
    md.getUserMedia.mockResolvedValueOnce(fakeStream(first)).mockResolvedValueOnce(fakeStream(second))
    await ctrl.open(video, cam)
    await ctrl.setTorch(true)

    first.end()
    await tick()
    await tick()

    expect(second.applyConstraints).toHaveBeenCalledWith({ advanced: [{ torch: true }] })
  })

  it('ignores ended after close', async () => {
    const { md, ctrl, video, events } = setup()
    const track = fakeTrack()
    md.getUserMedia.mockResolvedValueOnce(fakeStream(track))
    await ctrl.open(video, cam)
    await ctrl.close()
    track.end()
    await tick()
    expect(md.getUserMedia).toHaveBeenCalledTimes(1)
    expect(events.some((e) => e.type === 'lost')).toBe(false)
  })

  it('visibilitychange → visible re-plays the video and refreshes settings', async () => {
    const { md, ctrl, video } = setup()
    md.getUserMedia.mockResolvedValueOnce(fakeStream(fakeTrack()))
    await ctrl.open(video, cam)
    video.play.mockClear()

    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
    document.dispatchEvent(new Event('visibilitychange'))
    await tick()

    expect(video.play).toHaveBeenCalled()
    expect(md.getUserMedia).toHaveBeenCalledTimes(1) // 有幀 → 不重開
  })
})

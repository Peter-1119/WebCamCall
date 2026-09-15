import { describe, expect, it } from 'vitest'
import type { CameraInfo } from '../types'
import { inferFacing, isLikelyMainLens, nextCamera, pickByFacing, pickMainCamera } from './devices'

const c = (deviceId: string, label: string): CameraInfo => ({ deviceId, label, facing: inferFacing(label) })

describe('inferFacing', () => {
  it.each([
    ['camera2 0, facing back', 'environment'],
    ['Back Camera', 'environment'],
    ['Back Ultra Wide Camera', 'environment'],
    ['後置相機', 'environment'],
    ['前置超廣角相機', 'user'],
    ['後置雙廣角相機', 'environment'],
    ['camera2 1, facing front', 'user'],
    ['Front Camera', 'user'],
    ['FaceTime HD Camera', 'user'],
    ['HD Pro Webcam C920', 'unknown'],
    ['', 'unknown'],
  ])('%s → %s', (label, facing) => {
    expect(inferFacing(label)).toBe(facing)
  })
})

describe('isLikelyMainLens', () => {
  it.each([
    ['Back Camera', true],
    ['camera2 0, facing back', true],
    ['Back Wide Camera', true],
    ['Back Ultra Wide Camera', false],
    ['Back Ultra-Wide Camera', false],
    ['Back Telephoto Camera', false],
    ['Back Macro Camera', false],
    ['Back Depth Camera', false],
    ['IR Camera', false],
    ['前置超廣角相機', false],
    ['後置望遠相機', false],
    ['後置相機', true],
    ['後置雙廣角相機', true],
    ['Back Dual Wide Camera', true],
  ])('%s → %s', (label, main) => {
    expect(isLikelyMainLens(label)).toBe(main)
  })
})

describe('pickMainCamera', () => {
  const samsung = [
    c('a', 'Back Ultra Wide Camera'),
    c('b', 'Back Camera'),
    c('c', 'Back Telephoto Camera'),
    c('d', 'Front Camera'),
  ]
  const pixel = [c('p0', 'camera2 0, facing back'), c('p1', 'camera2 1, facing front'), c('p2', 'camera2 2, facing back')]

  it('returns null when the current camera is already a main lens', () => {
    expect(pickMainCamera(samsung, samsung[1]!, 'environment')).toBeNull()
    expect(pickMainCamera(pixel, pixel[0]!, 'environment')).toBeNull()
  })

  it('switches away from ultra-wide to the main back camera', () => {
    expect(pickMainCamera(samsung, samsung[0]!, 'environment')?.deviceId).toBe('b')
  })

  it('prefers the lowest camera2 index among back cameras when choosing fresh', () => {
    expect(pickMainCamera(pixel, null, 'environment')?.deviceId).toBe('p0')
  })

  it('keeps an unlabeled back camera: without lens keywords we cannot tell', () => {
    expect(pickMainCamera(pixel, pixel[2]!, 'environment')).toBeNull()
  })

  it('respects facing = user', () => {
    expect(pickMainCamera(samsung, samsung[1]!, 'user')?.deviceId).toBe('d')
  })

  it('falls back to unknown-facing cameras (desktop)', () => {
    const desktop = [c('w', 'HD Pro Webcam C920')]
    expect(pickMainCamera(desktop, null, 'environment')?.deviceId).toBe('w')
    expect(pickMainCamera([], null, 'environment')).toBeNull()
  })

  it('keeps non-main lenses if they are all there is', () => {
    const onlyUltra = [c('u', 'Back Ultra Wide Camera')]
    expect(pickMainCamera(onlyUltra, null, 'environment')?.deviceId).toBe('u')
  })
})

describe('pickByFacing (iPad: ideal environment may yield the front camera)', () => {
  const ipad = [c('f', '前置超廣角相機'), c('b', '後置相機')]

  it('returns the back camera when the front one was opened but environment was requested', () => {
    expect(pickByFacing(ipad, ipad[0]!, 'environment')?.deviceId).toBe('b')
  })

  it('returns null when facing already matches or nothing matches', () => {
    expect(pickByFacing(ipad, ipad[1]!, 'environment')).toBeNull()
    expect(pickByFacing([ipad[0]!], ipad[0]!, 'environment')).toBeNull()
  })

  it('prefers a main lens among the matching-facing cameras', () => {
    const list = [c('f', 'Front Camera'), c('uw', 'Back Ultra Wide Camera'), c('m', 'Back Camera')]
    expect(pickByFacing(list, list[0]!, 'environment')?.deviceId).toBe('m')
  })
})

describe('nextCamera', () => {
  const list = [c('1', 'a'), c('2', 'b'), c('3', 'c')]
  it('cycles', () => {
    expect(nextCamera(list, list[0]!)?.deviceId).toBe('2')
    expect(nextCamera(list, list[2]!)?.deviceId).toBe('1')
    expect(nextCamera(list, null)?.deviceId).toBe('1')
    expect(nextCamera([], null)).toBeNull()
  })
})

import { describe, expect, it } from 'vitest'
import { resolveOptions } from '../options'
import { buildConstraints, constraintLadder, isOverconstrained, mapGetUserMediaError } from './constraints'

const cam = resolveOptions().camera

function domErr(name: string) {
  const e = new Error(name)
  e.name = name
  return e
}

describe('constraint ladder', () => {
  it('has three levels with deviceId, two without', () => {
    expect(constraintLadder(cam)).toEqual(['full', 'no-resolution'])
    expect(constraintLadder(cam, 'dev-1')).toEqual(['full', 'no-device', 'no-resolution'])
    expect(constraintLadder({ ...cam, deviceId: 'x' })).toHaveLength(3)
  })

  it('full: exact deviceId when given, otherwise ideal facingMode', () => {
    const withId = buildConstraints(cam, 'full', 'dev-1').video as MediaTrackConstraints
    expect(withId.deviceId).toEqual({ exact: 'dev-1' })
    expect(withId.facingMode).toBeUndefined()
    expect(withId.width).toEqual({ ideal: 1920 })

    const noId = buildConstraints(cam, 'full').video as MediaTrackConstraints
    expect(noId.facingMode).toEqual({ ideal: 'environment' })
    expect(noId.deviceId).toBeUndefined()
  })

  it('no-device drops deviceId, no-resolution drops width/height', () => {
    const l1 = buildConstraints(cam, 'no-device', 'dev-1').video as MediaTrackConstraints
    expect(l1.deviceId).toBeUndefined()
    expect(l1.facingMode).toEqual({ ideal: 'environment' })
    expect(l1.width).toBeDefined()

    const l2 = buildConstraints(cam, 'no-resolution', 'dev-1').video as MediaTrackConstraints
    expect(l2.width).toBeUndefined()
    expect(l2.height).toBeUndefined()
  })

  it('never includes focusMode or audio', () => {
    const c = buildConstraints(cam, 'full')
    expect(c.audio).toBe(false)
    expect(JSON.stringify(c)).not.toContain('focusMode')
  })
})

describe('getUserMedia error mapping', () => {
  it.each([
    ['NotAllowedError', 'permission-denied', true],
    ['PermissionDeniedError', 'permission-denied', true],
    ['SecurityError', 'permission-denied', false],
    ['NotFoundError', 'no-camera', false],
    ['DevicesNotFoundError', 'no-camera', false],
    ['NotReadableError', 'camera-in-use', true],
    ['TrackStartError', 'camera-in-use', true],
    ['AbortError', 'camera-in-use', true],
    ['OverconstrainedError', 'constraints-unsatisfiable', true],
    ['SomethingNewError', 'camera-failed', true],
  ])('%s → %s (recoverable=%s)', (name, code, recoverable) => {
    const err = domErr(name)
    const mapped = mapGetUserMediaError(err)
    expect(mapped.code).toBe(code)
    expect(mapped.recoverable).toBe(recoverable)
    expect(mapped.cause).toBe(err)
    expect(mapped.name).toBe('ScannerError')
    expect(mapped).toBeInstanceOf(Error)
  })

  it('TypeError maps to insecure-context when not secure', () => {
    const orig = window.isSecureContext
    Object.defineProperty(window, 'isSecureContext', { value: false, configurable: true })
    expect(mapGetUserMediaError(new TypeError('x')).code).toBe('insecure-context')
    Object.defineProperty(window, 'isSecureContext', { value: orig, configurable: true })
  })

  it('isOverconstrained recognises both spellings only', () => {
    expect(isOverconstrained(domErr('OverconstrainedError'))).toBe(true)
    expect(isOverconstrained(domErr('ConstraintNotSatisfiedError'))).toBe(true)
    expect(isOverconstrained(domErr('NotAllowedError'))).toBe(false)
    expect(isOverconstrained(null)).toBe(false)
  })
})

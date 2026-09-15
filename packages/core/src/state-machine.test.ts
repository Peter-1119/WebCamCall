import { describe, expect, it, vi } from 'vitest'
import { createStateMachine } from './state-machine'
import { isScannerError } from './errors'
import { STATE_TRANSITIONS } from './types'
import type { ScannerState } from './types'

describe('state machine', () => {
  it('starts idle and emits on transition', () => {
    const emit = vi.fn()
    const sm = createStateMachine(emit)
    expect(sm.state).toBe('idle')
    sm.transition('requesting-permission', 'start')
    expect(sm.state).toBe('requesting-permission')
    expect(emit).toHaveBeenCalledWith({ type: 'state', state: 'requesting-permission', previous: 'idle' })
  })

  it('throws InvalidStateError on every illegal transition in the table', () => {
    const all = Object.keys(STATE_TRANSITIONS) as ScannerState[]
    for (const from of all) {
      for (const to of all) {
        const sm = createStateMachine(() => {}, from)
        if (STATE_TRANSITIONS[from].includes(to)) {
          expect(() => sm.transition(to, 'start')).not.toThrow()
          continue
        }
        let caught: unknown
        try {
          sm.transition(to, 'pause')
        } catch (e) {
          caught = e
        }
        expect(isScannerError(caught)).toBe(true)
        expect(caught).toMatchObject({ code: 'invalid-state', action: 'pause', state: from })
        expect(sm.state).toBe(from)
      }
    }
  })

  it('assert() rejects disallowed actions without changing state', () => {
    const sm = createStateMachine(() => {}, 'idle')
    expect(() => sm.assert('resume', 'paused')).toThrow()
    expect(() => sm.assert('start', 'idle', 'stopped', 'failed')).not.toThrow()
  })

  it('walks the happy path including restart after failure', () => {
    const sm = createStateMachine(() => {})
    for (const [to, action] of [
      ['requesting-permission', 'start'], ['starting', 'start'], ['scanning', 'start'],
      ['paused', 'pause'], ['scanning', 'resume'], ['stopped', 'stop'],
      ['requesting-permission', 'start'], ['failed', 'start'], ['requesting-permission', 'start'],
    ] as const) {
      sm.transition(to, action)
    }
    expect(sm.state).toBe('requesting-permission')
  })
})

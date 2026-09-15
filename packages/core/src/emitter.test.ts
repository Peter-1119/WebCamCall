import { describe, expect, it, vi } from 'vitest'
import { createEmitter } from './emitter'

const stateEvent = { type: 'state', state: 'scanning', previous: 'starting' } as const

describe('emitter', () => {
  it('dispatches by type and to subscribe-all', () => {
    const e = createEmitter()
    const typed = vi.fn()
    const all = vi.fn()
    e.on('state', typed)
    e.subscribe(all)
    e.emit(stateEvent)
    e.emit({ type: 'stats', stats: { fps: 1, decodeMs: { p50: 1, p95: 1 }, droppedFrames: 0 } })
    expect(typed).toHaveBeenCalledTimes(1)
    expect(all).toHaveBeenCalledTimes(2)
  })

  it('unsubscribe works, including from inside a listener', () => {
    const e = createEmitter()
    const calls: string[] = []
    const off = e.on('state', () => {
      calls.push('a')
      off()
    })
    e.on('state', () => calls.push('b'))
    e.emit(stateEvent)
    e.emit(stateEvent)
    expect(calls).toEqual(['a', 'b', 'b'])
  })

  it('a throwing listener does not block others and is reported', () => {
    const onError = vi.fn()
    const e = createEmitter(onError)
    const second = vi.fn()
    e.on('state', () => {
      throw new Error('boom')
    })
    e.on('state', second)
    expect(() => e.emit(stateEvent)).not.toThrow()
    expect(second).toHaveBeenCalled()
    expect(onError).toHaveBeenCalledWith(expect.any(Error))
  })
})

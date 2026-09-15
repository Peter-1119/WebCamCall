import { describe, expect, it } from 'vitest'
import { rectToQuad } from '../geometry'
import { createDebouncer } from './debounce'
import type { DecodedSymbol } from './port'

const sym = (text: string): DecodedSymbol => ({
  text,
  format: 'qr_code',
  quad: rectToQuad({ x: 0, y: 0, width: 10, height: 10 }),
  rawBytes: null,
})

function clock() {
  let t = 0
  return { now: () => t, advance: (ms: number) => (t += ms) }
}

describe('debounce', () => {
  it('debounceFrames: 0 emits immediately', () => {
    const d = createDebouncer({ debounceFrames: 0, rescanDelayMs: 0 }, clock().now)
    const out = d.process([sym('A')])
    expect(out.decoded.map((s) => s.text)).toEqual(['A'])
    expect(out.pending).toEqual([])
  })

  it('requires N consecutive frames and reports progress in between', () => {
    const d = createDebouncer({ debounceFrames: 3, rescanDelayMs: 0 }, clock().now)
    expect(d.process([sym('A')]).pending[0]?.progress).toEqual({ seen: 1, required: 3 })
    expect(d.process([sym('A')]).pending[0]?.progress).toEqual({ seen: 2, required: 3 })
    const third = d.process([sym('A')])
    expect(third.decoded).toHaveLength(1)
    expect(third.pending).toHaveLength(0)
  })

  it('a missing frame resets the counter', () => {
    const d = createDebouncer({ debounceFrames: 2, rescanDelayMs: 0 }, clock().now)
    d.process([sym('A')])
    d.process([]) // 沒看到
    expect(d.process([sym('A')]).pending[0]?.progress.seen).toBe(1)
  })

  it('rescanDelay silences the same value after emission, then allows it again', () => {
    const c = clock()
    const d = createDebouncer({ debounceFrames: 1, rescanDelayMs: 1000 }, c.now)
    expect(d.process([sym('A')]).decoded).toHaveLength(1)
    c.advance(500)
    const quiet = d.process([sym('A')])
    expect(quiet.decoded).toHaveLength(0)
    expect(quiet.pending).toHaveLength(0)
    c.advance(600)
    expect(d.process([sym('A')]).decoded).toHaveLength(1)
  })

  it('tracks multiple values independently', () => {
    const d = createDebouncer({ debounceFrames: 2, rescanDelayMs: 0 }, clock().now)
    d.process([sym('A')])
    const out = d.process([sym('A'), sym('B')])
    expect(out.decoded.map((s) => s.text)).toEqual(['A'])
    expect(out.pending.map((p) => p.symbol.text)).toEqual(['B'])
  })

  it('counts a value once per frame even if it appears twice', () => {
    const d = createDebouncer({ debounceFrames: 2, rescanDelayMs: 0 }, clock().now)
    const out = d.process([sym('A'), sym('A')])
    expect(out.pending).toHaveLength(1)
    expect(out.pending[0]?.progress.seen).toBe(1)
  })

  it('update() applies new options to subsequent frames', () => {
    const d = createDebouncer({ debounceFrames: 5, rescanDelayMs: 0 }, clock().now)
    d.update({ debounceFrames: 1, rescanDelayMs: 0 })
    expect(d.process([sym('A')]).decoded).toHaveLength(1)
  })
})

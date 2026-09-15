import { describe, expect, it } from 'vitest'
import { VERSION } from './index'

describe('toolchain smoke test', () => {
  it('exports VERSION', () => {
    expect(VERSION).toBe('0.0.0')
  })

  it('runs under happy-dom (document exists)', () => {
    expect(typeof document).toBe('object')
  })
})

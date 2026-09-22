import { describe, expect, it } from 'vitest'
import { VERSION } from './index'

describe('toolchain smoke test', () => {
  it('exports VERSION', () => {
    // 原始碼（vitest）下沒有 build-time define，會是 dev 標記；dist 裡是 package.json 的版本
    expect(VERSION).toBe('0.0.0-dev')
  })

  it('runs under happy-dom (document exists)', () => {
    expect(typeof document).toBe('object')
  })
})

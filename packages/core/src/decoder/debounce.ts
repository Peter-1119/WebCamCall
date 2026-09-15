import type { DecodedSymbol } from './port'

export interface DebounceOptions {
  /** 連續幾幀才確認；`0` = 立即。 */
  readonly debounceFrames: number
  /** 同值發出後多久內不重發；`0` = 關閉。 */
  readonly rescanDelayMs: number
}

export interface DebounceOutput {
  readonly decoded: readonly DecodedSymbol[]
  readonly pending: ReadonlyArray<{
    readonly symbol: DecodedSymbol
    readonly progress: { readonly seen: number; readonly required: number }
  }>
}

/**
 * 逐值 debounce（純邏輯）。
 *
 * - 每個 `text` 各自計數，某幀沒出現就歸零（「連續」的定義）
 * - 達到 `debounceFrames` 幀 → 進 `decoded`；未達 → 進 `pending`（會變成 candidate 事件）
 * - 發出後 `rescanDelayMs` 內同值靜默（連 pending 都不發，避免 UI 在已鎖定的碼上一直閃）
 * - 多碼時每個值獨立，互不影響
 */
export function createDebouncer(options: DebounceOptions, now: () => number = () => performance.now()) {
  let opts = options
  const seen = new Map<string, number>()
  const emittedAt = new Map<string, number>()

  function prune(t: number) {
    if (emittedAt.size < 200) return
    for (const [k, at] of emittedAt) if (t - at > opts.rescanDelayMs) emittedAt.delete(k)
  }

  return {
    process(symbols: readonly DecodedSymbol[]): DebounceOutput {
      const t = now()
      const required = Math.max(1, opts.debounceFrames)
      const decoded: DecodedSymbol[] = []
      const pending: Array<{ symbol: DecodedSymbol; progress: { seen: number; required: number } }> = []
      const present = new Set<string>()

      for (const s of symbols) {
        if (present.has(s.text)) continue // 同幀同值只算一次
        present.add(s.text)

        const count = (seen.get(s.text) ?? 0) + 1
        seen.set(s.text, count)

        const last = emittedAt.get(s.text)
        if (last !== undefined && opts.rescanDelayMs > 0 && t - last < opts.rescanDelayMs) continue

        if (count >= required) {
          decoded.push(s)
          emittedAt.set(s.text, t)
        } else {
          pending.push({ symbol: s, progress: { seen: count, required } })
        }
      }

      for (const k of seen.keys()) if (!present.has(k)) seen.delete(k)
      prune(t)
      return { decoded, pending }
    },

    update(next: DebounceOptions) {
      opts = next
    },

    reset() {
      seen.clear()
      emittedAt.clear()
    },
  }
}

export type Debouncer = ReturnType<typeof createDebouncer>

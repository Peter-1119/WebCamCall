import type { DecodedSymbol } from './port'

export interface DebounceOptions {
  /** 連續幾幀才確認；`0` = 立即。 */
  readonly debounceFrames: number
  /**
   * 同值發出後，要**離開畫面**多久才可再發；`0` = 關閉（每次確認都發）。
   * 碼一直留在框內只會發一次——工廠「掃到 → 送出 → 拿開」的流程不會重複送單。
   */
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
 * - 發出後同值靜默，直到它**離開畫面** ≥ `rescanDelayMs`（每看到一次就延後）；
 *   靜默期間連 pending 都不發，避免 UI 在已鎖定的碼上一直閃
 * - 多碼時每個值獨立，互不影響
 */
export function createDebouncer(options: DebounceOptions, now: () => number = () => performance.now()) {
  let opts = options
  const seen = new Map<string, number>()
  /** 已發出的值 → 最後一次在畫面裡看到的時間。 */
  const lastSeen = new Map<string, number>()

  function prune(t: number) {
    if (lastSeen.size < 200) return
    for (const [k, at] of lastSeen) if (t - at > opts.rescanDelayMs) lastSeen.delete(k)
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

        const last = lastSeen.get(s.text)
        if (last !== undefined && opts.rescanDelayMs > 0 && t - last < opts.rescanDelayMs) {
          lastSeen.set(s.text, t) // 還在畫面裡：持續延後
          continue
        }

        if (count >= required) {
          decoded.push(s)
          if (opts.rescanDelayMs > 0) lastSeen.set(s.text, t)
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
      lastSeen.clear()
    },
  }
}

export type Debouncer = ReturnType<typeof createDebouncer>

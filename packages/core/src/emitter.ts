import type { ScanEvent, ScanEventOf, ScanEventType } from './types'

type Listener<T extends ScanEventType> = (event: ScanEventOf<T>) => void
type AnyListener = (event: ScanEvent) => void

/**
 * 極簡 typed emitter。
 *
 * - emit 時對 listener 集合做快照，listener 內取消訂閱不會影響本輪
 * - listener 丟出的例外用 `queueMicrotask` 重新拋出：不吞錯（會出現在 console / error tracking），
 *   也不讓一個壞 listener 中斷其他 listener 或中斷掃描迴圈
 */
export function createEmitter(
  onListenerError: (err: unknown) => void = (err) => {
    queueMicrotask(() => {
      throw err
    })
  },
) {
  const byType = new Map<ScanEventType, Set<AnyListener>>()
  const all = new Set<AnyListener>()
  const rethrow = onListenerError

  return {
    on<T extends ScanEventType>(type: T, listener: Listener<T>): () => void {
      let set = byType.get(type)
      if (!set) {
        set = new Set()
        byType.set(type, set)
      }
      const l = listener as AnyListener
      set.add(l)
      return () => {
        set.delete(l)
      }
    },

    subscribe(listener: AnyListener): () => void {
      all.add(listener)
      return () => {
        all.delete(listener)
      }
    },

    emit(event: ScanEvent): void {
      const typed = byType.get(event.type)
      if (typed) {
        for (const l of [...typed]) {
          try {
            l(event)
          } catch (err) {
            rethrow(err)
          }
        }
      }
      if (all.size) {
        for (const l of [...all]) {
          try {
            l(event)
          } catch (err) {
            rethrow(err)
          }
        }
      }
    },

    clear(): void {
      byType.clear()
      all.clear()
    },
  }
}

export type Emitter = ReturnType<typeof createEmitter>

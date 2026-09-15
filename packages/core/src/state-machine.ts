import { createInvalidStateError } from './errors'
import type { ScanEventOf, ScannerAction, ScannerState } from './types'
import { STATE_TRANSITIONS } from './types'

/**
 * 狀態機。唯一的真相來源是 `STATE_TRANSITIONS`（types/state.ts）。
 *
 * - `transition()`：不在表內的轉移同步 throw `InvalidStateError`。
 *   這是給 core 內部用的防呆：若真的 throw，代表 Scanner 的流程寫錯了，不是使用者的錯。
 * - `assert()`：公開方法入口檢查「此狀態允許這個動作嗎」，不允許就 throw。
 *   `pause()` / `resume()` 的嚴格行為靠這個。
 */
export function createStateMachine(
  emit: (event: ScanEventOf<'state'>) => void,
  initial: ScannerState = 'idle',
) {
  let state = initial

  return {
    get state(): ScannerState {
      return state
    },

    can(to: ScannerState): boolean {
      return STATE_TRANSITIONS[state].includes(to)
    },

    is(...states: readonly ScannerState[]): boolean {
      return states.includes(state)
    },

    transition(to: ScannerState, action: ScannerAction): void {
      if (!STATE_TRANSITIONS[state].includes(to)) {
        throw createInvalidStateError(action, state)
      }
      const previous = state
      state = to
      emit({ type: 'state', state: to, previous })
    },

    assert(action: ScannerAction, ...allowed: readonly ScannerState[]): void {
      if (!allowed.includes(state)) throw createInvalidStateError(action, state)
    },
  }
}

export type StateMachine = ReturnType<typeof createStateMachine>

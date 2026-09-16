import { onScopeDispose, shallowRef, watch } from 'vue'
import type { Ref, ShallowRef } from 'vue'
import type { Candidate, DecodedResult, ScannerState } from '@scanner/core'

/**
 * 提示代碼（**不是文案**，App 自己對 i18n）：
 * - `align`        ：掃描中但一直沒有任何候選 → 使用者可能還沒對準框
 * - `move-closer`  ：找到條碼位置但解不出內容 → 太小、太遠或失焦
 * - `hold-steady`  ：解得出內容但 debounce 一直不滿 → 手在抖或反光閃爍
 */
export type HintCode = 'align' | 'move-closer' | 'hold-steady'

export interface HintOptions {
  /** 有候選但多久沒解出就提示。預設 2000。 */
  readonly stuckAfterMs?: number
  /** 沒有任何候選多久就提示對準。預設 3000。 */
  readonly alignAfterMs?: number
  /** 成功後多久內不提示。預設 1500。 */
  readonly quietAfterDecodeMs?: number
}

/**
 * 依候選型態與時間推斷「卡住」的原因。每 250ms 評估一次，只在 `scanning` 狀態下運作。
 */
export function useHint(
  inputs: {
    readonly state: Ref<ScannerState>
    readonly candidates: Ref<readonly Candidate[]>
    readonly lastResult: Ref<DecodedResult | null>
  },
  options: HintOptions = {},
  now: () => number = () => Date.now(),
): ShallowRef<HintCode | null> {
  const stuckAfterMs = options.stuckAfterMs ?? 2000
  const alignAfterMs = options.alignAfterMs ?? 3000
  const quietMs = options.quietAfterDecodeMs ?? 1500
  const hint = shallowRef<HintCode | null>(null)

  let scanningSince = 0
  let lastDecodedAt = -Infinity
  let lastCandidateAt = -Infinity
  /** 這一輪（自上次成功以來）第一次看到候選的時間。 */
  let candidateStreakStart = 0
  let lastKind: 'located' | 'progress' | null = null
  let timer: ReturnType<typeof setInterval> | null = null

  function evaluate() {
    const t = now()
    if (inputs.state.value !== 'scanning') {
      hint.value = null
      return
    }
    if (t - lastDecodedAt < quietMs) {
      hint.value = null
      return
    }
    const recentCandidate = t - lastCandidateAt < 500
    if (recentCandidate) {
      if (t - candidateStreakStart >= stuckAfterMs) {
        hint.value = lastKind === 'located' ? 'move-closer' : 'hold-steady'
      } else {
        hint.value = null
      }
      return
    }
    const idleSince = Math.max(scanningSince, lastCandidateAt, lastDecodedAt)
    hint.value = t - idleSince >= alignAfterMs ? 'align' : null
  }

  watch(
    inputs.state,
    (s) => {
      if (s === 'scanning') {
        scanningSince = now()
        candidateStreakStart = 0
        if (!timer) timer = setInterval(evaluate, 250)
      } else {
        if (timer) clearInterval(timer)
        timer = null
        hint.value = null
      }
    },
    { immediate: true },
  )

  watch(inputs.candidates, (list) => {
    if (list.length === 0) return
    const t = now()
    if (t - lastCandidateAt >= 500) candidateStreakStart = t
    lastCandidateAt = t
    lastKind = list.some((c) => c.text !== undefined) ? 'progress' : 'located'
  })

  watch(inputs.lastResult, (r) => {
    if (!r) return
    lastDecodedAt = now()
    candidateStreakStart = 0
    hint.value = null
  })

  onScopeDispose(() => {
    if (timer) clearInterval(timer)
  })

  return hint
}

import { onScopeDispose, shallowRef, watch } from 'vue'
import type { Ref, ShallowRef } from 'vue'
import type { Point, Quad } from '@scanner/core'

export interface SmoothQuadOptions {
  /** 每個 rAF 往目標靠近的比例，0..1。越大越跟手、越小越平滑。預設 0.35。 */
  readonly factor?: number
  /** 目標消失後保留多久再清空（毫秒）。預設 300。 */
  readonly holdMs?: number
  /** 與目標距離小於這個值（px）就直接貼齊，避免無限逼近。預設 0.5。 */
  readonly snap?: number
}

/**
 * 把跳動的追蹤框做線性插值，避免每幀重算造成的抖動。
 * 有目標時每個 rAF 更新一次輸出；目標變 null 後保留 `holdMs` 再清空（讓框淡出而不是瞬間消失）。
 */
export function useSmoothQuad(
  target: Ref<Quad<'element'> | null | undefined>,
  options: SmoothQuadOptions = {},
): ShallowRef<Quad<'element'> | null> {
  const factor = options.factor ?? 0.35
  const holdMs = options.holdMs ?? 300
  const snap = options.snap ?? 0.5
  const output = shallowRef<Quad<'element'> | null>(null)

  let raf = 0
  let hold: ReturnType<typeof setTimeout> | null = null

  const lerp = (a: Point, b: Point): Point => {
    const dx = b.x - a.x
    const dy = b.y - a.y
    if (Math.abs(dx) < snap && Math.abs(dy) < snap) return b
    return { x: a.x + dx * factor, y: a.y + dy * factor }
  }

  function step() {
    raf = 0
    const t = target.value
    const cur = output.value
    if (!t) return
    if (!cur) {
      output.value = t
      return
    }
    const next: Quad<'element'> = [lerp(cur[0], t[0]), lerp(cur[1], t[1]), lerp(cur[2], t[2]), lerp(cur[3], t[3])]
    output.value = next
    if (next.some((p, i) => p !== t[i])) raf = requestAnimationFrame(step)
  }

  watch(
    target,
    (t) => {
      if (t) {
        if (hold) clearTimeout(hold)
        hold = null
        if (!raf) raf = requestAnimationFrame(step)
      } else if (output.value && !hold) {
        hold = setTimeout(() => {
          hold = null
          output.value = null
        }, holdMs)
      }
    },
    // sync：只是排 rAF / timer，不需要等 flush；也讓行為不依賴 Vue 的排程
    { immediate: true, flush: 'sync' },
  )

  onScopeDispose(() => {
    if (raf) cancelAnimationFrame(raf)
    if (hold) clearTimeout(hold)
  })

  return output
}

<script setup lang="ts">
/**
 * 預設 overlay。疊在 `<video>` 上（父層 `position: relative`，本元件 `position: absolute; inset: 0`）。
 *
 * - 掃描框從 `api.scanner.options.roi` 讀，用 core 的 `rectToElementSpace()` 畫：與 core 實際裁切的區域一定一致
 * - 追蹤框：`api.candidates` → 元素座標 → `useSmoothQuad()` 插值
 * - 成功：震動 + 可選音效 + 綠框與勾勾（形狀，不只靠顏色）
 * - 卡住：`useHint()` 推斷原因，只給 code，文案由 `hint` slot 提供
 * - 零文案；鍵盤 Escape → `close`，failed 時 Enter → `retry`
 */
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { getElementTransform, rectToElementSpace, toElementSpace } from '@cclemon/scanner-core'
import type { ElementTransform, ObjectFit, Quad, Rect } from '@cclemon/scanner-core'
import type { UseBarcodeScannerReturn } from '@cclemon/scanner-vue'
import { useHint } from './useHint'
import { useSmoothQuad } from './useSmoothQuad'

const props = withDefaults(
  defineProps<{
    /** `useBarcodeScanner()` 的回傳。 */
    api: UseBarcodeScannerReturn
    /** 與 scanner 綁的同一個 `<video>`；座標換算需要它的尺寸。 */
    video: HTMLVideoElement | null | undefined
    /** `<video>` 的 object-fit，要與 CSS 一致。 */
    objectFit?: ObjectFit
    /** 成功時震動毫秒數；`false` 關閉。 */
    vibrate?: number | false
    /** 成功音效的 URL；不給就沒有聲音。 */
    sound?: string | null
    stuckAfterMs?: number
    alignAfterMs?: number
    /** 鎖定框顯示多久（毫秒）。 */
    lockMs?: number
  }>(),
  { objectFit: 'cover', vibrate: 60, sound: null, stuckAfterMs: 2000, alignAfterMs: 3000, lockMs: 800 },
)

const emit = defineEmits<{ close: []; retry: [] }>()

let idCounter = 0
const uid = `so-${++idCounter}-${Math.random().toString(36).slice(2, 7)}`

const state = computed(() => props.api.state.value)
const roi = computed(() => props.api.scanner.value?.options.roi ?? null)

// ---- 元素座標換算：ResizeObserver + 狀態變化時重算，不在每個候選重量 DOM ----
const transform = shallowRef<ElementTransform | null>(null)
const roiBox = shallowRef<Rect | null>(null)
const elementSize = shallowRef({ width: 0, height: 0 })

function measure() {
  const v = props.video
  if (!v) return
  transform.value = getElementTransform(v, { objectFit: props.objectFit })
  elementSize.value = { width: v.clientWidth, height: v.clientHeight }
  roiBox.value = transform.value ? rectToElementSpace(roi.value ?? { x: 0, y: 0, width: 1, height: 1 }, transform.value) : null
}

let ro: ResizeObserver | null = null
watch(
  () => props.video,
  (v) => {
    ro?.disconnect()
    ro = null
    if (v && typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(measure)
      ro.observe(v)
    }
    measure()
  },
  { immediate: true },
)
watch([state, roi], () => requestAnimationFrame(measure))
onMounted(measure)
onBeforeUnmount(() => ro?.disconnect())

// ---- 追蹤框 ----
const targetQuad = computed<Quad<'element'> | null>(() => {
  const c = props.api.candidates.value[0]
  const t = transform.value
  return c && t ? toElementSpace(c.quad, t) : null
})
const smooth = useSmoothQuad(targetQuad)
const tracking = computed(() => props.api.candidates.value.length > 0)
const points = (q: Quad<'element'>) => q.map((p) => `${p.x},${p.y}`).join(' ')

// ---- 鎖定 ----
const lock = shallowRef<Quad<'element'> | null>(null)
let lockTimer: ReturnType<typeof setTimeout> | null = null
let audio: HTMLAudioElement | null = null

watch(
  () => props.api.lastResult.value,
  (r) => {
    if (!r || !transform.value) return
    lock.value = toElementSpace(r.quad, transform.value)
    if (lockTimer) clearTimeout(lockTimer)
    lockTimer = setTimeout(() => {
      lock.value = null
    }, props.lockMs)
    if (props.vibrate !== false) navigator.vibrate?.(props.vibrate)
    if (props.sound) {
      if (!audio || audio.src !== props.sound) audio = new Audio(props.sound)
      audio.currentTime = 0
      void audio.play().catch(() => {})
    }
  },
)
const lockCenter = computed(() => {
  const q = lock.value
  if (!q) return null
  return { x: (q[0].x + q[2].x) / 2, y: (q[0].y + q[2].y) / 2 }
})

// ---- 提示 ----
const hint = useHint(
  { state: props.api.state, candidates: props.api.candidates, lastResult: props.api.lastResult },
  { stuckAfterMs: props.stuckAfterMs, alignAfterMs: props.alignAfterMs },
)

// ---- 鍵盤 ----
function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    e.preventDefault()
    emit('close')
  } else if ((e.key === 'Enter' || e.key === ' ') && state.value === 'failed') {
    e.preventDefault()
    emit('retry')
  }
}
const retry = () => emit('retry')
const close = () => emit('close')

/** 四角括號的路徑：長度隨追蹤狀態變化（「收窄」的視覺提示）。 */
const brackets = computed(() => {
  const b = roiBox.value
  if (!b) return ''
  const len = Math.min(b.width, b.height) * (tracking.value ? 0.28 : 0.18)
  const { x, y, width: w, height: h } = b
  return [
    `M${x},${y + len} V${y} H${x + len}`,
    `M${x + w - len},${y} H${x + w} V${y + len}`,
    `M${x + w},${y + h - len} V${y + h} H${x + w - len}`,
    `M${x + len},${y + h} H${x} V${y + h - len}`,
  ].join(' ')
})
</script>

<template>
  <div
    class="so"
    :class="{ 'so--tracking': tracking, 'so--locked': !!lock, 'so--failed': state === 'failed' }"
    :data-state="state"
    tabindex="0"
    @keydown="onKey"
  >
    <svg v-if="roiBox" class="so__svg" :width="elementSize.width" :height="elementSize.height" aria-hidden="true">
      <defs>
        <mask :id="`${uid}-mask`">
          <rect x="0" y="0" :width="elementSize.width" :height="elementSize.height" fill="#fff" />
          <rect :x="roiBox.x" :y="roiBox.y" :width="roiBox.width" :height="roiBox.height" rx="8" fill="#000" />
        </mask>
      </defs>
      <rect class="so__dim" x="0" y="0" :width="elementSize.width" :height="elementSize.height" :mask="`url(#${uid}-mask)`" />
      <path class="so__bracket" :d="brackets" />
      <polygon v-if="smooth && !lock" class="so__track" :points="points(smooth)" />
      <g v-if="lock && lockCenter" class="so__lock">
        <polygon :points="points(lock)" />
        <path class="so__check" :d="`M${lockCenter.x - 14},${lockCenter.y} l9,9 l19,-19`" />
      </g>
      <g v-if="state === 'failed'" class="so__fail">
        <rect :x="roiBox.x" :y="roiBox.y" :width="roiBox.width" :height="roiBox.height" rx="8" />
        <path :d="`M${roiBox.x + roiBox.width / 2 - 14},${roiBox.y + roiBox.height / 2 - 14} l28,28 M${roiBox.x + roiBox.width / 2 + 14},${roiBox.y + roiBox.height / 2 - 14} l-28,28`" />
      </g>
    </svg>

    <div v-if="hint" class="so__hint"><slot name="hint" :hint="hint" /></div>
    <div class="so__status" role="status" aria-live="polite"><slot name="status" :state="state" :hint="hint" :last-result="api.lastResult.value" /></div>
    <div v-if="state === 'failed'" class="so__error"><slot name="error" :error="api.error.value" :retry="retry" /></div>
    <div class="so__actions"><slot name="actions" :state="state" :retry="retry" :close="close" /></div>
  </div>
</template>

<style scoped>
.so { position: absolute; inset: 0; outline: none; --so-accent: #21d07a; --so-track: #ffc107; --so-fail: #ff5252; }
.so:focus-visible { box-shadow: inset 0 0 0 3px var(--so-accent); }
.so__svg { position: absolute; inset: 0; pointer-events: none; }
.so__dim { fill: rgba(0, 0, 0, 0.45); }
.so__bracket { fill: none; stroke: #fff; stroke-width: 3; stroke-linecap: round; transition: d 150ms ease, stroke 150ms; }
.so--tracking .so__bracket { stroke: var(--so-track); stroke-width: 4; }
.so__track { fill: rgba(255, 193, 7, 0.15); stroke: var(--so-track); stroke-width: 3; stroke-linejoin: round; }
.so__lock polygon { fill: rgba(33, 208, 122, 0.25); stroke: var(--so-accent); stroke-width: 4; stroke-linejoin: round; animation: so-pulse 400ms ease-out; }
.so__check { fill: none; stroke: #fff; stroke-width: 5; stroke-linecap: round; stroke-linejoin: round; }
.so__fail rect { fill: none; stroke: var(--so-fail); stroke-width: 3; }
.so__fail path { stroke: var(--so-fail); stroke-width: 5; stroke-linecap: round; }
.so__hint { position: absolute; left: 0; right: 0; bottom: 12%; display: flex; justify-content: center; pointer-events: none; }
.so__status { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
.so__error { position: absolute; left: 0; right: 0; top: 50%; transform: translateY(-50%); display: flex; justify-content: center; }
.so__actions { position: absolute; top: 8px; right: 8px; display: flex; gap: 8px; }
@keyframes so-pulse { from { stroke-width: 12; opacity: 0.4; } to { stroke-width: 4; opacity: 1; } }
@media (prefers-reduced-motion: reduce) { .so__lock polygon { animation: none; } .so__bracket { transition: none; } }
</style>

<script setup lang="ts">
/**
 * 全包元件：`<video>` + `<ScannerOverlay>` + `useBarcodeScanner()`。
 *
 * ```vue
 * <BarcodeScanner :formats="['qr_code']" auto-start @decoded="onDecoded" />
 * ```
 *
 * composable 的回傳透過 `defineExpose` 與 default slot 全部露出，需要進階控制時不用換元件。
 * 所有 overlay 的 slot（hint / status / error / actions）原樣轉發。
 */
import { computed, proxyRefs, ref, watch } from 'vue'
import type { BackendPreference, BarcodeFormat, CameraOptions, DecodeScaleOptions, DecodedResult, ObjectFit, Roi, ScannerError, ScannerState, WasmOptions } from '@cclemon/scanner-core'
import { useBarcodeScanner } from '@cclemon/scanner-vue'
import ScannerOverlay from './ScannerOverlay.vue'

const props = withDefaults(
  defineProps<{
    formats?: readonly BarcodeFormat[]
    backend?: BackendPreference
    camera?: CameraOptions
    wasm?: WasmOptions
    /** `wasm.wasmUrl` 的捷徑：`<BarcodeScanner wasm-url="/scanner/zxing_reader.wasm" />`。內網環境必設。 */
    wasmUrl?: string
    roi?: Roi | null
    decodeScale?: DecodeScaleOptions
    debounceFrames?: number
    rescanDelayMs?: number
    targetFps?: number
    multi?: boolean
    /** 點陣式（DPM）Data Matrix 前處理；`'auto'` = formats 含 data_matrix 時開啟。 */
    dotted?: boolean | 'auto'
    /**
     * 相機 zoom（相機一開好就套用，改變時也套用；會夾到 `capabilities.zoom` 的範圍）。
     * 不支援 zoom 的相機靜默略過。遠拍小碼（PCB 2DID）用 2–3 讓每模組像素數翻倍，比任何演算法都有效。
     * iPad 實測 zoom 1–10；是否為光學裁切需實機驗證。
     */
    zoom?: number
    /** 每秒發 `stats` 事件（透過 template ref 的 `scanner.on('stats')` 取得）。 */
    emitStats?: boolean
    autoStart?: boolean
    /** 前鏡頭常見的鏡像顯示；會同步套到座標換算。 */
    mirror?: boolean
    objectFit?: ObjectFit
    vibrate?: number | false
    sound?: string | null
    stuckAfterMs?: number
    alignAfterMs?: number
  }>(),
  {
    formats: () => ['qr_code'],
    backend: 'auto',
    roi: () => ({ x: 0.1, y: 0.3, width: 0.8, height: 0.4 }),
    debounceFrames: 2,
    rescanDelayMs: 1500,
    targetFps: 15,
    multi: false,
    dotted: 'auto',
    emitStats: false,
    autoStart: false,
    mirror: false,
    objectFit: 'cover',
    vibrate: 60,
    sound: null,
    stuckAfterMs: 2000,
    alignAfterMs: 3000,
  },
)

const emit = defineEmits<{
  decoded: [result: DecodedResult]
  error: [error: ScannerError]
  state: [state: ScannerState, previous: ScannerState]
  close: []
  retry: []
}>()

const video = ref<HTMLVideoElement | null>(null)

const api = useBarcodeScanner(video, () => ({
  formats: props.formats,
  backend: props.backend,
  ...(props.camera ? { camera: props.camera } : {}),
  ...(props.wasm || props.wasmUrl ? { wasm: { ...(props.wasm ?? {}), ...(props.wasmUrl ? { wasmUrl: props.wasmUrl } : {}) } } : {}),
  roi: props.roi,
  ...(props.decodeScale ? { decodeScale: props.decodeScale } : {}),
  debounceFrames: props.debounceFrames,
  rescanDelayMs: props.rescanDelayMs,
  targetFps: props.targetFps,
  multi: props.multi,
  dotted: props.dotted,
  emitStats: props.emitStats,
  autoStart: props.autoStart,
  onDecoded: (r) => emit('decoded', r),
  onError: (e) => emit('error', e),
  onStateChange: (s, p) => emit('state', s, p),
}))

// slot 與 template ref 拿到的是 unwrap 過的值（state 是字串而不是 Ref），寫法與一般 props 一致
const exposed = proxyRefs(api)

// zoom prop：相機能力到了（或 prop 改了）就套用，夾在支援範圍內；不支援就不做
watch(
  [() => props.zoom, api.capabilities],
  ([z, caps]) => {
    if (z === undefined || !caps?.zoom) return
    const v = Math.min(caps.zoom.max, Math.max(caps.zoom.min, z))
    void api.setZoom(v).catch(() => {})
  },
  { immediate: true },
)

const videoStyle = computed(() => ({ objectFit: props.objectFit, transform: props.mirror ? 'scaleX(-1)' : undefined }))

function retry() {
  emit('retry')
  void api.start().catch(() => {})
}

defineExpose(exposed)
</script>

<template>
  <div class="bs">
    <video ref="video" class="bs__video" :style="videoStyle" />
    <ScannerOverlay
      :api="api"
      :video="video"
      :object-fit="objectFit"
      :vibrate="vibrate"
      :sound="sound"
      :stuck-after-ms="stuckAfterMs"
      :align-after-ms="alignAfterMs"
      @close="emit('close')"
      @retry="retry"
    >
      <template v-if="$slots.hint" #hint="p"><slot name="hint" v-bind="p" /></template>
      <template v-if="$slots.status" #status="p"><slot name="status" v-bind="p" /></template>
      <template v-if="$slots.error" #error="p"><slot name="error" v-bind="p" /></template>
      <template v-if="$slots.actions" #actions="p"><slot name="actions" v-bind="p" /></template>
    </ScannerOverlay>
    <div class="bs__slot"><slot v-bind="exposed" /></div>
  </div>
</template>

<style scoped>
.bs { position: relative; width: 100%; height: 100%; background: #000; overflow: hidden; }
.bs__video { width: 100%; height: 100%; display: block; }
.bs__slot { position: absolute; inset: 0; pointer-events: none; }
.bs__slot > * { pointer-events: auto; }
</style>

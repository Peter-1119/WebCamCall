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
import { computed, proxyRefs, ref } from 'vue'
import type { BackendPreference, BarcodeFormat, CameraOptions, DecodeScaleOptions, DecodedResult, ObjectFit, Roi, ScannerError, ScannerState, WasmOptions } from '@scanner/core'
import { useBarcodeScanner } from '@scanner/vue'
import ScannerOverlay from './ScannerOverlay.vue'

const props = withDefaults(
  defineProps<{
    formats?: readonly BarcodeFormat[]
    backend?: BackendPreference
    camera?: CameraOptions
    wasm?: WasmOptions
    roi?: Roi | null
    decodeScale?: DecodeScaleOptions
    debounceFrames?: number
    rescanDelayMs?: number
    targetFps?: number
    multi?: boolean
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
  ...(props.wasm ? { wasm: props.wasm } : {}),
  roi: props.roi,
  ...(props.decodeScale ? { decodeScale: props.decodeScale } : {}),
  debounceFrames: props.debounceFrames,
  rescanDelayMs: props.rescanDelayMs,
  targetFps: props.targetFps,
  multi: props.multi,
  autoStart: props.autoStart,
  onDecoded: (r) => emit('decoded', r),
  onError: (e) => emit('error', e),
  onStateChange: (s, p) => emit('state', s, p),
}))

// slot 與 template ref 拿到的是 unwrap 過的值（state 是字串而不是 Ref），寫法與一般 props 一致
const exposed = proxyRefs(api)

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

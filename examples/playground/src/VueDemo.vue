<script setup>
import { computed, ref, watch } from 'vue'
import {
  useBarcodeScanner, getElementTransform, rectToElementSpace, toElementSpace,
  QR_FORMATS, LINEAR_FORMATS,
} from '@scanner/vue'

// eslint-disable-next-line no-undef
const build = typeof __BUILD__ !== 'undefined' ? __BUILD__ : 'dev'
const video = ref(null)
const roi = { x: 0.1, y: 0.3, width: 0.8, height: 0.4 }

// 場景切換：同一個 scanner，改 formats 就熱更新，不用重啟相機
const mode = ref('qr')
const formats = computed(() =>
  mode.value === 'qr' ? QR_FORMATS : mode.value === '1d' ? LINEAR_FORMATS : [...QR_FORMATS, ...LINEAR_FORMATS],
)

const history = ref([])
const log = ref([])
const say = (m) => { log.value.unshift(`${new Date().toLocaleTimeString()} ${m}`); if (log.value.length > 40) log.value.pop() }

const {
  state, error, backend, camera, capabilities, settings, lastResult, candidates, support,
  start, stop, pause, resume, toggleTorch, switchCamera,
} = useBarcodeScanner(video, () => ({
  formats: formats.value,
  roi,
  debounceFrames: 2,
  wasm: { wasmUrl: `${import.meta.env.BASE_URL}zxing_reader.wasm` },
  onDecoded(result) {
    navigator.vibrate?.(60)
    history.value.unshift({ text: result.text, format: result.format, at: new Date().toLocaleTimeString() })
    if (history.value.length > 30) history.value.pop()
  },
  onError: (e) => say(`ERROR ${e.code} (recoverable=${e.recoverable})`),
  onStateChange: (s, p) => say(`state: ${p} → ${s}`),
}))

// ---- overlay：把影像座標換成元素座標 ----
const roiBox = ref(null)
const updateRoi = () => { if (video.value) roiBox.value = rectToElementSpace(roi, video.value) }
watch(state, (s) => { if (s === 'scanning') requestAnimationFrame(updateRoi) })
window.addEventListener('resize', updateRoi)

const toPoints = (quad) => {
  const t = video.value && getElementTransform(video.value)
  return t ? toElementSpace(quad, t).map((p) => `${p.x},${p.y}`).join(' ') : ''
}
const trackPolys = computed(() => candidates.value.map((c) => ({ points: toPoints(c.quad), label: c.progress ? `${c.progress.seen}/${c.progress.required}` : '…' })))

// 鎖定框：decoded 後顯示 0.7 秒
const lock = ref('')
let lockTimer = 0
watch(lastResult, (r) => {
  if (!r) return
  lock.value = toPoints(r.quad)
  clearTimeout(lockTimer)
  lockTimer = setTimeout(() => { lock.value = '' }, 700)
})

const running = computed(() => state.value === 'scanning' || state.value === 'paused')
</script>

<template>
  <main class="app">
    <div class="build">build {{ build }} · state <b>{{ state }}</b> · backend {{ backend ?? '-' }}</div>

    <div class="viewport">
      <video ref="video" class="video" />
      <svg class="overlay" v-if="roiBox">
        <rect :x="roiBox.x" :y="roiBox.y" :width="roiBox.width" :height="roiBox.height" class="roi" />
        <polygon v-for="(t, i) in trackPolys" :key="i" :points="t.points" class="track" />
        <polygon v-if="lock" :points="lock" class="lock" />
      </svg>
      <div v-if="trackPolys.length" class="hint">{{ trackPolys[0].label }}</div>
    </div>

    <div class="modes">
      <label><input type="radio" value="qr" v-model="mode" /> 只掃 QR</label>
      <label><input type="radio" value="1d" v-model="mode" /> 只掃一維條碼</label>
      <label><input type="radio" value="mixed" v-model="mode" /> 混合</label>
    </div>

    <div class="controls">
      <button v-if="!running && state !== 'requesting-permission' && state !== 'starting'" @click="start">Start</button>
      <button v-else @click="stop">Stop</button>
      <button :disabled="!running" @click="state === 'paused' ? resume() : pause()">{{ state === 'paused' ? 'Resume' : 'Pause' }}</button>
      <button :disabled="!capabilities?.torch" @click="toggleTorch">Torch {{ settings?.torch ? 'off' : 'on' }}</button>
      <button :disabled="!running" @click="switchCamera()">Next cam</button>
    </div>

    <div class="last">
      <div class="label">最新結果</div>
      <div class="value">{{ lastResult?.text ?? '—' }}</div>
      <small v-if="lastResult">{{ lastResult.format }}</small>
    </div>

    <ul class="results">
      <li v-for="(r, i) in history" :key="i"><span class="fmt">{{ r.format }}</span> {{ r.text }} <small>{{ r.at }}</small></li>
    </ul>

    <pre class="stats">
error: {{ error?.code ?? '-' }}
camera: {{ camera?.label ?? '-' }} [{{ camera?.facing }}]  torch={{ capabilities?.torch }} zoom={{ capabilities?.zoom ? `${capabilities.zoom.min}-${capabilities.zoom.max}` : 'no' }}
settings: {{ settings?.resolution.width }}x{{ settings?.resolution.height }} @{{ settings?.frameRate }}
formats: {{ formats.join(', ') }}
support: {{ JSON.stringify(support) }}
    </pre>
    <ul class="log"><li v-for="(l, i) in log" :key="i">{{ l }}</li></ul>
  </main>
</template>

<style scoped>
.build { font-size: 12px; color: #9f9; font-family: monospace; }
.app { display: flex; flex-direction: column; gap: 8px; padding: 8px; max-width: 480px; margin: 0 auto; }
.viewport { position: relative; width: 100%; aspect-ratio: 3 / 4; background: #000; overflow: hidden; }
.video { width: 100%; height: 100%; object-fit: cover; display: block; }
.overlay { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; }
.roi { fill: none; stroke: #0f0; stroke-width: 2; }
.track { fill: rgba(255, 200, 0, .15); stroke: #fc0; stroke-width: 3; stroke-linejoin: round; }
.lock { fill: rgba(0, 255, 0, .25); stroke: #0f0; stroke-width: 4; stroke-linejoin: round; }
.hint { position: absolute; top: 8px; left: 8px; background: rgba(0,0,0,.6); padding: 2px 8px; font-size: 12px; border-radius: 4px; }
.modes { display: flex; gap: 12px; font-size: 14px; }
.controls { display: flex; gap: 6px; }
.controls button { flex: 1; padding: 12px 4px; font-size: 15px; }
.last { background: #1a2a1a; border: 1px solid #2a4a2a; padding: 8px; border-radius: 4px; }
.last .label { font-size: 11px; color: #9f9; }
.last .value { font-size: 20px; word-break: break-all; }
.results { list-style: none; margin: 0; padding: 0; font-size: 13px; max-height: 140px; overflow: auto; background: #1a1a1a; }
.results li { padding: 4px 8px; border-bottom: 1px solid #333; word-break: break-all; }
.results .fmt { color: #9cf; font-family: monospace; font-size: 12px; }
.results small { color: #888; }
.stats { font-size: 12px; white-space: pre-wrap; word-break: break-all; margin: 0; }
.log { font-size: 11px; margin: 0; padding-left: 16px; max-height: 200px; overflow: auto; }
</style>

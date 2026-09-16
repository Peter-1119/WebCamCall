<script setup>
import { onBeforeUnmount, onMounted, reactive, ref, shallowRef } from 'vue'
import { createDecoder, createScanner, getElementTransform, probeSupport, rectToElementSpace, toElementSpace } from '@cclemon/scanner-core'

// eslint-disable-next-line no-undef
const build = typeof __BUILD__ !== 'undefined' ? __BUILD__ : 'dev'
const video = ref(null)
const support = ref(null)
const log = ref([])
const say = (m) => { log.value.unshift(`${new Date().toLocaleTimeString()} ${m}`); if (log.value.length > 60) log.value.pop() }

const roi = { x: 0.1, y: 0.3, width: 0.8, height: 0.4 }
const wasmUrl = `${import.meta.env.BASE_URL}zxing_reader.wasm` // 自架，不靠 CDN

const s = reactive({
  state: 'idle', backend: '-', error: null,
  camera: null, caps: null, settings: null,
  fps: 0, decodeMs: '-', dropped: 0,
  roiBox: null, track: '', lock: '', hint: '',
  results: [], cameras: [],
})

const sc = shallowRef(null) // onMounted 後才建（video ref 那時才有值）

function build_scanner() {
  const inst = createScanner(video.value, {
    formats: ['qr_code', 'code_128', 'ean_13', 'code_39', 'data_matrix'],
    roi,
    targetFps: 15,
    debounceFrames: 2,
    rescanDelayMs: 1500,
    emitStats: true,
    wasm: { wasmUrl },
  })
  let lockTimer = 0
  let trackTimer = 0
  inst.on('state', ({ state, previous }) => { s.state = state; s.backend = inst.backend ?? '-'; say(`state: ${previous} → ${state}`); if (state === 'scanning') requestAnimationFrame(updateRoi) })
  inst.on('error', ({ error }) => { s.error = error.code; say(`ERROR ${error.code} (recoverable=${error.recoverable}) ${error.cause?.name ?? error.cause ?? ''}`) })
  inst.on('camera', ({ camera, capabilities, settings }) => {
    s.camera = camera; s.caps = capabilities; s.settings = settings; s.backend = inst.backend ?? '-'
    say(`camera: ${camera.label} [${camera.facing}] ${settings.resolution.width}x${settings.resolution.height}`)
    inst.listCameras().then((l) => { s.cameras = l })
  })
  inst.on('stats', ({ stats }) => { s.fps = stats.fps; s.decodeMs = `${stats.decodeMs.p50.toFixed(1)}/${stats.decodeMs.p95.toFixed(1)}`; s.dropped = stats.droppedFrames })
  inst.on('candidate', ({ candidate }) => {
    const t = getElementTransform(video.value)
    if (!t) return
    s.track = toElementSpace(candidate.quad, t).map((p) => `${p.x},${p.y}`).join(' ')
    s.hint = candidate.progress ? `${candidate.progress.seen}/${candidate.progress.required}` : 'located'
    clearTimeout(trackTimer); trackTimer = setTimeout(() => { s.track = ''; s.hint = '' }, 300)
  })
  inst.on('decoded', ({ result }) => {
    const t = getElementTransform(video.value)
    if (t) s.lock = toElementSpace(result.quad, t).map((p) => `${p.x},${p.y}`).join(' ')
    clearTimeout(lockTimer); lockTimer = setTimeout(() => { s.lock = '' }, 700)
    navigator.vibrate?.(60)
    s.results.unshift({ text: result.text, format: result.format, at: new Date().toLocaleTimeString(), bytes: result.rawBytes?.length ?? '-' })
    if (s.results.length > 30) s.results.pop()
    say(`decoded [${result.format}] ${result.text}`)
  })
  return inst
}

function updateRoi() { if (video.value) s.roiBox = rectToElementSpace(roi, video.value) }

const start = () => { s.error = null; sc.value.start().catch(() => {}) }
const stop = () => sc.value.stop()
const pauseResume = () => (s.state === 'paused' ? sc.value.resume() : sc.value.pause())
const torch = () => sc.value.setTorch(!s.settings?.torch).catch((e) => say(`torch: ${e.code}`))
const next = () => sc.value.switchCamera('next').catch((e) => say(`switch: ${e.code}`))

// 單張圖片解碼（createDecoder），也是桌機沒相機時的測試入口
const fileResult = ref('')
async function decodeFile(ev) {
  const file = ev.target.files?.[0]
  if (!file) return
  fileResult.value = '…'
  const t0 = performance.now()
  try {
    const d = await createDecoder({ formats: ['qr_code', 'code_128', 'ean_13', 'code_39', 'data_matrix'], multi: true, wasm: { wasmUrl } })
    const res = await d.decode(file)
    await d.dispose()
    fileResult.value = res.length ? res.map((r) => `[${r.format}] ${r.text}`).join('\n') : '(no code found)'
    say(`file decode: ${res.length} result(s) in ${(performance.now() - t0).toFixed(0)}ms via ${d.backend}`)
  } catch (e) {
    fileResult.value = `error: ${e.code ?? e.message}`
  }
  ev.target.value = ''
}

onMounted(async () => {
  sc.value = build_scanner()
  support.value = await probeSupport()
  window.addEventListener('resize', updateRoi)
})
onBeforeUnmount(() => { sc.value.stop(); window.removeEventListener('resize', updateRoi) })
</script>

<template>
  <main class="app">
    <div class="build">build {{ build }} · state <b>{{ s.state }}</b> · backend {{ s.backend }}</div>

    <div class="viewport">
      <video ref="video" class="video" />
      <svg class="overlay" v-if="s.roiBox">
        <rect :x="s.roiBox.x" :y="s.roiBox.y" :width="s.roiBox.width" :height="s.roiBox.height" class="roi" />
        <polygon v-if="s.track" :points="s.track" class="track" />
        <polygon v-if="s.lock" :points="s.lock" class="lock" />
      </svg>
      <div v-if="s.hint" class="hint">{{ s.hint }}</div>
    </div>

    <div class="controls">
      <button v-if="s.state === 'idle' || s.state === 'stopped' || s.state === 'failed'" @click="start">Start</button>
      <button v-else @click="stop">Stop</button>
      <button :disabled="s.state !== 'scanning' && s.state !== 'paused'" @click="pauseResume">{{ s.state === 'paused' ? 'Resume' : 'Pause' }}</button>
      <button :disabled="!s.caps?.torch" @click="torch">Torch {{ s.settings?.torch ? 'off' : 'on' }}</button>
      <button :disabled="s.state !== 'scanning' && s.state !== 'paused'" @click="next">Next cam</button>
    </div>

    <ul class="results">
      <li v-for="(r, i) in s.results" :key="i"><span class="fmt">{{ r.format }}</span> {{ r.text }} <small>{{ r.at }} · {{ r.bytes }}B</small></li>
      <li v-if="!s.results.length" class="empty">（尚無結果）</li>
    </ul>

    <label class="file">解碼圖片檔（createDecoder）：<input type="file" accept="image/*" @change="decodeFile" /></label>
    <pre v-if="fileResult" class="stats">{{ fileResult }}</pre>

    <pre class="stats">
error: {{ s.error ?? '-' }}
camera: {{ s.camera?.label ?? '-' }} [{{ s.camera?.facing }}]  caps: torch={{ s.caps?.torch }} zoom={{ s.caps?.zoom ? `${s.caps.zoom.min}-${s.caps.zoom.max}` : 'no' }}
settings: {{ s.settings?.resolution.width }}x{{ s.settings?.resolution.height }} @{{ s.settings?.frameRate }}
fps: {{ s.fps }}  decode p50/p95: {{ s.decodeMs }}ms  dropped: {{ s.dropped }}
support: {{ JSON.stringify(support) }}
cameras:{{ s.cameras.map((c) => `\n  "${c.label}" [${c.facing}]${c.deviceId === s.camera?.deviceId ? ' ◀' : ''}`).join('') }}
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
.controls { display: flex; gap: 6px; }
.controls button { flex: 1; padding: 12px 4px; font-size: 15px; }
.results { list-style: none; margin: 0; padding: 0; font-size: 14px; max-height: 160px; overflow: auto; background: #1a1a1a; }
.results li { padding: 4px 8px; border-bottom: 1px solid #333; word-break: break-all; }
.results .fmt { color: #9cf; font-family: monospace; font-size: 12px; }
.results .empty { color: #777; }
.results small { color: #888; }
.file { font-size: 13px; }
.stats { font-size: 12px; white-space: pre-wrap; word-break: break-all; margin: 0; }
.log { font-size: 11px; margin: 0; padding-left: 16px; max-height: 240px; overflow: auto; }
</style>

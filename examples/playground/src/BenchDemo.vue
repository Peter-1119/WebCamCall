<script setup>
import { onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { createScanner, rectToElementSpace } from '@scanner/core'

/**
 * 效能量測（Phase 7）。把一張 QR 放在框內不動，按 Run：
 * - 端到端延遲：幀被擷取（result.timestamp）→ 收到 decoded 事件的毫秒數，p50 / p95
 * - 解碼耗時：Worker 內量測（stats 事件）
 * - 主執行緒：Long Tasks API（Chrome）+ rAF 間隔 > 50ms 的次數（所有瀏覽器）
 * - 記憶體：performance.memory（只有 Chrome 有；Safari 顯示 n/a）
 * - 5 分鐘 soak：看 fps / 延遲有沒有隨時間變差、記憶體有沒有一直長
 */
const video = ref(null)
const roi = { x: 0.1, y: 0.3, width: 0.8, height: 0.4 }
const wasmUrl = `${import.meta.env.BASE_URL}zxing_reader.wasm`

const s = reactive({
  state: 'idle', running: false, elapsed: 0, duration: 30,
  latency: [], decodeP50: [], decodeP95: [], fps: [], dropped: 0, decodedCount: 0,
  longTasks: 0, longTaskMax: 0, rafStalls: 0, rafMax: 0,
  memStart: null, memNow: null, memSamples: [],
  report: '', roiBox: null,
})

const pct = (arr, p) => { if (!arr.length) return 0; const a = [...arr].sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.floor(p * a.length))] }
const mem = () => performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null

let scanner = null
let timer = 0
let rafId = 0
let lastRaf = 0
let po = null

function buildScanner() {
  const sc = createScanner(video.value, {
    formats: ['qr_code', 'code_128', 'ean_13'],
    roi,
    debounceFrames: 0,
    rescanDelayMs: 0,
    emitStats: true,
    wasm: { wasmUrl },
  })
  sc.on('state', ({ state }) => { s.state = state; if (state === 'scanning') requestAnimationFrame(() => { s.roiBox = rectToElementSpace(roi, video.value) }) })
  sc.on('decoded', ({ result }) => {
    if (!s.running) return
    s.latency.push(performance.now() - result.timestamp)
    s.decodedCount++
  })
  sc.on('stats', ({ stats }) => {
    if (!s.running) return
    s.decodeP50.push(stats.decodeMs.p50); s.decodeP95.push(stats.decodeMs.p95); s.fps.push(stats.fps); s.dropped += stats.droppedFrames
  })
  sc.on('error', ({ error }) => { s.report = `ERROR ${error.code}` })
  return sc
}

function rafLoop(t) {
  if (lastRaf) { const gap = t - lastRaf; if (gap > 50) { s.rafStalls++; if (gap > s.rafMax) s.rafMax = gap } }
  lastRaf = t
  rafId = requestAnimationFrame(rafLoop)
}

async function run() {
  reset()
  scanner = scanner ?? buildScanner()
  await scanner.start()
  s.running = true
  s.memStart = mem()
  lastRaf = 0
  rafId = requestAnimationFrame(rafLoop)
  if ('PerformanceObserver' in window && PerformanceObserver.supportedEntryTypes?.includes('longtask')) {
    po = new PerformanceObserver((list) => { for (const e of list.getEntries()) { s.longTasks++; if (e.duration > s.longTaskMax) s.longTaskMax = e.duration } })
    po.observe({ type: 'longtask' })
  }
  const t0 = performance.now()
  timer = setInterval(() => {
    s.elapsed = Math.round((performance.now() - t0) / 1000)
    s.memNow = mem()
    if (s.elapsed % 30 === 0 && s.memNow != null) s.memSamples.push(`${s.elapsed}s:${s.memNow}MB`)
    if (s.elapsed >= s.duration) finish()
  }, 1000)
}

function finish() {
  clearInterval(timer)
  cancelAnimationFrame(rafId)
  po?.disconnect(); po = null
  s.running = false
  const fpsAvg = s.fps.length ? (s.fps.reduce((a, b) => a + b, 0) / s.fps.length).toFixed(1) : '0'
  s.report = [
    `=== bench ${new Date().toLocaleString()} · ${navigator.userAgent.match(/(iPad|iPhone|Android|Windows|Mac)[^;)]*/)?.[0] ?? ''} ===`,
    `duration: ${s.elapsed}s   decoded events: ${s.decodedCount}   avg fps: ${fpsAvg}   dropped: ${s.dropped}`,
    `end-to-end latency (capture → decoded):  p50 ${pct(s.latency, 0.5).toFixed(1)}ms   p95 ${pct(s.latency, 0.95).toFixed(1)}ms   n=${s.latency.length}`,
    `decode (worker):  p50 ${pct(s.decodeP50, 0.5).toFixed(1)}ms   p95 ${pct(s.decodeP95, 0.95).toFixed(1)}ms`,
    `main thread:  long tasks ${po === null && !('longtask' in (PerformanceObserver.supportedEntryTypes ?? [])) ? 'n/a (no Long Tasks API)' : `${s.longTasks} (max ${s.longTaskMax.toFixed(0)}ms)`}   rAF stalls >50ms: ${s.rafStalls} (max ${s.rafMax.toFixed(0)}ms)`,
    `memory:  ${s.memStart == null ? 'n/a (performance.memory unavailable)' : `${s.memStart}MB → ${s.memNow}MB  [${s.memSamples.join(' ')}]`}`,
  ].join('\n')
}

function reset() {
  Object.assign(s, { elapsed: 0, latency: [], decodeP50: [], decodeP95: [], fps: [], dropped: 0, decodedCount: 0, longTasks: 0, longTaskMax: 0, rafStalls: 0, rafMax: 0, memStart: null, memNow: null, memSamples: [], report: '' })
}

async function stop() { finish(); await scanner?.stop() }
const copy = () => navigator.clipboard?.writeText(s.report)

onMounted(() => { window.addEventListener('resize', () => { if (video.value) s.roiBox = rectToElementSpace(roi, video.value) }) })
onBeforeUnmount(() => { clearInterval(timer); cancelAnimationFrame(rafId); po?.disconnect(); scanner?.stop() })
</script>

<template>
  <main class="app">
    <div class="viewport">
      <video ref="video" class="video" />
      <svg v-if="s.roiBox" class="overlay"><rect :x="s.roiBox.x" :y="s.roiBox.y" :width="s.roiBox.width" :height="s.roiBox.height" class="roi" /></svg>
      <div class="live" v-if="s.running">{{ s.elapsed }}s / {{ s.duration }}s · decoded {{ s.decodedCount }} · p50 {{ pct(s.latency, 0.5).toFixed(0) }}ms</div>
    </div>
    <p class="tip">把一張 QR 或條碼放在綠框內不要動，按 Run。用 5 min 看穩定性與記憶體。</p>
    <div class="controls">
      <select v-model.number="s.duration" :disabled="s.running">
        <option :value="30">30 s</option>
        <option :value="120">2 min</option>
        <option :value="300">5 min</option>
      </select>
      <button v-if="!s.running" @click="run">Run</button>
      <button v-else @click="stop">Stop</button>
      <button :disabled="!s.report" @click="copy">Copy</button>
    </div>
    <pre v-if="s.report" class="report">{{ s.report }}</pre>
    <pre class="stats">state: {{ s.state }}</pre>
  </main>
</template>

<style scoped>
.app { display: flex; flex-direction: column; gap: 8px; padding: 8px; max-width: 480px; margin: 0 auto; }
.viewport { position: relative; width: 100%; aspect-ratio: 3 / 4; background: #000; overflow: hidden; }
.video { width: 100%; height: 100%; object-fit: cover; display: block; }
.overlay { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; }
.roi { fill: none; stroke: #0f0; stroke-width: 2; }
.live { position: absolute; top: 8px; left: 8px; background: rgba(0,0,0,.7); padding: 4px 8px; font-size: 12px; font-family: monospace; }
.tip { font-size: 13px; color: #aaa; margin: 0; }
.controls { display: flex; gap: 6px; }
.controls > * { flex: 1; padding: 12px 4px; font-size: 15px; }
.report { font-size: 12px; white-space: pre-wrap; background: #1a2a1a; border: 1px solid #2a4a2a; padding: 8px; margin: 0; }
.stats { font-size: 12px; margin: 0; }
</style>

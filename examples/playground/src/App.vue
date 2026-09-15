<script setup>
import { onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import {
  createCameraController, createFrameGrabber, createFrameSource, createScaleController,
  probeSupport, rectToElementSpace, resolveOptions,
} from '@scanner/core'

// Phase 2 demo：相機管線，不解碼。用來在實機驗證 iOS / Android 行為。
// eslint-disable-next-line no-undef
const build = typeof __BUILD__ !== 'undefined' ? __BUILD__ : 'dev'
const video = ref(null)
const debug = ref(null)
const support = ref(null)
const log = ref([])
const roi = { x: 0.1, y: 0.3, width: 0.8, height: 0.4 }
const options = resolveOptions({ roi, targetFps: 15 })

const s = reactive({
  camera: null, caps: null, settings: null, roiBox: null, error: null,
  fps: 0, dropped: 0, throttled: 0, level: '-', grab: '-', grabMs: 0, running: false, cameras: [],
})

const say = (m) => log.value.unshift(`${new Date().toLocaleTimeString()} ${m}`)

const ctrl = createCameraController((e) => {
  if (e.type === 'camera') {
    s.camera = e.camera.info; s.caps = e.camera.capabilities; s.settings = e.camera.settings
    say(`camera: ${e.camera.info.label || '(no label)'} [${e.camera.info.facing}] ${e.camera.settings.resolution.width}x${e.camera.settings.resolution.height}`)
    requestAnimationFrame(updateRoi)
    ctrl.listCameras().then((list) => { s.cameras = list })
  } else {
    s.error = e.error.code; say(`LOST: ${e.error.code}`)
  }
}, { debug: (m) => say(`  · ${m}`) })
const grabber = createFrameGrabber()
const scale = createScaleController(options.decodeScale, roi)
let source = null
let statTimer = 0

function updateRoi() {
  if (video.value) s.roiBox = rectToElementSpace(roi, video.value)
}

async function onFrame() {
  const v = video.value
  const plan = scale.plan({ width: v.videoWidth, height: v.videoHeight })
  const t0 = performance.now()
  const frame = await grabber.grab(v, plan.crop, plan.targetWidth, t0)
  s.grabMs = (performance.now() - t0).toFixed(1)
  s.level = String(plan.level)
  s.grab = `${frame.bitmap.width}x${frame.bitmap.height} (scale ${frame.scale.toFixed(2)})`
  // 把送去解碼的內容畫出來，實機上肉眼確認裁切與縮放是否正確
  const d = debug.value
  if (d) {
    if (d.width !== frame.bitmap.width || d.height !== frame.bitmap.height) { d.width = frame.bitmap.width; d.height = frame.bitmap.height }
    d.getContext('2d').drawImage(frame.bitmap, 0, 0)
  }
  frame.bitmap.close()
  scale.report('none', frame.imageSize) // 沒有解碼器：模擬一直沒解出，看階梯輪替
}

async function start() {
  s.error = null
  try {
    await ctrl.open(video.value, options)
    source = createFrameSource(video.value, onFrame, options.targetFps)
    source.start()
    s.running = true
    statTimer = setInterval(() => {
      s.fps = source.stats.delivered; s.dropped = source.stats.dropped; s.throttled = source.stats.throttled
      source.resetStats()
    }, 1000)
  } catch (err) {
    s.error = err.code ?? String(err); say(`ERROR ${s.error} ${err.cause?.name ?? ''}`)
  }
}
async function stop() {
  clearInterval(statTimer); source?.stop(); source = null
  await ctrl.close(); s.running = false; s.camera = null; s.caps = null
}
const torch = () => ctrl.setTorch(!s.settings?.torch).catch((e) => say(`torch: ${e.code}`))
async function next() {
  const list = await ctrl.listCameras()
  const i = list.findIndex((c) => c.deviceId === s.camera?.deviceId)
  const target = list[(i + 1) % list.length]
  say(`switch → ${target.label}`)
  source?.stop()
  await ctrl.open(video.value, options, target.deviceId)
  source = createFrameSource(video.value, onFrame, options.targetFps); source.start()
}

onMounted(async () => { support.value = await probeSupport(); window.addEventListener('resize', updateRoi) })
onBeforeUnmount(() => { stop(); window.removeEventListener('resize', updateRoi) })
</script>

<template>
  <main class="app">
    <div class="build">build {{ build }}</div>
    <div class="viewport">
      <video ref="video" class="video" />
      <div v-if="s.roiBox" class="roi" :style="{ left: s.roiBox.x + 'px', top: s.roiBox.y + 'px', width: s.roiBox.width + 'px', height: s.roiBox.height + 'px' }" />
    </div>
    <div class="controls">
      <button v-if="!s.running" @click="start">Start</button>
      <button v-else @click="stop">Stop</button>
      <button :disabled="!s.caps?.torch" @click="torch">Torch {{ s.settings?.torch ? 'off' : 'on' }}</button>
      <button :disabled="!s.running" @click="next">Next camera</button>
    </div>
    <pre class="stats">
error: {{ s.error ?? '-' }}
camera: {{ s.camera?.label ?? '-' }} [{{ s.camera?.facing }}]
caps: torch={{ s.caps?.torch }} zoom={{ s.caps?.zoom ? `${s.caps.zoom.min}-${s.caps.zoom.max}` : 'no' }} focus={{ s.caps?.focusModes?.join(',') || 'no' }}
settings: {{ s.settings?.resolution.width }}x{{ s.settings?.resolution.height }} @{{ s.settings?.frameRate }} focus={{ s.settings?.focusMode }}
frames/s: {{ s.fps }} dropped: {{ s.dropped }} throttled: {{ s.throttled }}
grab: {{ s.grab }} level: {{ s.level }} {{ s.grabMs }}ms
support: {{ JSON.stringify(support) }}
cameras:{{ s.cameras.map((c) => `
  ${c.deviceId.slice(0, 8)}… "${c.label}" [${c.facing}]${c.deviceId === s.camera?.deviceId ? ' ◀ current' : ''}`).join('') }}
    </pre>
    <ul class="log"><li v-for="(l, i) in log" :key="i">{{ l }}</li></ul>
    <canvas ref="debug" class="debug" />
  </main>
</template>

<style>
body { margin: 0; font-family: system-ui; background: #111; color: #eee; }
.build { font-size: 12px; color: #9f9; font-family: monospace; }
.app { display: flex; flex-direction: column; gap: 8px; padding: 8px; max-width: 480px; margin: 0 auto; }
.viewport { position: relative; width: 100%; aspect-ratio: 3 / 4; background: #000; overflow: hidden; }
.video { width: 100%; height: 100%; object-fit: cover; display: block; }
.roi { position: absolute; border: 2px solid #0f0; box-shadow: 0 0 0 9999px rgba(0,0,0,.45); pointer-events: none; }
.controls { display: flex; gap: 8px; }
.controls button { flex: 1; padding: 12px; font-size: 16px; }
.stats { font-size: 12px; white-space: pre-wrap; word-break: break-all; margin: 0; }
.debug { max-width: 100%; border: 1px solid #444; }
.log { font-size: 11px; margin: 0; padding-left: 16px; }
</style>

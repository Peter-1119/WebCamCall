<script setup>
import { ref } from 'vue'
import { BarcodeScanner } from '@cclemon/scanner-ui'

// 「5 行跑起來」的用法：元件包好相機、overlay、震動；文案全部由這裡（App）提供
const scanner = ref(null)
const results = ref([])
// 廠內無外網：wasm 一定要自架，否則 core 會去 jsDelivr CDN 抓而失敗（decoder-init-failed）
const wasmUrl = `${import.meta.env.BASE_URL}zxing_reader.wasm`
const hintText = { align: '把條碼對進框內', 'move-closer': '靠近一點', 'hold-steady': '拿穩一點' }
const errorText = { 'permission-denied': '請允許相機權限', 'no-camera': '找不到相機', 'camera-in-use': '相機被其他 App 佔用' }
const onDecoded = (r) => results.value.unshift(`${r.format}: ${r.text}`)
// 格式組合：一般（QR / 1D）或 PCB 2DID（點陣 Data Matrix，自動開啟 dotted 加強）
const mode = ref('normal')
const formats = { normal: ['qr_code', 'code_128', 'ean_13'], dm: ['data_matrix'] }
// zoom prop：遠拍小碼最有效的手段（每模組像素數 ×zoom）；不支援 zoom 的相機會靜默略過
const zoom = ref(1)
</script>

<template>
  <main class="app">
    <div class="viewport">
      <BarcodeScanner
        ref="scanner"
        :formats="formats[mode]"
        :wasm-url="wasmUrl"
        :zoom="zoom"
        @decoded="onDecoded"
      >
        <!-- 提示與錯誤文案由 App 提供，元件只給 code -->
        <template #hint="{ hint }"><span class="pill">{{ hintText[hint] ?? hint }}</span></template>
        <template #status="{ state }">狀態：{{ state }}</template>
        <template #error="{ error, retry }">
          <div class="err">
            <p>{{ errorText[error?.code] ?? error?.code }}</p>
            <button @click="retry">重試</button>
          </div>
        </template>
        <template #actions="{ state, close }">
          <button class="mini" @click="close">✕</button>
        </template>
        <!-- default slot 拿到 composable 的全部回傳 -->
        <template #default="{ state, start, stop }">
          <button class="fab" @click="state === 'scanning' ? stop() : start()">{{ state === 'scanning' ? 'Stop' : 'Start' }}</button>
        </template>
      </BarcodeScanner>
    </div>
    <div class="bar">
      <label><input type="radio" value="normal" v-model="mode" /> QR / 1D</label>
      <label><input type="radio" value="dm" v-model="mode" /> 2DID（點陣 DM）</label>
      <label class="zoom">zoom {{ zoom.toFixed(1) }}<input type="range" min="1" max="5" step="0.5" v-model.number="zoom" /></label>
    </div>
    <ul class="results"><li v-for="(r, i) in results" :key="i">{{ r }}</li></ul>
  </main>
</template>

<style scoped>
.app { display: flex; flex-direction: column; gap: 8px; padding: 8px; max-width: 480px; margin: 0 auto; }
.viewport { width: 100%; aspect-ratio: 3 / 4; }
.pill { background: rgba(0,0,0,.7); color: #fff; padding: 6px 14px; border-radius: 999px; font-size: 14px; }
.err { background: rgba(0,0,0,.8); padding: 16px; border-radius: 8px; text-align: center; }
.mini { background: rgba(0,0,0,.5); color: #fff; border: 0; width: 32px; height: 32px; border-radius: 50%; }
.fab { position: absolute; bottom: 12px; left: 50%; transform: translateX(-50%); padding: 12px 28px; font-size: 16px; border-radius: 999px; border: 0; }
.bar { display: flex; gap: 12px; align-items: center; font-size: 14px; flex-wrap: wrap; }
.zoom { display: flex; gap: 6px; align-items: center; }
.results { list-style: none; margin: 0; padding: 0; font-size: 14px; max-height: 200px; overflow: auto; background: #1a1a1a; }
.results li { padding: 4px 8px; border-bottom: 1px solid #333; word-break: break-all; }
</style>

# @scanner — 跨平台 Web 條碼 / QR 掃描 library

Headless core + Vue composable + 預設 UI。主要目標裝置 iPad Safari，桌機 Chrome 可用。

```
packages/
  core/   @scanner/core   零依賴、不綁框架：相機管線、wasm/native 解碼、狀態機、座標換算
  vue/    @scanner/vue    useBarcodeScanner() composable（同時 re-export core）
  ui/     @scanner/ui     <BarcodeScanner> 全包元件、<ScannerOverlay> 預設 overlay（零文案）
examples/
  playground/             四個分頁：<BarcodeScanner> / composable / core / bench
docs/
  device-checklist.md     實機測試檢查表
  deploy.md               部署與廠內環境的坑
  barcode-scanner-prompts.md  原始的開發提示詞包
```

## 快速開始

### 5 行：`<BarcodeScanner>`

```vue
<script setup>
import { BarcodeScanner } from '@scanner/ui'
const onDecoded = (r) => console.log(r.text, r.format)
</script>

<template>
  <BarcodeScanner :formats="['qr_code']" :wasm="{ wasmUrl: '/scanner/zxing_reader.wasm' }" @decoded="onDecoded">
    <template #hint="{ hint }">{{ { align: '對準框內', 'move-closer': '靠近一點', 'hold-steady': '拿穩' }[hint] }}</template>
    <template #error="{ error, retry }"><button @click="retry">{{ error.code }}</button></template>
  </BarcodeScanner>
</template>
```

### composable：自己排版

```vue
<script setup>
import { ref } from 'vue'
import { useBarcodeScanner, QR_FORMATS, LINEAR_FORMATS } from '@scanner/vue'

const video = ref(null)
const mode = ref('qr')
const { state, lastResult, error, start, stop } = useBarcodeScanner(video, () => ({
  formats: mode.value === 'qr' ? QR_FORMATS : LINEAR_FORMATS,   // 改 mode 即熱切換
  wasm: { wasmUrl: '/scanner/zxing_reader.wasm' },
}))
</script>
```

### 純 JS / 其他框架：core

```js
import { createScanner } from '@scanner/core'

const scanner = createScanner(videoEl, { formats: ['qr_code'], wasm: { wasmUrl: '/zxing_reader.wasm' } })
scanner.on('decoded', ({ result }) => console.log(result.text))
scanner.on('error', ({ error }) => console.log(error.code, error.recoverable))
await scanner.start()
```

## 設計重點

- **零文案**：core 只回傳 `code`（`'permission-denied'`、`'move-closer'`…），i18n 是 App 的事
- **單一模式預設**：畫面有多個碼時只回報離掃描框中心最近的一個；`multi: true` 才全部回報
- **格式越少越快**：`formats: QR_FORMATS` / `LINEAR_FORMATS` / 混合；可用 `updateOptions()` 熱切換
- **多尺度解碼**：`decodeScale` 三層策略（640 基準 → 階梯升級 → 候選放大），遠近都解得出
- **主執行緒不碰像素**：`ImageBitmap` transfer 進 Worker，wasm 解碼在 Worker
- **座標一律原始影像座標系**：畫框用 `toElementSpace()` / `rectToElementSpace()` 換算，處理 `object-fit: cover`
- **`stop()` 可重入、`pause()`/`resume()` 嚴格**：見 `STATE_TRANSITIONS`

## 開發

```bash
pnpm install
pnpm dev          # tsup --watch（core）+ vite（playground，https://<ip>:5173）
pnpm test         # vitest：195 tests，含真 zxing-wasm 的整合測試
pnpm typecheck
pnpm build
```

桌機自動化測試用 `PLAYGROUND_HTTP=1 pnpm --filter playground dev`（http://localhost:5174，免憑證）。

## 部署

```bash
./scripts/deploy-playground.sh    # → https://sfserver.flexium.com.tw/scanner/
```

廠內必讀：`docs/deploy.md`（wasmUrl、nginx MIME、SELinux、Git Bash 路徑轉換）。

## 實機數據（iPad，2026-09-16）

| 項目 | 數值 |
|---|---|
| 相機 | 後置相機 1080×1920 @30，zoom 1–10，無 torch |
| 端到端延遲（幀擷取 → decoded 事件） | p50 23 ms / p95 25 ms，5 分鐘不變 |
| wasm 解碼（碼在框內、base 640） | p50 2 ms / p95 3 ms；階梯升到全解析度時 12–15 ms |
| 解碼幀率 | 15 fps，5 分鐘 4489 / 4500 幀命中，主執行緒 rAF 零卡頓 |
| 格式 | QR、Code 128 實測 OK |
| BarcodeDetector | 不存在 → `auto` 走 wasm |

## 錯誤代碼

| code | recoverable | 情境 |
|---|---|---|
| `insecure-context` | ✗ | 非 HTTPS |
| `permission-denied` | ✓ | 使用者拒絕 |
| `no-camera` | ✗ | 沒有相機 |
| `camera-in-use` | ✓ | 被其他 App 佔用 |
| `constraints-unsatisfiable` | ✓ | deviceId 失效等 |
| `camera-failed` | ✓ | 其他 gUM 錯誤、等不到首幀 |
| `track-ended` | ✓ | 相機被系統收走且自動恢復失敗 |
| `decoder-init-failed` | 視情況 | wasm 下載失敗（沒設 wasmUrl 時最常見） |
| `decoder-crashed` | ✓ | Worker 死掉 |
| `unsupported-backend` / `unsupported-format` | ✗ | 強制 native 但不可用 |
| `capability-unsupported` | ✗ | torch / zoom 不支援 |
| `invalid-state` | — | 程式邏輯錯誤（同步 throw） |

# @cclemon/scanner 快速上手（Vue 3 + Vite）

條碼 / QR 掃描，iPad Safari 實測：對準後約 25 ms 出結果。
這份文件可以直接複製到其他專案的 `docs/`。

## 1. 安裝

```bash
pnpm add @cclemon/scanner-ui @cclemon/scanner-vue @cclemon/scanner-core
```

> 需要 `@cclemon/scanner-core` **≥ 0.1.2**（wasm 檔內附）。`pnpm view @cclemon/scanner-core version` 確認。

## 2. 最簡用法（5 行）

```vue
<script setup>
import { BarcodeScanner } from '@cclemon/scanner-ui'
import wasmUrl from '@cclemon/scanner-core/zxing_reader.wasm?url'

const onDecoded = (result) => {
  console.log(result.text, result.format)   // 例如 'Y04900132', 'code_128'
}
const errorText = { 'permission-denied': '請允許相機權限', 'no-camera': '找不到相機', 'camera-in-use': '相機被其他 App 佔用' }
</script>

<template>
  <!-- 元件會填滿父容器，父容器要給尺寸 -->
  <div style="width: 100%; max-width: 480px; aspect-ratio: 3 / 4">
    <BarcodeScanner :formats="['qr_code', 'code_128']" :wasm-url="wasmUrl" @decoded="onDecoded">
      <template #hint="{ hint }">
        {{ { align: '把條碼對進框內', 'move-closer': '靠近一點', 'hold-steady': '拿穩一點' }[hint] }}
      </template>
      <template #error="{ error, retry }">
        <button @click="retry">{{ errorText[error.code] ?? error.code }}，點我重試</button>
      </template>
      <template #default="{ state, start, stop }">
        <button v-if="state !== 'scanning'" @click="start">開始掃描</button>
        <button v-else @click="stop">停止</button>
      </template>
    </BarcodeScanner>
  </div>
</template>
```

- **一定要有一個按鈕呼叫 `start()`**：iOS 要求相機由使用者手勢觸發，不能自動開。
- 元件本身沒有任何文字，所有文案由 slot 提供（方便 i18n）。
- 畫面同時有多個碼時，只回報**框中央**的那一個；同一個碼留在框內只會觸發 `@decoded` **一次**（拿開 1.5 秒再放回才會再觸發），所以直接在 `onDecoded` 送 API 不會重複送。

## 3. 格式（越少越快）

```js
import { QR_FORMATS, LINEAR_FORMATS } from '@cclemon/scanner-vue'

:formats="QR_FORMATS"                        // 只掃 QR（預設）
:formats="LINEAR_FORMATS"                    // 只掃一維條碼（EAN/UPC/Code128/Code39/ITF…）
:formats="[...QR_FORMATS, ...LINEAR_FORMATS]" // 混合，成本約 1.5–2 倍
```

`formats` 是響應式的：綁一個 `ref` 改值就即時切換，不重啟相機。

## 4. 自己排版：composable

```vue
<script setup>
import { ref } from 'vue'
import { useBarcodeScanner } from '@cclemon/scanner-vue'
import wasmUrl from '@cclemon/scanner-core/zxing_reader.wasm?url'

const video = ref(null)
const { state, lastResult, error, start, stop, toggleTorch, capabilities } = useBarcodeScanner(video, {
  formats: ['qr_code'],
  wasm: { wasmUrl },
  onDecoded: (r) => submit(r.text),
})
</script>

<template>
  <video ref="video" style="width: 100%; object-fit: cover" />
  <button @click="start">掃描</button>
  <button v-if="capabilities?.torch" @click="toggleTorch">手電筒</button>
  <p>{{ lastResult?.text }}</p>
  <p v-if="error">{{ error.code }}</p>
</template>
```

回傳值（都是 readonly ref）：`state` `error` `backend` `camera` `capabilities` `settings` `lastResult` `candidates` `support`；
方法：`start` `stop` `pause` `resume` `toggleTorch` `setZoom` `switchCamera` `updateOptions`。
元件卸載時自動釋放相機與 Worker。

## 5. 錯誤代碼 → 文案（自己對 i18n）

| `error.code` | 意思 | 建議文案 |
|---|---|---|
| `permission-denied` | 使用者拒絕相機 | 請允許相機權限後重試 |
| `no-camera` | 沒有相機 | 此裝置沒有相機 |
| `camera-in-use` | 被其他 App 佔用 | 請關閉其他使用相機的 App |
| `insecure-context` | 不是 HTTPS | 需以 HTTPS 開啟 |
| `camera-failed` / `track-ended` | 相機異常 | 相機異常，請重試 |
| `decoder-init-failed` | wasm 載入失敗（多半是 `wasm-url` 沒設或路徑錯） | 掃描器載入失敗 |

`error.recoverable === true` 時顯示「重試」按鈕即可。

## 6. 部署注意

- **HTTPS**（相機硬性條件；`http://localhost` 例外）
- nginx 若是舊版要補 `types { application/wasm wasm; }`
- 不能有 `Permissions-Policy: camera=()` header
- 掛在子路徑（`/rms/`）時 `?url` 匯入會自動處理，不用改

## 7. 常見問題

| 現象 | 原因 |
|---|---|
| 按了開始沒反應、state 停在 `requesting-permission` | 瀏覽器正在問權限，或 iPad 上不是由手勢觸發 |
| `decoder-init-failed` | 沒傳 `wasm-url`，core 去 CDN 抓 wasm 但內網沒外網 |
| 掃得到 QR 掃不到條碼 | `formats` 沒包含一維格式 |
| 兩個碼只回報一個 | 設計如此（單一模式）；要全部回報加 `:multi="true"` |
| 前鏡頭畫面左右相反 | `<BarcodeScanner mirror>` |

## 更多

- 完整說明與 iPad 實測數據：https://github.com/Peter-1119/WebCamCall （private）
- 部署細節：`docs/deploy.md`；實機檢查表：`docs/device-checklist.md`

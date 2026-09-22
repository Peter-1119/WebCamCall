<!-- 此檔由 scripts/sync-docs.mjs 從 docs/ 產生，請改 docs/ 再重跑 build -->

# @cclemon/scanner 完整使用手冊

> QUICKSTART 是「5 分鐘跑起來」；這份是「所有能調的東西、為什麼這樣設計、遇到問題怎麼查」。
> 適用版本：`scanner-core ≥ 0.1.5`、`scanner-vue ≥ 0.1.2`、`scanner-ui ≥ 0.1.2`。

---

## 目錄

1. [三個套件、三種用法](#1-三個套件三種用法)
2. [安裝與 wasm 檔](#2-安裝與-wasm-檔)
3. [`<BarcodeScanner>` 元件](#3-barcodescanner-元件)
4. [`useBarcodeScanner()` composable](#4-usebarcodescanner-composable)
5. [`createScanner()` core API](#5-createscanner-core-api)
6. [所有設定選項（ScannerOptions）](#6-所有設定選項scanneroptions)
7. [事件](#7-事件)
8. [狀態機](#8-狀態機)
9. [錯誤代碼](#9-錯誤代碼)
10. [格式與效能調校](#10-格式與效能調校)
11. [多尺度解碼（decodeScale）](#11-多尺度解碼decodescale)
12. [點陣式 Data Matrix（dotted）](#12-點陣式-data-matrixdotted)
13. [單一 vs 多碼模式](#13-單一-vs-多碼模式)
14. [重複發送控制（debounce / rescanDelay）](#14-重複發送控制debounce--rescandelay)
15. [相機控制：切鏡頭、手電筒、縮放](#15-相機控制切鏡頭手電筒縮放)
16. [座標與自訂 overlay](#16-座標與自訂-overlay)
17. [`<ScannerOverlay>` 預設 overlay](#17-scanneroverlay-預設-overlay)
18. [單張圖片解碼（createDecoder）](#18-單張圖片解碼createdecoder)
19. [iOS Safari 注意事項](#19-ios-safari-注意事項)
20. [生命週期：stop / dispose / 暖機](#20-生命週期stop--dispose--暖機)
21. [常見情境食譜](#21-常見情境食譜)
22. [除錯與疑難排解](#22-除錯與疑難排解)
23. [部署](#23-部署)

---

## 1. 三個套件、三種用法

| 套件 | 內容 | 依賴 |
|---|---|---|
| `@cclemon/scanner-core` | 相機管線、wasm/native 解碼、狀態機、座標換算、單張圖片解碼。**零依賴、不綁框架**。 | 無 |
| `@cclemon/scanner-vue` | `useBarcodeScanner()` composable。同時 re-export core 的所有東西。 | vue ^3.3、core |
| `@cclemon/scanner-ui` | `<BarcodeScanner>` 全包元件、`<ScannerOverlay>` 預設 overlay。**零文案**。 | vue、core、vue 套件 |

| 用法 | 適合 | 你要做的 |
|---|---|---|
| **A. `<BarcodeScanner>`** | 80% 的情境：要一個掃描框、掃到就拿結果 | 放元件、給 slot 文案、接 `@decoded` |
| **B. `useBarcodeScanner()` + 自己的 template** | 版面要自己排、overlay 要自己畫 | 準備 `<video ref>`、用回傳的 ref 與方法 |
| **C. `createScanner()`** | 非 Vue 專案、或要完全控制 | 自己訂閱事件、自己管生命週期 |

三層是疊起來的：A 用 B，B 用 C。任何一層都可以「往下拿」——`<BarcodeScanner>` 的 template ref 就是 B 的回傳，B 的 `scanner` ref 就是 C 的實例。

---

## 2. 安裝與 wasm 檔

```bash
pnpm add @cclemon/scanner-ui @cclemon/scanner-vue @cclemon/scanner-core
```

### wasm 是什麼、為什麼要一個 URL

解碼器本體是 **953 KB 的 WebAssembly 二進位檔**（zxing-cpp 編譯），瀏覽器執行時要像圖片一樣從某個 URL 下載。它**已經包在 `scanner-core` 套件裡**（`dist/zxing_reader.wasm`），問題只是「部署後它在你網站的哪個網址」。

尋找順序（core 0.1.2+）：

1. 你給的 `wasm.wasmUrl`（或 `<BarcodeScanner wasm-url>`）
2. 與 worker 檔同目錄的 `zxing_reader.wasm`——webpack、Vite **dev** 模式自動成立
3. jsDelivr CDN——**需要外網**，內網會失敗（`decoder-init-failed`），console 有 `[scanner] ... fell back to CDN` 警告

**Vite 專案 production build 不會替 node_modules 裡的檔案產生資源**，所以請一定傳：

```js
import wasmUrl from '@cclemon/scanner-core/zxing_reader.wasm?url'
```

Vite 會把它複製到 `dist/assets/zxing_reader-<hash>.wasm` 並給你正確網址（子路徑自動處理）。這個 URL **指向你自己的網站**，不是外網。

其他 bundler：把 `node_modules/@cclemon/scanner-core/dist/zxing_reader.wasm` 複製到靜態目錄，`wasmUrl` 填部署後的路徑（可以是目錄，會自動接 `/zxing_reader.wasm`）。

---

## 3. `<BarcodeScanner>` 元件

```vue
<script setup>
import { ref } from 'vue'
import { BarcodeScanner } from '@cclemon/scanner-ui'
import wasmUrl from '@cclemon/scanner-core/zxing_reader.wasm?url'

const scanner = ref(null)   // template ref = composable 的全部回傳（已 unwrap）
</script>

<template>
  <div style="width: 100%; aspect-ratio: 3 / 4">
    <BarcodeScanner
      ref="scanner"
      :formats="['qr_code', 'code_128', 'data_matrix']"
      :wasm-url="wasmUrl"
      :roi="{ x: 0.1, y: 0.3, width: 0.8, height: 0.4 }"
      :debounce-frames="2"
      :rescan-delay-ms="1500"
      :target-fps="15"
      @decoded="onDecoded"
      @error="onError"
      @state="onState"
    >
      <template #hint="{ hint }">…</template>
      <template #status="{ state, hint, lastResult }">…</template>
      <template #error="{ error, retry }">…</template>
      <template #actions="{ state, retry, close }">…</template>
      <template #default="{ state, start, stop, lastResult, capabilities, toggleTorch, switchCamera }">…</template>
    </BarcodeScanner>
  </div>
</template>
```

### Props

| prop | 型別 | 預設 | 說明 |
|---|---|---|---|
| `formats` | `BarcodeFormat[]` | `['qr_code']` | 要辨識的格式，見 §10 |
| `wasm-url` | `string` | — | wasm 檔 URL，見 §2 |
| `wasm` | `{ wasmUrl?, createWorker? }` | — | 進階：自訂 Worker 建立方式 |
| `backend` | `'auto' \| 'native' \| 'wasm'` | `'auto'` | 見 §6 |
| `camera` | `CameraOptions` | — | deviceId / facingMode / 解析度，見 §6 |
| `roi` | `Roi \| null` | `{0.1, 0.3, 0.8, 0.4}` | 掃描框（幀的比例）；`null` = 整幀 |
| `decode-scale` | `DecodeScaleOptions` | 見 §11 | 多尺度解碼 |
| `debounce-frames` | `number` | `2` | 連續幾幀相同才確認 |
| `rescan-delay-ms` | `number` | `1500` | 同碼離開畫面多久後可再發 |
| `target-fps` | `number` | `15` | 解碼幀率上限 |
| `multi` | `boolean` | `false` | 多碼模式，見 §13 |
| `dotted` | `boolean \| 'auto'` | `'auto'` | 點陣式 DM 前處理，見 §12 |
| `zoom` | `number` | — | 相機 zoom，開好相機就套用、夾在 `capabilities.zoom` 範圍內；不支援就略過。遠拍小碼用 2–3 |
| `emit-stats` | `boolean` | `false` | 每秒發 `stats` 事件 |
| `auto-start` | `boolean` | `false` | 元素出現後自動 start（iOS 不建議） |
| `mirror` | `boolean` | `false` | 前鏡頭鏡像顯示（座標會一起換算） |
| `object-fit` | `'cover' \| 'contain' \| 'fill'` | `'cover'` | video 的 object-fit，overlay 依此換算座標 |
| `vibrate` | `number \| false` | `60` | 成功時震動毫秒 |
| `sound` | `string \| null` | `null` | 成功音效 URL |
| `stuck-after-ms` | `number` | `2000` | 有候選但多久沒解出就提示 |
| `align-after-ms` | `number` | `3000` | 沒有任何候選多久就提示對準 |

### Emits

| 事件 | 參數 |
|---|---|
| `decoded` | `DecodedResult` |
| `error` | `ScannerError` |
| `state` | `(state, previous)` |
| `close` | overlay 的 ✕ 或 Escape |
| `retry` | `failed` 時按 Enter 或 error slot 的 `retry()`（元件會自動再 `start()`） |

### Slots

| slot | 何時顯示 | slot props |
|---|---|---|
| `hint` | 卡住時（底部置中） | `{ hint: 'align' \| 'move-closer' \| 'hold-steady' }` |
| `status` | 永遠，視覺隱藏、`aria-live="polite"` | `{ state, hint, lastResult }` |
| `error` | `state === 'failed'`（置中） | `{ error, retry }` |
| `actions` | 永遠（右上角） | `{ state, retry, close }` |
| default | 永遠，疊最上層 | composable 的全部回傳（已 unwrap，`state` 是字串） |

元件**沒有任何內建文字**——連按鈕都沒有。這是刻意的：文案由 App 決定，方便 i18n。

### 尺寸

元件 `width/height: 100%` 填滿父容器，**父容器要有尺寸**。手機直式建議 `aspect-ratio: 3 / 4`。

---

## 4. `useBarcodeScanner()` composable

```js
import { useBarcodeScanner } from '@cclemon/scanner-vue'

const video = ref(null)
const api = useBarcodeScanner(video, options)
```

- `video`：`Ref<HTMLVideoElement | null>`。scanner 在元素出現時才建立（支援 `v-if`），元素換掉會重建。
- `options`：`ScannerOptions`（§6）加上四個 callback 與 `autoStart`。**可以是 ref / getter**——可熱更新的欄位改了會自動套用，不重啟相機。

### 回傳值

| 名稱 | 型別 | 說明 |
|---|---|---|
| `state` | `Readonly<Ref<ScannerState>>` | 見 §8 |
| `error` | `Readonly<Ref<ScannerError \| null>>` | 進入 `starting`/`scanning` 時自動清空 |
| `backend` | `'native' \| 'wasm' \| null` | 實際選到的後端 |
| `camera` | `CameraInfo \| null` | `{ deviceId, label, facing }` |
| `capabilities` | `CameraCapabilities \| null` | `{ torch, zoom: {min,max,step} \| null, focusModes }`，**用前必檢查** |
| `settings` | `CameraSettings \| null` | `{ torch, zoom, focusMode, resolution, frameRate }` |
| `lastResult` | `DecodedResult \| null` | 最近一次 decoded |
| `candidates` | `readonly Candidate[]` | 目前幀的候選（每幀最多更新一次，300ms 沒新候選清空） |
| `support` | `SupportReport \| null` | `probeSupport()` 結果（client 端才有） |
| `scanner` | `Scanner \| null` | 底層實例（§5） |
| `start()` | `Promise<void>` | 元素還沒出現會等 |
| `stop()` | `Promise<void>` | 停相機，解碼器暖機保留 |
| `pause()` / `resume()` | — | 只在 scanning / paused 合法 |
| `toggleTorch()` | `Promise<void>` | 依 `settings.torch` 反轉 |
| `setZoom(v)` | `Promise<void>` | 範圍見 `capabilities.zoom` |
| `switchCamera(target?)` | `Promise<void>` | 預設 `'next'` |
| `updateOptions(patch)` | — | 熱更新 |

### Callback 選項

```js
useBarcodeScanner(video, {
  onDecoded: (result) => {},
  onCandidate: (candidate) => {},        // 高頻，每個候選一次
  onError: (error) => {},
  onStateChange: (state, previous) => {},
  autoStart: false,
})
```

ref 風格與 callback 風格可以並用。

### 響應式選項範例：依場別切格式

```js
const mode = ref('qr')
useBarcodeScanner(video, () => ({
  formats: mode.value === 'qr' ? QR_FORMATS : LINEAR_FORMATS,
  wasm: { wasmUrl },
}))
// 改 mode.value 就即時生效，相機不重啟
```

### 清理

在元件 setup 內呼叫時，scope 銷毀（元件卸載）會自動 `dispose()`（停相機 + 終止 Worker）。在 setup 之外呼叫（沒有 effect scope）要自己呼叫 `api.scanner.value.dispose()`。

---

## 5. `createScanner()` core API

```js
import { createScanner } from '@cclemon/scanner-core'

const scanner = createScanner(videoEl, options)   // 不會立即開相機
const off = scanner.on('decoded', ({ result }) => {})
await scanner.start()
// …
await scanner.stop()      // 停相機，保留解碼器
await scanner.dispose()   // 全部釋放
```

### 屬性（唯讀）

`state`、`options`（套用預設值後）、`backend`、`camera`、`capabilities`、`settings`。

### 方法

| 方法 | 合法狀態 | 非法時 |
|---|---|---|
| `start()` | idle / stopped / failed | 其他狀態 no-op，回傳進行中的 promise |
| `stop()` / `dispose()` | 任何 | 永遠 no-op（可重入） |
| `pause()` | scanning | **同步 throw** `invalid-state` |
| `resume()` | paused | **同步 throw** `invalid-state` |
| `switchCamera(target)` | scanning / paused | reject `invalid-state` |
| `setTorch(on)` / `setZoom(v)` | scanning / paused | reject `invalid-state` 或 `capability-unsupported` |
| `listCameras()` | 任何 | — |
| `updateOptions(patch)` | 任何 | — |
| `on(type, listener)` | 任何 | 回傳取消訂閱函式 |
| `subscribe(listener)` | 任何 | 訂閱所有事件 |

`start()` 失敗時**同時** emit `error` 事件並 reject 同一個錯誤物件，兩種風格都能接。

### 對 `<video>` 做的事

core 會設定 `srcObject`、`playsInline`、`muted`、`autoplay` 並呼叫 `play()`。樣式（大小、object-fit）由你負責。iOS 15 若在 `display: none` 時指定 srcObject 會不渲染，要藏請用 `visibility: hidden`。

---

## 6. 所有設定選項（ScannerOptions）

```ts
interface ScannerOptions {
  formats?: BarcodeFormat[]            // 預設 ['qr_code']
  backend?: 'auto' | 'native' | 'wasm' // 預設 'auto'
  camera?: {
    deviceId?: string                  // 指定鏡頭（來自 listCameras()）
    facingMode?: 'environment' | 'user'// 預設 'environment'
    idealWidth?: number                // 預設 1920
    idealHeight?: number               // 預設 1080
    preferMainCamera?: boolean         // 預設 true（Android 避開超廣角/微距）
    stream?: MediaStream               // 自己管理的 stream；core 不會 stop 它
  }
  wasm?: {
    wasmUrl?: string                   // 見 §2
    createWorker?: () => Worker        // bundler 搞不定 new Worker(new URL()) 時用
  }
  roi?: Roi | null                     // 預設 null = 整幀
  decodeScale?: {                      // 見 §11
    base?: number                      // 640
    ladder?: number[]                  // [960, 1280, 0]
    escalateAfterFrames?: number       // 5
    zoomToCandidate?: boolean          // true
  }
  debounceFrames?: number              // 2
  rescanDelayMs?: number               // 1500
  targetFps?: number                   // 15
  multi?: boolean                      // false
  emitStats?: boolean                  // false
  dotted?: boolean | 'auto'            // 'auto'
}
```

### 哪些可以熱更新（`updateOptions()`，不重啟相機）

`formats`、`roi`、`targetFps`、`debounceFrames`、`rescanDelayMs`、`multi`、`decodeScale`、`dotted`。
其他（`backend`、`camera`、`wasm`）要 `stop()` 再 `start()`。

### `backend`

- `auto`：有 `BarcodeDetector` 且要求的格式全部支援 → native，否則 wasm。**iPad Safari 沒有 BarcodeDetector；Windows Chrome 有建構子但格式為空**，兩者都走 wasm。
- `native`：強制；不可用 → `unsupported-backend`。
- `wasm`：強制。需要 raw bytes、或想避開平台差異時用。

### `camera.idealWidth/Height`

是 `ideal` 不是 `exact`，瀏覽器給最接近的（桌機 webcam 常給 640×480 或 1280×720，iPad 給 1080×1920 直式）。實際值看 `settings.resolution`。一維條碼需要較高水平解析度，二維碼 1280 通常夠。

### `camera.deviceId` / `listCameras()`

```js
const cams = await scanner.listCameras()
// [{ deviceId, label: '後置相機', facing: 'environment' }, …]
```

權限取得前 `label` 是空字串。iOS 的 label 會隨系統語言在地化（中文介面是「後置相機」「前置超廣角相機」）。

---

## 7. 事件

所有事件都是 `{ type, ... }` 的 discriminated union，`on(type, listener)` 會自動窄化型別。

| type | payload | 頻率 | 說明 |
|---|---|---|---|
| `state` | `{ state, previous }` | 狀態轉移時 | 見 §8 |
| `candidate` | `{ candidate }` | **每幀可能多次** | 見下方 |
| `decoded` | `{ result }` | 確認後，每個碼一次 | 見下方 |
| `error` | `{ error }` | 出錯時 | 見 §9 |
| `camera` | `{ camera, capabilities, settings }` | 開啟、切換、自動恢復、torch/zoom 改變後 | |
| `stats` | `{ stats }` | 每秒（`emitStats: true` 才有） | `{ fps, decodeMs: {p50, p95}, droppedFrames }` |

### `DecodedResult`

```ts
{
  text: string
  format: BarcodeFormat          // 'qr_code' | 'code_128' | 'data_matrix' | …
  quad: Quad<'image'>            // 四角，原始影像座標系，左上→右上→右下→左下
  rawBytes: Uint8Array | null    // native 後端為 null
  imageSize: { width, height }   // 該幀尺寸
  frameId: number                // 同一幀的多個結果共用（多碼分組用）
  timestamp: number              // performance.now()，幀被擷取的時間
  backend: 'native' | 'wasm'
}
```

### `Candidate`

「疑似條碼但尚未確認」，兩種情況：

1. 找到位置但解不出（`text` 為 `undefined`）——太小、太遠、失焦、點陣碼。只有 wasm 會發。
2. 解出了但 debounce 還沒滿（`text` 有值，`progress: { seen, required }`）。

`candidate` 高頻，UI 要自己節流；composable 的 `candidates` ref 已經合併成每幀一次。

---

## 8. 狀態機

```
idle ─start()─▶ requesting-permission ─▶ starting ─▶ scanning ⇄ paused
                        │                   │           │          │
                        └──▶ failed ◀───────┴───────────┴──────────┘
                               │
  (任何非 idle 狀態) ─stop()─▶ stopped ─start()─▶ requesting-permission
```

| 狀態 | 意思 |
|---|---|
| `idle` | 建立後尚未 start |
| `requesting-permission` | `getUserMedia()` 進行中（瀏覽器可能在問權限） |
| `starting` | 拿到 stream，等 video 就緒與解碼器載入（第一次含下載 wasm）；`switchCamera()` 也會經過 |
| `scanning` | 解碼迴圈執行中 |
| `paused` | 迴圈停止，預覽維持 |
| `stopped` | 資源已釋放，可再 start |
| `failed` | 不可自動恢復的錯誤，可再 start |

`idle` 與 `stopped` 的差別只在「是否曾啟動過」，方便 UI 顯示「重試」而非「開始」。

合法轉移表以 `STATE_TRANSITIONS` 常數匯出，可以直接拿來做 UI 判斷。

---

## 9. 錯誤代碼

`ScannerError` 繼承 `Error`，有 `code`、`recoverable`、`cause`（原始 DOMException）。**message 等於 code**，沒有使用者文案。

| code | recoverable | 情境 | 建議處理 |
|---|---|---|---|
| `insecure-context` | ✗ | 非 HTTPS（localhost 例外） | 顯示「需 HTTPS」 |
| `permission-denied` | ✓ | 使用者拒絕 | 引導到設定重新允許，提供重試 |
| `no-camera` | ✗ | 沒有 videoinput | 顯示不支援 |
| `camera-in-use` | ✓ | 被其他 App 佔用（Android 常見） | 提示關閉其他 App，重試 |
| `constraints-unsatisfiable` | ✓ | deviceId 失效等（core 已自動退階三次仍失敗） | 重試或換鏡頭 |
| `camera-failed` | ✓ | 其他 gUM 錯誤；stream 開了但 6 秒等不到首幀 | 重試 |
| `track-ended` | ✓ | 相機被系統收走且自動恢復失敗 | 重試 |
| `decoder-init-failed` | 視情況 | wasm 下載失敗（沒設 wasmUrl、內網、路徑錯） | 檢查 wasm URL；message 會列出嘗試過的位置 |
| `decoder-crashed` | ✓ | Worker 死掉 / 5 秒無回應 | 重試（會重建） |
| `unsupported-backend` | ✗ | 強制 native 但不可用 | 改 auto |
| `unsupported-format` | ✗ | 格式在該後端不支援（`error.formats` 列出） | 改 formats 或 backend |
| `capability-unsupported` | ✗ | `setTorch/setZoom` 但 track 不支援（`error.capability`） | 先看 `capabilities` |
| `invalid-state` | — | 在非法狀態呼叫方法（**同步 throw**，不 emit） | 程式邏輯錯誤 |

```js
import { isScannerError } from '@cclemon/scanner-core'
try { await scanner.start() } catch (e) {
  if (isScannerError(e)) showMessage(t(`scanner.${e.code}`), e.recoverable)
}
```

---

## 10. 格式與效能調校

### 格式常數

```js
import { QR_FORMATS, LINEAR_FORMATS, MATRIX_FORMATS, ALL_FORMATS } from '@cclemon/scanner-core'
```

| 常數 | 內容 |
|---|---|
| `QR_FORMATS` | `qr_code` |
| `LINEAR_FORMATS` | `ean_13 ean_8 upc_a upc_e code_128 code_39 code_93 codabar itf databar databar_expanded` |
| `MATRIX_FORMATS` | `qr_code micro_qr aztec data_matrix pdf417 maxicode` |
| `ALL_FORMATS` | 全部 |

### 格式越少越快

zxing 對一維（掃線）與二維（定位圖案）是兩套演算法，只給一種就只跑一套。混合大約 1.5–2 倍成本。場景固定時給單一組合，混合場景再合併，或用 `updateOptions({ formats })` 依場別熱切換。

### 效能旋鈕

| 旋鈕 | 影響 | 建議 |
|---|---|---|
| `formats` | 最大 | 只給需要的 |
| `roi` | 大 | 框越小越快，也讓使用者知道要對哪裡 |
| `targetFps` | 中 | 15 足夠；省電可 10 |
| `decodeScale.base` | 中 | 640 預設；一維條碼很小時可 800 |
| `dotted` | 碼在框內 +10 ms／幀；找不到碼時 +40–120 ms／幀（見 §12） | 只有 PCB 點陣碼需要 |

### iPad 實測（後鏡頭 1080×1920、ROI 0.8×0.4、base 640）

- 碼在框內：Worker 解碼 p50 2 ms / p95 3 ms，端到端（幀擷取 → decoded 事件）p50 23 ms / p95 25 ms
- 碼不在框內（階梯升到全解析度 + tryHarder）：12–15 ms
- 5 分鐘 4489/4500 幀命中，主執行緒 rAF 零卡頓

---

## 11. 多尺度解碼（decodeScale）

問題：解碼成本與像素數成正比，但小碼/遠距需要足夠像素（QR 每模組至少 2–3 px）。固定降採樣顧此失彼。

三層策略（由便宜到貴）：

1. **base**（640）：每幀先縮到這個寬度解。大多數情況一幀就解出。
2. **ladder**（`[960, 1280, 0]`，`0` = 全解析度）：連續 `escalateAfterFrames`（5）幀沒結果就升一級，到底繞回；解出後停在成功的那級。升級後同時開 zxing 的 `tryHarder`。
3. **zoomToCandidate**：wasm 回報「找到位置但解不出」時，下一幀對該區域做**全解析度局部裁切**。像素少、資訊足，是遠距小碼的最佳解。

```js
decodeScale: { base: 640, ladder: [960, 1280, 0], escalateAfterFrames: 5, zoomToCandidate: true }
// 關掉全部（固定降採樣）：{ base: 640, ladder: [], zoomToCandidate: false }
```

一維條碼很細時可把 `base` 提到 800；碼一定很大（例如貼在箱子上）可把 `ladder` 設 `[]` 省事。

---

## 12. 點陣式 Data Matrix（dotted）

PCB 鑽孔、雷射點刻的 DPM 碼每個模組是**圓點**而非實心方格，zxing 取樣落在點間空隙 → 「有黃框但解不出」，遠拍時甚至連黃框都沒有（zxing 的 L 邊追蹤在模組 2–3 px 時幾乎找不到候選）。

`dotted` 開啟時（預設 `'auto'` = `formats` 含 `data_matrix`），即時掃描每幀多做四件事，**一般 QR / 一維流程完全不受影響**：

1. **整幀第二次嘗試**：正常解碼沒結果就做一次「百分位對比拉伸 → 形態學膨脹（把點撐成方塊）→ 再解」。膨脹核要接近模組大小，而模組大小取決於距離，所以每幀輪替 `[5, 3, 9, 7, 13, 17] × {暗點, 亮點}` 十二種變體（**絕對值**，不隨畫面縮放），上一幀有定位框就改用框寬估的核，成功後記住。
2. **點密度定位**：整幀連候選都沒有時，找「一小塊區域擠滿小點」的地方（black-hat 去背景 → 局部極大 = 點 → 視窗內點數的峰值），最多 3 個候選。影像解析度夠（≥ 0.75× 原圖）就直接在 Worker 內裁候選、多變體再解；不夠就交給下一幀裁原尺寸。
3. **候選裁切用帽濾波變體**：所有原尺寸小裁切（候選放大、追蹤）都用「black-hat / top-hat 去背景 + 膨脹」的一組變體（核依預期符號寬度挑，±2），40 ms 預算內全部試完。影片實測（模組 3 px）光這一步就把可解幀從 4% 拉到 20%。
4. **追蹤**：任何一次解出 / 定位到，之後每幀多抓一塊上次位置周圍的原尺寸小裁切（≥ 160 px），解碼器**先解它**（~10 ms），命中就不用解主幀；主幀照常走階梯，維持發現新碼的能力。連續 10 幀沒在裁切裡解出才放掉。

**成本分工**：

| | 每幀多做的事 | 成本（Node 量測，實機請看 `stats`） |
|---|---|---|
| 即時掃描（`formats` 不含 `data_matrix`） | 無 | 0 |
| 即時掃描（含 `data_matrix`），碼在框內正常距離 | 追蹤裁切 ~10 ms，命中後主幀不解 | 約 +10 ms／幀 |
| 即時掃描（含 `data_matrix`），遠拍 / 找不到碼 | 整幀變體 + 點密度定位（帽濾波佔大半） | 640 寬 +40–60 ms、1080 寬 +90–120 ms／幀；解碼幀率會下降但主執行緒不卡 |
| 拍照模式 `createDecoder` | 多尺度（960/1280/640/1920）× 12 變體 + 候選裁切，全部在 Worker 內同一份像素上跑 | 印刷碼 < 100 ms；點陣碼 0.2–1.5 s；預設 3 秒預算 |

- 只有 wasm 後端支援。
- 實測 17 張 PCB 照片（兩種板材、遠近、旋轉、反光）：拍照模式 **14/17**；剩下是整塊板子入鏡、碼只佔畫面 2% 的遠拍。
- 實測影片（整塊板子入鏡、碼 57–84 px 寬、模組 2.6–3.8 px、30 秒 448 幀）：0.1.5 之前 **3/448** 幀解出 → 現在 **69/448**，首次命中 0.2 s、最長空窗 8.5 s。用「已知位置 + 全部變體」的理論上限約 100/448：剩下的幀是**打光讓點完全不可見**（銅面均勻深色）或動態模糊，任何演算法都救不了。

使用建議（重要性排序）：

1. **用 zoom**：`<BarcodeScanner :zoom="2.5">` 或 `scanner.setZoom()`。每模組像素數 × zoom，比任何演算法都有效；iPad 實測 zoom 1–10。
2. 碼佔框寬 **1/4 以上**、對準框中央。
3. 打光：鑽孔點只在某些入射角有對比，畫面上點看不見時換個角度。
4. `createDecoder()`（單張圖片）沒有幀預算，會把變體全部試完。

研究筆記與待試清單見 `docs/dpm-research.md`。

---

## 13. 單一 vs 多碼模式

**`multi: false`（預設）**：畫面有多個碼時，只回報**離掃描框中心最近**的那一個。`decoded` 永遠只有一個結果，開發者只讀 `result.text`，座標可以完全不理。使用者自然會學到「把要掃的碼對進框中間」。

**`multi: true`**：每幀找到的每個碼各發一個 `decoded`，用 `result.frameId` 分組：

```js
const seen = new Map()
scanner.on('decoded', ({ result }) => {
  seen.set(result.text, result)          // 同一幀的多個結果 frameId 相同
  render([...seen.values()])
})
```

多碼時建議 `debounceFrames: 0`（不然每個碼都要等），並自己畫框告訴使用者哪個是哪個（§16）。

---

## 14. 重複發送控制（debounce / rescanDelay）

### `debounceFrames`（預設 2）

連續 N 幀解出**相同值**才發 `decoded`，過濾單幀誤判（一維條碼特別需要）。中間過程發 `candidate`（帶 `progress`）。設 `0` 立即發。

### `rescanDelayMs`（預設 1500）

同一個值發出後，要**離開畫面 ≥ N ms** 才可再發。碼一直留在框內只發**一次**——「掃到 → 送出 → 拿開」的流程不會重複送單。拿開超過 1.5 秒再放回才會再發。設 `0` 關閉（每個確認幀都發，App 自己去重）。

兩者搭配的典型設定：

| 情境 | debounceFrames | rescanDelayMs |
|---|---|---|
| 掃到就送 API（預設） | 2 | 1500 |
| 掃到就 `stop()` | 1–2 | 隨意（不會再發） |
| 持續監看某個碼是否還在 | 1 | 0 + 自己去重 |
| 多碼盤點 | 0 | 3000 |

---

## 15. 相機控制：切鏡頭、手電筒、縮放

```js
// 能力一定要先檢查，任何一項都可能不支援
if (scanner.capabilities?.torch) await scanner.setTorch(true)
if (scanner.capabilities?.zoom) await scanner.setZoom(2)   // 會夾在 min..max

await scanner.switchCamera('next')                          // 依 listCameras() 順序
await scanner.switchCamera({ facingMode: 'user' })
await scanner.switchCamera(deviceId)
```

`switchCamera` 會經過 `starting` 再回到 `scanning`（或 `paused`，維持切換前狀態）。

iPad 實測：後鏡頭 `torch=false`（無閃光燈）、`zoom 1–10`、`focusModes []`（iOS 不暴露但預設連續對焦）。iOS 會在廣角/微距間自動切換，web 無法鎖定，對掃碼反而有利。

### 鏡頭選擇邏輯（`preferMainCamera`）

開啟後若開到的鏡頭方向不對（iPad Safari 對 `ideal: environment` 曾給前鏡頭）或 label 含 ultra-wide / telephoto / macro / 超廣角 / 望遠 / 微距，會用 deviceId 重開一次。正常裝置零成本。

### 自動恢復

track `ended`、切 App 回來、鎖屏解鎖：core 會 re-play、1.5 秒內 `currentTime` 沒前進就用同一顆鏡頭重開，成功則發 `camera` 事件（不發 error），失敗才發 `track-ended`。掃描迴圈會自動重建。

---

## 16. 座標與自訂 overlay

### 座標系

- **影像座標**（`Quad<'image'>`）：core 回傳的所有座標。原點幀左上角，單位 px，範圍 `videoWidth × videoHeight`。不受 ROI / 降採樣影響。
- **元素座標**（`Quad<'element'>`）：`<video>` 元素的 CSS px。要畫到畫面上才需要。

兩者用 TypeScript phantom type 區分，把影像座標直接畫到 overlay 是**編譯錯誤**。

### 三個 helper

```js
import { getElementTransform, toElementSpace, rectToElementSpace } from '@cclemon/scanner-core'

const t = getElementTransform(videoEl, { objectFit: 'cover', mirrored: false })  // 每幀一次
const quad = toElementSpace(result.quad, t)      // Quad<'element'>
const box  = rectToElementSpace(roi, t)          // { x, y, width, height } CSS px
```

- `getElementTransform` 會讀 `videoWidth/Height` 與 `clientWidth/Height`（強制 layout），**每幀呼叫一次**後把結果餵給另外兩個，不要每個候選都量。video 還沒尺寸時回 `null`。
- `rectToElementSpace` 是畫掃描框的**唯一正確方式**：與 core 實際裁切的區域同一份 ROI、同一套換算。
- `objectFit` 要與 CSS 一致；不預設讀 `getComputedStyle` 是為了避免 style recalc。

### SVG overlay 範例（composable）

```vue
<script setup>
const video = ref(null)
const roi = { x: 0.1, y: 0.3, width: 0.8, height: 0.4 }
const { candidates, lastResult, state, start } = useBarcodeScanner(video, { roi, wasm: { wasmUrl } })

const box = ref(null)
watch(state, (s) => { if (s === 'scanning') requestAnimationFrame(() => { box.value = rectToElementSpace(roi, video.value) }) })

const polys = computed(() => {
  const t = video.value && getElementTransform(video.value)
  return t ? candidates.value.map((c) => toElementSpace(c.quad, t).map((p) => `${p.x},${p.y}`).join(' ')) : []
})
</script>

<template>
  <div style="position: relative">
    <video ref="video" style="width: 100%; object-fit: cover" />
    <svg style="position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none">
      <rect v-if="box" v-bind="box" fill="none" stroke="#0f0" stroke-width="2" />
      <polygon v-for="(p, i) in polys" :key="i" :points="p" fill="rgba(255,200,0,.2)" stroke="#fc0" stroke-width="3" />
    </svg>
  </div>
</template>
```

`window.resize` 時記得重算 `box`。前鏡頭用 CSS `scaleX(-1)` 鏡像時，`getElementTransform` 傳 `mirrored: true`。

---

## 17. `<ScannerOverlay>` 預設 overlay

想用 composable 自己排版、但不想畫框：

```vue
<div style="position: relative">
  <video ref="video" style="width: 100%; height: 100%; object-fit: cover" />
  <ScannerOverlay :api="api" :video="video" @close="…" @retry="api.start()">
    <template #hint="{ hint }">…</template>
  </ScannerOverlay>
</div>
```

| prop | 預設 | 說明 |
|---|---|---|
| `api` | 必填 | `useBarcodeScanner()` 的回傳 |
| `video` | 必填 | 同一個 `<video>` 元素 |
| `object-fit` | `'cover'` | 要與 CSS 一致 |
| `vibrate` | `60` | 成功震動 ms；`false` 關 |
| `sound` | `null` | 成功音效 URL |
| `stuck-after-ms` | `2000` | 有候選但沒解出多久提示 |
| `align-after-ms` | `3000` | 無候選多久提示 |
| `lock-ms` | `800` | 綠框顯示時間 |

行為：ROI 外暗色遮罩 + 四角括號（掃描框從 `api.scanner.options.roi` 讀，**不接受另一份 roi prop**，杜絕各算各的）；有候選時括號變黃變長；追蹤框每幀線性插值；成功綠框脈衝 + 勾勾 + 震動；失敗紅框 + 叉叉 + `error` slot；`role="status" aria-live` 區塊；鍵盤 Escape → `close`、failed 時 Enter → `retry`；`prefers-reduced-motion` 關閉動畫。

提示 code 的推斷：只有位置沒文字 → `move-closer`；有文字但 debounce 一直不滿 → `hold-steady`；沒候選超過 N 秒 → `align`；成功後 1.5 秒內不提示。

---

## 18. 單張圖片解碼（createDecoder）

上傳照片、相簿選圖、測試：

```js
import { createDecoder } from '@cclemon/scanner-core'

const decoder = await createDecoder({ formats: ['qr_code', 'data_matrix'], multi: true, wasm: { wasmUrl } })
const results = await decoder.decode(file)      // File / Blob / HTMLImageElement / ImageBitmap / canvas …
await decoder.dispose()
```

- 建立時就載入 wasm（不等第一次 decode）。
- 找不到回傳 `[]`，**不會 reject**。
- 沒有 ROI / debounce / 節流；`tryHarder` 一律開。
- 比即時掃描做得多：多尺度（960 / 1280 / 640 / 1920 寬）→ 候選裁切（原尺寸）→ 每一級把所有點陣變體試完。
- `decode(source, { budgetMs })` 預設 3000 ms 預算，到期回傳目前結果。印刷 QR 約 20 ms，難的點陣碼 0.2–1.5 s。
- 座標以該影像原始尺寸為準。
- iPad 實測相簿照片約 50–200 ms。

---

## 19. iOS Safari 注意事項

| 項目 | 做法 |
|---|---|
| 相機需要使用者手勢 | `start()` 要在 click/touch handler 內**同步**呼叫，不要先 await 別的東西。`autoStart` 在 iOS 不可靠 |
| HTTPS | 硬性條件。`http://localhost` 例外 |
| `playsInline` | core 已處理；否則會全螢幕播放 |
| 藏起 video | 用 `visibility: hidden`，不要 `display: none`（iOS 15 不渲染） |
| 切 App / 鎖屏回來 | core 自動恢復，看 `camera` 事件；失敗才 `track-ended` |
| torch 在背景會被關 | 回前景後 `settings.torch` 會更新，UI 綁 `settings` 而不是自己記 |
| `getSettings()` 剛開時沒 width/height | core 在 video 就緒後才讀 |
| UA 是 `Macintosh` | 不要用 UA 判斷 iPad，用 `navigator.maxTouchPoints > 1` |
| 沒有 BarcodeDetector | `auto` 自動走 wasm |
| PWA（加到主畫面） | 曾有 video 永不 load 的案例，core 有 6 秒 timeout → `camera-failed`，出現請回報 |

---

## 20. 生命週期：stop / dispose / 暖機

| 方法 | 相機 | 解碼器（Worker + WASM） | 之後 `start()` |
|---|---|---|---|
| `stop()` | 停 | **保留（暖機）** | 只需相機時間（快） |
| `dispose()` | 停 | 終止 | 重建解碼器（第一次的速度） |
| 解碼器出錯（`decoder-*`） | 停 | 丟掉 | 重建 |

「掃工號 → stop → 掃工單 → stop → 掃機台」這種循環很便宜。元件卸載 / 離開頁面時 composable 自動 `dispose()`；用 core 直接操作的人要自己呼叫。

`stop()` 與 `dispose()` 都可重入（重複呼叫不報錯）。`start()` 進行中呼叫 `stop()` 會安靜地中止，不發 error。

---

## 21. 常見情境食譜

### 掃到一個就停

```js
useBarcodeScanner(video, {
  onDecoded: async (r) => { await stop(); submit(r.text) },
})
```

### 依序掃多個欄位（工號 → 工單 → 機台）

```js
const field = ref('employee')
const { start, stop } = useBarcodeScanner(video, () => ({
  formats: field.value === 'employee' ? QR_FORMATS : LINEAR_FORMATS,   // 每個欄位可用不同格式
  onDecoded: async (r) => {
    await stop()
    form[field.value] = r.text
    field.value = nextField(field.value)
  },
}))
// 每個欄位：使用者點「掃描」→ start()；解碼器暖機，第二次起幾乎瞬間
```

### 掃描時允許同一個碼再掃（例如計數）

```js
{ rescanDelayMs: 0, debounceFrames: 2, onDecoded: (r) => count[r.text]++ }
// 注意：碼留在框內會每幀觸發，自己控制節奏（例如 1 秒內同值只算一次）
```

### 上傳照片解碼（沒相機也能用）

```vue
<input type="file" accept="image/*" capture="environment" @change="onFile" />
```
```js
async function onFile(e) {
  const d = await createDecoder({ formats: ALL_FORMATS, wasm: { wasmUrl } })
  const res = await d.decode(e.target.files[0]); await d.dispose()
}
```

### 用自己的 MediaStream

```js
const stream = await navigator.mediaDevices.getUserMedia({ video: true })
createScanner(video, { camera: { stream } })   // core 不會 stop 這個 stream
```

### 讀取效能數據

```js
createScanner(video, { emitStats: true }).on('stats', ({ stats }) => console.log(stats.fps, stats.decodeMs.p95))
```

---

## 22. 除錯與疑難排解

### 先看 `probeSupport()`

```js
import { probeSupport } from '@cclemon/scanner-core'
console.log(await probeSupport())
// { secureContext, getUserMedia, native: { present, available, formats }, wasm: { available }, requestVideoFrameCallback, offscreenCanvas }
```

### 症狀對照

| 症狀 | 最可能原因 | 查法 |
|---|---|---|
| state 停在 `requesting-permission` | 瀏覽器正在問權限；iOS 上不是手勢觸發 | 看瀏覽器有沒有權限泡泡 |
| `decoder-init-failed` | wasm URL 不對 / 內網沒外網 | `error.message` 列出嘗試過的位置；Network 面板看 `.wasm` 是否 200 |
| `camera-failed`（timeout） | video 6 秒沒幀：iOS PWA、或分頁被遮住 | 換一般 Safari 分頁試 |
| 掃 QR 可以、條碼不行 | `formats` 沒含一維 | 檢查 formats |
| Data Matrix 有黃框解不出 | 點陣式碼、或 formats 沒含 `data_matrix`、或 core < 0.1.3 | 升級 + 加格式；靠近一點 |
| 兩個碼只回報一個 | 單一模式設計如此 | 要全部就 `multi: true` |
| 同一個碼只發一次 | `rescanDelayMs` 語意（離開畫面才重發） | 要重發就設 `0` |
| 綠框位置不對 | `objectFit` 與 CSS 不一致；或 video 有 padding | 統一 object-fit；video 不要 padding |
| 前鏡頭左右相反 | 沒鏡像 | `mirror` / `mirrored: true` |
| 切分頁回來畫面凍結 | 自動恢復失敗 | log 有 `track-ended`？回報裝置與 iOS 版本 |
| 每次 Start 都要等 1 秒 | 用了 `dispose()` 而非 `stop()` | 保留暖機用 `stop()` |
| console `[scanner] ... fell back to CDN` | 沒設 wasmUrl，走外網 | 內網部署會失敗，設 wasmUrl |

### 事件流水帳

```js
scanner.subscribe((e) => console.log(e.type, e))
```

### 版本：確認瀏覽器真正在跑哪一版

```js
import { VERSION } from '@cclemon/scanner-core'
console.log('[scanner] core', VERSION)   // build 時從 package.json 編進 dist，例如 "0.2.1"
```

`package.json` / `npm ls` 只說明**裝了**什麼；bundler 的預打包快取（Vite `node_modules/.vite`）或部署端的 HTML 快取都可能讓瀏覽器跑到舊版。
掃描行為跟預期不符時，第一件事是印 `VERSION`。（0.2.0 之前這個常數固定是 `'0.0.0'`，沒有參考價值。）

---

## 23. 部署

- HTTPS（相機硬性條件）
- nginx 舊版補 `application/wasm` MIME：改全域 `/etc/nginx/mime.types`，**不要**在 location 內單獨寫 `types {}`（會整份取代，JS/CSS 變 text/plain）
- 不能有 `Permissions-Policy: camera=()`
- Rocky/RHEL：scp 後 `restorecon`
- 快取：assets 帶 hash 可長快取；只對 `index.html` 設 `no-store`

詳見 `docs/deploy.md`；實機測試項目見 `docs/device-checklist.md`。

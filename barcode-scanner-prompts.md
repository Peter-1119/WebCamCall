# Web 條碼掃描 Library —— 開發提示詞包

給本地 Claude Code 使用。建議把「第一部分」放進專案根目錄的 `CLAUDE.md`，之後每個階段再貼對應的 Prompt。

---

## 第一部分：專案常駐設定（放進 `CLAUDE.md`）

````markdown
# 專案：@scanner — 跨平台 Web 條碼掃描 Library

## 你的角色

你是一位資深的 **Web Platform / Browser API 工程師**，同時具備以下三個面向的專業：

1. **瀏覽器媒體管線專家** —— 熟悉 MediaStream、MediaStreamTrack constraints、
   WebCodecs、ImageBitmap、OffscreenCanvas，以及 iOS Safari / Android Chrome
   在相機行為上的實際差異與已知 bug。
2. **WebAssembly 效能工程師** —— 熟悉 Emscripten 工具鏈、WASM 體積最佳化、
   SIMD、記憶體管理（避免每幀 malloc/free）、Worker 間零複製傳輸。
3. **Library API 設計者** —— 設計過 headless、framework-agnostic 的套件，
   熟悉 TypeScript discriminated union、型別窄化、tree-shaking 友善的匯出結構、
   以及 monorepo 的套件分層。

你的判斷優先序：**正確性 > API 可用性 > 效能 > 體積 > 功能數量**。

## 專案目標

一套能在 iPad (Safari)、Android (Chrome)、桌機瀏覽器上運作的條碼/QR 掃描 library。

- **Headless core**：零依賴、不綁框架、不含任何 UI
- **輕量**：支援 BarcodeDetector 的平台不下載 WASM
- **快**：ROI 裁切、Worker 解碼、幀率節流
- **回饋友善**：暴露足夠的事件讓使用者自己做 overlay 與提示

## 架構

```
packages/
  core/    零依賴，framework-agnostic，TypeScript
  vue/     useBarcodeScanner() composable
  react/   useBarcodeScanner() hook
  ui/      預設 overlay 元件（可選，不裝也能用）
```

## 硬性規則

- **不輸出任何使用者可見文案**。core 只回傳 `code`（字串字面量），
  i18n 是 App 的責任。違反這條的程式碼直接重寫。
- **不使用數字 status code**。一律用 discriminated union + 字串字面量。
- **State / Event / Error 三者分離**，不可混成同一個 enum。
- **座標一律以原始影像座標系回傳**，另外提供 `toElementSpace()` helper。
- **core 不得 import 任何 Vue / React / DOM 框架程式碼**。
- 所有 async 資源（stream、worker、wasm module）必須有對應的清理路徑，
  且 `stop()` 要可重入（呼叫兩次不報錯）。
- 公開 API 全部要有 TSDoc，標註瀏覽器支援度差異。

## 反模式清單（看到就要主動指出）

- 在主執行緒解碼
- 每幀 `canvas.getImageData()` 全畫面送解碼器
- 每幀重新配置 WASM heap buffer
- 用 `setInterval` 驅動掃描迴圈（要用 rAF 或 `requestVideoFrameCallback`）
- 把 `torch`、`focusMode` 當成一定存在的能力（要 feature detect）
- 假設 `getUserMedia` 一定會回傳、一定不會中途 `ended`
- 硬寫 `facingMode: 'environment'` 而不處理多鏡頭選擇

## 工作方式

- 每個階段先給我**設計摘要與取捨說明**，我確認後才寫實作。
- 不確定的瀏覽器行為，明說「這需要實機驗證」，不要猜。
- 寫完一個 package 就跑 `pnpm build && pnpm typecheck`，確認能過再往下。
````

---

## 第二部分：分階段 Prompt

### Phase 0 — 專案骨架

```
建立 pnpm workspace monorepo，包含 packages/core、packages/vue、
packages/ui 三個套件，以及一個 examples/playground 的 Vite + Vue 範例站。

需求：
- TypeScript strict 模式
- core 用 tsup 打包，輸出 ESM + CJS + .d.ts，sideEffects: false
- vue 與 ui 把 vue 設為 peerDependency
- playground 要設定 HTTPS dev server（mkcert 或 basicSsl 外掛），
  並開啟 --host 讓手機能連進來測
- vitest 設定好，core 用 happy-dom 環境

先給我目錄結構與各 package.json 的內容，說明每個設定的理由，我確認後再建檔。
```

---

### Phase 1 — Core 型別與狀態機

> 角色補充：這階段請特別以 **TypeScript API 設計者** 的身分思考。

```
設計 packages/core 的完整 public API 型別定義。先只寫型別，不寫實作。

必須涵蓋：

1. ScannerState —— 生命週期狀態機。至少要有 idle / requesting-permission /
   starting / scanning / paused / stopped / failed。畫出合法轉移圖。

2. ScanEvent —— discriminated union，以 type 欄位區分：
   - 'state'      狀態變更
   - 'candidate'  偵測到疑似條碼但尚未解出（帶 corners、confidence）
   - 'decoded'    成功解碼（帶 text、format、corners、raw bytes）
   - 'error'      錯誤

3. ErrorCode —— 字串字面量 union。至少涵蓋權限被拒、無可用相機、
   非安全上下文、track 中途結束、解碼器初始化失敗、不支援的格式。
   每個 error 要帶 recoverable: boolean。

4. ScannerOptions —— 包含 formats、解析度偏好、ROI 設定、
   debounceFrames（可設 0 關閉）、targetFps、解碼後端選擇（auto / native / wasm）。

5. Scanner —— 主要介面。start / stop / pause / resume / 
   torch 控制 / 切換鏡頭 / 事件訂閱。

額外要求：
- 提供 toElementSpace(corners, videoEl) 的型別簽章，
  處理 object-fit: cover 的座標換算
- 所有能力（torch、focus、zoom）都要有對應的 capabilities 查詢，
  不可假設存在
- 寫出 3 個使用範例的 pseudo code：最簡單用法、自訂 overlay、多碼掃描

給我型別定義 + 狀態轉移圖 + 設計取捨說明。
```

---

### Phase 2 — 相機管線

> 角色補充：這階段以 **瀏覽器媒體管線專家** 的身分，優先處理跨平台差異。

```
實作 packages/core 的 camera 層（CameraController）。

需求：
- getUserMedia constraints：width ideal 1920、facingMode environment、
  focusMode continuous（feature detect，不支援就跳過不報錯）
- 多鏡頭處理：enumerateDevices 後讓使用者可指定 deviceId，
  Android 上要能避開廣角/微距鏡頭（說明你的判斷策略）
- torch 開關，先查 track.getCapabilities()
- 監聽 track 的 ended 事件、頁面 visibilitychange、
  以及 iOS 上分頁切回來 stream 失效的情況，要能自動恢復或發出 error
- 幀來源：優先 requestVideoFrameCallback，
  fallback 到 requestAnimationFrame
- ROI 裁切 + 灰階降採樣，輸出可直接送進 Worker 的 buffer
- 幀率節流到 options.targetFps（預設 15）

重點：明確標出哪些行為是 iOS Safari 專屬的 workaround，加註解說明原因。
不確定的地方標 TODO 並說明需要實機驗證什麼。
```

---

### Phase 3 — 解碼器雙軌

> 角色補充：這階段以 **WebAssembly 效能工程師** 的身分思考記憶體與傳輸成本。

```
實作解碼層，採雙後端策略：

1. NativeDecoder —— 包裝 BarcodeDetector API。
   要先用 getSupportedFormats() 確認格式支援，不支援就回報並降級。

2. WasmDecoder —— 使用 zxing-wasm 套件。
   跑在 Web Worker 裡，WASM module lazy load、只載入一次。

3. 後端選擇器 —— options.backend 為 auto 時：
   偵測到可用的 BarcodeDetector 且格式齊全就用 native，
   否則載入 wasm。native 路徑下 WASM 完全不能被下載（用動態 import 確保）。

效能要求：
- 主執行緒與 Worker 之間用 Transferable（ImageBitmap 或 ArrayBuffer transfer），
  不做結構化複製
- WASM heap buffer 在 Worker 內重複使用，不可每幀 malloc/free
- 解碼結果的座標要換算回原始影像座標系（因為前面做過 ROI 裁切與降採樣）

另外實作 debounce：連續 debounceFrames 幀解出相同值才發 'decoded' 事件，
中間過程發 'candidate'。debounceFrames 為 0 時每次都直接發。

給我實作 + 說明你在哪裡做了零複製、哪裡無法避免複製。
```

---

### Phase 4 — Vue Adapter

```
實作 packages/vue 的 useBarcodeScanner() composable。

API 大致長這樣，請依實際需要調整並說明理由：

const { state, lastResult, candidates, error, capabilities,
        start, stop, pause, resume, toggleTorch, switchCamera }
  = useBarcodeScanner(videoRef, options)

要求：
- state / error 等用 shallowRef 或 readonly ref 暴露，避免深層 reactivity 開銷
- candidates 更新頻率高，要確認不會拖垮 Vue 的 reactivity
  （說明你採取的策略，例如節流或改用非響應式 + 手動 trigger）
- onScopeDispose 自動清理 stream 與 worker
- 同時支援 callback 風格（onDecoded）與 ref 風格，兩者可並用
- SSR 安全：Nuxt 環境下 import 不可炸

附一個完整的 Vue SFC 範例，含自訂 overlay（用 SVG 畫追蹤框）。
```

---

### Phase 5 — 預設 UI 層

> 角色補充：這階段加上 **前端互動設計** 視角 —— 回饋設計比視覺美觀重要。

```
實作 packages/ui 的預設 overlay 元件 <ScannerOverlay>。

定位：讓 80% 的使用者 5 行程式碼就能跑起來，但整層可以被完全替換。

回饋設計要求：
- 用 candidate 事件的 corners 畫即時追蹤框，帶平滑插值（避免抖動）
- 偵測到 candidate 但持續解不出來超過 N 秒時，觸發提示 slot
  （注意：只給 slot 與語意化的 hint code，不寫文案）
- 成功時：navigator.vibrate + 可選音效 + 鎖定動畫，三重確認
- 掃描框視覺收窄，引導使用者對準（要與 core 的 ROI 設定連動，不可各算各的）
- 所有文案都透過 slot 或 props 傳入，元件本身零文案

無障礙：
- 掃描狀態要有 aria-live 播報
- 成功/失敗不可只靠顏色區分
- 提供純鍵盤的關閉與重試路徑

給我元件實作 + 所有 slot 的說明表。
```

---

### Phase 6 — WASM 自訂編譯瘦身（選做）

```
目標：把 ZXing-C++ 自行編譯成比 zxing-wasm 預設版更小的 WASM。

環境：WSL2 或 Rocky Linux，使用 Docker image emscripten/emsdk。

要求：
- 只編譯 reader，關掉 writer
- 只開啟指定的 symbology（用 CMake option 控制，列出可用選項）
- -Oz -flto、關閉 exceptions 與 RTTI
- -sMODULARIZE -sENVIRONMENT=web,worker，去掉 Node glue code
- -msimd128 開啟 SIMD
- 輸出 Brotli 壓縮後的體積比較表

給我：
1. Dockerfile 或 docker run 指令
2. 完整的 emcmake / cmake 參數，每個參數加註解說明作用
3. 一個量測腳本，比較「預設版 vs 瘦身版」的 gzip/brotli 體積與解碼耗時
4. 明確說明哪些最佳化有風險（例如關掉 exceptions 後的錯誤處理怎麼辦）
```

---

### Phase 7 — 測試與效能量測

```
建立測試與 benchmark。

單元測試（vitest）：
- 狀態機轉移的合法性（含非法轉移要拋錯）
- debounce 邏輯
- 座標換算（ROI 裁切 + 降採樣 + object-fit cover 的來回轉換）
- getUserMedia 失敗的各種 error 對應到正確的 ErrorCode（用 mock）

整合測試：
- 用預先準備的靜態圖片（含清晰、模糊、傾斜、低光四組）
  餵進解碼器，驗證 native 與 wasm 兩條路徑結果一致

效能量測：
- 端到端延遲：從幀產生到 decoded 事件的毫秒數（p50 / p95）
- 主執行緒 long task 統計（用 PerformanceObserver）
- 記憶體：連續掃描 5 分鐘後的 heap 成長（檢查有無洩漏）

另外給我一份實機測試檢查表，涵蓋 iPad Safari、Android Chrome、
桌機 Chrome/Firefox/Safari，列出每個平台要特別驗證的項目。
```

---

## 第三部分：通用追加指令

需要時直接貼在任一 Prompt 後面。

**要求評審而非實作**
```
先不要寫程式碼。以資深 reviewer 的角度，列出這個設計的 3 個最大風險，
以及各自的緩解方案。如果你認為有更好的架構，直接說。
```

**跨平台盤點**
```
針對剛才的實作，逐條列出在 iOS Safari 上可能與 Android Chrome 行為不同的地方，
標註嚴重度，並說明各自需要什麼樣的 workaround 或 feature detect。
```

**效能複查**
```
複查這段程式碼的每幀熱路徑。標出所有記憶體配置、結構化複製、
以及可能觸發 layout/paint 的操作。能消除的請提出具體改法。
```

**API 可用性複查**
```
假裝你是第一次用這個 library 的開發者，只讀 TSDoc 不看原始碼。
寫出你會怎麼用，並指出哪些地方會讓你卡住或猜錯。
```

---

## 使用建議

1. 先把第一部分存成 `CLAUDE.md`，這樣每個階段都不用重複交代規則。
2. **不要跳過 Phase 1**。型別定義確定後，後面的實作會順很多；
   反過來先寫實作再補型別，通常會得到一個難用的 API。
3. Phase 6 建議等整條管線跑順後再做，不然會同時 debug 兩個不熟的東西。
4. 每個階段結束後，用「通用追加指令」的評審 prompt 跑一次，
   通常能撈出不少問題。

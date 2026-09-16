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

## 已定案的設計決策

- **主要目標裝置：iPad Safari**（2026-09-15 確認廠內只用 iPad）。Android 支援保留在架構中但
  不做實機驗證。實測 iPad：無 BarcodeDetector → **wasm 是唯一實際會跑的解碼路徑**；
  有 rVFC、OffscreenCanvas；後鏡頭 label「後置相機」、zoom 1–10、無 torch；
  `getSettings()` 在 gUM 剛 resolve 時沒有 width/height。
  **2026-09-16 實測 wasm 解碼：p50 12ms / p95 15ms（1080×1920 後鏡頭，ROI 0.8×0.4，base 640）**，
  QR 與 Code 128 皆可解，執行中熱切換 formats 正常。decodeScale 預設值不需調整。
  bench：端到端 p50 23 / p95 25 ms，5 分鐘 4489/4500 幀命中、rAF 零卡頓。iPad Safari UA 是 `Macintosh`。
- 部署：`./scripts/deploy-playground.sh` → https://sfserver.flexium.com.tw/scanner/（nginx 靜態，
  SELinux 要 restorecon，IT 反代終結 TLS）。廠內可能無外網，**wasm 必須可自架**（wasmUrl）。
  細節見 `docs/deploy.md`；實機測試項目見 `docs/device-checklist.md`。
- 工具限制：Bash heredoc 超過約 170 行會被截斷（改用 Write 工具）；heredoc 內 `` 會變成 backspace 字元。
- **語言**：library（packages/*）用 TypeScript；examples/playground 用純 JS。
- **發布**：公開 npm `@cclemon/scanner-{core,vue,ui}`（帳號 cclemon，2FA 需本人在終端機 `npm publish ./release/*.tgz`）；
  wasm 檔包在 core 的 dist 並 export `./zxing_reader.wasm`。GitHub：Peter-1119/WebCamCall（private）。
- **多尺度解碼**（`options.decodeScale`）：解碼成本與像素數成正比，但小碼/遠距需要
  足夠像素。三層策略：基準降採樣（640）→ 連續 N 幀無結果時沿階梯升級
  （960 → 1280 → 全解析度，成功後記住尺度）→ wasm 路徑對「找到位置但解不出」
  的候選做全解析度局部裁切（zoomToCandidate）。Phase 2 負責裁切/縮放管線，
  Phase 3 負責回饋訊號。不可退化成固定降採樣。
- **點陣式 DM**：PCB 鑽孔碼 zxing 原生解不出；`dotted` 前處理 = 百分位對比拉伸 + van Herk min/max 膨脹，
  核 ≈ 1.3–1.5× 模組，每幀輪替 [5,9,13,17]×{dark,light}，成功後 sticky。以真實 PCB 照片驗證。
- 狀態機轉移表是 `STATE_TRANSITIONS` 常數，`pause()`/`resume()` 非法狀態同步 throw，
  `start()`/`stop()` 冪等。多碼掃描逐碼發 `decoded`、以 `frameId` 分組。ROI 用比例。

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

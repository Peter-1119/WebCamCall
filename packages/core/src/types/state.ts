/**
 * 掃描器生命週期狀態。
 *
 * ```
 * idle ─start()─▶ requesting-permission ─▶ starting ─▶ scanning ⇄ paused
 *                          │                  │            │          │
 *                          └──▶ failed ◀──────┴────────────┴──────────┘
 *                                 │
 *   (任何非 idle 狀態) ─stop()─▶ stopped ─start()─▶ requesting-permission
 * ```
 *
 * - `idle`                  ：建立後尚未 `start()`。
 * - `requesting-permission` ：`getUserMedia()` 進行中，瀏覽器可能正在顯示權限對話框。
 * - `starting`              ：已取得 stream，等待 `<video>` 開始播放與解碼器就緒
 *                             （wasm 路徑下包含下載 WASM）。`switchCamera()` 也會經過這裡。
 * - `scanning`              ：解碼迴圈執行中。
 * - `paused`                ：解碼迴圈停止，但 stream 與預覽維持。
 * - `stopped`               ：所有資源已釋放。可再次 `start()`。
 * - `failed`                ：發生不可自動恢復的錯誤，資源已釋放。可再次 `start()`。
 *
 * `idle` 與 `stopped` 的差別只在「是否曾經啟動過」，方便 UI 顯示「重試」而非「開始」。
 */
export type ScannerState =
  | 'idle'
  | 'requesting-permission'
  | 'starting'
  | 'scanning'
  | 'paused'
  | 'stopped'
  | 'failed'

/**
 * 合法狀態轉移表。key 是來源狀態，value 是可轉移的目標狀態。
 *
 * 這是狀態機的**規格**而不是實作：Phase 7 的單元測試會直接對著這張表驗證，
 * 內部的 transition 函式遇到不在表內的轉移必須拋錯。
 */
export const STATE_TRANSITIONS: Readonly<Record<ScannerState, readonly ScannerState[]>> = {
  idle: ['requesting-permission'],
  'requesting-permission': ['starting', 'failed', 'stopped'],
  starting: ['scanning', 'failed', 'stopped'],
  scanning: ['paused', 'starting', 'failed', 'stopped'],
  paused: ['scanning', 'starting', 'failed', 'stopped'],
  failed: ['requesting-permission', 'stopped'],
  stopped: ['requesting-permission'],
}

/**
 * 公開方法的呼叫規則（與轉移表分開，因為「呼叫某方法」不一定等於「轉移狀態」）：
 *
 * | 方法             | 合法狀態               | 非法時的行為                         |
 * |------------------|------------------------|--------------------------------------|
 * | `start()`        | idle, stopped, failed  | 其他狀態：no-op，回傳進行中的 promise |
 * | `stop()` / `dispose()` | 任何狀態         | 永遠 no-op（可重入）                  |
 * | `pause()`        | scanning               | 同步 throw {@link InvalidStateError}  |
 * | `resume()`       | paused                 | 同步 throw {@link InvalidStateError}  |
 * | `switchCamera()` | scanning, paused       | reject {@link InvalidStateError}      |
 * | `setTorch()` 等  | scanning, paused       | reject {@link InvalidStateError}      |
 *
 * `start()` / `stop()` 冪等、`pause()` / `resume()` 嚴格，理由：
 * 前者常在元件 mount/unmount、visibilitychange 這種可能重複觸發的地方呼叫；
 * 後者若在錯誤狀態被呼叫幾乎一定是程式邏輯錯誤，靜默吞掉會讓 bug 難找。
 */
export type ScannerAction = 'start' | 'stop' | 'pause' | 'resume' | 'switchCamera' | 'setTorch' | 'setZoom'

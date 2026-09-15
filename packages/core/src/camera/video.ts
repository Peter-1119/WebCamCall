import { createScannerError } from '../errors'

/** 有 rVFC 的 video 元素型別（lib.dom 在 TS 5.x 已內建，這裡只是保險）。 */
type VideoWithRvfc = HTMLVideoElement & {
  requestVideoFrameCallback?: (cb: (now: number, meta: { mediaTime: number }) => void) => number
  cancelVideoFrameCallback?: (handle: number) => void
}

export function hasRvfc(video: HTMLVideoElement): video is Required<VideoWithRvfc> {
  return typeof (video as VideoWithRvfc).requestVideoFrameCallback === 'function'
}

/**
 * 把 stream 接到 `<video>` 並等到**第一個真實幀**出現。
 *
 * iOS Safari workaround 清單（每條都有註解）：
 * 1. `playsInline` 沒設會強制全螢幕播放。同時設屬性與 property，舊版只認其中一種。
 * 2. `autoplay` 屬性不可靠（WeChat iOS 更是完全不觸發 loadeddata），一律明確呼叫 `play()`。
 *    `play()` 被拒（NotAllowedError）不視為失敗——muted video 幾乎都能播，
 *    真正的判準是「有沒有幀」。
 * 3. `playing` 事件後 `videoWidth` 可能還是 0 幾十毫秒；用 rVFC 等第一幀最準，
 *    沒有 rVFC 就輪詢 `videoWidth > 0 && readyState >= HAVE_CURRENT_DATA`。
 * 4. iOS PWA 重啟後 video 可能永遠不 load（vue-qrcode-reader 的經驗），所以要有 timeout。
 * 5. `srcObject` 在元素 `display: none` 時指定會不渲染（iOS 15），
 *    UI 層要藏請用 `visibility: hidden`。這裡無法偵測，寫在文件。
 */
export async function attachVideo(
  video: HTMLVideoElement,
  stream: MediaStream,
  timeoutMs = 6000,
): Promise<void> {
  video.playsInline = true
  video.setAttribute('playsinline', '')
  video.muted = true
  video.setAttribute('muted', '')
  video.autoplay = true
  video.srcObject = stream

  // 不 await：iOS 上 play() 的 promise 有時在有幀之後才 resolve；拒絕也不代表失敗。
  void video.play().catch(() => {})

  await waitForVideoReady(video, timeoutMs)
}

/**
 * 等 video 有可用的幀資料：`readyState >= HAVE_CURRENT_DATA` 且 `videoWidth > 0`。
 *
 * 刻意**不用** rVFC / rAF：視窗被遮住或分頁在背景時兩者都不會觸發
 * （實機驗證：桌機 Chrome 視窗被蓋住時 rVFC 完全停止，導致 6 秒 timeout 誤判）。
 * `setTimeout` 在背景會被節流到 1 次/秒，但仍然會跑。
 */
export function waitForVideoReady(video: HTMLVideoElement, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let done = false
    const ready = () => video.videoWidth > 0 && video.readyState >= 2 /* HAVE_CURRENT_DATA */
    const finish = (err?: Error) => {
      if (done) return
      done = true
      clearTimeout(timer)
      clearTimeout(poll)
      video.removeEventListener('loadeddata', onEvent)
      video.removeEventListener('playing', onEvent)
      err ? reject(err) : resolve()
    }
    const onEvent = () => {
      if (ready()) finish()
    }
    let poll: ReturnType<typeof setTimeout>
    const tick = () => {
      if (ready()) return finish()
      poll = setTimeout(tick, 50)
    }
    const timer = setTimeout(() => finish(createScannerError('camera-failed', { cause: 'timeout' })), timeoutMs)
    video.addEventListener('loadeddata', onEvent)
    video.addEventListener('playing', onEvent)
    tick()
  })
}

/**
 * 等 `currentTime` 前進，代表 stream 真的有新幀在流（與有沒有被畫出來無關）。
 * 給「切回前景後是否凍結」的 watchdog 用：iOS 凍結時 readyState 仍是 4、videoWidth 仍 > 0，
 * 只有 currentTime 會停住。
 */
export function waitForFrameAdvance(video: HTMLVideoElement, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const start = video.currentTime
    const t0 = Date.now()
    const tick = () => {
      if (video.currentTime !== start) return resolve()
      if (Date.now() - t0 > timeoutMs) return reject(createScannerError('camera-failed', { cause: 'frozen' }))
      setTimeout(tick, 100)
    }
    setTimeout(tick, 100)
  })
}

/**
 * 拆掉 video 與 stream 的連結。
 * 順序重要：先 pause 再清 srcObject，最後 load() 讓 iOS 真正釋放解碼器資源
 * （否則某些 iOS 版本切鏡頭幾次後會拿到黑畫面）。
 */
export function detachVideo(video: HTMLVideoElement): void {
  try {
    video.pause()
  } catch {
    /* 已經 detached */
  }
  video.srcObject = null
  video.removeAttribute('src')
  try {
    video.load()
  } catch {
    /* happy-dom 等測試環境沒有實作 */
  }
}

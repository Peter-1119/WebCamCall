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

  await waitForFrame(video, timeoutMs)
}

/**
 * 等待下一個真實幀。`attachVideo` 與「切回分頁後是否凍結」的偵測共用。
 * 失敗以 `camera-failed` reject（cause: 'timeout'）。
 */
export function waitForFrame(video: HTMLVideoElement, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let done = false
    let rvfcHandle = 0
    let rafHandle = 0

    const finish = (err?: Error) => {
      if (done) return
      done = true
      clearTimeout(timer)
      if (rvfcHandle && hasRvfc(video)) video.cancelVideoFrameCallback(rvfcHandle)
      if (rafHandle) cancelAnimationFrame(rafHandle)
      err ? reject(err) : resolve()
    }

    const timer = setTimeout(
      () => finish(createScannerError('camera-failed', { cause: 'timeout' })),
      timeoutMs,
    )

    if (hasRvfc(video)) {
      rvfcHandle = video.requestVideoFrameCallback(() => finish())
      return
    }

    // rAF fallback：等 metadata 與 videoWidth
    const poll = () => {
      if (video.videoWidth > 0 && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
        finish()
      } else {
        rafHandle = requestAnimationFrame(poll)
      }
    }
    poll()
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

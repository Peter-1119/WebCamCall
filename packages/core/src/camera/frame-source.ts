import { hasRvfc } from './video'

export interface FrameMeta {
  /** `performance.now()` 時間戳。 */
  readonly timestamp: number
  /** rVFC 給的 mediaTime；rAF fallback 用 `video.currentTime`。 */
  readonly mediaTime: number
}

export interface FrameSourceStats {
  /** 因為上一幀還在解碼（背壓）而跳過的幀數。 */
  dropped: number
  /** 因為 targetFps 節流而跳過的幀數。 */
  throttled: number
  /** 實際送出的幀數。 */
  delivered: number
}

export interface FrameSourceDeps {
  readonly now: () => number
  readonly raf: (cb: (t: number) => void) => number
  readonly caf: (handle: number) => void
}

/**
 * 幀來源：驅動掃描迴圈，負責節流與背壓。
 *
 * - 優先 `requestVideoFrameCallback`（Chrome 83+、Safari 15.4+）：只在**新幀**時回呼，
 *   且帶 `mediaTime` 可辨識重複幀。fallback `requestAnimationFrame` 時用 `currentTime`
 *   比對，避免同一幀送兩次（iOS 的 currentTime 更新粒度較粗，可能漏幀，屬可接受）。
 * - 節流：距上一幀送出不足 `1000 / targetFps` 就跳過。
 * - 背壓：`onFrame` 回傳的 promise 未 settle 前不再送幀，計入 `dropped`。
 *   永遠解最新的幀；排隊只會累積延遲。
 * - 不用 setInterval：分頁在背景時 rAF/rVFC 自動停，省電。
 */
export function createFrameSource(
  video: HTMLVideoElement,
  onFrame: (meta: FrameMeta) => Promise<void> | void,
  targetFps: number,
  deps: FrameSourceDeps = {
    now: () => performance.now(),
    raf: (cb) => requestAnimationFrame(cb),
    caf: (h) => cancelAnimationFrame(h),
  },
) {
  let running = false
  let paused = false
  let busy = false
  let minInterval = targetFps > 0 ? 1000 / targetFps : 0
  let lastDelivered = -Infinity
  let lastMediaTime = -1
  let handle = 0
  const useRvfc = hasRvfc(video)
  const stats: FrameSourceStats = { dropped: 0, throttled: 0, delivered: 0 }

  function schedule() {
    if (!running) return
    if (useRvfc) {
      handle = video.requestVideoFrameCallback((_now, meta) => tick(meta.mediaTime))
    } else {
      handle = deps.raf(() => tick(video.currentTime))
    }
  }

  function tick(mediaTime: number) {
    if (!running) return
    schedule() // 先排下一幀，onFrame 拋錯也不會讓迴圈死掉

    if (paused) return
    if (!useRvfc && mediaTime === lastMediaTime) return // rAF 下的重複幀
    lastMediaTime = mediaTime

    const now = deps.now()
    if (busy) {
      stats.dropped++
      return
    }
    if (now - lastDelivered < minInterval) {
      stats.throttled++
      return
    }

    lastDelivered = now
    stats.delivered++
    busy = true
    let result: Promise<void> | void
    try {
      result = onFrame({ timestamp: now, mediaTime })
    } catch {
      busy = false
      return
    }
    if (result && typeof result.then === 'function') {
      result.then(
        () => {
          busy = false
        },
        () => {
          busy = false
        },
      )
    } else {
      busy = false
    }
  }

  function cancel() {
    if (!handle) return
    if (useRvfc) video.cancelVideoFrameCallback(handle)
    else deps.caf(handle)
    handle = 0
  }

  return {
    stats,
    get running() {
      return running
    },
    get paused() {
      return paused
    },
    start() {
      if (running) return
      running = true
      paused = false
      schedule()
    },
    pause() {
      paused = true
    },
    resume() {
      paused = false
    },
    stop() {
      running = false
      paused = false
      busy = false
      cancel()
    },
    setTargetFps(fps: number) {
      minInterval = fps > 0 ? 1000 / fps : 0
    },
    resetStats() {
      stats.dropped = 0
      stats.throttled = 0
      stats.delivered = 0
    },
  }
}

export type FrameSource = ReturnType<typeof createFrameSource>

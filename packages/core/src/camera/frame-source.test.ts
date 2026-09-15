import { describe, expect, it, vi } from 'vitest'
import { createFrameSource } from './frame-source'

/** 手動驅動的 rAF：呼叫 `flush()` 才跑排隊的 callback。 */
function fakeLoop() {
  let now = 0
  let queue: Array<(t: number) => void> = []
  const deps = {
    now: () => now,
    raf: (cb: (t: number) => void) => {
      queue.push(cb)
      return queue.length
    },
    caf: () => {
      queue = []
    },
  }
  return {
    deps,
    advance(ms: number) {
      now += ms
    },
    flush() {
      const q = queue
      queue = []
      for (const cb of q) cb(now)
    },
    get pending() {
      return queue.length
    },
  }
}

function fakeVideo(): HTMLVideoElement & { currentTime: number } {
  return { currentTime: 0 } as HTMLVideoElement & { currentTime: number }
}

describe('frame source (rAF fallback)', () => {
  it('delivers frames at most at targetFps', () => {
    const loop = fakeLoop()
    const video = fakeVideo()
    const onFrame = vi.fn()
    const src = createFrameSource(video, onFrame, 10, loop.deps) // 100ms interval
    src.start()

    for (let i = 0; i < 10; i++) {
      video.currentTime += 0.016
      loop.advance(16)
      loop.flush()
    }
    // 160ms 內只該送出 2 幀（t=16 與 t=128 附近）
    expect(onFrame).toHaveBeenCalledTimes(2)
    expect(src.stats.throttled).toBe(8)
    src.stop()
    expect(loop.pending).toBe(0)
  })

  it('skips duplicate frames (same currentTime) under rAF', () => {
    const loop = fakeLoop()
    const video = fakeVideo()
    const onFrame = vi.fn()
    const src = createFrameSource(video, onFrame, 0, loop.deps)
    src.start()
    video.currentTime = 1
    loop.flush()
    loop.flush() // 同一幀
    loop.flush()
    expect(onFrame).toHaveBeenCalledTimes(1)
    src.stop()
  })

  it('applies backpressure: no new frame while onFrame is pending', async () => {
    const loop = fakeLoop()
    const video = fakeVideo()
    let release!: () => void
    const onFrame = vi.fn(() => new Promise<void>((r) => (release = r)))
    const src = createFrameSource(video, onFrame, 0, loop.deps)
    src.start()

    video.currentTime = 1
    loop.flush()
    video.currentTime = 2
    loop.flush()
    video.currentTime = 3
    loop.flush()
    expect(onFrame).toHaveBeenCalledTimes(1)
    expect(src.stats.dropped).toBe(2)

    release()
    await Promise.resolve()
    video.currentTime = 4
    loop.flush()
    expect(onFrame).toHaveBeenCalledTimes(2)
    src.stop()
  })

  it('pause stops delivery but keeps the loop alive; resume continues', () => {
    const loop = fakeLoop()
    const video = fakeVideo()
    const onFrame = vi.fn()
    const src = createFrameSource(video, onFrame, 0, loop.deps)
    src.start()
    src.pause()
    video.currentTime = 1
    loop.flush()
    expect(onFrame).not.toHaveBeenCalled()
    expect(loop.pending).toBe(1)
    src.resume()
    video.currentTime = 2
    loop.flush()
    expect(onFrame).toHaveBeenCalledTimes(1)
    src.stop()
  })

  it('a throwing onFrame does not kill the loop', () => {
    const loop = fakeLoop()
    const video = fakeVideo()
    const onFrame = vi.fn(() => {
      throw new Error('boom')
    })
    const src = createFrameSource(video, onFrame, 0, loop.deps)
    src.start()
    video.currentTime = 1
    loop.flush()
    video.currentTime = 2
    loop.flush()
    expect(onFrame).toHaveBeenCalledTimes(2)
    src.stop()
  })

  it('start is idempotent and stop cancels', () => {
    const loop = fakeLoop()
    const src = createFrameSource(fakeVideo(), () => {}, 0, loop.deps)
    src.start()
    src.start()
    expect(loop.pending).toBe(1)
    src.stop()
    expect(loop.pending).toBe(0)
    expect(src.running).toBe(false)
  })
})

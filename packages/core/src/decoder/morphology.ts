/**
 * 點陣式（DPM / dot-peen）條碼的前處理。
 *
 * PCB 鑽孔、雷射點刻的 Data Matrix 每個模組是一個**圓點**而不是實心方格，
 * zxing 取樣模組中心時會落在點與點之間的空隙，結果是「定位得到、解不出」或完全找不到。
 * 解法：形態學膨脹——把每個點撐大到接近模組大小，讓它們連成方塊。
 *
 * 實測（PCB 上約 24×24 模組、金面暗點）：原圖 0/3 解出，膨脹核 ≈ 模組大小時 3/3 解出。
 *
 * 全部用 Uint8 灰階、可分離的一維 min/max 濾波（水平一次、垂直一次），O(w·h·k)。
 */

export type DotPolarity = 'dark' | 'light'

export interface DottedVariant {
  /** 膨脹核大小（px，奇數）。要接近模組大小才有效，所以由呼叫端輪替。 */
  readonly kernel: number
  /** `dark`：暗點在亮底（PCB 金面鑽孔）→ min 濾波；`light`：亮點在暗底（黑色金屬雷刻）→ max 濾波。 */
  readonly polarity: DotPolarity
}

/** RGBA → 灰階（BT.601 整數近似）。輸出可重用。 */
export function rgbaToGray(rgba: Uint8ClampedArray, out?: Uint8Array): Uint8Array {
  const n = rgba.length >> 2
  const g = out && out.length === n ? out : new Uint8Array(n)
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    g[i] = (rgba[j]! * 77 + rgba[j + 1]! * 150 + rgba[j + 2]! * 29) >> 8
  }
  return g
}

/** 灰階 → RGBA（zxing-wasm 只吃 RGBA）。輸出可重用。 */
export function grayToRgba(gray: Uint8Array, out?: Uint8ClampedArray): Uint8ClampedArray {
  const n = gray.length
  const o = out && out.length === n * 4 ? out : new Uint8ClampedArray(n * 4)
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    const v = gray[i]!
    o[j] = v
    o[j + 1] = v
    o[j + 2] = v
    o[j + 3] = 255
  }
  return o
}

/**
 * 百分位對比拉伸：把 `cutoff` 分位以下壓到 0、`1 - cutoff` 以上拉到 255，中間線性。
 * PCB 金面 / 墨綠底這種低對比場景，不拉伸的話膨脹後 zxing 仍二值化不出來（實測 0/2 → 拉伸後 OK）。
 * 就地修改 `gray`。
 */
export function stretchContrast(gray: Uint8Array, cutoff = 0.02): Uint8Array {
  const hist = new Uint32Array(256)
  for (let i = 0; i < gray.length; i++) hist[gray[i]!]!++
  const target = gray.length * cutoff
  let lo = 0
  let acc = 0
  while (lo < 255 && acc + hist[lo]! < target) acc += hist[lo++]!
  let hi = 255
  acc = 0
  while (hi > lo && acc + hist[hi]! < target) acc += hist[hi--]!
  if (hi - lo < 16) return gray // 幾乎單色或已經滿幅，不動
  const lut = new Uint8Array(256)
  const scale = 255 / (hi - lo)
  for (let v = 0; v < 256; v++) lut[v] = v <= lo ? 0 : v >= hi ? 255 : Math.round((v - lo) * scale)
  for (let i = 0; i < gray.length; i++) gray[i] = lut[gray[i]!]!
  return gray
}

/**
 * 一維 min / max 濾波，沿著 stride 方向掃 `length` 個元素、共 `lines` 條線。
 * van Herk / Gil-Werman 演算法：每個元素 ~3 次比較，**與核大小無關**（naive 是 O(k)）。
 * 640×360、k=17 從 ~9 ms 降到 ~2 ms。邊界用最近像素補（clamp）。
 */
function filter1D(
  src: Uint8Array,
  dst: Uint8Array,
  lines: number,
  length: number,
  lineStride: number,
  step: number,
  radius: number,
  useMin: boolean,
  g: Uint8Array,
  h: Uint8Array,
): void {
  const k = radius * 2 + 1
  for (let l = 0; l < lines; l++) {
    const base = l * lineStride
    // g：每個 k 區塊內的前綴 min/max；h：後綴 min/max
    for (let i = 0; i < length; i++) {
      const v = src[base + i * step]!
      if (i % k === 0) g[i] = v
      else {
        const p = g[i - 1]!
        g[i] = useMin ? (v < p ? v : p) : v > p ? v : p
      }
    }
    for (let i = length - 1; i >= 0; i--) {
      const v = src[base + i * step]!
      if (i === length - 1 || (i + 1) % k === 0) h[i] = v
      else {
        const p = h[i + 1]!
        h[i] = useMin ? (v < p ? v : p) : v > p ? v : p
      }
    }
    // 視窗 [i-r, i+r] 的極值 = op(h[i-r], g[i+r])，邊界 clamp
    for (let i = 0; i < length; i++) {
      const lo = i - radius < 0 ? 0 : i - radius
      const hi = i + radius >= length ? length - 1 : i + radius
      const a = h[lo]!
      const b = g[hi]!
      dst[base + i * step] = useMin ? (a < b ? a : b) : a > b ? a : b
    }
  }
}

/** 可重用的工作 buffer；`g`/`h` 是一維濾波的暫存，長度 ≥ max(width, height)。 */
export interface MorphScratch {
  a: Uint8Array
  b: Uint8Array
  g?: Uint8Array
  h?: Uint8Array
}

/**
 * 膨脹「點」成「塊」：`dark` 用 min（暗區長大），`light` 用 max（亮區長大）。
 * `scratch` 可重用以避免每幀配置。
 */
export function dilateDots(
  gray: Uint8Array,
  width: number,
  height: number,
  variant: DottedVariant,
  scratch?: MorphScratch,
): Uint8Array {
  const n = width * height
  const s: MorphScratch = scratch && scratch.a.length === n ? scratch : { a: new Uint8Array(n), b: new Uint8Array(n) }
  const radius = Math.max(1, variant.kernel >> 1)
  const useMin = variant.polarity === 'dark'
  const m = Math.max(width, height)
  if (!s.g || s.g.length < m) {
    s.g = new Uint8Array(m)
    s.h = new Uint8Array(m)
  }
  // 先拉對比（複製一份，不動輸入），再膨脹
  s.a.set(gray)
  stretchContrast(s.a)
  // 水平（a → b），垂直（b → a）
  filter1D(s.a, s.b, height, width, width, 1, radius, useMin, s.g, s.h!)
  filter1D(s.b, s.a, width, height, 1, width, radius, useMin, s.g, s.h!)
  return s.a
}

/**
 * 依影像寬度產生膨脹核階梯：640 寬時 [5, 9, 13, 17]，依比例縮放並取奇數。
 * 實測核要約 **1.3–1.5 倍模組大小**才夠（點只佔模組一半，還得把相鄰模組連成 L 型定位線），
 * 四級大致對應模組 3–4 / 6–7 / 9–10 / 12–13 px。PCB 實拍 520 px 裁切（模組 ≈ 9 px）需要核 ≥ 13。
 */
export function dottedKernels(width: number): number[] {
  const scale = width / 640
  return [5, 9, 13, 17].map((k) => {
    const v = Math.round(k * scale)
    return Math.max(3, v % 2 === 0 ? v + 1 : v)
  })
}

/**
 * 輪替器：每幀一個變體（核 × 極性），成功就記住並優先用；連續失敗才往下走。
 * 極性順序 dark 先（PCB 金面鑽孔最常見），再 light。
 */
export function createDottedCycler() {
  let index = 0
  let sticky: DottedVariant | null = null
  let stickyMisses = 0

  return {
    next(width: number): DottedVariant {
      if (sticky) return sticky
      const kernels = dottedKernels(width)
      const total = kernels.length * 2
      const i = index % total
      index++
      return { kernel: kernels[i % kernels.length]!, polarity: i < kernels.length ? 'dark' : 'light' }
    },
    report(variant: DottedVariant, success: boolean) {
      if (success) {
        sticky = variant
        stickyMisses = 0
      } else if (sticky) {
        // 記住的變體連續 6 幀失敗（約 0.4 秒）就放掉，重新輪替
        if (++stickyMisses >= 6) {
          sticky = null
          stickyMisses = 0
        }
      }
    },
    reset() {
      index = 0
      sticky = null
      stickyMisses = 0
    },
  }
}

export type DottedCycler = ReturnType<typeof createDottedCycler>

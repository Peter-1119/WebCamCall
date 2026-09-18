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
  /**
   * 膨脹前先做形態學「帽」濾波（half-width，px）去背景：`dark` 用 black-hat（closing − 原圖）、
   * `light` 用 top-hat（原圖 − opening）。把「比周圍暗/亮的小點」從銅面、走線、陰影中抽出來，
   * 半徑 ≈ 1–1.5 × 模組。影片實測（模組 3 px、oracle ROI）：不做 4% → 半徑 3 做 20%。
   * 不給就只做百分位對比拉伸（原本行為）。
   */
  readonly hat?: number
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
 * 水平方向的一維 min / max 濾波（每列獨立）。
 * van Herk / Gil-Werman 演算法：每個元素 ~3 次比較，**與核大小無關**（naive 是 O(k)）。
 * 內迴圈以 k 為區塊展開，避免逐元素取模與分支。邊界用最近像素補（clamp）。
 */
function filterHorizontal(
  src: Uint8Array,
  dst: Uint8Array,
  width: number,
  height: number,
  radius: number,
  useMin: boolean,
  g: Uint8Array,
  h: Uint8Array,
): void {
  const k = radius * 2 + 1
  for (let y = 0; y < height; y++) {
    const base = y * width
    // g：每個 k 區塊內的前綴極值
    for (let b = 0; b < width; b += k) {
      const end = b + k < width ? b + k : width
      let p = src[base + b]!
      g[b] = p
      if (useMin) for (let i = b + 1; i < end; i++) { const v = src[base + i]!; p = v < p ? v : p; g[i] = p }
      else for (let i = b + 1; i < end; i++) { const v = src[base + i]!; p = v > p ? v : p; g[i] = p }
    }
    // h：每個 k 區塊內的後綴極值
    for (let b = 0; b < width; b += k) {
      const end = b + k < width ? b + k : width
      let p = src[base + end - 1]!
      h[end - 1] = p
      if (useMin) for (let i = end - 2; i >= b; i--) { const v = src[base + i]!; p = v < p ? v : p; h[i] = p }
      else for (let i = end - 2; i >= b; i--) { const v = src[base + i]!; p = v > p ? v : p; h[i] = p }
    }
    // 視窗 [i-r, i+r] 的極值 = op(h[i-r], g[i+r])，邊界 clamp
    if (useMin) for (let i = 0; i < width; i++) { const a = h[i - radius < 0 ? 0 : i - radius]!; const c = g[i + radius >= width ? width - 1 : i + radius]!; dst[base + i] = a < c ? a : c }
    else for (let i = 0; i < width; i++) { const a = h[i - radius < 0 ? 0 : i - radius]!; const c = g[i + radius >= width ? width - 1 : i + radius]!; dst[base + i] = a > c ? a : c }
  }
}

/**
 * 垂直方向的 van Herk 濾波，但**逐列掃描**：每一列同時推進所有欄的前綴 / 後綴極值，
 * 記憶體存取連續。用 stride 走欄的版本每個像素都 cache miss，640×1138 要 14 ms/pass，
 * 這個版本 ~3 ms。`g`/`h` 需要整張影像大小。
 */
function filterVertical(
  src: Uint8Array,
  dst: Uint8Array,
  width: number,
  height: number,
  radius: number,
  useMin: boolean,
  g: Uint8Array,
  h: Uint8Array,
): void {
  const k = radius * 2 + 1
  for (let y = 0; y < height; y++) {
    const row = y * width
    if (y % k === 0) g.set(src.subarray(row, row + width), row)
    else {
      const prev = row - width
      if (useMin) for (let x = 0; x < width; x++) { const v = src[row + x]!; const p = g[prev + x]!; g[row + x] = v < p ? v : p }
      else for (let x = 0; x < width; x++) { const v = src[row + x]!; const p = g[prev + x]!; g[row + x] = v > p ? v : p }
    }
  }
  for (let y = height - 1; y >= 0; y--) {
    const row = y * width
    if (y === height - 1 || (y + 1) % k === 0) h.set(src.subarray(row, row + width), row)
    else {
      const next = row + width
      if (useMin) for (let x = 0; x < width; x++) { const v = src[row + x]!; const p = h[next + x]!; h[row + x] = v < p ? v : p }
      else for (let x = 0; x < width; x++) { const v = src[row + x]!; const p = h[next + x]!; h[row + x] = v > p ? v : p }
    }
  }
  for (let y = 0; y < height; y++) {
    const lo = (y - radius < 0 ? 0 : y - radius) * width
    const hi = (y + radius >= height ? height - 1 : y + radius) * width
    const row = y * width
    if (useMin) for (let x = 0; x < width; x++) { const a = h[lo + x]!; const b = g[hi + x]!; dst[row + x] = a < b ? a : b }
    else for (let x = 0; x < width; x++) { const a = h[lo + x]!; const b = g[hi + x]!; dst[row + x] = a > b ? a : b }
  }
}

function horizontal(src: Uint8Array, dst: Uint8Array, width: number, height: number, radius: number, useMin: boolean, s: MorphScratch): void {
  filterHorizontal(src, dst, width, height, radius, useMin, s.g!, s.h!)
}
function vertical(src: Uint8Array, dst: Uint8Array, width: number, height: number, radius: number, useMin: boolean, s: MorphScratch): void {
  filterVertical(src, dst, width, height, radius, useMin, s.g!, s.h!)
}

/** 可重用的工作 buffer；`g`/`h` 是一維濾波的暫存，長度 ≥ width × height（垂直濾波逐列掃描需要整張）。 */
export interface MorphScratch {
  a: Uint8Array
  b: Uint8Array
  /** 帽濾波用的第三個 buffer，需要時才配置 */
  c?: Uint8Array
  g?: Uint8Array
  h?: Uint8Array
  /** 點密度定位的積分影像與粗格加總，需要時才配置 */
  ii?: Uint32Array
  sums?: Uint32Array
}

function ensureScratch(s: MorphScratch, n: number): void {
  if (!s.g || s.g.length < n) {
    s.g = new Uint8Array(n)
    s.h = new Uint8Array(n)
  }
}

/**
 * 帽濾波（就地）：`dark` → black-hat = closing(g) − g；`light` → top-hat = g − opening(g)。
 * 結果正規化成 0–255 並保持「點為暗」（dark）或「點為亮」（light）的極性，讓後續膨脹方向不變。
 * 需要 scratch.a（輸入 / 輸出）、b、c。
 */
export function hatFilter(
  gray: Uint8Array,
  width: number,
  height: number,
  radius: number,
  polarity: DotPolarity,
  s: MorphScratch,
): Uint8Array {
  const n = width * height
  if (!s.c || s.c.length !== n) s.c = new Uint8Array(n)
  ensureScratch(s, n)
  const dark = polarity === 'dark'
  // closing = min(max(g))；opening = max(min(g))
  horizontal(gray, s.b, width, height, radius, !dark, s)
  vertical(s.b, s.c, width, height, radius, !dark, s)
  horizontal(s.c, s.b, width, height, radius, dark, s)
  vertical(s.b, s.c, width, height, radius, dark, s)
  let max = 1
  for (let i = 0; i < n; i++) {
    const d = dark ? s.c[i]! - gray[i]! : gray[i]! - s.c[i]!
    s.b[i] = d
    if (d > max) max = d
  }
  const scale = 255 / max
  for (let i = 0; i < n; i++) {
    const v = Math.round(s.b[i]! * scale)
    gray[i] = dark ? 255 - v : v
  }
  return gray
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
  ensureScratch(s, n)
  // 先去背景（帽濾波，選用）或拉對比（複製一份，不動輸入），再膨脹
  s.a.set(gray)
  if (variant.hat) hatFilter(s.a, width, height, variant.hat, variant.polarity, s)
  stretchContrast(s.a)
  // 水平（a → b），垂直（b → a）
  horizontal(s.a, s.b, width, height, radius, useMin, s)
  vertical(s.b, s.a, width, height, radius, useMin, s)
  return s.a
}

/**
 * 膨脹核階梯（**絕對值**，與影像寬度無關）。
 *
 * 核該跟「模組大小」走，不是跟畫面走：17 張 PCB 實拍評測顯示，遠拍時 1080 幀裡模組只有 3 px、
 * 核 3–5 才對；原本依寬度縮放從 9 起跳會把碼糊掉（1080 幀 7/17 → 改絕對值後 12/17）。
 * 順序依實測命中率排：5 與 3 最常中，再往大走。`width` 參數保留給未來需要時做上限，目前不使用。
 */
export function dottedKernels(_width?: number): number[] {
  return [5, 3, 9, 7, 13, 17]
}

/**
 * 由「定位到的候選框寬度」估膨脹核：假設 Data Matrix 約 22 個模組（常見 18–26），
 * 核 ≈ 1.4 × 模組，取奇數、限制在 3–17。有這個估計時就不用盲目輪替 12 個變體。
 */
export function kernelFromSymbolWidth(widthPx: number, modules = 22): number {
  const k = Math.round((widthPx / modules) * 1.4)
  const odd = k % 2 === 0 ? k + 1 : k
  return Math.min(17, Math.max(3, odd))
}

/**
 * 輪替器：每幀一個變體（核 × 極性）。
 *
 * - 有 `hintKernel`（上一幀定位框估出的核）：先試 hint 的兩種極性，再試 hint±2，之後才回到盲目輪替
 * - 沒有 hint：依實測命中率順序輪替 `dottedKernels()` × {dark, light}
 * - 成功就記住（sticky），連續失敗 6 幀才放掉
 *
 * 影片實測（PCB 遠拍、模組 2.6–3.8 px）：盲目輪替 0/448 幀命中；用 hint 後才有機會在正確級距命中。
 */
export function createDottedCycler() {
  let index = 0
  let sticky: DottedVariant | null = null
  let stickyMisses = 0
  let hintIndex = 0
  let lastHint: number | null = null

  return {
    next(width: number, hintKernel?: number): DottedVariant {
      if (sticky) return sticky
      if (hintKernel !== undefined) {
        if (hintKernel !== lastHint) {
          lastHint = hintKernel
          hintIndex = 0
        }
        const seq: DottedVariant[] = [
          { kernel: hintKernel, polarity: 'dark' },
          { kernel: hintKernel, polarity: 'light' },
          { kernel: Math.max(3, hintKernel - 2), polarity: 'dark' },
          { kernel: Math.min(17, hintKernel + 2), polarity: 'dark' },
          { kernel: Math.max(3, hintKernel - 2), polarity: 'light' },
          { kernel: Math.min(17, hintKernel + 2), polarity: 'light' },
        ]
        if (hintIndex < seq.length) return seq[hintIndex++]!
        // hint 序列用完：回到盲目輪替（下面）
      } else {
        lastHint = null
        hintIndex = 0
      }
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
      hintIndex = 0
      lastHint = null
    },
  }
}

export type DottedCycler = ReturnType<typeof createDottedCycler>

/** `locateDotClusters` 回傳的候選區域（解碼影像座標，px）。 */
export interface DotCluster {
  readonly cx: number
  readonly cy: number
  /** 視窗內的點數，越大越像碼。 */
  readonly score: number
}

/**
 * 點密度定位：在整張（縮小後的）影像上找「一小塊區域裡擠滿了小點」的地方——點陣 Data Matrix 的長相。
 * zxing 的 L 邊追蹤在模組 2–3 px 的遠拍上幾乎找不到候選（影片 448 幀只有 36 幀），這個定位器不靠邊，靠點的密度。
 *
 * 1. black-hat（半徑 2）把「比周圍暗的小點」抽出來（亮點在暗底的碼用 `polarity: 'light'`）
 * 2. 只留響應前 1% 且是 3×3 局部極大的像素 = 一個「點」（只數獨立的點，不數紋理）
 * 3. 積分影像算 `window` 視窗內的點數，步長 4 掃描，取前 `k` 個彼此距離 > window 的峰值
 *
 * `window` ≈ 符號邊長（解碼影像 px）：22 模組 × 3 px ≈ 66，640 寬的幀約 40。
 * 成本：640×1138 在 JS 約 35–45 ms（帽濾波佔大半），所以只在 `dotted` 模式、整幀沒結果時跑。
 * 影片實測（PCB 遠拍）：候選前 3 名包含真正的碼的比例約 4/5；配合裁切 + 全部變體，命中 3/448 → 65/448。
 */
export function locateDotClusters(
  gray: Uint8Array,
  width: number,
  height: number,
  options: { readonly k: number; readonly window: number; readonly polarity?: DotPolarity },
  scratch?: MorphScratch,
): DotCluster[] {
  const n = width * height
  const s: MorphScratch = scratch && scratch.a.length === n ? scratch : { a: new Uint8Array(n), b: new Uint8Array(n) }
  s.a.set(gray)
  hatFilter(s.a, width, height, 2, options.polarity ?? 'dark', s)
  // 響應 = 距離「無點」的差；hatFilter 讓 dark 極性的點為暗、light 為亮
  const resp = s.a
  if ((options.polarity ?? 'dark') === 'dark') for (let i = 0; i < n; i++) resp[i] = 255 - resp[i]!
  const hist = new Uint32Array(256)
  for (let i = 0; i < n; i++) hist[resp[i]!]!++
  let acc = 0
  let thr = 255
  while (thr > 0 && acc + hist[thr]! < n * 0.01) acc += hist[thr--]!
  // 積分影像（點數）；buffer 掛在 scratch 上重用（1.6M px 的幀每次配 6.5 MB 會被 GC 拖慢）
  const stride = width + 1
  const iiLen = stride * (height + 1)
  if (!s.ii || s.ii.length !== iiLen) s.ii = new Uint32Array(iiLen)
  const ii = s.ii
  ii.fill(0, 0, stride * 2)
  for (let y = 1; y < height - 1; y++) {
    let row = 0
    const r = y * width
    const out = (y + 1) * stride
    const prev = y * stride
    ii[out] = 0
    ii[out + 1] = 0
    for (let x = 1; x < width - 1; x++) {
      const i = r + x
      const v = resp[i]!
      if (
        v > thr &&
        v >= resp[i - 1]! && v >= resp[i + 1]! && v >= resp[i - width]! && v >= resp[i + width]! &&
        v >= resp[i - width - 1]! && v >= resp[i - width + 1]! && v >= resp[i + width - 1]! && v >= resp[i + width + 1]!
      ) row++
      ii[out + x + 1] = ii[prev + x + 1]! + row
    }
    ii[out + width] = ii[out + width - 1]!
  }
  ii.copyWithin(height * stride, (height - 1) * stride, height * stride)

  // 視窗加總（步長 4 的粗格），再取 k 個彼此距離 > window 的最大值
  const half = options.window >> 1
  const step = 4
  const gw = Math.max(0, Math.floor((width - 2 * half) / step))
  const gh = Math.max(0, Math.floor((height - 2 * half) / step))
  if (gw === 0 || gh === 0) return []
  if (!s.sums || s.sums.length !== gw * gh) s.sums = new Uint32Array(gw * gh)
  const sums = s.sums
  for (let gy = 0; gy < gh; gy++) {
    const y0 = gy * step
    const y1 = y0 + 2 * half
    for (let gx = 0; gx < gw; gx++) {
      const x0 = gx * step
      const x1 = x0 + 2 * half
      sums[gy * gw + gx] = ii[y1 * stride + x1]! - ii[y0 * stride + x1]! - ii[y1 * stride + x0]! + ii[y0 * stride + x0]!
    }
  }
  const picked: DotCluster[] = []
  const sep = Math.ceil(options.window / step)
  for (let k = 0; k < options.k; k++) {
    let best = -1
    let bi = -1
    for (let i = 0; i < sums.length; i++) {
      const v = sums[i]!
      if (v > best) {
        best = v
        bi = i
      }
    }
    if (bi < 0 || best <= 0) break
    const gx = bi % gw
    const gy = (bi - gx) / gw
    picked.push({ cx: gx * step + half, cy: gy * step + half, score: best })
    // 壓掉鄰近格子，下一輪找別的區域
    for (let yy = Math.max(0, gy - sep); yy <= Math.min(gh - 1, gy + sep); yy++)
      for (let xx = Math.max(0, gx - sep); xx <= Math.min(gw - 1, gx + sep); xx++) sums[yy * gw + xx] = 0
  }
  return picked
}

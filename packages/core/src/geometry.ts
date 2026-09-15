import type {
  ElementTransform,
  ElementTransformOptions,
  GetElementTransform,
  Point,
  Quad,
  Rect,
  RectToElementSpace,
  Roi,
  Size,
  ToElementSpace,
} from './types'

/** 判斷第二個參數是 `<video>` 還是已算好的轉換。不用 `instanceof`，SSR 下 `HTMLVideoElement` 不存在。 */
function isVideoElement(target: HTMLVideoElement | ElementTransform): target is HTMLVideoElement {
  return 'videoWidth' in target
}

export const getElementTransform: GetElementTransform = (videoEl, options = {}) => {
  const iw = videoEl.videoWidth
  const ih = videoEl.videoHeight
  if (!iw || !ih) return null

  // clientWidth/Height：不含 transform，含 padding。video 元素不該有 padding，文件會註明。
  const ew = videoEl.clientWidth
  const eh = videoEl.clientHeight
  const fit = options.objectFit ?? 'cover'
  const pos = options.objectPosition ?? { x: 0.5, y: 0.5 }

  let scaleX: number
  let scaleY: number
  if (fit === 'fill') {
    scaleX = ew / iw
    scaleY = eh / ih
  } else {
    const s = fit === 'cover' ? Math.max(ew / iw, eh / ih) : Math.min(ew / iw, eh / ih)
    scaleX = s
    scaleY = s
  }

  return {
    scaleX,
    scaleY,
    offsetX: (ew - iw * scaleX) * pos.x,
    offsetY: (eh - ih * scaleY) * pos.y,
    mirrored: options.mirrored ?? false,
    imageSize: { width: iw, height: ih },
    elementSize: { width: ew, height: eh },
  }
}

function resolveTransform(
  target: HTMLVideoElement | ElementTransform,
  options?: ElementTransformOptions,
): ElementTransform | null {
  return isVideoElement(target) ? getElementTransform(target, options) : target
}

function mapPoint(p: Point, t: ElementTransform): Point {
  const x = t.offsetX + p.x * t.scaleX
  return { x: t.mirrored ? t.elementSize.width - x : x, y: t.offsetY + p.y * t.scaleY }
}

export const toElementSpace: ToElementSpace = (quad, target, options) => {
  const t = resolveTransform(target, options)
  if (!t) {
    // video 還沒尺寸：回傳全零而非 throw，讓 overlay 在第一幀前不用特別處理
    const z = { x: 0, y: 0 }
    return [z, z, z, z]
  }
  const [a, b, c, d] = quad
  const out: Quad<'element'> = [mapPoint(a, t), mapPoint(b, t), mapPoint(c, t), mapPoint(d, t)]
  // 鏡像後左上會跑到右上；把順序轉回「左上 → 右上 → 右下 → 左下」
  return t.mirrored ? [out[1], out[0], out[3], out[2]] : out
}

/**
 * ROI（比例）→ 影像像素矩形，四捨五入到整數且限制在影像範圍內。
 * core 裁切幀與 UI 畫框都從這裡出發，保證是同一塊。
 */
export function roiToImageRect(roi: Roi | null, image: Size): Rect {
  if (!roi) return { x: 0, y: 0, width: image.width, height: image.height }
  const x = clamp(Math.round(roi.x * image.width), 0, image.width)
  const y = clamp(Math.round(roi.y * image.height), 0, image.height)
  const w = clamp(Math.round(roi.width * image.width), 0, image.width - x)
  const h = clamp(Math.round(roi.height * image.height), 0, image.height - y)
  return { x, y, width: w, height: h }
}

export const rectToElementSpace: RectToElementSpace = (roi, target, options) => {
  const t = resolveTransform(target, options)
  if (!t) return { x: 0, y: 0, width: 0, height: 0 }
  const r = roiToImageRect(roi, t.imageSize)
  const tl = mapPoint({ x: r.x, y: r.y }, t)
  const br = mapPoint({ x: r.x + r.width, y: r.y + r.height }, t)
  return {
    x: Math.min(tl.x, br.x),
    y: Math.min(tl.y, br.y),
    width: Math.abs(br.x - tl.x),
    height: Math.abs(br.y - tl.y),
  }
}

/** 軸對齊矩形 → quad（左上 → 右上 → 右下 → 左下）。 */
export function rectToQuad(r: Rect): Quad<'image'> {
  return [
    { x: r.x, y: r.y },
    { x: r.x + r.width, y: r.y },
    { x: r.x + r.width, y: r.y + r.height },
    { x: r.x, y: r.y + r.height },
  ]
}

/** quad 的包圍框。 */
export function quadBounds(q: Quad<'image'>): Rect {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const p of q) {
    if (p.x < minX) minX = p.x
    if (p.y < minY) minY = p.y
    if (p.x > maxX) maxX = p.x
    if (p.y > maxY) maxY = p.y
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
}

/**
 * 把「裁切 + 縮放後」的座標換回原始影像座標。
 * 解碼器看到的是 `crop` 這塊縮到 `scale` 倍後的影像，所以 `img = crop.origin + decoded / scale`。
 */
export function toImageSpace(q: Quad<'image'>, crop: Rect, scale: number): Quad<'image'> {
  const f = (p: Point): Point => ({ x: crop.x + p.x / scale, y: crop.y + p.y / scale })
  return [f(q[0]), f(q[1]), f(q[2]), f(q[3])]
}

/** 矩形外擴 `ratio` 倍（每邊各擴 ratio/2）後夾在 `bounds` 內。候選放大用。 */
export function expandRect(r: Rect, ratio: number, bounds: Rect): Rect {
  const dw = r.width * ratio
  const dh = r.height * ratio
  const x = clamp(r.x - dw / 2, bounds.x, bounds.x + bounds.width)
  const y = clamp(r.y - dh / 2, bounds.y, bounds.y + bounds.height)
  const right = clamp(r.x + r.width + dw / 2, bounds.x, bounds.x + bounds.width)
  const bottom = clamp(r.y + r.height + dh / 2, bounds.y, bounds.y + bounds.height)
  return { x: Math.floor(x), y: Math.floor(y), width: Math.ceil(right - x), height: Math.ceil(bottom - y) }
}

export function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v
}

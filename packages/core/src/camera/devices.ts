import type { CameraInfo } from '../types'

/**
 * label 關鍵字 → facing。涵蓋英文與常見中文 label。
 * Android Chrome 的 label 格式是 `camera2 0, facing back`；iOS 是 `Back Camera` / `Front Camera`；
 * 桌機通常是產品名（`FaceTime HD Camera`、`HD Pro Webcam C920`），推不出來就是 `unknown`。
 */
export function inferFacing(label: string): CameraInfo['facing'] {
  if (/\b(back|rear|environment)\b|後置|后置|後鏡|后镜|背面/i.test(label)) return 'environment'
  if (/\b(front|user|face(time)?|selfie)\b|前置|前鏡|前镜|正面/i.test(label)) return 'user'
  return 'unknown'
}

/**
 * 開到的鏡頭方向與要求不符時，找一顆符合方向的。
 * 實機驗證：iPad Safari 對 `facingMode: { ideal: 'environment' }` 可能給前鏡頭。
 * 回傳 `null` 表示方向已符合或沒有可換的。
 */
export function pickByFacing(
  cameras: readonly CameraInfo[],
  current: CameraInfo,
  facing: 'environment' | 'user',
): CameraInfo | null {
  if (current.facing === facing) return null
  const same = cameras.filter((c) => c.facing === facing)
  if (same.length === 0) return null
  return pickMainCamera(same, null, facing)
}

/**
 * 「不是主鏡頭」的關鍵字。Samsung 等會給描述性 label
 * （`Back Ultra Wide Camera`、`Back Telephoto Camera`、`Back Macro Camera`）。
 * 單獨的 "wide" 不算：主鏡頭有時就叫 Wide Camera。
 *
 * iOS 的 label 會**隨系統語言在地化**（實機驗證：iPad 中文介面給 `前置超廣角相機`），
 * 所以中文關鍵字也要認：超廣角 / 望遠 / 微距 / 深度。
 * 「雙廣角」「三相機」是 iOS 的虛擬合成鏡頭（會自動切換微距），對掃碼反而最好，不排除。
 */
const NON_MAIN_LENS =
  /ultra[\s-]?wide|wide[\s-]?angle|macro|tele(photo)?|depth|bokeh|infrared|\bir\b|\btof\b|virtual|超廣角|超广角|望遠|長焦|长焦|微距|深度/i

export function isLikelyMainLens(label: string): boolean {
  return !NON_MAIN_LENS.test(label)
}

/** Android Chrome 的 `camera2 N, facing back` 取 N，其他 label 回傳 Infinity（排最後）。 */
function cameraIndex(label: string): number {
  const m = /camera2?\s*(\d+)/i.exec(label)
  return m ? Number(m[1]) : Number.POSITIVE_INFINITY
}

export async function listVideoInputs(): Promise<readonly CameraInfo[]> {
  const md = typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined
  if (!md?.enumerateDevices) return []
  const devices = await md.enumerateDevices()
  return devices
    .filter((d) => d.kind === 'videoinput')
    .map((d) => ({ deviceId: d.deviceId, label: d.label, facing: inferFacing(d.label) }))
}

/**
 * Android 多鏡頭的主鏡頭挑選（`preferMainCamera`）。
 *
 * 前提：已經用 facingMode 開過一次相機（否則 label 全空，什麼都判斷不了）。
 *
 * 1. 只看與 `facing` 同向的鏡頭；一顆都推不出方向時退回全部
 * 2. 排除 label 含非主鏡頭關鍵字的
 * 3. 若目前開的鏡頭在候選內 → 維持（不必重開）
 * 4. 否則取 `camera2 N` 編號最小的；沒有編號就取第一個
 *
 * 回傳 `null` 表示沒有更好的選擇（維持現狀）。
 *
 * TODO(實機驗證)：Pixel 系列的 label 是否含 lens 資訊；Samsung 的 label 是否穩定。
 */
export function pickMainCamera(
  cameras: readonly CameraInfo[],
  current: CameraInfo | null,
  facing: 'environment' | 'user',
): CameraInfo | null {
  let pool = cameras.filter((c) => c.facing === facing)
  if (pool.length === 0) pool = cameras.filter((c) => c.facing === 'unknown')
  if (pool.length === 0) return null

  const main = pool.filter((c) => isLikelyMainLens(c.label))
  const candidates = main.length ? main : pool

  if (current && candidates.some((c) => c.deviceId === current.deviceId)) return null

  const sorted = [...candidates].sort((a, b) => cameraIndex(a.label) - cameraIndex(b.label))
  return sorted[0] ?? null
}

/** `switchCamera('next')`：依列表順序取下一個，繞回開頭。 */
export function nextCamera(cameras: readonly CameraInfo[], current: CameraInfo | null): CameraInfo | null {
  if (cameras.length === 0) return null
  if (!current) return cameras[0] ?? null
  const i = cameras.findIndex((c) => c.deviceId === current.deviceId)
  return cameras[(i + 1) % cameras.length] ?? null
}

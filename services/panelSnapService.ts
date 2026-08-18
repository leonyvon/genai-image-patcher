// Panel Snap Service — 框选吸附（纯函数，无 React 依赖）
//
// 检测在降采样灰度图上进行（最长边 <= maxDim, 默认 1500px）。对每行/列计算：
//   whiteFrac：灰度 > WHITE 的像素占比（白缝信号）
//   longestRun：最长连续灰度 < DARK 的像素游程（黑线信号）
// 打分 sep[i] in [0,1] + kind（0 none / 1 gutter 白缝 / 2 line 黑线）。
// 吸附 snapRect 为纯同步：把百分比矩形换算到检测像素空间，逐边在
// ±SNAP_RADIUS（原始图像素，检测空间乘 detectScale）内找最近可信分隔线。

export interface PctRect {
  x: number
  y: number
  width: number
  height: number
}

export interface PanelDetector {
  snapRect(rect: PctRect): PctRect
  dispose(): void
}

// --- 算法常量（原型已固化，勿改数值） ---
const DARK = 60
const WHITE = 235
const FULLW = 0.99   // 黑线：最长连续黑游程 >= 99% 跨度（真格线 100% 连续，内容有断裂）
const GUTTER = 0.30  // 白缝：该行/列白色像素占比阈值
const MAXBAND = 16   // 细线约束：连续满宽行/列 <= 16px 才算格线
const SEP_THRESH = 0.40 // 吸附阈值
const SNAP_RADIUS = 80  // 吸附半径（原始图像素）
const MIN_PANEL = 24    // 最小面板尺寸兜底（原始图像素）
const MAX_DIM = 2048    // 检测最长边（≥2048 保证 1024×1536 这类小图不被降采样，1px 格线不被模糊）

interface SepResult {
  sep: Float32Array
  kind: number[]
}

interface SnapHit {
  idx: number
  score: number
  kind: number
  dist: number
}

function luma(r: number, g: number, b: number): number {
  return r * 0.299 + g * 0.587 + b * 0.114
}

// 对一维统计量打分（原型 computeSep 的忠实移植）
function computeSep(white: Float32Array, run: Int32Array, span: number): SepResult {
  const n = run.length
  const full = new Uint8Array(n)
  for (let i = 0; i < n; i++) full[i] = run[i] >= FULLW * span ? 1 : 0
  const sep = new Float32Array(n)
  const kind = new Array<number>(n).fill(0) // 0 none, 1 gutter(白缝), 2 line(黑线)
  for (let i = 0; i < n; i++) {
    if (white[i] > GUTTER) {
      sep[i] = Math.max(sep[i], white[i])
      kind[i] = 1
    }
  }
  let i = 0
  while (i < n) {
    if (!full[i]) {
      i++
      continue
    }
    let j = i
    while (j < n && full[j]) j++
    // 只有厚度 <= MAXBAND 的连续满宽带才标记为 line
    if (j - i <= MAXBAND) {
      for (let k = i; k < j; k++) {
        const s = run[k] / span
        if (s > sep[k]) {
          sep[k] = s
          kind[k] = 2
        }
      }
    }
    i = j
  }
  return { sep, kind }
}

// 在 [pos-radius, pos+radius] 内找最近的 sep >= SEP_THRESH 分隔线
function snapEdge(sep: Float32Array, kind: number[], pos: number, radius: number): SnapHit | null {
  const n = sep.length
  const lo = Math.max(0, Math.floor(pos - radius))
  const hi = Math.min(n - 1, Math.ceil(pos + radius))
  let best: SnapHit | null = null
  let bestDist = Infinity
  for (let i = lo; i <= hi; i++) {
    if (sep[i] >= SEP_THRESH) {
      const d = Math.abs(i - pos)
      if (d < bestDist) {
        bestDist = d
        best = { idx: i, score: sep[i], kind: kind[i], dist: d }
      }
    }
  }
  return best
}

export async function buildPanelDetector(
  imageUrl: string,
  opts?: { maxDim?: number; originalWidth?: number; originalHeight?: number }
): Promise<PanelDetector> {
  const maxDim = opts?.maxDim ?? MAX_DIM

  // 原始尺寸：用于按比例单次降采样解码，以及 SNAP_RADIUS / MIN_PANEL 的像素换算
  const oW = opts?.originalWidth
  const oH = opts?.originalHeight

  const blob = await (await fetch(imageUrl)).blob()
  let bitmap: ImageBitmap
  if (oW && oH) {
    // 单次解码直接带 resize：避免"先全分辨率解码、超限再二次解码"的内存尖峰。
    // ratio 不超过 1（不放大），且按原图宽高同比例缩放，保持宽高比不拉伸。
    // 微小缩放（ratio >= 0.9）会模糊 1px 格线、破坏 FULLW=0.99 连续性检测，故不降采样。
    const ratio = Math.min(1, maxDim / oW, maxDim / oH)
    if (ratio < 0.9) {
      const w = Math.max(1, Math.round(oW * ratio))
      const h = Math.max(1, Math.round(oH * ratio))
      bitmap = await createImageBitmap(blob, { resizeWidth: w, resizeHeight: h, resizeQuality: 'high' })
    } else {
      bitmap = await createImageBitmap(blob)
    }
  } else {
    bitmap = await createImageBitmap(blob)
  }

  const detectW = bitmap.width
  const detectH = bitmap.height

  // 换算基准：优先用传入的原始尺寸；未提供时回退到解码后尺寸。
  // 注意：仅当原图最长边 <= maxDim 时 detectW/H 才等于原始尺寸；
  // 大图降采样后 detectW=1500 != origW（此即 SNAP_RADIUS 需要乘 detectScale 的原因）
  const origW = oW ?? detectW
  const origH = oH ?? detectH
  const scaleX = detectW / origW
  const scaleY = detectH / origH

  // 合成到白底再抽灰度（处理 RGBA / 透明，与原型一致）
  const canvas = document.createElement('canvas')
  canvas.width = detectW
  canvas.height = detectH
  const ctx = canvas.getContext('2d')
  if (!ctx) {
    bitmap.close()
    throw new Error('Could not get canvas 2d context for panel detection')
  }
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, detectW, detectH)
  ctx.drawImage(bitmap, 0, 0)
  const imgData = ctx.getImageData(0, 0, detectW, detectH).data

  // 每行统计：whiteFrac + 最长连续黑游程
  const rowWhite = new Float32Array(detectH)
  const rowRun = new Int32Array(detectH)
  for (let y = 0; y < detectH; y++) {
    const off = y * detectW
    let w = 0
    let best = 0
    let cur = 0
    for (let x = 0; x < detectW; x++) {
      const o = (off + x) * 4
      const g = luma(imgData[o], imgData[o + 1], imgData[o + 2])
      if (g > WHITE) w++
      if (g < DARK) {
        cur++
        if (cur > best) best = cur
      } else {
        cur = 0
      }
    }
    rowWhite[y] = w / detectW
    rowRun[y] = best
  }

  // 每列统计
  const colWhite = new Float32Array(detectW)
  const colRun = new Int32Array(detectW)
  for (let x = 0; x < detectW; x++) {
    let w = 0
    let best = 0
    let cur = 0
    for (let y = 0; y < detectH; y++) {
      const o = (y * detectW + x) * 4
      const g = luma(imgData[o], imgData[o + 1], imgData[o + 2])
      if (g > WHITE) w++
      if (g < DARK) {
        cur++
        if (cur > best) best = cur
      } else {
        cur = 0
      }
    }
    colWhite[x] = w / detectH
    colRun[x] = best
  }

  const rows = computeSep(rowWhite, rowRun, detectW)
  const cols = computeSep(colWhite, colRun, detectH)
  const rowSep = rows.sep
  const rowKind = rows.kind
  const colSep = cols.sep
  const colKind = cols.kind

  // 原始像素 -> 检测像素的换算因子
  const radiusX = SNAP_RADIUS * scaleX
  const radiusY = SNAP_RADIUS * scaleY
  const minPanelW = MIN_PANEL * scaleX
  const minPanelH = MIN_PANEL * scaleY

  const snapRect = (rect: PctRect): PctRect => {
    // pct -> 检测像素（检测像素 = pct/100 × 检测维度）
    const l = (rect.x / 100) * detectW
    const r = ((rect.x + rect.width) / 100) * detectW
    const t = (rect.y / 100) * detectH
    const b = ((rect.y + rect.height) / 100) * detectH

    // 四条边各自独立吸附，找不到可信分隔线的边保持原位（部分吸附）
    const top = snapEdge(rowSep, rowKind, t, radiusY)
    const bottom = snapEdge(rowSep, rowKind, b, radiusY)
    const left = snapEdge(colSep, colKind, l, radiusX)
    const right = snapEdge(colSep, colKind, r, radiusX)

    let st = top ? top.idx : t
    let sb = bottom ? bottom.idx : b
    let sl = left ? left.idx : l
    let sr = right ? right.idx : r

    // 最小尺寸兜底：吸附后过窄则整轴回退到原始框
    if (sb - st < minPanelH) {
      st = t
      sb = b
    }
    if (sr - sl < minPanelW) {
      sl = l
      sr = r
    }

    // 检测像素 -> pct
    return {
      x: (sl / detectW) * 100,
      y: (st / detectH) * 100,
      width: ((sr - sl) / detectW) * 100,
      height: ((sb - st) / detectH) * 100,
    }
  }

  return {
    snapRect,
    dispose: () => {
      bitmap.close()
      canvas.width = 0
      canvas.height = 0
    },
  }
}

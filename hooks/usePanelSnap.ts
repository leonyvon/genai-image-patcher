import { useCallback, useEffect, useRef } from "react"
import { buildPanelDetector } from "../services/panelSnapService"
import type { PanelDetector, PctRect } from "../services/panelSnapService"

/**
 * 框选吸附探测器生命周期管理。
 * - enabled=false 或 image 缺失 -> 返回恒等函数，不构建探测器
 * - image.originalUrl 变化时异步重建（含"应用为原图"后 originalUrl 变更的场景）
 * - 未就绪时 snapRect 为恒等（no-op），绝不阻塞拖框
 * - 卸载/切换/关闭时 dispose()，并用 cancelled 标志防止异步竞态
 */
export function usePanelSnap(
  image: { originalUrl: string; originalWidth: number; originalHeight: number } | undefined,
  enabled: boolean
): { snapRect: (rect: PctRect) => PctRect } {
  const detectorRef = useRef<PanelDetector | null>(null)

  const snapRect = useCallback((rect: PctRect): PctRect => {
    const detector = detectorRef.current
    if (!detector) return rect
    return detector.snapRect(rect)
  }, [])

  const originalUrl = image?.originalUrl
  const originalWidth = image?.originalWidth
  const originalHeight = image?.originalHeight

  useEffect(() => {
    if (!enabled || !originalUrl || !originalWidth || !originalHeight) {
      detectorRef.current?.dispose()
      detectorRef.current = null
      return
    }

    let cancelled = false
    buildPanelDetector(originalUrl, { originalWidth, originalHeight })
      .then((detector) => {
        if (cancelled) {
          detector.dispose()
          return
        }
        detectorRef.current?.dispose()
        detectorRef.current = detector
      })
      .catch((err) => {
        console.error('Failed to build panel snap detector', err)
      })

    return () => {
      cancelled = true
      detectorRef.current?.dispose()
      detectorRef.current = null
    }
  }, [enabled, originalUrl, originalWidth, originalHeight])

  return { snapRect }
}

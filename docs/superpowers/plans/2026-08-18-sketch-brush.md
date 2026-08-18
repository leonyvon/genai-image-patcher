# 画笔草图指引（Sketch Brush）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用户在图上画矢量线条，作为 AI 可见的草图指引，生成时自动合成进 AI 输入，且永不写入最终输出。

**Architecture:** 线条以百分比坐标矢量数据存在 `UploadedImage.sketchStrokes` 上；EditorCanvas 用独立 overlay canvas 渲染（工作视图显示、result 视图隐藏）；发送 AI 前在 `imageUtils` 的切片/全图遮罩函数里用 `compositeSketchStrokes` 合成（选区确认时清空选区内线条）。复用现有 restore/remove 画笔的"全分辨率 overlay canvas + 窗口级鼠标事件"模式。

**Tech Stack:** React 19 + TypeScript + Vite，无测试框架（仓库约定：验证 = `npx tsc --noEmit` + `npm run build` + 手动浏览器冒烟）。

**设计文档:** `docs/superpowers/specs/2026-08-18-sketch-brush-design.md`

---

### Task 1: 数据模型（types.ts）

**Files:**
- Modify: `types.ts`（`SketchStroke` 接口 + `UploadedImage.sketchStrokes`）

- [ ] **Step 1: 添加 SketchStroke 接口**

在 `types.ts` 的 `RestoreBox` 接口（第 2-9 行）之前插入：

```ts
export interface SketchStroke {
  id: string;
  color: string;                      // hex，如 '#ff3b30'
  size: number;                       // 粗细：图片最大边长的百分比（0-100），与 restoreBrushSize 语义一致
  points: { x: number; y: number }[]; // 百分比坐标 0-100，相对整图
}
```

- [ ] **Step 2: UploadedImage 增加 sketchStrokes 字段**

在 `types.ts` 的 `UploadedImage` 接口（第 46-66 行）末尾（`referenceBase64` 后）添加：

```ts
  /** AI 可见的草图指引线条（矢量、百分比坐标）。永不写入最终输出，仅合成进 AI 输入。 */
  sketchStrokes?: SketchStroke[];
```

- [ ] **Step 3: 类型检查并提交**

Run: `npx tsc --noEmit`
Expected: 无新增错误（仅既有输出）

```bash
git add types.ts && git commit -m "feat: SketchStroke 数据模型（画笔草图指引线条）"
```

---

### Task 2: 合成工具（imageUtils.ts）

**Files:**
- Modify: `services/imageUtils.ts`（新增 `compositeSketchStrokes`；`cropRegion`、`createMultiMaskedFullImage`、`createInvertedMultiMaskedFullImage` 增加可选 `strokes` 参数）

- [ ] **Step 1: 文件头 import SketchStroke**

`services/imageUtils.ts` 顶部从 `../types` 的 import 列表中加入 `SketchStroke`（先查看现有 import 行，如 `import { Region, ... } from '../types'`，把 `SketchStroke` 加进同一花括号）。

- [ ] **Step 2: 新增 compositeSketchStrokes 工具函数**

在 `cropRegion`（第 418 行）定义之前插入：

```ts
/**
 * Draws sketch guidance strokes onto a canvas context.
 * Coordinates are image-relative percentages (0-100); size is a percentage
 * of the image's max dimension — the formula works on any canvas that has
 * the image's aspect ratio (overlay, crop, full mask).
 * When sourceRect (a Region in image-relative %) is given, strokes are
 * clipped to the canvas rect and mapped into it (region-crop case).
 */
export const compositeSketchStrokes = (
  ctx: CanvasRenderingContext2D,
  strokes: SketchStroke[],
  canvasW: number,
  canvasH: number,
  sourceRect?: { x: number; y: number; width: number; height: number }
): void => {
  if (!strokes || strokes.length === 0) return;
  ctx.save();
  if (sourceRect) {
    ctx.beginPath();
    ctx.rect(0, 0, canvasW, canvasH);
    ctx.clip();
  }
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const stroke of strokes) {
    ctx.strokeStyle = stroke.color;
    ctx.lineWidth = (stroke.size / 100) * Math.max(canvasW, canvasH);
    ctx.beginPath();
    let started = false;
    for (const p of stroke.points) {
      const lx = sourceRect ? ((p.x - sourceRect.x) / sourceRect.width) * 100 : p.x;
      const ly = sourceRect ? ((p.y - sourceRect.y) / sourceRect.height) * 100 : p.y;
      const px = (lx / 100) * canvasW;
      const py = (ly / 100) * canvasH;
      if (!started) { ctx.moveTo(px, py); started = true; }
      else ctx.lineTo(px, py);
    }
    ctx.stroke();
  }
  ctx.restore();
};
```

- [ ] **Step 3: cropRegion 增加 strokes 参数并在 drawImage 后合成**

把 `cropRegion`（第 418-444 行）改为：

```ts
export const cropRegion = async (
  imageElement: HTMLImageElement,
  region: Region,
  strokes?: SketchStroke[]
): Promise<string> => {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  
  if (!ctx) throw new Error('Could not get canvas context');

  const x = (region.x / 100) * imageElement.naturalWidth;
  const y = (region.y / 100) * imageElement.naturalHeight;
  const w = (region.width / 100) * imageElement.naturalWidth;
  const h = (region.height / 100) * imageElement.naturalHeight;

  canvas.width = w;
  canvas.height = h;

  ctx.drawImage(
    imageElement,
    x, y, w, h,
    0, 0, w, h
  );

  compositeSketchStrokes(ctx, strokes || [], canvas.width, canvas.height, {
    x: region.x, y: region.y, width: region.width, height: region.height,
  });

  const result = await canvasToObjectURL(canvas);
  releaseCanvas(canvas);
  return result;
};
```

- [ ] **Step 4: createMultiMaskedFullImage 增加 strokes 参数**

签名改为 `(imageElement: HTMLImageElement, regions: Region[], strokes?: SketchStroke[])`，在 `regions.forEach(...)` 之后、`canvasToObjectURL(canvas)` 之前插入：

```ts
  compositeSketchStrokes(ctx, strokes || [], canvas.width, canvas.height);
```

- [ ] **Step 5: createInvertedMultiMaskedFullImage 增加 strokes 参数**

签名改为 `(imageElement: HTMLImageElement, regions: Region[], strokes?: SketchStroke[])`，在 `regions.forEach(...)` 之后、`canvasToObjectURL(canvas)` 之前插入：

```ts
  compositeSketchStrokes(ctx, strokes || [], canvas.width, canvas.height);
```

- [ ] **Step 6: 类型检查并提交**

Run: `npx tsc --noEmit`
Expected: 无新增错误（可选参数不破坏现有调用点）

```bash
git add services/imageUtils.ts && git commit -m "feat: compositeSketchStrokes 工具 + 切片/全图遮罩合成接线"
```

---

### Task 3: AI 处理路径接线（useImageProcessor.ts）

**Files:**
- Modify: `hooks/useImageProcessor.ts`（3 处调用点传 `imageSnapshot.sketchStrokes`）

- [ ] **Step 1: 全图遮罩两处调用**

第 125 行改为：

```ts
                    inputImageUrl = await createInvertedMultiMaskedFullImage(maskImg, allActiveRegions, imageSnapshot.sketchStrokes);
```

第 127 行改为：

```ts
                    inputImageUrl = await createMultiMaskedFullImage(maskImg, allActiveRegions, imageSnapshot.sketchStrokes);
```

- [ ] **Step 2: 翻译上下文遮罩一处调用**

第 314 行改为：

```ts
                const fullMaskedUrl = await createMultiMaskedFullImage(maskImg, allActiveRegions, imageSnapshot.sketchStrokes);
```

- [ ] **Step 3: 单选区切片一处调用**

第 340 行改为：

```ts
                croppedUrl = await cropRegion(imgElement, region, imageSnapshot.sketchStrokes);
```

- [ ] **Step 4: 类型检查并提交**

Run: `npx tsc --noEmit`
Expected: 无新增错误

```bash
git add hooks/useImageProcessor.ts && git commit -m "feat: AI 输入路径合成画笔线条"
```

---

### Task 4: EditorCanvas 绘制与渲染

**Files:**
- Modify: `components/EditorCanvas.tsx`（props、状态、overlay canvas、绘制/擦除 handler、JSX 接线）

- [ ] **Step 1: import 与 props**

第 3 行改为：

```ts
import { UploadedImage, Region, Language, RestoreBox, ThemeType, SketchStroke } from '../types';
```

第 7 行改为：

```ts
import { renderRegionWithRestore, loadImage, releaseObjectURL, compositeSketchStrokes } from '../services/imageUtils';
```

在 `EditorCanvasProps` 接口（第 50 行 `onSelectRestoreRegion` 之后）追加：

```ts
  /** Sketch brush: AI-visible guidance strokes on the whole image. */
  brushMode?: boolean;
  brushColor?: string;
  brushSize?: number;
  brushEraser?: boolean;
  onUpdateSketchStrokes?: (imageId: string, strokes: SketchStroke[]) => void;
  onClearSketchStrokes?: () => void;
```

- [ ] **Step 2: props 解构默认值**

在第 98-99 行（`restoreBrushSize = 8` 之后）追加解构：

```ts
    brushMode = false,
    brushColor = '#ff3b30',
    brushSize = 2,
    brushEraser = false,
    onUpdateSketchStrokes,
    onClearSketchStrokes,
```

- [ ] **Step 3: 状态与 refs**

在第 405-406 行（remove brush 状态之后）追加：

```ts
  // --- Sketch brush state (AI-visible guidance strokes) ---
  const [isSketchPainting, setIsSketchPainting] = useState(false);
  const sketchOverlayRef = useRef<HTMLCanvasElement | null>(null);
  const liveStrokeRef = useRef<SketchStroke | null>(null);
```

- [ ] **Step 4: 渲染 + 尺寸同步 + 绘制/擦除 handler**

在 `const isOriginalMode = viewMode === 'original';`（第 891 行）之后插入整块：

```ts
  // --- Sketch brush: render strokes onto the overlay canvas (full-res px) ---
  const renderSketchOverlay = useCallback(() => {
    const overlay = sketchOverlayRef.current;
    if (!overlay) return;
    const octx = overlay.getContext('2d');
    if (!octx) return;
    octx.clearRect(0, 0, overlay.width, overlay.height);
    compositeSketchStrokes(octx, image.sketchStrokes || [], overlay.width, overlay.height);
  }, [image.sketchStrokes]);

  // Size the overlay to the image and (re)render whenever strokes / mode change.
  useEffect(() => {
    const overlay = sketchOverlayRef.current;
    if (!overlay) return;
    overlay.width = image.originalWidth || 800;
    overlay.height = image.originalHeight || 600;
    renderSketchOverlay();
  }, [isOriginalMode, brushMode, image.originalWidth, image.originalHeight, image.sketchStrokes, renderSketchOverlay]);

  // Window-level mouse handlers for sketch brush painting / erasing
  useEffect(() => {
    if (!brushMode || !isOriginalMode) return;

    const handleWindowMouseMove = (e: MouseEvent) => {
      if (!isSketchPainting || !sketchOverlayRef.current) return;
      const overlay = sketchOverlayRef.current;
      const rect = overlay.getBoundingClientRect();
      const px = ((e.clientX - rect.left) / rect.width) * 100;
      const py = ((e.clientY - rect.top) / rect.height) * 100;

      if (brushEraser) {
        // Vector eraser: remove whole strokes whose any point is within radius
        const radiusPct = brushSize;
        const current = image.sketchStrokes || [];
        const remaining = current.filter(s =>
          !s.points.some(p => Math.hypot(p.x - px, p.y - py) <= radiusPct)
        );
        if (remaining.length !== current.length && onUpdateSketchStrokes) {
          onUpdateSketchStrokes(image.id, remaining);
        }
        return;
      }

      const live = liveStrokeRef.current;
      if (!live) return;
      const octx = overlay.getContext('2d');
      if (!octx) return;
      const prev = live.points[live.points.length - 1];
      const sizePx = (live.size / 100) * Math.max(overlay.width, overlay.height);
      octx.strokeStyle = live.color;
      octx.lineWidth = sizePx;
      octx.lineCap = 'round';
      octx.lineJoin = 'round';
      octx.beginPath();
      octx.moveTo((prev.x / 100) * overlay.width, (prev.y / 100) * overlay.height);
      octx.lineTo((px / 100) * overlay.width, (py / 100) * overlay.height);
      octx.stroke();
      live.points.push({ x: px, y: py });
    };

    const handleWindowMouseUp = () => {
      if (!isSketchPainting) return;
      setIsSketchPainting(false);
      const live = liveStrokeRef.current;
      liveStrokeRef.current = null;
      if (live && live.points.length > 0 && onUpdateSketchStrokes) {
        onUpdateSketchStrokes(image.id, [...(image.sketchStrokes || []), live]);
      }
    };

    window.addEventListener('mousemove', handleWindowMouseMove);
    window.addEventListener('mouseup', handleWindowMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleWindowMouseMove);
      window.removeEventListener('mouseup', handleWindowMouseUp);
    };
  }, [brushMode, isOriginalMode, isSketchPainting, brushEraser, brushSize, image.id, image.sketchStrokes, onUpdateSketchStrokes]);
```

- [ ] **Step 5: 容器 mousedown 分支**

把容器 `onMouseDown` 链（第 938-947 行）改为（在 removeBrushMode 分支后插入 brushMode 分支）：

```tsx
          onMouseDown={isRestoreActive ? handleRestoreContainerMouseDown : removeBrushMode ? (e) => {
            // Brush remove: start painting a free-form removal mask
            if (e.button !== 0) return;
            if (e.altKey || spaceHeldRef.current) return;
            setIsRemovePainting(true);
          } : brushMode && isOriginalMode ? (e) => {
            // Sketch brush: start a new guidance stroke (or erase)
            if (e.button !== 0) return;
            if (e.altKey || spaceHeldRef.current) return;
            const overlay = sketchOverlayRef.current;
            if (!overlay) return;
            const rect = overlay.getBoundingClientRect();
            const px = ((e.clientX - rect.left) / rect.width) * 100;
            const py = ((e.clientY - rect.top) / rect.height) * 100;
            setIsSketchPainting(true);
            liveStrokeRef.current = {
              id: crypto.randomUUID(),
              color: brushColor,
              size: brushSize,
              points: [{ x: px, y: py }],
            };
            if (!brushEraser) {
              const octx = overlay.getContext('2d');
              if (octx) {
                const sizePx = (brushSize / 100) * Math.max(overlay.width, overlay.height);
                octx.fillStyle = brushColor;
                octx.beginPath();
                octx.arc((px / 100) * overlay.width, (py / 100) * overlay.height, sizePx / 2, 0, Math.PI * 2);
                octx.fill();
              }
            }
          } : (e) => {
            // Block left-click background interaction when panning with space or alt
            if (e.button === 0 && (e.altKey || spaceHeldRef.current)) return;
            handleBackgroundMouseDown(e);
          }}
```

光标样式（第 953 行）改为：

```tsx
            cursor: isRestoreActive ? 'crosshair' : (removeBrushMode ? 'crosshair' : (brushMode && isOriginalMode ? 'crosshair' : (isOriginalMode && interaction.type === 'drawing' ? 'crosshair' : 'default'))),
```

- [ ] **Step 6: overlay canvas JSX**

在 removeBrushOverlay canvas 块（第 958-964 行）之后插入：

```tsx
          {/* Sketch brush overlay: AI-visible guidance strokes (hidden in result view) */}
          <canvas
            ref={sketchOverlayRef}
            className="absolute inset-0 pointer-events-none"
            style={{
              width: '100%',
              height: '100%',
              zIndex: 4,
              display: isOriginalMode && (brushMode || (image.sketchStrokes && image.sketchStrokes.length > 0)) ? 'block' : 'none',
            }}
          />
```

- [ ] **Step 7: 类型检查并提交**

Run: `npx tsc --noEmit`
Expected: 无新增错误

```bash
git add components/EditorCanvas.tsx && git commit -m "feat: EditorCanvas 画笔草图绘制（overlay 渲染/橡皮擦/result 视图隐藏）"
```

---

### Task 5: App 状态、工具栏按钮与画笔面板

**Files:**
- Modify: `App.tsx`（状态、handler、工具栏按钮、画笔面板、互斥、props 接线）

- [ ] **Step 1: import SketchStroke**

查看 `App.tsx` 顶部从 `./types` 的 import，把 `SketchStroke` 加进同一 import。

- [ ] **Step 2: 状态**

在第 312 行（`const [removeBrushSize, setRemoveBrushSize] = useState(8);`）之后追加：

```ts
const [brushMode, setBrushMode] = useState(false);
const [brushColor, setBrushColor] = useState('#ff3b30');
const [brushSize, setBrushSize] = useState(2);
const [brushEraser, setBrushEraser] = useState(false);
const [confirmClearStrokes, setConfirmClearStrokes] = useState(false);
```

- [ ] **Step 3: handlers**

在 `handleUpdateRestoreMask`（第 628-633 行）之后追加：

```ts
  const handleUpdateSketchStrokes = useCallback((imageId: string, strokes: SketchStroke[]) => {
      updateImage(imageId, img => ({ ...img, sketchStrokes: strokes.length > 0 ? strokes : undefined }));
  }, [updateImage]);

  const handleClearSketchStrokes = useCallback(() => {
      if (!selectedImage) return;
      updateImage(selectedImage.id, img => ({ ...img, sketchStrokes: undefined }));
      setConfirmClearStrokes(false);
  }, [selectedImage, updateImage]);
```

- [ ] **Step 4: 现有按钮互斥**

"🔧 框选还原"按钮 onClick（第 961 行）改为：

```ts
onClick={() => { setRestoreMode(!restoreMode); setRestoreBrushMode(false); setRestoreSelectedRegionId(null); setBrushMode(false); }}
```

"涂抹移除"按钮 onClick（第 970 行）改为：

```ts
onClick={() => { setRemoveBrushMode(!removeBrushMode); setRestoreMode(false); setRestoreBrushMode(false); setBrushMode(false); }}
```

- [ ] **Step 5: 画笔入口按钮**

在涂抹移除按钮块（第 976 行 `)}` 之后）插入：

```tsx
                  {/* Sketch brush mode (AI-visible guidance strokes) */}
                  {viewMode === 'original' && (
                     <button
                         onClick={() => { setBrushMode(!brushMode); setRestoreMode(false); setRestoreBrushMode(false); setRemoveBrushMode(false); setConfirmClearStrokes(false); }}
                         className={`px-3 py-1.5 rounded-full text-xs font-bold backdrop-blur-md border shadow-sm transition-all ${brushMode ? 'bg-sky-500 text-white border-sky-500' : 'bg-skin-surface/80 text-skin-text border-skin-border hover:bg-skin-surface'}`}
                         title={t(config.language, 'brushModeDesc')}
                     >
                         {brushMode ? '退出画笔' : t(config.language, 'brushMode')}
                     </button>
                  )}
```

- [ ] **Step 6: 画笔工具面板**

在 restore 工具栏块（第 1012 行 `)}` 之后）插入：

```tsx
                  {/* Sketch brush tool panel */}
                  {brushMode && (
                    <div className="absolute top-16 left-4 z-10 flex flex-col gap-2 p-3 rounded-xl bg-skin-surface/90 backdrop-blur-md border border-skin-border shadow-xl">
                      <div className="flex gap-1.5">
                        {['#ff3b30', '#3b82f6', '#22c55e', '#eab308', '#ffffff', '#111111'].map(c => (
                          <button key={c} onClick={() => setBrushColor(c)}
                            className={`w-5 h-5 rounded-full border-2 transition-transform ${brushColor === c ? 'border-sky-500 scale-110' : 'border-skin-border hover:scale-105'}`}
                            style={{ backgroundColor: c }} />
                        ))}
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-[10px] font-bold text-skin-muted">{t(config.language, 'brushSize')}</span>
                        <input type="range" min="1" max="10" step="0.5" value={brushSize}
                          onChange={(e) => setBrushSize(Number(e.target.value))}
                          className="w-24 h-1 accent-sky-500" />
                        <span className="text-[10px] text-skin-muted w-4">{brushSize}</span>
                      </div>
                      <div className="flex gap-1.5">
                        <button onClick={() => setBrushEraser(!brushEraser)}
                          className={`px-2 py-1 text-[10px] font-bold rounded border ${brushEraser ? 'bg-rose-500 text-white border-rose-500' : 'bg-skin-surface text-skin-text border-skin-border hover:bg-skin-surface'}`}>
                          {t(config.language, 'brushEraser')}
                        </button>
                        <button
                          onClick={() => confirmClearStrokes ? handleClearSketchStrokes() : setConfirmClearStrokes(true)}
                          className={`px-2 py-1 text-[10px] font-bold rounded border ${confirmClearStrokes ? 'bg-rose-600 text-white border-rose-600' : 'bg-rose-500/80 text-white border-rose-500 hover:bg-rose-500'}`}>
                          {confirmClearStrokes ? t(config.language, 'brushClearConfirm') : t(config.language, 'brushClear')}
                        </button>
                      </div>
                    </div>
                  )}
```

- [ ] **Step 7: EditorCanvas props 接线**

在 EditorCanvas 组件调用处（`onUpdateRestoreMask={...}` 第 1078 行附近）追加：

```tsx
                    brushMode={brushMode}
                    brushColor={brushColor}
                    brushSize={brushSize}
                    brushEraser={brushEraser}
                    onUpdateSketchStrokes={brushMode ? handleUpdateSketchStrokes : undefined}
                    onClearSketchStrokes={brushMode ? handleClearSketchStrokes : undefined}
```

- [ ] **Step 8: 类型检查并提交**

Run: `npx tsc --noEmit`
Expected: 无新增错误

```bash
git add App.tsx && git commit -m "feat: 画笔工具栏按钮与工具面板（颜色/粗细/橡皮擦/清空）"
```

---

### Task 6: 选区确认清空线条（useImageManager.ts）

**Files:**
- Modify: `hooks/useImageManager.ts`（`handleApplyRegionAsOriginal` 内过滤选区内笔画）

- [ ] **Step 1: 过滤选区内笔画**

`handleApplyRegionAsOriginal`（第 314 行起）的 `updateImage` 回调中，在 `const newRegions = ...` 之前插入：

```ts
      const region = img.regions.find((r) => r.id === regionId);
      // 确认选区绘图更改后，清空完全落在该选区矩形内的草图线条（百分比坐标直接判定）
      const newStrokes = img.sketchStrokes?.filter((s) =>
        !s.points.some((p) =>
          region &&
          p.x >= region.x && p.x <= region.x + region.width &&
          p.y >= region.y && p.y <= region.y + region.height
        )
      );
```

- [ ] **Step 2: 返回状态带上新线条**

`handleApplyRegionAsOriginal` 的 return 对象（第 361-370 行）中 `historyIndex: newIndex,` 之后追加：

```ts
        sketchStrokes: newStrokes && newStrokes.length > 0 ? newStrokes : undefined,
```

- [ ] **Step 3: 类型检查并提交**

Run: `npx tsc --noEmit`
Expected: 无新增错误

```bash
git add hooks/useImageManager.ts && git commit -m "feat: 选区确认应用后清空该选区内画笔线条"
```

---

### Task 7: i18n 文案

**Files:**
- Modify: `services/translations.ts`（zh + en 两个字典）

- [ ] **Step 1: 中文文案**

在中文字典 `clearRemoveBrush`（第 64 行）之后追加：

```ts
    brushMode: "🖌 画笔",
    brushModeDesc: "在图上画线作为 AI 草图指引，生成时自动合成进 AI 输入",
    brushEraser: "橡皮擦",
    brushClear: "清空",
    brushClearConfirm: "确认清空?",
    brushSize: "粗细",
```

- [ ] **Step 2: 英文文案**

在英文字典 `clearRemoveBrush`（第 336 行附近，先找到英文字典中对应行）之后追加：

```ts
    brushMode: "🖌 Brush",
    brushModeDesc: "Draw guidance strokes on the image; composited into AI input on generate",
    brushEraser: "Eraser",
    brushClear: "Clear",
    brushClearConfirm: "Confirm clear?",
    brushSize: "Size",
```

- [ ] **Step 3: 类型检查并提交**

Run: `npx tsc --noEmit`
Expected: 无新增错误

```bash
git add services/translations.ts && git commit -m "feat: 画笔工具 i18n 文案（中英）"
```

---

### Task 8: 整体验证

**Files:**
- 无代码改动，仅验证

- [ ] **Step 1: 类型检查**

Run: `npx tsc --noEmit`
Expected: 无错误（仅既有输出）

- [ ] **Step 2: 构建**

Run: `npm run build`
Expected: 构建成功（仅既有 chunk-size 警告）

- [ ] **Step 3: 浏览器冒烟清单**

按 AGENTS.md 的冒烟技巧（回填区粘贴图片造图、合成鼠标事件画线）逐项验证：

1. 打开工作视图 → 点"🖌 画笔"按钮 → 面板出现（6 色块、粗细滑块、橡皮擦、清空）
2. 选红色、粗细 3 → 在图上拖拽 → 红色线条实时出现，mouseup 后保留
3. 切换颜色画第二条线 → 两条线颜色不同
4. 点"橡皮擦" → 在线条上拖拽 → 整条线被删除
5. 点"清空" → 按钮变"确认清空?" → 再点 → 全部线条消失
6. 切到 result 视图 → 线条隐藏；切回 original → 线条恢复
7. 造一个 completed 选区 → 生成时控制台/网络确认发给 AI 的切片含线条（可临时在 `cropRegion` 加 console.log 或检查 base64 尺寸特征；验证后移除）
8. 在选区内画线 → ✅ 提交调整为新原图 → 该选区内线条消失、选区外线条保留
9. 下载/ZIP 输出图不含任何线条（视觉检查）
10. 画笔模式激活时画矩形 → 不创建新选区；点"框选还原"/"涂抹移除" → 画笔模式退出

- [ ] **Step 4: 提交验证结论**

如果发现 bug，记录并修复后重新验证；全部通过后在 `AGENTS.md` 追加本节功能要点（按仓库惯例沉淀工作记忆）。

```bash
git add AGENTS.md && git commit -m "docs: AGENTS.md 沉淀画笔草图指引要点"
```

---

## 自审记录

- **Spec 覆盖**：数据模型（Task 1）✓ 绘制/橡皮擦/清空（Task 4+5）✓ AI 合成（Task 2+3）✓ 生命周期隐藏/清空/不进输出（Task 4 Step 6 + Task 6 + 架构天然保证）✓ 工具栏与面板（Task 5）✓ i18n（Task 7）✓ 验证（Task 8）✓
- **占位符扫描**：无 TBD/TODO；所有代码块完整。
- **类型一致性**：`SketchStroke`、`compositeSketchStrokes(ctx, strokes, canvasW, canvasH, sourceRect?)`、`cropRegion(img, region, strokes?)`、`handleUpdateSketchStrokes(imageId, strokes)` 在全部任务中签名一致。
- **已知取舍**：橡皮擦为整条删除（spec 已确认）；擦除半径用百分比近似（与粗细语义一致）。

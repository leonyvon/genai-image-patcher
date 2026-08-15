# 选区编辑·水平翻转 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为选区增加"水平翻转内容"编辑能力：有补丁→翻转补丁；无补丁→裁原图翻转成手动补丁；入口为画布选中选区的现有操作工具条。

**Architecture:** 复用现有"手动补丁"数据模型（`region.processedImageUrl`）。新增 `flipImageHorizontal` 工具函数（canvas 水平镜像），App 层 `handleFlipRegion` 处理源选择与状态更新，EditorCanvas 现有 Action Buttons 工具条新增 `⇄` 按钮。翻转内容经现有 completed overlay 渲染/拼合/下载自动生效。

**Tech Stack:** React/TS + Canvas 2D。设计文档：`docs/superpowers/specs/2026-08-15-region-flip-design.md`。

**验证方式说明（与仓库既有实践一致）：** 无测试框架，前端以 `npx tsc --noEmit` + `npm run build` + 手动清单验收。

---

### Task 1: imageUtils.ts 新增 flipImageHorizontal

**Files:**
- Modify: `services/imageUtils.ts`

- [ ] **Step 1: 新增水平翻转函数**

在 `services/imageUtils.ts` 中 `urlToBase64` 定义之后（约第 71 行后）插入：

```ts
/**
 * Horizontally mirror an image, returning a new Object URL.
 * The caller owns the returned URL and must release it when done.
 */
export const flipImageHorizontal = async (sourceUrl: string): Promise<string> => {
  const img = await loadImage(sourceUrl);
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not get canvas context');
  ctx.translate(canvas.width, 0);
  ctx.scale(-1, 1);
  ctx.drawImage(img, 0, 0);
  return canvasToObjectURL(canvas);
};
```

注意：`loadImage` 与内部 `canvasToObjectURL`（第 30 行，返回 `Promise<string>` Object URL）均在本文件可用。

- [ ] **Step 2: 类型检查**

Run: `npx tsc --noEmit` → Expected: exit 0

- [ ] **Step 3: 提交**

```bash
git add services/imageUtils.ts
git commit -m "feat: flipImageHorizontal 工具函数"
```

---

### Task 2: App.tsx handleFlipRegion + 接线

**Files:**
- Modify: `App.tsx`（imageUtils 导入、处理器、EditorCanvas 接线）

- [ ] **Step 1: 导入**

把 App.tsx 第 7 行的 imageUtils 导入末尾追加 `flipImageHorizontal`（`loadImage`/`cropRegion`/`releaseObjectURL` 已在导入中）：

```ts
import { loadImage, cropRegion, stitchImage, createInvertedMultiMaskedFullImage, extractCropFromFullImage, stitchImageInverted, releaseObjectURL, compressImageToTargetSize, urlToBase64, isEffectiveReference, flipImageHorizontal } from './services/imageUtils';
```

- [ ] **Step 2: 新增 handleFlipRegion**

在 `handleApplyAsOriginalWrapper`（约第 605-619 行）之后插入：

```ts
  // 选区编辑：水平翻转选区内容。有补丁→翻转补丁；无补丁→裁原图翻转成手动补丁。
  const handleFlipRegion = useCallback(async (imageId: string, regionId: string) => {
    const img = images.find((i) => i.id === imageId);
    if (!img) return;
    const region = img.regions.find((r) => r.id === regionId);
    if (!region) return;
    let cropUrl: string | null = null;
    try {
      let sourceUrl: string;
      if (region.processedImageUrl) {
        sourceUrl = region.processedImageUrl;
      } else {
        const imgEl = await loadImage(img.originalUrl || img.previewUrl);
        cropUrl = await cropRegion(imgEl, region);
        sourceUrl = cropUrl;
      }
      const flippedUrl = await flipImageHorizontal(sourceUrl);
      if (cropUrl) releaseObjectURL(cropUrl);
      if (region.processedImageUrl && region.processedImageUrl !== flippedUrl) {
        releaseObjectURL(region.processedImageUrl);
      }
      updateImage(imageId, (prev) => ({
        ...prev,
        regions: prev.regions.map((r) => r.id === regionId ? {
          ...r,
          processedImageUrl: flippedUrl,
          status: 'completed' as const,
          anchorX: r.x, anchorY: r.y, anchorWidth: r.width, anchorHeight: r.height,
          restoreBoxes: undefined,
          restoreMaskUrl: undefined,
        } : r),
      }));
    } catch (e) {
      if (cropUrl) releaseObjectURL(cropUrl);
      console.error('Failed to flip region', e);
      setErrorMsg('Failed to flip region.');
    }
  }, [images, updateImage, setErrorMsg]);
```

- [ ] **Step 3: 接线到 EditorCanvas**

定位 App.tsx 渲染 `<EditorCanvas` 的位置（约第 700 行区域，`image={...}` 等 props 处）。在该组件的 props 中（`onOcrRegion`/`onOpenEditor` 等附近）增加：

```tsx
        onFlipRegion={(regionId) => handleFlipRegion(<该处 image 的 id>, regionId)}
```

即：`image.id`（该画布当前渲染的图片 id，用与 `image={...}` 相同的变量）。若该组件已有 `onAdjustRegionSize` 等回调，紧随其后插入即可。

- [ ] **Step 4: 类型检查与构建**

Run: `npx tsc --noEmit` → Expected: exit 0
Run: `npm run build` → Expected: built，仅既有 chunk-size 警告

- [ ] **Step 5: 提交**

```bash
git add App.tsx
git commit -m "feat: 选区水平翻转处理器并接线"
```

---

### Task 3: EditorCanvas 工具条新增翻转按钮

**Files:**
- Modify: `components/EditorCanvas.tsx`

- [ ] **Step 1: props 增加 onFlipRegion**

在 `EditorCanvasProps` 接口（第 19-40 行，`onOcrRegion?` 附近）增加：

```ts
  onFlipRegion?: (regionId: string) => void;
```

在组件函数参数解构中（`onOcrRegion` 等解构处）增加：

```ts
  onFlipRegion,
```

- [ ] **Step 2: Action Buttons 工具条新增翻转按钮**

定位 "ORIGINAL MODE: Action Buttons" 区块（约第 971-1038 行，含 OCR/Edit/Reset/ContextOnly 按钮的 `flex gap-1` 容器）。在 Context Only 按钮（`toggleContextOnly` 那个 `<button>`，约 1027-1038 行）之后插入翻转按钮：

```tsx
                      {!disabled && onFlipRegion && region.status !== 'processing' && (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              onFlipRegion(region.id);
                            }}
                             className="w-6 h-6 bg-skin-surface text-skin-text border border-skin-border rounded-full flex items-center justify-center shadow-md hover:shadow-lg hover:bg-skin-fill transition-all"
                             title="Flip Horizontal"
                          >
                            <span className="text-[11px] font-bold leading-none">⇄</span>
                          </button>
                      )}
```

- [ ] **Step 3: 类型检查与构建**

Run: `npx tsc --noEmit` → Expected: exit 0
Run: `npm run build` → Expected: built，仅既有 chunk-size 警告

- [ ] **Step 4: 提交**

```bash
git add components/EditorCanvas.tsx
git commit -m "feat: 画布选区工具条新增水平翻转按钮"
```

---

## 手动验收清单

1. `npm run dev` 启动；上传图，框选一个区域 → **先生成**（区域有补丁）
2. 选中该区域 → 工具条出现 `⇄` 按钮 → 点击 → 选区内容水平镜像、画布即时更新
3. 下载最终结果 / 应用为原图 → 确认翻转内容进入结果
4. 新建一个**未处理**选区 → 点 `⇄` → 从原图裁出该区域并翻转成手动补丁显示
5. 对**有 restoreBoxes** 的选区翻转 → 还原掩码被清除（不再显示还原效果）
6. 翻转后重新生成该区域 → AI 结果覆盖翻转补丁，行为正常
7. result 模式 / restore 模式下不显示 `⇄` 按钮（仅 original 编辑模式）

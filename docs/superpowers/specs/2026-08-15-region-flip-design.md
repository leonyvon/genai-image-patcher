# 选区编辑 · 水平翻转设计

日期：2026-08-15
状态：待实现

## 背景与目标

为选区（region）增加简单的编辑能力，首个功能是**水平翻转选区内容**：把选区内显示的画面内容左右镜像，并使其进入最终拼合结果（可下载/应用为原图）。后续可在此基础上扩展其他变换（旋转等）。

## 需求决策记录（已与用户确认）

| 决策点 | 结论 |
|---|---|
| 翻转对象 | **选区内容**（画面内容左右镜像），非选区框位置 |
| 适用范围 | **两者都支持**：有 AI 补丁 → 翻转补丁；无补丁 → 从原图裁出该区域 → 翻转 → 作为"手动补丁" |
| UI 入口 | **画布选区工具条**：选中选区（original 编辑模式）时，选区框上方浮动 `⇄ 水平翻转` 按钮 |
| 数据落点 | **方案 A**：翻转结果作为"手动补丁"替换 `region.processedImageUrl` |

## 数据流与核心逻辑

### 新增工具函数（services/imageUtils.ts）

```ts
/** 水平镜像一张图，返回新的 Object URL（canvas 变换） */
export const flipImageHorizontal = async (sourceUrl: string): Promise<string>
```

实现：`loadImage` → canvas（原图尺寸）→ `ctx.translate(w, 0); ctx.scale(-1, 1); ctx.drawImage` → 复用内部 `canvasToObjectURL` 返回 Object URL。

### App 处理器 handleFlipRegion(imageId, regionId)（App.tsx）

```
取 image 与 region（不存在 → setErrorMsg 返回）
源选择：
  有补丁  → loadImage(region.processedImageUrl) → flipImageHorizontal → 新 URL
  无补丁  → loadImage(image.originalUrl || image.previewUrl)
            → cropRegion(imgEl, region) 裁出区域 → flipImageHorizontal → 新 URL（用完释放 cropUrl）
updateImage(imageId, img => ({
  ...img,
  regions: img.regions.map(r => r.id === regionId ? {
    ...r,
    processedImageUrl: 翻转结果URL,
    status: 'completed',
    anchorX: r.x, anchorY: r.y, anchorWidth: r.width, anchorHeight: r.height, // 固定锚点保证拼合对齐
    restoreBoxes: undefined,
    restoreMaskUrl: undefined, // 翻转后还原掩码失效，清除
  } : r),
}))
释放旧 processedImageUrl（若有）
```

**效果**：翻转内容经现有 completed overlay 渲染立即显示；拼合（stitch）、下载、应用为原图全部复用现有逻辑自动生效。

## UI（components/EditorCanvas.tsx）

- 新增 prop `onFlipRegion: (imageId: string, regionId: string) => void`
- 选区框渲染处，`isSelected && isOriginalMode` 时，在选区框上方浮动工具条：`⇄ 水平翻转` 小按钮（`position: absolute; top: -28px`，点击 `stopPropagation` 避免触发框选/拖拽交互）
- 工具条仅在选区选中时显示；翻转后画布即时更新

## 边界情况

- **无补丁选区翻转** = 生成"手动补丁"（与现有手动模式语义一致）；之后 AI 生成会覆盖该补丁
- **restoreBoxes / restoreMaskUrl** 翻转后与原内容不对齐 → 清除
- **URL 生命周期**：翻转结果为新 Object URL；旧的 `processedImageUrl`（及临时 cropUrl）需释放防泄漏
- **错误处理**：图片加载/翻转失败 → `setErrorMsg`，不改动 region
- **视图模式**：工具条仅在 original 编辑模式显示（result 模式不显示编辑入口）

## 不做的事（YAGNI）

- 翻转撤销/重做（与现有手动补丁一致，重新生成可还原）
- 其他变换（旋转/缩放等，后续按需扩展）
- 变换状态持久化（翻转即补丁结果，无独立"变换栈"）

## 验证方式

- `npx tsc --noEmit` 与 `npm run build` 通过
- 手动验证：
  1. 上传图，框选区域，**先生成**（有补丁）→ 点"水平翻转"→ 选区内容镜像、画布即时更新、拼合结果正确
  2. 新建**未处理**选区 → 点"水平翻转"→ 从原图裁出翻转作为手动补丁显示
  3. 翻转后下载最终结果 / 应用为原图，确认翻转内容进入结果
  4. 有 restoreBoxes 的选区翻转后还原掩码被清除（不再生效）

# 选区「同尺寸完全重制」设计文档

- 日期：2026-08-23
- 状态：已批准（待实现计划）

## 1. 背景与目标

当前框选一个区域后，标准单选区生成路径会把该区域切片作为 `images[0]`（参考图）发给 grsai(gpt-image-2)，模型据此"保真编辑"。

新增功能「同尺寸完全重制」：开启后，该选区生成时**不发送选区切片**，仅把选区的精确像素尺寸作为 `aspectRatio` 参数与提示词后缀发送给模型，由模型从提示词纯文生图，输出尺寸与选区完全一致。

设计决定（已与用户确认）：
- **仅 grsai 生效**：只有 `provider === 'grsai'` 时显示/启用开关；OpenAI/Gemini 是编辑模型必须有输入图，开关对其隐藏。
- **保留全局参考图**：full redraw 时不发选区切片，但仍发送用户在设置里标记的全局参考图（`config.grsaiReferenceImages`，如有）；`aspectRatio` 设为选区精确像素 `WxH`；提示词追加尺寸说明。

## 2. 适用范围与不适用范围

- 适用：标准单选区生成路径（`useImageProcessor.ts` 的 `processRegionTask`，即 `!config.useFullImageMasking` 时）。
- 不适用：`useFullImageMasking` 路径（发整图遮罩，full redraw 无意义）——开关在该模式下隐藏。
- 不适用：非 grsai provider——开关隐藏。
- 与翻译模式共存：翻译仍按遮罩上下文跑（不变），redraw 走 full redraw 分支，尺寸后缀照常追加。

## 3. 数据模型

`types.ts` 的 `Region` 新增可选字段：

```ts
fullRedraw?: boolean; // 同尺寸完全重制：生成时不发选区图，仅按选区尺寸文生图（仅 grsai 生效）
```

`App.tsx` 的 `bridgeSnapshot` region 映射新增：

```ts
fullRedraw: r.fullRedraw ?? false,
```

## 4. UI 开关（选区工具栏）

位置：`components/EditorCanvas.tsx` 选中选区的 action 按钮区（现有 OCR / 编辑 / 前后切换按钮旁）。

- 显示条件：`config.provider === 'grsai'` 且 `!config.useFullImageMasking` 且选区被选中（现有 `isSelected && !isManipulating && !restoreMode` 块内）。
- 按钮为切换式：文案「同尺寸重制」，开启时高亮（如紫色背景）。
- 开启时选区边框改为紫色（区别于普通青色 / 还原琥珀色），一眼可辨。
- 新增 prop：`onToggleFullRedraw?: (regionId: string) => void`，在 `EditorCanvasProps` 声明。
- App 侧新增稳定适配器 `editorOnToggleFullRedraw`（绑定 `selectedImage.id`）→ `handleSetRegionFullRedraw(imageId, regionId, enabled)`：
  ```ts
  const handleSetRegionFullRedraw = (imageId: string, regionId: string, enabled: boolean) =>
    updateImage(imageId, img => ({
      ...img,
      regions: img.regions.map(r => r.id === regionId ? { ...r, fullRedraw: enabled } : r),
    }));
  ```
- 翻译文案：新增 key `fullRedraw`（按钮文案/tooltip），在 `services/translations.ts` 补中英文。

## 5. 生成管线（useImageProcessor.ts）

在 `processRegionTask` 开头判定：

```ts
const isFullRedraw = !!region.fullRedraw && config.provider === 'grsai';
```

### 5.1 full redraw 分支（isFullRedraw === true）

跳过 `cropRegion` / `padImageToSquare` / `compressImageToTargetSize` 整套裁剪流程。改为：

```ts
const pxW = Math.max(1, Math.round((region.width / 100) * imgElement.naturalWidth));
const pxH = Math.max(1, Math.round((region.height / 100) * imgElement.naturalHeight));
let effectivePrompt = basePrompt;
if (userCustomPrompt) effectivePrompt += ` ${userCustomPrompt}`;
if (translationText) effectivePrompt += `\n\n${TRANSLATION_CACHE_MARKER}\n${translationText}`;
effectivePrompt += ` 请生成一张宽 ${pxW} 像素、高 ${pxH} 像素的图像，与选区尺寸完全一致（同尺寸完全重制）。`;
const apiResultBase64 = await generateRegionEdit(
  '', effectivePrompt, aiConfig, signal,
  { fullRedraw: true, aspectRatioOverride: `${pxW}x${pxH}` }
);
```

- square fill / payload 压缩全部跳过（输出已是精确尺寸）。
- 后处理：不调用 `extractCropFromFullImage`；`apiResultUrl` 直接作为 `processedImageUrl`（其尺寸即 `pxW×pxH`，与选区像素尺寸一致，拼合 fitScale≈1 无黑边）。`anchorX/Y/W/H` 取 `region.x/y/width/height`。

### 5.2 普通分支（isFullRedraw === false）

保持现有逻辑不变（裁剪 → pad → compress → `generateRegionEdit(redrawBase64, ...)` → `extractCropFromFullImage`）。

## 6. grsai 服务（services/aiService.ts）

`generateRegionEdit` 签名增加 `options?` 参数并透传：

```ts
export const generateRegionEdit = async (
  imageBase64: string, prompt: string, config: AppConfig,
  signal?: AbortSignal, options?: { fullRedraw?: boolean; aspectRatioOverride?: string }
): Promise<string> => { ... worker 透传 options 给 generateGrsaiImage ... }
```

`generateGrsaiImage` 增加 `options?` 参数：

```ts
const isFullRedraw = !!options?.fullRedraw;
const aspectRatio = isFullRedraw && options?.aspectRatioOverride
  ? options.aspectRatioOverride
  : (derive from slice as today);
const images = isFullRedraw
  ? [...(referenceImages ?? [])]   // 不发选区切片，保留全局参考图
  : [dataUrl, ...(referenceImages ?? [])];
```

- 调试日志 `[grsai-debug] request` 同步反映 full redraw（`imageDataLength: 0`、标注 `fullRedraw: true`）。
- **风险与兜底**：当 full redraw 且无任何全局参考图时 `images = []`。需实测 grsai 是否接受空 `images[]`；若拒绝，则回退发送 1×1 透明占位 PNG（仅兜底，不进入正常路径）。该探测列为验证项。

## 7. MCP 接口

### 7.1 mcp/server.py

新增工具：

```py
@mcp.tool()
def set_region_full_redraw(image_id: str, region_id: str, enabled: bool) -> str:
    """设置某选区的"同尺寸完全重制"开关。enabled=true 时该选区生成不发送选区图，仅按选区尺寸文生图（仅 grsai 生效）。"""
    if not _ensure_bridge():
        return _err("桥接服务不可达")
    res = _cmd("set_region_full_redraw", {"image_id": image_id, "region_id": region_id, "enabled": bool(enabled)})
    return _ok(res) if res.get("ok") else _err(str(res.get("error")))
```

### 7.2 App.tsx bridgeHandlers

新增处理器：

```ts
set_region_full_redraw: async ({ image_id, region_id, enabled }) => {
  const img = images.find(i => i.id === image_id);
  if (!img) return { ok: false, error: `image not found: ${image_id}` };
  if (!img.regions.some(r => r.id === region_id)) return { ok: false, error: `region not found: ${region_id}` };
  handleSetRegionFullRedraw(image_id, region_id, !!enabled);
  return { ok: true };
},
```

### 7.3 快照

`get_status` 经 `bridgeSnapshot` 已含 `fullRedraw` 字段，Agent 可读后决定是否开启，再 `generate(scope)`。无需新增 MCP 读取工具。

## 8. 边界与守卫

- `useFullImageMasking` 开启：开关隐藏。
- 非 grsai provider：开关隐藏。
- 翻译模式共存：翻译按遮罩上下文跑（不变），redraw 走 full redraw 分支，尺寸后缀照常追加。
- 撤销/重做：`fullRedraw` 是 region 字段，随 `ImageHistoryState.regions` 自然纳入历史（无需特殊处理）。
- 选区「应用为原图」(`handleApplyRegionAsOriginal`)：仅烙该选区，full redraw 状态随 region 保留/重置，按现有逻辑即可。

## 9. 验证

1. `npx tsc --noEmit` + `npm run build` 通过（仅既有 chunk-size 警告）。
2. 浏览器冒烟：框选区 → 开「同尺寸重制」→ 生成，确认：
   - 发出的请求 `images` 不含选区切片、含全局参考图（如有）；
   - `aspectRatio` = 选区精确像素 `WxH`；
   - 提示词含尺寸后缀；
   - 结果拼合无黑边（fitScale≈1）。
3. MCP：经 `set_region_full_redraw` 开启后 `generate`，确认 `get_status` 快照 `fullRedraw=true` 且生成行为一致。
4. 探测 grsai 空 `images[]`（无全局参考图 + full redraw）是否被接受；若拒绝，落地 1×1 透明占位兜底。
5. 回归：普通重绘（开关关闭）行为不变；`useFullImageMasking` 路径不受影响。

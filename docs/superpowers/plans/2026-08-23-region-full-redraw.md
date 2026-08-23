# 选区「同尺寸完全重制」实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让用户在 grsai 下对单个选区开启「同尺寸完全重制」——生成时不发送选区切片，仅按选区精确像素尺寸（`aspectRatio` + 提示词后缀）文生图，并暴露 MCP 接口 `set_region_full_redraw`。

**Architecture:** 在 `Region` 上新增 `fullRedraw` 布尔字段；UI 在选区工具栏加切换按钮（仅 grsai 且非全图遮罩时显示）；`useImageProcessor` 标准单选区路径在 `fullRedraw` 时跳过裁剪、改发空图 + 尺寸后缀；`aiService.generateGrsaiImage` 据此不发切片、保留全局参考图、用精确像素 `aspectRatio`；MCP 新增 `set_region_full_redraw` 工具并经 `bridgeSnapshot` 暴露状态。

**Tech Stack:** React 19 + TypeScript + Vite；grsai(gpt-image-2) HTTP API；FastMCP(Python) + Node 桥接。仓库无测试框架，验证以 `npx tsc --noEmit` + `npm run build` + 浏览器/MCP 冒烟为准（见 AGENTS.md）。

---

## 文件结构

- 修改 `types.ts`：Region 增加 `fullRedraw?: boolean`。
- 修改 `services/translations.ts`：新增 `fullRedraw` / `fullRedrawShort` 中英文案。
- 修改 `components/EditorCanvas.tsx`：新增 props `fullRedrawAvailable` / `onToggleFullRedraw`；选区边框 fullRedraw 紫色样式；工具栏加切换按钮。
- 修改 `App.tsx`：新增 `handleSetRegionFullRedraw` + 稳定适配器；向 EditorCanvas 传 props；`bridgeHandlers` 加 `set_region_full_redraw`；`bridgeSnapshot` region 加 `fullRedraw`。
- 修改 `hooks/useImageProcessor.ts`：`processRegionTask` 增加 full redraw 分支（跳过裁剪、追加尺寸后缀、直接以结果作补丁）。
- 修改 `services/aiService.ts`：`generateRegionEdit` 增加 `options?`；`generateGrsaiImage` 支持 `fullRedraw` / `aspectRatioOverride`。
- 修改 `mcp/server.py`：新增 `set_region_full_redraw` 工具。

---

### Task 1: Region 数据模型

**Files:**
- Modify: `types.ts:19-41`（`Region` 接口）

- [ ] **Step 1: 在 `Region` 接口增加字段**

在 `errorMessage?: string;` 之后插入：

```ts
  /** 同尺寸完全重制：生成时不发选区图，仅按选区尺寸文生图（仅 grsai 生效）。 */
  fullRedraw?: boolean;
```

- [ ] **Step 2: 类型检查**

Run: `npx tsc --noEmit`
Expected: 通过（仅既有无关告警，无新增错误）

- [ ] **Step 3: 提交**

```bash
git add types.ts
git commit -m "feat: Region 增加 fullRedraw 字段（同尺寸完全重制）"
```

---

### Task 2: 翻译文案

**Files:**
- Modify: `services/translations.ts`（`zh` 与 `en` 两个对象）

- [ ] **Step 1: 在 `zh` 对象添加 key**

在 `iopaintUrl: "IOPaint 服务地址",` 之后插入：

```ts
    fullRedraw: "同尺寸完全重制：不发送选区图，仅按选区尺寸文生图（仅 grsai）",
    fullRedrawShort: "同尺寸",
```

- [ ] **Step 2: 在 `en` 对象添加对应 key**

在 `en` 对象中找到与 `iopaintUrl` 对应的行之后插入（保持 key 一致）：

```ts
    fullRedraw: "Same-size full redraw: send no region image, generate from prompt at the selection's exact size (grsai only)",
    fullRedrawShort: "Same-size",
```

- [ ] **Step 3: 类型检查**

Run: `npx tsc --noEmit`
Expected: 通过

- [ ] **Step 4: 提交**

```bash
git add services/translations.ts
git commit -m "feat: 新增 fullRedraw 中英文案"
```

---

### Task 3: EditorCanvas 开关 UI

**Files:**
- Modify: `components/EditorCanvas.tsx`
  - `EditorCanvasProps`（约 20-61 行）增加 props
  - 选区边框样式（约 1224-1259 行）增加 fullRedraw 分支
  - 工具栏按钮区（约 1515 行后）增加切换按钮

- [ ] **Step 1: 增加 props 声明**

在 `EditorCanvasProps` 中 `enablePanelSnap?: boolean;` 之后插入：

```ts
  /** 是否允许显示「同尺寸完全重制」开关（provider==='grsai' 且非全图遮罩时为 true）。 */
  fullRedrawAvailable?: boolean;
  /** 切换某选区的 fullRedraw 状态。 */
  onToggleFullRedraw?: (regionId: string) => void;
```

并在组件解构参数（约 80 行起的 `{ ... }` 内）加入：

```ts
    fullRedrawAvailable = false,
    onToggleFullRedraw,
```

- [ ] **Step 2: 选区边框 fullRedraw 紫色样式**

在现有 `if (region.contextOnly) { ... }` 样式分支（约 1255-1259 行）之后插入：

```ts
            if (region.fullRedraw && isOriginalMode) {
                styleClasses = isSelected
                  ? 'border-2 border-purple-500 bg-purple-500/20 shadow-[0_0_0_2px_rgba(255,255,255,0.8),0_0_0_4px_#a855f7] z-30 cursor-move'
                  : 'border-2 border-purple-500 bg-purple-500/10 z-10 cursor-pointer';
            }
```

- [ ] **Step 3: 工具栏增加切换按钮**

在 contextOnly 按钮块结束 `)}`（约 1515 行）之后、`Flip Horizontal` 按钮块之前插入：

```ts
                       {!disabled && fullRedrawAvailable && region.status !== 'processing' && (
                           <button
                             onClick={(e) => {
                               e.stopPropagation();
                               onToggleFullRedraw?.(region.id);
                             }}
                              className={`w-6 h-6 border rounded-full flex items-center justify-center shadow-md hover:shadow-lg transition-all text-[8px] font-bold leading-none ${region.fullRedraw ? 'bg-purple-500 text-white border-purple-500' : 'bg-skin-surface text-skin-muted border-skin-border'}`}
                              title={t(language, 'fullRedraw')}
                           >
                             {t(language, 'fullRedrawShort')}
                           </button>
                       )}
```

- [ ] **Step 4: 类型检查**

Run: `npx tsc --noEmit`
Expected: 通过

- [ ] **Step 5: 提交**

```bash
git add components/EditorCanvas.tsx
git commit -m "feat: 选区工具栏增加「同尺寸完全重制」开关与紫色边框"
```

---

### Task 4: App 状态与桥接接线

**Files:**
- Modify: `App.tsx`
  - `bridgeSnapshot` region 映射（约 169-176 行）加 `fullRedraw`
  - 新增 `handleSetRegionFullRedraw`（放在 `handleUpdateRegionPrompt` 附近）
  - 稳定适配器 `editorOnToggleFullRedraw`（约 900-911 行区域）
  - `<EditorCanvas>` 传参（约 1118-1157 行）
  - `bridgeHandlers` 加 `set_region_full_redraw`（约 187-296 行）

- [ ] **Step 1: 快照暴露 fullRedraw**

在 `bridgeSnapshot` 的 `regions: img.regions.map((r) => ({ ... }))` 内，`hasResult: !!r.processedImageUrl,` 之后加：

```ts
        fullRedraw: r.fullRedraw ?? false,
```

- [ ] **Step 2: 新增状态更新函数**

在 `handleUpdateRegionPrompt` 定义附近新增：

```ts
  const handleSetRegionFullRedraw = (imageId: string, regionId: string, enabled: boolean) => {
    updateImage(imageId, img => ({
      ...img,
      regions: img.regions.map(r => r.id === regionId ? { ...r, fullRedraw: enabled } : r),
    }));
  };
```

- [ ] **Step 3: 稳定适配器**

在 `editorOnAdjustRegionSize` 定义（约 909-911 行）之后加：

```ts
  const editorOnToggleFullRedraw = useCallback((regionId: string) => {
      if (selectedImageId_safe) handleSetRegionFullRedraw(selectedImageId_safe, regionId, !(selectedImage?.regions.find(r => r.id === regionId)?.fullRedraw));
  }, [selectedImageId_safe, selectedImage, handleSetRegionFullRedraw]);
```

- [ ] **Step 4: 向 EditorCanvas 传参**

在 `<EditorCanvas` 的 props 中（约 `enablePanelSnap={config.enablePanelSnap}` 之前或之后）加：

```ts
                    fullRedrawAvailable={config.provider === 'grsai' && !config.useFullImageMasking}
                    onToggleFullRedraw={editorOnToggleFullRedraw}
```

- [ ] **Step 5: bridgeHandlers 增加命令**

在 `set_prompt` 处理器（约 220-234 行）之后加：

```ts
    set_region_full_redraw: async ({ image_id, region_id, enabled }) => {
      const img = images.find((i) => i.id === image_id);
      if (!img) return { ok: false, error: `image not found: ${image_id}` };
      if (!img.regions.some((r) => r.id === region_id)) return { ok: false, error: `region not found: ${region_id}` };
      handleSetRegionFullRedraw(image_id, region_id, !!enabled);
      return { ok: true };
    },
```

- [ ] **Step 6: 类型检查**

Run: `npx tsc --noEmit`
Expected: 通过

- [ ] **Step 7: 提交**

```bash
git add App.tsx
git commit -m "feat: 接线 fullRedraw 状态更新、UI 传参与 MCP 命令"
```

---

### Task 5: 生成管线 full redraw 分支

**Files:**
- Modify: `hooks/useImageProcessor.ts`（`processRegionTask` 函数，约 353-533 行）

说明：本任务改动集中在 `processRegionTask`。下面按函数内位置给出精确修改。

- [ ] **Step 1: 任务开头判定 isFullRedraw 并预计算像素尺寸**

在 `processRegionTask` 内 `if (signal.aborted) return;`（约 354 行）之后插入：

```ts
            const isFullRedraw = !!region.fullRedraw && config.provider === 'grsai';
            const fullRedrawPxW = isFullRedraw
              ? Math.max(1, Math.round((region.width / 100) * imgElement.naturalWidth))
              : 0;
            const fullRedrawPxH = isFullRedraw
              ? Math.max(1, Math.round((region.height / 100) * imgElement.naturalHeight))
              : 0;
```

（`imgElement` 已在函数上方 line 128 加载，此处可用。）

- [ ] **Step 2: 跳过裁剪/填充/压缩（仅非 full redraw）**

将现有裁剪块（约 365-400 行，从 `croppedUrl = await cropRegion(imgElement, region, imageSnapshot.sketchStrokes);` 到压缩结束 `if (croppedUrl) { releaseObjectURL(croppedUrl); croppedUrl = undefined; }`）整体包进 `if (!isFullRedraw) { ... }`。即在该块前后加：

```ts
                if (!isFullRedraw) {
                    croppedUrl = await cropRegion(imgElement, region, imageSnapshot.sketchStrokes);
                    // ... 原有 padImageToSquare / compressImageToTargetSize 全部保持原样 ...
                    if (croppedUrl) { releaseObjectURL(croppedUrl); croppedUrl = undefined; }
                }
```

- [ ] **Step 3: full redraw 时跳过翻译 API**

将翻译块 `if (config.enableTranslationMode) { ... }`（约 419-441 行）改为：

```ts
                if (config.enableTranslationMode && !isFullRedraw) {
                   // ... 原有翻译逻辑保持不变 ...
                }
```

（full redraw 时 translationText 保持空字符串，不调用翻译 API。）

- [ ] **Step 4: 追加尺寸后缀到提示词**

在现有 `if (translationText) { effectivePrompt += ... }`（约 457-459 行）之后插入：

```ts
                if (isFullRedraw) {
                    effectivePrompt += ` 请生成一张宽 ${fullRedrawPxW} 像素、高 ${fullRedrawPxH} 像素的图像，与选区尺寸完全一致（同尺寸完全重制）。`;
                }
```

- [ ] **Step 5: 条件调用 generateRegionEdit**

将现有 `let apiResultBase64 = await generateRegionEdit(await getRedrawBase64(), effectivePrompt, aiConfig, signal);`（约 460 行）替换为：

```ts
                let apiResultBase64: string;
                if (isFullRedraw) {
                    apiResultBase64 = await generateRegionEdit('', effectivePrompt, aiConfig, signal, { fullRedraw: true, aspectRatioOverride: `${fullRedrawPxW}x${fullRedrawPxH}` });
                } else {
                    apiResultBase64 = await generateRegionEdit(await getRedrawBase64(), effectivePrompt, aiConfig, signal);
                }
```

- [ ] **Step 6: 跳过 depad（full redraw 输出已是精确尺寸）**

将现有 `if (config.enableSquareFill && paddingInfo) { ... }`（约 490-496 行）改为：

```ts
                if (!isFullRedraw && config.enableSquareFill && paddingInfo) {
                    const depadResultUrl = config.squareFillMode === 'ratio'
                        ? await depadImageByRatio(apiResultUrl, paddingInfo)
                        : await depadImageFromSquare(apiResultUrl, paddingInfo, config.squareFillMargin);
                    releaseObjectURL(apiResultUrl);
                    apiResultUrl = depadResultUrl;
                }
```

- [ ] **Step 7: 后处理——full redraw 直接以结果作补丁**

将现有后处理 `// Standard Masking Mode` 的 `for (const region of regionsToProcess) { ... extractCropFromFullImage ... }`（约 287-298 行）整体替换为：

```ts
                    // Standard Masking Mode
                    if (isFullRedraw) {
                        const completedRegion = { ...region, processedImageUrl: apiResultUrl, status: 'completed' as const, anchorX: region.x, anchorY: region.y, anchorWidth: region.width, anchorHeight: region.height };
                        regionsMap.set(region.id, completedRegion);
                        apiResultUrl = undefined; // 所有权已转移
                    } else {
                        for (const region of regionsToProcess) {
                            const finalRegionImageUrl = await extractCropFromFullImage(
                                apiResultUrl,
                                region,
                                maskImg.naturalWidth,
                                maskImg.naturalHeight,
                                config.fullImageOpaquePercent
                            );
                            const completedRegion = { ...region, processedImageUrl: finalRegionImageUrl, status: 'completed' as const, anchorX: region.x, anchorY: region.y, anchorWidth: region.width, anchorHeight: region.height };
                            regionsMap.set(region.id, completedRegion);
                        }
                        apiResultUrl = undefined;
                    }
```

- [ ] **Step 8: 类型检查**

Run: `npx tsc --noEmit`
Expected: 通过

- [ ] **Step 9: 提交**

```bash
git add hooks/useImageProcessor.ts
git commit -m "feat: 标准路径支持 full redraw（跳过裁剪、尺寸后缀、直接作补丁）"
```

---

### Task 6: grsai 服务支持 full redraw

**Files:**
- Modify: `services/aiService.ts`
  - `generateRegionEdit`（约 627-653 行）增加 `options?`
  - `generateGrsaiImage`（约 410-535 行）增加 `options?` 并据此调整 `images` 与 `aspectRatio`

- [ ] **Step 1: generateRegionEdit 透传 options**

将签名与 worker 调用改为：

```ts
export const generateRegionEdit = async (
  imageBase64: string,
  prompt: string,
  config: AppConfig,
  signal?: AbortSignal,
  options?: { fullRedraw?: boolean; aspectRatioOverride?: string }
): Promise<string> => {

  const timeout = config.apiTimeout || 60000;
  const retries = config.maxRetries ?? 0;

  const worker = async (opSignal: AbortSignal) => {
    if (config.provider === 'grsai') {
      if (!config.grsaiApiKey) throw new Error("grsai API Key is missing");
      return generateGrsaiImage(imageBase64, prompt, config.grsaiApiKey, config.grsaiModel, opSignal, timeout, config.grsaiReferenceImages, options);
    } else if (config.provider === 'openai') {
      if (!config.openaiApiKey) throw new Error("OpenAI API Key is missing");
      return generateOpenAIImage(imageBase64, prompt, config, opSignal);
    } else {
      return generateGeminiImage(imageBase64, prompt, config.geminiModel, config.geminiApiKey, opSignal, timeout);
    }
  };

  return executeWithRetry(worker, timeout, retries, signal);
};
```

- [ ] **Step 2: generateGrsaiImage 接收 options 并调整 images / aspectRatio**

将 `generateGrsaiImage` 签名改为：

```ts
const generateGrsaiImage = async (
  imageBase64: string,
  prompt: string,
  apiKey: string,
  modelName: string,
  signal?: AbortSignal,
  timeoutMs?: number,
  referenceImages?: string[],
  options?: { fullRedraw?: boolean; aspectRatioOverride?: string }
): Promise<string> => {
```

在 `const safeApiKey = sanitizeHeaderValue(apiKey);` 之后、`const dataUrl = ...` 之前插入：

```ts
  const isFullRedraw = !!options?.fullRedraw;
```

将 `aspectRatio` 推导（约 445-453 行）改为：

```ts
  let aspectRatio = '1024x1024';
  if (isFullRedraw && options?.aspectRatioOverride) {
    aspectRatio = options.aspectRatioOverride;
  } else {
    try {
      const { width, height } = await getImageDimensionsFromBase64(dataUrl);
      if (width > 0 && height > 0) {
        aspectRatio = `${width}x${height}`;
      }
    } catch (e) {
      console.warn('grsai: could not derive slice dimensions, falling back to 1024x1024:', e);
    }
  }
```

将 `const body = { ... images: [dataUrl, ...(referenceImages ?? [])] ... }`（约 455-461 行）改为：

```ts
  const body = {
    model: modelName,
    prompt: prompt,
    images: isFullRedraw ? [...(referenceImages ?? [])] : [dataUrl, ...(referenceImages ?? [])],
    aspectRatio,
    replyType: 'json',
  };
```

将调试日志 `[grsai-debug] request` 中 `imageDataLength: body.images[0].length,` 改为安全访问：

```ts
    imageDataLength: body.images[0] ? body.images[0].length : 0,
```

（full redraw 且无全局参考图时 `images` 为空，避免 `body.images[0]` 为 undefined 报错。）

- [ ] **Step 3: 类型检查**

Run: `npx tsc --noEmit`
Expected: 通过

- [ ] **Step 4: 提交**

```bash
git add services/aiService.ts
git commit -m "feat: grsai 支持 full redraw（不发切片、保留全局参考图、精确像素 aspectRatio）"
```

---

### Task 7: MCP 工具 set_region_full_redraw

**Files:**
- Modify: `mcp/server.py`（在 `set_prompt` 工具，约 160-166 行之后）

- [ ] **Step 1: 新增工具**

在 `set_prompt` 的 `@mcp.tool()` 定义之后插入：

```py
@mcp.tool()
def set_region_full_redraw(image_id: str, region_id: str, enabled: bool) -> str:
    """设置某选区的"同尺寸完全重制"开关。enabled=true 时该选区生成不发送选区图，仅按选区尺寸文生图（仅 grsai 生效）。"""
    if not _ensure_bridge():
        return _err("桥接服务不可达")
    res = _cmd("set_region_full_redraw", {"image_id": image_id, "region_id": region_id, "enabled": bool(enabled)})
    return _ok(res) if res.get("ok") else _err(str(res.get("error")))
```

- [ ] **Step 2: 语法检查**

Run: `python -c "import ast; ast.parse(open(r'mcp/server.py', encoding='utf-8').read()); print('ok')"`
Expected: `ok`

- [ ] **Step 3: 提交**

```bash
git add mcp/server.py
git commit -m "feat: MCP 新增 set_region_full_redraw 工具"
```

---

### Task 8: 构建与冒烟验证

**Files:** 无新增，验证既有改动

- [ ] **Step 1: 全量类型检查 + 构建**

Run: `npx tsc --noEmit && npm run build`
Expected: tsc 无新增错误；build 成功（仅既有 chunk-size 警告）

- [ ] **Step 2: 浏览器冒烟（grsai）**

1. `npm run dev` 启动应用与 IOPaint 钩子。
2. 上传一张图，框选一个区域；确认选区工具栏出现「同尺寸」紫色按钮。
3. 点击开启（按钮变紫、选区边框变紫）。
4. 开始生成；打开 DevTools Console 观察 `[grsai-debug] request`：
   - `imageDataLength: 0`（未发切片）；
   - `aspectRatio` = 选区精确像素 `WxH`；
   - 提示词含「同尺寸完全重制」与尺寸。
5. 生成完成后结果拼合无黑边（fitScale≈1），选区显示补丁。
6. 关闭开关再生成一次，确认恢复发送切片（回归）。

- [ ] **Step 3: MCP 冒烟**

1. 启动 MCP 服务（自动拉起 bridge）。
2. `get_status` 确认目标 region 的 `fullRedraw` 字段存在（默认 false）。
3. 调用 `set_region_full_redraw(image_id, region_id, true)`，再 `get_status` 确认 `fullRedraw=true`。
4. `generate(scope='single')` 阻塞完成，`processingState='DONE'`，行为与浏览器开启一致。

- [ ] **Step 4: 空 images[] 探测（无全局参考图场景）**

若测试环境未标记任何全局参考图，Step 2/3 的 full redraw 会令 grsai 收到 `images: []`。
- 观察 `[grsai-debug]` 与返回：若 grsai 接受空 images 并正常返回 → 无需兜底。
- 若返回错误（如 "images required"）→ 在 `generateGrsaiImage` 的 `isFullRedraw` 分支、且 `referenceImages` 为空时，改发 1×1 透明占位 PNG 的 data URL（仅兜底，不进入正常路径），重新构建验证。

- [ ] **Step 5: 最终提交（如有兜底修复）**

```bash
git add -A
git commit -m "fix: full redraw 无全局参考图时兜底发送占位图（如探测失败）"
```

（仅当 Step 4 确实需要兜底时才提交此步；否则跳过。）

---

## 自审（Self-Review）

1. **Spec 覆盖**：数据模型(Task1)✓、UI 开关(Task3)✓、生成管线(Task5)✓、grsai 服务(Task6)✓、MCP 接口(Task7)✓、快照暴露(Task4)✓、边界守卫（仅 grsai/非全图遮罩，Task3/4 的 `fullRedrawAvailable` 计算）✓、验证(Task8)✓。
2. **占位符扫描**：无 TBD/TODO；每步含具体代码或命令。
3. **类型一致性**：`fullRedraw` 字段在 types/快照/EditorCanvas/处理器一致；`generateRegionEdit(imageBase64, prompt, config, signal, options?)` 签名在 Task5 调用与 Task6 定义一致；`aspectRatioOverride` / `fullRedraw` 在 options 中命名一致。
4. **偏差说明**：full redraw 时**跳过翻译 API**（translationText 为空），因翻译需选区原图、与"完全重制"语义冲突；这与 spec 第 2/8 节"翻译仍按遮罩上下文跑"略有出入——本计划改为 full redraw 不翻译，更简洁且避免向翻译 API 发送空图。若需严格保留翻译，应在 Task5 Step3 改为用 `maskedContextUrl` 作为翻译主图，复杂度更高，默认不采用。

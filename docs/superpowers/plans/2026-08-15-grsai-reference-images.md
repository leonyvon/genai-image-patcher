# grsai 全局参考图功能实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 grsai 生成路径支持全局参考图——图库中标记的图片压缩后持久化到配置，随每次 grsai 请求作为 `images[1..n]` 发送，提示词以 `[image 2]`+ 引用。

**Architecture:** 参考图以压缩 base64 data URL 数组存于 `AppConfig.grsaiReferenceImages`（localStorage 持久化）。图库缩略图的星标开关负责增删（压缩→存配置→图片打 `isReference` 标）。请求侧仅 `generateGrsaiImage` 把参考图拼进 `images` 数组。`isReference` 图片自动排除出处理队列与 ZIP 导出。

**Tech Stack:** React 19 + TypeScript + Vite（无测试框架）。设计文档：`docs/superpowers/specs/2026-08-15-grsai-reference-images-design.md`。

**验证方式说明（与仓库既有实践一致）：** 本仓库无测试基础设施（package.json 无 vitest/jest），既有 grsai 集成均以 `npx tsc --noEmit` + `npm run build` + 浏览器手动验证为验收标准，本计划沿用。每步命令均已给出精确期望输出。

---

### Task 1: 类型与配置默认值

**Files:**
- Modify: `types.ts:62-116`（AiProvider/AppConfig 区域）、`types.ts:43-60`（UploadedImage）
- Modify: `hooks/useConfig.ts:62-119`（DEFAULT_CONFIG）、`hooks/useConfig.ts:219-226`（迁移保障区）

- [ ] **Step 1: types.ts 增加字段**

在 `types.ts` 的 `UploadedImage` 接口（History 字段上方，约第 57 行 `historyIndex: number;` 之前）插入：

```ts
  isReference?: boolean; // If true, image is a grsai reference only — excluded from processing and ZIP export
  /** Compressed base64 data URL stored in config.grsaiReferenceImages (used for badge index and unmarking). */
  referenceBase64?: string;
```

在 `AppConfig` 的 grsai 区块（约第 116 行 `grsaiModel: string;` 之后）插入：

```ts
  /** Global reference images (compressed base64 data URLs). Sent as images[1..n] on grsai requests; [image 1] is always the region slice. */
  grsaiReferenceImages: string[];
```

- [ ] **Step 2: useConfig.ts 默认值与迁移保障**

在 `DEFAULT_CONFIG` 中 `grsaiModel: 'gpt-image-2',`（约第 83 行）之后插入：

```ts
  grsaiReferenceImages: [],
```

在迁移代码块中（现有 grsai 迁移保障之后，约第 226 行 `}` 前）追加：

```ts
        // Ensure grsaiReferenceImages exists
        if (typeof migratedConfig.grsaiReferenceImages === 'undefined') {
            migratedConfig.grsaiReferenceImages = [];
        }
```

- [ ] **Step 3: 类型检查**

Run: `npx tsc --noEmit`
Expected: exit 0，无报错。

- [ ] **Step 4: 提交**

```bash
git add types.ts hooks/useConfig.ts
git commit -m "feat: grsai 参考图类型与配置默认值"
```

---

### Task 2: 请求构造（grsai 路径）

**Files:**
- Modify: `services/aiService.ts`（`generateGrsaiImage` 约 397-460 行、`generateRegionEdit` 约 591-594 行）

- [ ] **Step 1: generateGrsaiImage 增加 referenceImages 参数并拼接 images**

把签名（约 397-404 行）改为：

```ts
const generateGrsaiImage = async (
  imageBase64: string,
  prompt: string,
  apiKey: string,
  modelName: string,
  signal?: AbortSignal,
  timeoutMs?: number,
  referenceImages?: string[]
): Promise<string> => {
```

把 body 构造（约 454-460 行）改为：

```ts
  const body = {
    model: modelName,
    prompt: prompt,
    images: [dataUrl, ...(referenceImages ?? [])],
    aspectRatio,
    replyType: 'json',
  };
```

把 `[grsai-debug] request` 日志（约 462-470 行）增加参考图数量：

```ts
  console.log('[grsai-debug] request', {
    model: body.model,
    aspectRatio: body.aspectRatio,
    replyType: body.replyType,
    imageMime: body.images[0].slice(0, 30),
    imageDataLength: body.images[0].length,
    referenceCount: body.images.length - 1,
    promptLength: body.prompt.length,
    promptHead: body.prompt.slice(0, 100),
  });
```

- [ ] **Step 2: generateRegionEdit 传入参考图**

把 grsai 分支（约 591-593 行）改为：

```ts
    if (config.provider === 'grsai') {
      if (!config.grsaiApiKey) throw new Error("grsai API Key is missing");
      return generateGrsaiImage(imageBase64, prompt, config.grsaiApiKey, config.grsaiModel, opSignal, timeout, config.grsaiReferenceImages);
    }
```

- [ ] **Step 3: 类型检查与构建**

Run: `npx tsc --noEmit` → Expected: exit 0
Run: `npm run build` → Expected: built in ~1s，54 modules，仅有既有的 chunk-size 警告

- [ ] **Step 4: 提交**

```bash
git add services/aiService.ts
git commit -m "feat: grsai 请求携带全局参考图"
```

---

### Task 3: 参考图排除出处理与导出

**Files:**
- Modify: `hooks/useImageProcessor.ts:65`（processSingleImage 守卫）、`hooks/useImageProcessor.ts:504`（handleProcess 目标过滤）
- Modify: `components/Sidebar.tsx:140-143`（downloadCount）、`components/Sidebar.tsx:170-180`（handleDownloadAllZip 过滤）

- [ ] **Step 1: useImageProcessor 排除 isReference**

在 `processSingleImage` 的 `if (imageSnapshot.isSkipped) return;`（约 65 行）之后插入：

```ts
        if (imageSnapshot.isReference) return;
```

把 `handleProcess` 的目标过滤（约 504 行）改为：

```ts
        const targets: UploadedImage[] = processAll 
            ? images.filter(img => !img.isSkipped && !img.isReference)
            : (selectedImage ? [selectedImage] : []);
```

- [ ] **Step 2: Sidebar ZIP/计数排除 isReference**

把 `downloadCount`（约 140-143 行）改为：

```ts
  const hasCompletedImages = images.some(img => img.regions.some(r => r.status === 'completed') || img.finalResultUrl);
  const processableImages = images.filter(img => !img.isReference);
  const downloadCount = hasCompletedImages 
      ? processableImages.filter(img => img.regions.some(r => r.status === 'completed') || img.isSkipped).length 
      : processableImages.length;
```

把 `handleDownloadAllZip` 的 `imagesToZip` 计算（约 174-179 行）改为：

```ts
    if (hasAnyResults) {
        imagesToZip = images.filter(img => !img.isReference && (img.regions.some(r => r.status === 'completed') || img.finalResultUrl || img.isSkipped));
    } 
    else {
        imagesToZip = images.filter(img => !img.isReference);
    }
```

- [ ] **Step 3: 类型检查**

Run: `npx tsc --noEmit` → Expected: exit 0

- [ ] **Step 4: 提交**

```bash
git add hooks/useImageProcessor.ts components/Sidebar.tsx
git commit -m "feat: 参考图图片排除出处理队列与 ZIP 导出"
```

---

### Task 4: 图库参考图开关（星标 + 角标）

**Files:**
- Modify: `App.tsx:7`（imageUtils 导入）、`App.tsx`（新增 handleToggleReference）、`App.tsx:538`（Sidebar 接线）
- Modify: `components/Sidebar.tsx:14-44`（SidebarProps）、`components/Sidebar.tsx:56-85`（解构）、`components/Sidebar.tsx:415-425` 附近（缩略图按钮区）

- [ ] **Step 1: App.tsx 导入与处理器**

把第 7 行的 imageUtils 导入改为（追加两个函数）：

```ts
import { loadImage, cropRegion, stitchImage, createInvertedMultiMaskedFullImage, extractCropFromFullImage, stitchImageInverted, releaseObjectURL, compressImageToTargetSize, urlToBase64 } from './services/imageUtils';
```

在 `handleProcess` 相关 hook 之后（`useImageProcessor(...)` 调用之后，约 58 行后）插入：

```ts
  // grsai 全局参考图：图库图片标记/取消标记。标记时压缩并持久化到 config。
  const handleToggleReference = useCallback(async (imageId: string) => {
    const img = images.find(i => i.id === imageId);
    if (!img) return;

    if (img.isReference && img.referenceBase64) {
      // 取消标记：从配置移除对应条目，清除图片标志
      setConfig(prev => ({ ...prev, grsaiReferenceImages: prev.grsaiReferenceImages.filter(b => b !== img.referenceBase64) }));
      updateImage(imageId, i => ({ ...i, isReference: false, referenceBase64: undefined }));
      return;
    }

    // 标记：压缩 → base64 → 写入配置
    try {
      const compressed = await compressImageToTargetSize(img.originalUrl, { targetSizeKB: 200, maxDimension: 1024 });
      const b64 = await urlToBase64(compressed);
      URL.revokeObjectURL(compressed);
      setConfig(prev => ({ ...prev, grsaiReferenceImages: [...prev.grsaiReferenceImages, b64] }));
      updateImage(imageId, i => ({ ...i, isReference: true, referenceBase64: b64 }));
    } catch (e) {
      console.warn('Failed to add reference image:', e);
    }
  }, [images, setConfig, updateImage]);
```

把 `<Sidebar` 的 props（约 538 行 `onToggleSkip={handleToggleSkip}` 之后）增加：

```tsx
        onToggleReference={handleToggleReference}
```

- [ ] **Step 2: Sidebar 增加 onToggleReference prop**

在 `SidebarProps` 接口（`onToggleSkip: (imageId: string) => void;` 之后）增加：

```ts
  onToggleReference: (imageId: string) => void;
```

在组件解构（`onToggleSkip,` 之后）增加：

```ts
  onToggleReference,
```

- [ ] **Step 3: 缩略图增加星标按钮与 [image N] 角标**

在现有 skip 按钮（约 415-425 行，`onToggleSkip` 的 `<button>`）之后插入星标按钮：

```tsx
                          <button 
                             onClick={(e) => { e.stopPropagation(); onToggleReference(img.id); }}
                             className={`absolute top-1 left-[24px] p-1 rounded-sm shadow-sm transition-all z-10 ${img.isReference ? 'bg-amber-400 text-white' : 'bg-skin-surface/90 text-skin-muted hover:text-amber-500 hover:bg-white'}`}
                             title={img.isReference ? t(lang, 'removeReference') : t(lang, 'useAsReference')}
                          >
                             <svg className="w-3 h-3" fill={img.isReference ? 'currentColor' : 'none'} stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.196-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118L2.98 10.1c-.783-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z" /></svg>
                          </button>
```

在缩略图内（completed 圆点之前，约 435 行附近）插入角标：

```tsx
                          {img.isReference && img.referenceBase64 && config.grsaiReferenceImages.indexOf(img.referenceBase64) >= 0 && (
                             <span className="absolute bottom-1 left-1 px-1 rounded bg-amber-500 text-white text-[9px] font-bold z-10 shadow-sm">
                                [image {config.grsaiReferenceImages.indexOf(img.referenceBase64) + 2}]
                             </span>
                          )}
```

- [ ] **Step 4: translations.ts 增加两个文案 key**

在 `services/translations.ts` 的 zh 区块（约 61-68 行附近）与 en 区块（约 314-321 行附近）各追加：

zh：
```ts
    useAsReference: "设为参考图",
    removeReference: "取消参考图",
```

en：
```ts
    useAsReference: "Use as reference",
    removeReference: "Remove reference",
```

（`t(lang, ...)` 未命中 key 时返回 key 本身，en/zh 任一缺失都不会报错，但保持双语完整。）

- [ ] **Step 5: 类型检查与构建**

Run: `npx tsc --noEmit` → Expected: exit 0
Run: `npm run build` → Expected: built，仅既有 chunk-size 警告

- [ ] **Step 6: 提交**

```bash
git add App.tsx components/Sidebar.tsx services/translations.ts
git commit -m "feat: 图库图片可标记为 grsai 参考图"
```

---

### Task 5: SettingsPanel 参考图列表

**Files:**
- Modify: `components/sidebar/SettingsPanel.tsx`（grsai 区块，约 166-196 行）

- [ ] **Step 1: grsai 区块增加参考图列表**

在 `{config.provider === 'grsai' && (...)}` 块的模型输入框（约 183-185 行）之后、区块闭合 `</>` 之前插入：

```tsx
                    <div className="animate-in fade-in slide-in-from-top-3 pt-2 mt-2 border-t border-skin-border/50">
                        <label className="text-[10px] uppercase font-bold text-skin-muted mb-1 block">Reference Images</label>
                        <p className="text-[10px] text-skin-muted mb-2 leading-tight">[image 1] is the region slice; references start at [image 2]. Mark images in the gallery with the star to add.</p>
                        {config.grsaiReferenceImages.length === 0 ? (
                            <p className="text-[10px] text-skin-muted italic">No reference images yet.</p>
                        ) : (
                            <div className="flex flex-wrap gap-2">
                                {config.grsaiReferenceImages.map((b64, i) => (
                                    <div key={i} className="relative w-14 h-14 rounded-lg overflow-hidden border border-skin-border bg-skin-fill group">
                                        <img src={b64} className="w-full h-full object-cover" alt={`reference ${i + 2}`} />
                                        <span className="absolute bottom-0.5 left-0.5 px-1 rounded bg-amber-500 text-white text-[8px] font-bold">{`[image ${i + 2}]`}</span>
                                        <button
                                            onClick={() => onChange('grsaiReferenceImages', config.grsaiReferenceImages.filter((_, idx) => idx !== i))}
                                            className="absolute top-0.5 right-0.5 w-4 h-4 rounded-full bg-black/60 text-white text-[9px] leading-none flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                                            title="Remove reference"
                                        >✕</button>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
```

- [ ] **Step 2: 类型检查与构建**

Run: `npx tsc --noEmit` → Expected: exit 0
Run: `npm run build` → Expected: built，仅既有 chunk-size 警告

- [ ] **Step 3: 提交**

```bash
git add components/sidebar/SettingsPanel.tsx
git commit -m "feat: 设置面板显示与管理 grsai 参考图"
```

---

## 手动验收清单（全部通过后功能完成）

1. `npm run dev` 启动；图库上传 ≥2 张图
2. 给其中两张点星标 → 缩略图出现 `[image 2]` / `[image 3]` 角标（按标记顺序），星标变金色
3. 选择 grsai provider + 任一图片画选区，提示词中写 `参照 [image 2] 的风格...`
4. 点生成 → F12 控制台 `[grsai-debug] request` 中 `referenceCount` = 参考图数，`imageMime`/`imageDataLength` 正常
5. 刷新页面 → 图库清空，但 SettingsPanel grsai 区块仍显示参考图缩略图；删除按钮生效
6. 勾选"应用到所有图片" → 参考图图片不参与处理；下载 ZIP 中不含参考图
7. 不标记任何参考图时生成，行为与改动前一致（`referenceCount: 0`）

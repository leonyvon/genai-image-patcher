# 框选吸附（Panel Snap）实现计划

日期：2026-08-17
关联设计：`docs/superpowers/specs/2026-08-17-panel-snap-design.md`

## 算法核心（已在原型验证，常量照搬）

检测在降采样灰度图上进行（最长边 ≤ 1500px）。对每行/列算两个量：
- `whiteFrac`：灰度 > 235 占比（白缝）
- `longestRun`：最长**连续**灰度 < 60 游程（黑线）

打分 `sep[i] ∈ [0,1]` + `kind ∈ {1=gutter, 2=line}`：
- 白缝：`whiteFrac > 0.30` → `sep = whiteFrac`
- 黑线：`longestRun ≥ 0.99 × 跨度` 且连续满宽带厚度 ≤ 16px → `sep = longestRun/跨度`

常量：`DARK=60, WHITE=235, FULLW=0.99, GUTTER=0.30, MAXBAND=16, SEP_THRESH=0.40, SNAP_RADIUS=80(原始图像素), MIN_PANEL=24(原始图像素)`。

吸附：每条边在其位置 ± SNAP_RADIUS 内找最近 `sep ≥ SEP_THRESH`，吸到该行/列；找不到则保持原值；吸附后宽/高 < MIN_PANEL 则该轴回退。

## 任务拆解（单 @fixer 顺序执行）

### Task 1 — 新建 `services/panelSnapService.ts`（纯函数，无 React）

```ts
export interface PctRect { x: number; y: number; width: number; height: number; } // 百分比 0-100
export interface PanelDetector {
  snapRect(rect: PctRect): PctRect;
  dispose(): void;
}
export async function buildPanelDetector(
  imageUrl: string,
  opts?: { maxDim?: number } // default 1500
): Promise<PanelDetector>;
```

实现要点：
- `createImageBitmap` 解码，必要时降采样到 `maxDim`（参照 `detectionService.ts` 的 `prepareImageForUpload` 思路）
- 合成到白底再抽灰度（RGBA 处理）
- 计算 `rowSep[]/colSep[]` + `rowKind[]/colKind[]`（按上面算法）
- `snapRect`：百分比 ↔ 检测像素线性换算（检测像素 = pct/100 × 检测维度）；每条边 `± SNAP_RADIUS×scale` 找最近分隔线；返回吸附后百分比矩形
- `dispose()`：`bitmap.close()`

### Task 2 — 新建 `hooks/usePanelSnap.ts`

```ts
export function usePanelSnap(
  image: { previewUrl: string; originalWidth: number; originalHeight: number } | undefined,
  enabled: boolean
): { snapRect: (rect: PctRect) => PctRect; ready: boolean };
```
- `enabled=false` 或 image 缺失 → 返回恒等函数，不构建
- `image.previewUrl` 变化时重建（异步）；未就绪时 `snapRect` 为恒等
- cleanup：卸载/切换时 `dispose()`，并用 `cancelled` 标志防止竞态

### Task 3 — 修改 `hooks/useCanvasInteraction.ts`

- 签名新增可选参数 `snapDrawnRegion?: (rect: {x,y,width,height}) => {x,y,width,height}`
- 用 ref 透传（`useEffect(() => { snapDrawnRegionRef.current = snapDrawnRegion; }, [snapDrawnRegion])`，沿用现有 `onUpdateRegionsRef` 模式）
- 在 `handleWindowMouseUp` 的 `drawing` 分支（约 164-180 行）：创建 `newRegion` 前，若 `snapDrawnRegionRef.current` 存在，先 `const s = snapDrawnRegionRef.current({x,y,width,height})`，用 `s` 的坐标建 Region
- 不传时行为完全等价现状

### Task 4 — 修改 `components/EditorCanvas.tsx`

- `EditorCanvasProps` 新增 `enablePanelSnap?: boolean`（默认 true）
- 组件内 `const { snapRect } = usePanelSnap(image, enablePanelSnap)`
- 把 `snapRect` 作为 `snapDrawnRegion` 传给 `useCanvasInteraction(...)`（仅当 `enablePanelSnap` 时传入，否则 `undefined`）
- 注意：`usePanelSnap` 需要 `image.previewUrl/originalWidth/originalHeight`（EditorCanvas 已有完整 `image`）

### Task 5 — 修改 `types.ts` + `hooks/useConfig.ts`

- `types.ts` `AppConfig` 新增 `enablePanelSnap: boolean;`（放 Manga Module 段附近）
- `useConfig.ts` `DEFAULT_CONFIG` 加 `enablePanelSnap: true`
- 迁移逻辑加：
  ```ts
  if (typeof migratedConfig.enablePanelSnap === 'undefined') {
      migratedConfig.enablePanelSnap = true;
  }
  ```

### Task 6 — 修改 `App.tsx`

- `<EditorCanvas ...>`（约 1041 行）加 prop `enablePanelSnap={config.enablePanelSnap}`

### Task 7 — 修改 `GlobalSettings.tsx` + `services/translations.ts`

- `translations.ts` 中文段（约 187-192 行附近）与英文段（约 458-463 行附近）各加：
  - `enablePanelSnap: "框选吸附"` / `"Panel Snap"`
  - `enablePanelSnapDesc: "拖框松手时自动吸附到最近的格线"` / `"Snap drawn regions to the nearest panel border"`
- `GlobalSettings.tsx` 在 manga mode 段之后（约 117 行 `useFullImageMasking` 之前）加一个独立开关（复用现有 checkbox 样式，可参照 `useFullImageMasking` 那个大号开关的 JSX）

## 验证

1. `npx tsc --noEmit` 无错误
2. `npm run build` 成功（仅既有 chunk-size 警告）
3. 手动清单（参照设计文档 §7）：
   - 干净黑线页（如 09-page-deck-sea）：糙框 3 格全吸附
   - 极暗页（04-page-dream-awake）：仅页框边吸附，色调分界边不吸附
   - 中间小框：全不吸附，原样保留
   - 关闭开关：行为与现状一致

## 参考实现

原型（已验证算法）：`C:\Users\LEON\AppData\Local\Temp\opencode\panel-snap\panel-snap.html`（`computeSep` + `snapEdge` + `snapBox` 三段即核心算法）。

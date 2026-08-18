# 画笔草图指引（Sketch Brush）设计

日期：2026-08-18
状态：已批准（用户逐节确认）

## 目标

用户可以直接在图片上用画笔画线，线条作为 **AI 可见的草图指引**：生成时合成进发送给 AI 的输入图（选区切片 / 全图遮罩），AI 能看见用户画的线条并据此创作。线条是独立图层，**永不写入最终输出**（拼合 / 下载 / ZIP / MCP 取图均不含线条）。

## 数据模型（types.ts）

```ts
export interface SketchStroke {
  id: string;
  color: string;                      // hex，如 '#ff3b30'
  size: number;                       // 粗细：图片最大边长的百分比（0-100），与现有画笔语义一致
  points: { x: number; y: number }[]; // 百分比坐标 0-100，相对整图
}

// UploadedImage 增加：
sketchStrokes?: SketchStroke[];
```

- 坐标体系与 `Region` 一致（相对整图百分比），分辨率无关。
- 粗细换算公式：`size/100 × canvas 最大边长`，任何画布（overlay / AI 切片）同公式。

## 绘制与渲染（EditorCanvas.tsx）

复用现有画笔基础设施（restore brush / remove brush 的 overlay canvas + 窗口级鼠标事件模式）。

### 新 props

- `brushMode?: boolean` — 画笔模式开关
- `brushColor?: string` — 当前颜色
- `brushSize?: number` — 当前粗细（百分比）
- `brushEraser?: boolean` — 橡皮擦模式
- `onUpdateSketchStrokes?: (imageId: string, strokes: SketchStroke[]) => void`
- `onClearSketchStrokes?: () => void`

### 行为

- 叠加 canvas（`sketchOverlayRef`）按图片原始尺寸建，CSS 缩放铺满容器（与涂抹移除 overlay 同模式）。
- 绘制中：mousemove 在 overlay 上画当前笔画线段（round cap/join，实色）。
- mouseup：当前笔画转成百分比坐标矢量数据，提交进 `sketchStrokes`，overlay 整体重渲染（strokes 数组 → canvas）。
- **橡皮擦（矢量级）**：擦除模式下 mousemove 命中（任一点落在擦除半径内）的整条笔画从数组移除并重渲染。整条删除，不做局部拆分。
- 光标环：复用现有画笔的圆环提示（显示当前粗细）。
- 画笔模式下背景 mousedown 不再画选区（与现有模式互斥逻辑一致）。
- 笔画只在工作视图（original）显示，result 视图隐藏。

## AI 输入合成（imageUtils.ts + useImageProcessor.ts）

### 新工具

`compositeSketchStrokes(ctx, strokes, canvasW, canvasH, clipRect?)`：
把笔画画进目标 canvas context，可选裁剪到矩形（选区范围，像素坐标）。笔画实色绘制（AI 需要看清指引，不做半透明）。

### 接线点

1. **选区切片**（主路径）：`cropRegion` 生成切片后，把笔画按选区矩形裁剪合成。grsai 参考图 `[image 1]` 同路径自动覆盖。
2. **全图遮罩**：`createMultiMaskedFullImage` / `createInvertedMultiMaskedFullImage` 合成时叠加笔画（无裁剪）。

## 生命周期

1. 笔画持久存在，仅橡皮擦 / 清空按钮可删。
2. **预览隐藏**：`viewMode === 'result'`（预览视图）时所有笔画临时隐藏——AI 绘制完成后切预览即满足"预览状态下所有线条临时隐藏"；切回工作视图恢复显示。
3. **选区确认清空**：`handleApplyRegionAsOriginal`（✅ 提交调整为新原图）执行后，删除所有点落在该选区矩形内的笔画（百分比坐标直接判定）。
4. **永不进输出**：笔画是独立数据结构，只合成进 AI 输入；拼合 / 下载 / ZIP / MCP 取图全部用 `originalUrl` + 补丁，天然不带线条。
5. 整图"应用为原图"不清空笔画（百分比坐标仍叠在新图上）。

## UI 与工具栏（App.tsx）

### 入口按钮

画布上方浮动按钮区（与"🔧 框选还原""涂抹移除"并列）新增 🖌️ 画笔按钮：
- 激活时高亮（沿用现有按钮样式体系）。
- 激活画笔时自动退出还原 / 涂抹模式（互斥，与现有模式切换逻辑一致）。

### 画笔工具面板（画笔激活时，画布角落浮动小面板）

- 颜色：4-6 个预设色块（红 / 蓝 / 绿 / 黄 / 白 / 黑），点击切换。
- 粗细：滑块（1-10，百分比）。
- 橡皮擦：切换按钮（激活时画笔变擦除）。
- 清空：一键清空全部笔画按钮（带确认，防误触）。

### 文案

新增 i18n key（`brushMode`、`brushEraser`、`brushClear`、`brushSize`、`brushColor` 等），中英双语，不动共享 key。

## 验证

- `npx tsc --noEmit` + `npm run build`（仅既有 chunk-size 警告）。
- 浏览器冒烟：画笔模式画线 → 笔画显示；切 result 视图隐藏；生成选区后笔画合成进 AI 输入（探测脚本 / 控制台检查切片 canvas）；✅ 提交后选区内笔画清空；清空按钮 / 橡皮擦生效；下载 / ZIP 输出不含线条。
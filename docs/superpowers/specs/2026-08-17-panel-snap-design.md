# 框选吸附（Panel Snap）设计文档

日期：2026-08-17
状态：设计评审待定

## 1. 背景与问题

用户手动框选漫画格子（选区重绘/漫画翻译）时，格线难以精确对准。尤其是本项目的漫画源（如 `hui-hai-chapter-01`）整章为**无白缝、黑线分隔、画面极暗**（白色像素 0%、近黑 64~98%）的极端风格，手工对齐格线费时易错。

目标：用户拖出一个**糙框**后，松手时自动把框的 4 条边吸附到最近的格线上，吸不到的边保持原位，绝不破坏用户已画好的选择。

## 2. 目标与非目标

**目标**
- 拖框松手时，4 条边各自独立吸附到最近的可信格线（白缝 或 满宽连续黑线）。
- 找不到可信格线的边**不动**（部分吸附），保留用户原始框。
- 纯浏览器端实现，无后端依赖（与项目"无后端"架构一致）。
- 吸到错误结果（窄条/越界）时自动回退。

**非目标（本版本不做）**
- 全图全自动分格（点一下自动选中整格）——已论证极暗页不可靠，改由"框选吸附 + 手动兜底"承担。
- 对已有选区拖拽/缩放时吸附（resize-snap）——后续迭代。
- 斜切/异形分格、阅读顺序排序——不涉及。
- 依赖后端检测（现有 `detectionService` 走 Python 后端，与本功能独立）。

## 3. 方案总览

新增一个纯函数服务 `panelSnapService`，在图像加载时**预计算**行/列分隔线分数（一次，O(W×H)），鼠标松手时用**同步**函数对拖出的百分比矩形做 4 边吸附。通过一个可选回调把吸附逻辑注入现有 `useCanvasInteraction` 的 drawing 流程。

```
图像加载 → buildPanelDetector(previewUrl) → 预计算 rowSep[]/colSep[]（异步，一次）
拖框松手 → snapRect(rawPctRect) → 每条边找最近分隔线 → 返回吸附后 pct 矩形（同步）
```

## 4. 算法（已在原型验证）

检测在**降采样后的灰度图**上进行（最长边 ≤ 1500px，1024px 已足够；分格边界是直尺画的，降采样不丢失）。

### 4.1 预计算（每张图一次）

对每一行/列计算两个量：
- `whiteFrac`：该行/列中灰度 > 235 的像素占比（白缝信号）
- `longestDarkRun`：该行/列中最长的**连续**灰度 < 60 像素游程（黑线信号）

据此给每行/列打分，`sep[i] ∈ [0,1]`，类型 `kind ∈ {gutter, line, none}`：
- 白缝：`whiteFrac[i] > 0.30` → `sep = whiteFrac[i]`，`kind = gutter`
- 黑线：`longestDarkRun[i] ≥ 0.99 × 跨度` 且所属连续满宽带厚度 ≤ 16px → `sep = longestDarkRun/跨度`，`kind = line`

**关键发现（实测）**：真格线是直尺画的，**100% 连续、零断裂**（`longestDarkRun = 全跨度`）；内容再黑也有纹理断裂。把连续性阈值从 0.92 收紧到 0.99，极暗页假格线从 68 条塌到 3 条。这是区分"真格线"与"暗内容"的决定性信号。

### 4.2 吸附（同步）

对拖出矩形 `{x, y, width, height}`（百分比）：
- 顶边/底边：在各自 y 位置 ± 吸附半径内找最近的 `rowSep ≥ 0.40`，吸到该行
- 左边/右边：在各自 x 位置 ± 吸附半径内找最近的 `colSep ≥ 0.40`，吸到该列
- 找不到 → 该边保持原值

**兜底**：吸附后若宽度或高度 < `MIN_PANEL`（24px），该轴回退到原始框。

### 4.3 可调常量

| 常量 | 值 | 说明 |
|---|---|---|
| DARK / WHITE | 60 / 235 | 灰度阈值 |
| FULLW | 0.99 | 黑线连续性（决定性参数） |
| GUTTER | 0.30 | 白缝占比阈值 |
| MAXBAND | 16px | 细线约束（满宽带最大厚度） |
| SEP_THRESH | 0.40 | 分隔线吸附阈值 |
| SNAP_RADIUS | ~60–100 原图像素（可调） | 每条边搜索半径 |
| MIN_PANEL | 24px | 最小面板尺寸兜底 |

## 5. 集成设计

### 5.1 新文件 `services/panelSnapService.ts`

纯函数，无 React 依赖：
- `buildPanelDetector(imageUrl, { maxDim = 1500 }): Promise<PanelDetector>`
  - 解码图像（`createImageBitmap`），必要时降采样到 `maxDim`
  - 抽灰度 → 计算 `rowSep[]/colSep[]` + `kind[]` → 返回
- `PanelDetector.snapRect(rect: PctRect, imgW, imgH): PctRect`
  - 纯同步；内部做 `pct ↔ 检测像素` 的线性换算
- `PanelDetector.dispose()`：释放中间位图

### 5.2 新文件 `hooks/usePanelSnap.ts`

管理探测器生命周期：
- 输入 `image`（`previewUrl` + `originalWidth/Height`）
- 当 `previewUrl` 变化时重建探测器（含"应用为原图"后 previewUrl 变更的场景）
- 返回 `snapRect`（探测器未就绪时为恒等函数，即 no-op）与 `ready` 状态
- 组件卸载/图片切换时 `dispose()`

### 5.3 修改 `hooks/useCanvasInteraction.ts`

- 新增可选参数 `snapDrawnRegion?: (rect: PctRect) => PctRect`
- 用 ref 透传（沿用现有 `onUpdateRegionsRef` 模式，避免 effect 依赖抖动）
- 在 `handleWindowMouseUp` 的 `drawing` 分支：创建 Region 前，若 `snapDrawnRegion` 存在，先吸附，用吸附后的坐标建 Region
- 不改变任何现有签名/行为（不传时完全等价于现状）

### 5.4 修改 `components/EditorCanvas.tsx`

- 调用 `usePanelSnap(image)` 得到 `snapRect`
- 仅在 `config.enablePanelSnap` 开启时传入 `useCanvasInteraction` 的 `snapDrawnRegion`
- 需把 `enablePanelSnap`（来自 App 的 config）作为新 prop 传入 EditorCanvas

### 5.5 坐标换算（关键正确性点）

- Region 百分比相对 `originalWidth × originalHeight`（现有约定，见 `types.ts`）
- 显示层：`<img src={previewUrl}>` 被 `objectFit: fill` 拉伸到原始尺寸，故 previewUrl 像素空间与原始尺寸线性对应
- 检测空间是 previewUrl 的降采样，同样线性
- 换算链：`pct → 原始px → 检测px(= × detectScale) → 吸附 → 反向 → pct`
- SNAP_RADIUS 定义在**原始图像素**（体验一致），检测空间内乘 `detectScale`

### 5.6 配置

- `types.ts` `AppConfig` 新增 `enablePanelSnap: boolean`，默认 `true`
- `useConfig` 迁移校验（旧 localStorage 无此字段时补默认值，参照现有主题迁移）
- UI：在 `GlobalSettings`（或 `SettingsPanel`）加一个开关；文案新增翻译 key（不沿用共享 key）

## 6. 边界情况

| 场景 | 行为 |
|---|---|
| 探测器未就绪（图片加载中） | `snapRect` 恒等，框原样创建 |
| 极暗页、无格线 | 找不到分隔线 → 部分/零吸附，框保留 |
| 吸附后过窄（< MIN_PANEL） | 该轴回退原始框 |
| 拖到页面边缘 | 边界分隔线（页框）视为有效格线，正常吸附 |
| 图像含透明（RGBA） | 合成到白底再抽灰度（与原型一致） |
| 开关关闭 | 完全走现有 manual 路径，零开销（不构建探测器） |
| 大图（6000×8000） | 降采样到 ≤1500px 检测，预计算一次性 ~几十 ms |

## 7. 验证

- `npx tsc --noEmit` + `npm run build`（仅既有 chunk-size 警告）
- 手动清单：
  1. 09-page-deck-sea（黑线干净页）：糙框 3 格全吸附，4 边正确
  2. 04-page-dream-awake（极暗页）：仅页框边吸附，色调分界边不吸附（框保留）
  3. 中间小框：4 边全不吸附，原样保留（无窄条）
  4. 开关关闭：行为与现状完全一致
- 已知验收参考：原型已跑通 09/04，算法参数固化于 4.3

## 8. 风险

- **`previewUrl` 在 balanced 模式被压到 2048px**：检测分辨率足够（1024 已够），无风险；unlimited 模式用全分辨率，靠降采样控制耗时。
- **回调透传签名**（项目已知陷阱）：`snapDrawnRegion` 为单参 `(rect) => rect`，不涉及 imageId/regionId 两参，但需在 `useCanvasInteraction` 用 ref 透传，避免 effect 依赖抖动（见 report.md §4.4）。
- **探测器重建开销**：仅 `previewUrl` 变化时重建，拖框/选区变更不触发。
- **FULLW=0.99 可能漏掉"被文字/拟声词打断"的真格线**：这是接受的范围——宁可漏吸（用户手搓）也不误吸。后续可加"打断容差"优化。

## 9. 待办（后续迭代，非本版本）

- 选区 resize-snap（拖手柄时吸附）
- 打断容差（FULLW 自适应）
- 色调分格页的亮度梯度分段（04 类页面的专用路线）

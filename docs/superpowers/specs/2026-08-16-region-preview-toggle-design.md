# 选区调整后即时显示 + 前后切换预览 设计

日期：2026-08-16
状态：待实现

## 背景与目标

当前选区调整（手动编辑器保存 / AI 生成完成）后，补丁写入 `region.processedImageUrl` + `status:'completed'`，但画布**只在 `viewMode === 'result'` 时叠放补丁层**（`EditorCanvas.tsx:750-779`），而结果视图需要手动点击左上角"已完成"切换。用户感受：调整后看不到结果，UI 反人类。

目标：
1. **调整后立即显示**在画面上，无需手动点"已完成"。
2. 选区工具栏新增**调整前/调整后切换预览**（复用现有环形箭头 reset 键的位置与图标，改为非破坏性切换）。
3. 新增 **✅ 键**：提交当前预览状态——预览为"调整前"时点击 = 真正删除补丁（显式确认，杜绝误触）；预览为"调整后"时点击 = 确认保留（无破坏性动作）。

## 需求决策记录（已与用户确认）

| 决策点 | 结论 |
|---|---|
| 显示机制 | **纯方案 A**：把"补丁是否显示"解耦为"当前选中选区"层级规则——original 视图下仅**选中且 completed** 的选区叠显补丁；result 视图行为不变（全部 completed 补丁叠显） |
| AI 生成 | 不自动选中/抢焦点（批量处理时选区完成不一定选中；手动编辑与 AI 单选区流程天然覆盖，因为操作前选区已选中） |
| 环形箭头键 | 从"立即删除补丁"改为"调整前/调整后"非破坏性切换；切到"调整前"时按钮高亮，title 随状态变化 |
| ✅ 键 | 提交当前预览状态：调整前→执行真正重置（沿用现有 `resetRegion` 路径）；调整后→确认保留（无破坏动作，保持选中与显示） |
| failed 选区 | 保留原"直接重置"按钮（无补丁可比对，直接清错误回 pending 重试） |
| 切换状态存储 | `showOriginalPreview` 为 EditorCanvas **本地 UI state**，不写入 Region/历史快照/MCP 快照 → 撤销重做、MCP 桥接零影响 |

## 核心逻辑

### 1. 补丁叠放渲染条件改造（components/EditorCanvas.tsx:750-779）

原：`{!isOriginalMode && image.regions.filter(r => r.status === 'completed' && r.processedImageUrl).map(...)}`

新：提取 `shouldShowPatchOverlay(region)` 谓词：

```
if (region.status !== 'completed' || !region.processedImageUrl) return false;
if (isOriginalMode) {
  // 工作视图：仅选中选区显示；正在拖拽/缩放时隐藏（避免锚点错位视觉）；
  // showOriginalPreview=true（切到调整前）时不渲染
  return selectedRegionId === region.id
      && !showOriginalPreview
      && !(interaction.type === 'moving' || interaction.type === 'resizing');
}
return true; // result 视图：全部 completed（不变）
```

渲染循环改为 `image.regions.filter(shouldShowPatchOverlay).map(...)`，其余叠放/裁剪/还原缓存逻辑（761-778）原样复用。

**立即显示原理**：编辑器保存路径（`App.tsx handleEditorSave → handleManualPatchUpdate`）不触碰 `selectedRegionId`，选区保持选中 → 保存后补丁立刻在 original 视图叠显。AI 生成同理（生成前选区已选中）。

### 2. 工具栏改造（components/EditorCanvas.tsx:1017-1028）

将 `{region.status === 'completed' || region.status === 'failed'}` 的 reset 按钮块拆为：

- **completed 选区**：两个按钮
  - **切换预览**（沿用现有环形箭头 SVG 与样式基础）：`onClick={() => setShowOriginalPreview(v => !v)}`。`showOriginalPreview === true` 时高亮（如 `bg-amber-100 text-amber-600 border-amber-400`，与 contextOnly 高亮风格一致），title 随状态切换（"显示调整后" / "显示调整前"）。**不破坏数据**。
  - **✅ 提交**（新增绿色对勾按钮）：`onClick` →
    - `showOriginalPreview === true`：执行 `resetRegion(region.id)`（`status→pending`、清 `processedImageUrl`/`restoreBoxes`，同现有 507-516），并 `setShowOriginalPreview(false)`。title："确认恢复原图（删除补丁）"，样式用警示色提示破坏性。
    - `showOriginalPreview === false`：确认保留，无破坏动作，保持选中与补丁显示。title："确认保留调整"。
- **failed 选区**：保留原环形箭头直接重置按钮（行为不变，清错误回 pending）。

新按钮 title 文案：走 `services/translations.ts` 的 `t(language, key)`，zh/en 双语各加 key（区别于既有硬编码英文 title 的旧按钮，新交互保持双语一致）。

### 3. 状态管理（components/EditorCanvas.tsx）

- 新增 `const [showOriginalPreview, setShowOriginalPreview] = useState(false);`
- `useEffect` 监听 `selectedRegionId` 变化 → 重置为 `false`。
- 该 state 不进入任何 props 回调 / 数据模型 / 历史快照。

## 边界情况

- **拖拽/缩放 completed 选区**：overlay 在操作期间隐藏（谓词已含），操作结束恢复——与 result 模式"不允许操作 completed 选区"的既有语义一致，不引入锚点错位视觉。
- **预览"调整前"后不点 ✅ 直接切走**：切换为纯预览，未确认前不破坏数据；选区切换/视图切换/撤销重做均安全。
- **切到 result 视图（点"已完成"）时 `showOriginalPreview` 仍为 true**：result 视图渲染规则忽略该开关，全部补丁正常显示；回到 original 视图后该选区的"调整前"预览状态保留（本地 UI state，直到选区切换或提交）。
- **撤销/重做**：历史快照恢复 regions 后，若该选区不再 completed，工具栏切换/✅ 按钮与 overlay 自然消失，`showOriginalPreview` 残留值无副作用。
- **URL 生命周期**：overlay 复用既有 `processedImageUrl`，无新增分配；✅ 提交走 `resetRegion` 既有释放逻辑（若后续补丁路径需释放旧 URL 由现有代码负责）。
- **"准备开始"按钮语义变化**：original 视图选中 completed 选区时仍显示其补丁——"工作视图直接反映当前选区调整结果"，取代"准备开始 = 纯原图"的旧语义（"已完成"仍可查看全部补丁）。
- **MCP 桥接**：零契约变化——快照字段不变，✅ 提交走的 `onUpdateRegions` 路径已桥接。

## 不做的事（YAGNI）

- 方案 B（补丁完成后自动切全局 result 视图、result 模式开放选区交互）——改动面大、批量 AI 视图跳变，不采用。
- AI 生成完成自动选中抢焦点——批量时打断操作。
- 切换状态持久化到 Region/历史/MCP 快照——纯视图偏好，本地 state 足够。
- ✅"确认保留"写入历史快照/新增撤销点——与现有手动补丁路径一致（写当前快照），不扩展。

## 验证方式

- `npx tsc --noEmit` 与 `npm run build` 通过（仅既有 chunk-size 警告）。
- 手动验证：
  1. 上传图框选选区 → 手动编辑器涂改保存 → **不点"已完成"**，画布直接显示调整后内容，工具栏出现切换 + ✅。
  2. 点环形箭头 → 切到"调整前"（原图内容、按钮高亮）→ 再点 → 切回调整后；来回切换无数据变化。
  3. 切到"调整前"状态点 ✅ → 补丁删除、选区回 pending、可重新生成；undo 可恢复。
  4. 切到"调整后"状态点 ✅ → 补丁保留、无破坏。
  5. AI 单选区生成 → 生成中选区仍选中，完成后补丁直接显示。
  6. 拖拽/缩放已 completed 选区 → 补丁层临时隐藏，操作结束恢复。
  7. 下载/应用为原图 → 拼合结果与既有行为一致。
  8. MCP 快照仍正常推送 region 状态。

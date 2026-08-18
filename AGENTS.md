# genai-image-patcher — Agent 工作记忆

浏览器端 React 19 + Vite 的 AI 局部修图应用（选区重绘 / 漫画翻译）。**无后端**：图片与状态全在浏览器内存（React state + useImageManager store），配置在 localStorage。AI 调用全部浏览器直连（grsai / Gemini / OpenAI 兼容）。

## 核心数据模型与不变量（最重要的架构事实）

- **`originalUrl` = 全分辨率 AI 裁剪源，永不压缩**；`previewUrl` = 显示/处理用（`performanceMode === 'balanced'` 时压缩到 2048px / JPEG q0.8）。
- **AI 裁剪源是 `originalUrl`**（`useImageProcessor.ts` 取 `originalUrl || previewUrl`）——只改 `previewUrl` 不改 `originalUrl` 会导致"显示改了但 AI 拿到原图"。
- **最终输出拼合（应用为原图 / 下载 / ZIP / MCP get_full_image）基图必须用 `originalUrl`**：用 `previewUrl` 会在平衡模式下压到 2048px 导致画质下降（已修，见 `getStitchedUrl` 与 App 的 stitch 调用，勿改回）。
- `Region`：坐标为**相对整图的百分比 0-100**；`processedImageUrl` = AI 补丁或手动补丁；`anchorX/Y/W/H` 锚定拼合对齐；`restoreBoxes`/`restoreMaskUrl` 是补丁内的"还原原内容"区域；`errorMessage` 记录最近一次失败原因。
- 拼合是"原图 + 补丁叠放"，选区锚点百分比无关分辨率，全分辨率拼合自动正确。
- 单命令/拼合加载大图会瞬时占高内存（6000×8000 约 190MB），属预期。

## 关键陷阱（本 session 修复过的 bug，防止回归）

- **上传**：`input.files` 是实时视图（live FileList），必须先 `Array.from(input.files)` 物化、**再** `input.value = ''`——顺序反了上传静默失效（`App.tsx handleUpload`）。
- **应用为原图**（`handleApplyResultAsOriginal`）：必须同时更新 `originalUrl = stitchedUrl` 并保留 `finalResultUrl`，否则下载按钮消失、后续 AI 仍用原图。
- **MIME 过滤**：不要用 `f.type.startsWith('image/')` 一刀切丢弃空 type 的文件（部分环境 File.type 为空）——交给 `loadImage` 实际解码校验。
- 撤销/重做（`handleUndoImage`/`RedoImage`）必须恢复 `originalUrl`，历史快照 `ImageHistoryState` 携带各时点源。
- **回调签名陷阱**（本 session 踩过）：EditorCanvas 传给 App 的回调若签名为 `(imageId, regionId)` 两参，App 侧包装**必须透传两参**（`(imageId, regionId) => wrapper(imageId, regionId)`）；写成单参 `(regionId) => wrapper(selectedImage.id, regionId)` 会让 wrapper 收到 imageId 当 regionId，查无选区**静默 no-op**——点击无反应时先查参数透传。
- **选区级"应用为原图"**（✅ 调整后状态 = `handleApplyRegionAsOriginal`）：只烙**当前选区**——`stitchImage(img.originalUrl, [region])` 拼合 → 更新 `originalUrl`/`previewUrl`/`finalResultUrl` → 该选区回 pending（清补丁/还原/锚点）→ 推历史快照可撤销，其他选区不动。**不要**用整图 `handleApplyResultAsOriginal`（会清空全部选区）；拼合基图必须 `originalUrl`（保全分辨率）。
- **MCP 阻塞超时与重启**：`generate` 阻塞时长依赖 bridge `COMMAND_TIMEOUT_MS`（600s，`bridge/server.mjs`）与 `mcp/server.py` httpx `timeout=600`——两者须 ≥ 浏览器端最长生成；**改超时后必须重启 bridge/MCP 服务才生效**（MCP 自动拉起的旧实例仍带旧超时，长生成会被 120s/180s 旧超时打断）。

## 选区视图与工具栏交互（2026-08-16 新增）

- **`viewMode='result'`（顶部"预览"按钮）剩余用途**（勿误删）：① 多选区总览——工作视图只叠显**选中选区**的补丁，result 视图显示全部 completed 补丁；② 🔧 框选还原工具**硬依赖** result 视图（`isRestoreActive = restoreMode && viewMode === 'result'`，还原按钮只在 result 视图出现）；③ 反向遮罩模式整图结果展示（`App.tsx` `viewMode==='result' && useInvertedMasking && finalResultUrl` 分支）；④ 只读终审（result 视图框选/移动/缩放全被 `useCanvasInteraction` 拦截）。
- 工作视图补丁显示由 `shouldShowPatchOverlay` 谓词控制（`EditorCanvas.tsx`）：original 视图仅 `selectedRegionId === 该选区 && !showOriginalPreview && !拖拽/缩放中`；result 视图全部 completed。
- `showOriginalPreview` 是 EditorCanvas **本地 UI state**（"调整前/后"切换预览），不写 Region/历史/MCP 快照，选区切换时自动重置。
- 选区工具条（original 视图 + 选中时显示）：环形箭头=前后切换预览（非破坏，切到"调整前"琥珀高亮）；✅=提交当前预览（调整前→真删补丁 `resetRegion`；调整后→应用调整为新原图）；`failed` 选区保留原直接重置按钮。
- **按钮文案 key 别混用**：`viewEdit`/`viewPreview`（顶部视图切换按钮）；`readyToCreate` 仅空状态大标题用；`status_completed` 是选区状态徽章 key（`t(status_${region.status})`）——改按钮文案要新建 key，别改共享 key 的译文。
- 侧栏提示词区一次列出**所有选区**的 prompt 输入框（`promptRegionsLabel` = "选区 N"），不再"点一个显示一个"。

## grsai（gpt-image-2）特性

- 接口：`POST https://grsai.dakka.com.cn/v1/api/generate`，Bearer 认证；`images[]` 支持多参考图；`aspectRatio` 自由格式（直接传选区 `"WxH"` 像素即可）。
- **gpt-image-2 是"保真编辑"模型**：输入里白色遮罩区域会原样保留、不重绘。因此**"全图遮罩"模式（选区可见、其余涂白）对 grsai 不适用**（返回整图尺寸但只有选区内容）；gr sai 请用普通模式或反向遮罩。
- **参考图**：`[image 1]` 恒为选区切片，`[image 2]`+ 按标记顺序（MCP 快照 `referenceOrder` 给出，`[image N] = referenceOrder + 1`）；参考图被排除出处理队列与 ZIP 导出；仅 grsai 生效。
- 全局提示词是基底，区域级提示词**追加**在其后（非替换）。

## MCP 桥接（genai-bridge-mcp，人机协作改图）

- 三层：`mcp/server.py`（FastMCP 工具翻译）→ `bridge/server.mjs`（Node，127.0.0.1:3100，HTTP+WS+文件中转，MCP 自动拉起）→ `hooks/useBridge.ts`（浏览器侧，命令映射到 App 处理器 + 状态快照推送）。
- **注册在 `E:\LEON\小说` 项目级 opencode 配置**（非本仓库）；完整用法见全局 skill `genai-image-patcher`。
- 契约要点：所有工具返回**字符串**（成功为 JSON，失败以 `Error: ` 前缀）；`generate` **阻塞至完成才返回**（结果含 `processingState`：DONE=正常 / IDLE=出错或被停止；单次最长 10 分钟），客户端**无需轮询**；`get_full_image`/`get_region_patch` 返回带 `kind`；blob URL 出不了浏览器，取图必须走工具（base64 经 WS 中转）。
- 快照字段：`generationSeq`、`updatedAt`（变化=状态变动需重读 id）、region `errorMessage`、image `referenceOrder`。
- **参考图校准门禁（2026-08-17 新增，勿削弱）**：`bridge/server.mjs` 内 `calibration` 状态 + `gateGenerate()`。`generate` 前必须已 `review_references` 校准且签名一致，否则返回 `REFERENCE_CALIBRATION_REQUIRED`。**校准是一次性的**——每次 `generate`（成败皆然）通过门禁后即 `calibration=null`，强制下次生图重新评估参考图（防"上轮参考图沿用进不同任务"）。签名 = 按 `referenceOrder` 升序的参考图 id 列表（`refSignature()`，与 `mcp/server.py` 的 `_refs_sorted` 必须一致）。`set_calibration` 是 bridge 本地命令（不经 WS 转发），`/state` 暴露 `calibration.current` 供 `get_status` 读取。改门禁逻辑必须同步 `E:\LEON\pi-agent-development\LEON_ArtistAgent\mcp-servers\bridge\server.mjs` 与两份 `mcp/server.py`。

## 环境注意事项（本机）

- **HTTP_PROXY（127.0.0.1:7897）会破坏 PowerShell 的 `Invoke-RestMethod` 访问 127.0.0.1**（返回 502）——调试桥接用 Node fetch/curl 或先清代理变量；Python httpx 调用本机桥接需 `trust_env=False`。
- Python MCP 依赖：**`mcp>=1.0,<2`**（2.x 移除了 `FastMCP`，API 不兼容）；桥接 Node 依赖仅 `ws`。
- 本机环境有 OPENAI_API_KEY 占位（6 位），真实 key 在 opencode.json 的 grsai-mcp 配置里。
- **主题只剩 `light`/`dark`**（`ThemeType` 已收窄；`index.css` 删了 ocean/rose/forest 变量）。旧 localStorage 存了这些主题值时加载自动回落 light（`useConfig` 迁移校验，勿删）；应用标题用 `text-skin-text` 跟随主题（黑/白）。

## 验证与流程约定

- **仓库无测试框架**：验证 = `npx tsc --noEmit` + `npm run build`（仅既有 chunk-size 警告）+ 手动浏览器清单。
- 设计文档在 `docs/superpowers/specs/`，实现计划在 `docs/superpowers/plans/`；功能走 设计→计划→子代理执行→oracle 审查 流程。
- 用浏览器实际测 API/桥接前，先用探测脚本（Node/Python 直调）确认服务端契约，再改代码。
- **浏览器冒烟技巧**（无需 API key）：向补丁工坊"回填区"派发 `ClipboardEvent('paste', { clipboardData: DataTransfer(含 image File) })` 即可造出 completed 选区；画选区用合成鼠标事件（容器 `mousedown` → `window mousemove/mouseup`，事件间隔 ≥150ms 等 React 渲染与 effect 生效）。
- **EditorCanvas zoom 初始化靠 mount 时双重 rAF**：后台/节流标签页会卡在 `zoom=0.01`/`visibility:hidden` 数十秒——模拟交互前先等 `img[alt="Workarea"]` 容器 `visibility:visible`，必要时 `browser_focus_tab` 唤醒。

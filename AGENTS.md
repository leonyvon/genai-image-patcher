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

## grsai（gpt-image-2）特性

- 接口：`POST https://grsai.dakka.com.cn/v1/api/generate`，Bearer 认证；`images[]` 支持多参考图；`aspectRatio` 自由格式（直接传选区 `"WxH"` 像素即可）。
- **gpt-image-2 是"保真编辑"模型**：输入里白色遮罩区域会原样保留、不重绘。因此**"全图遮罩"模式（选区可见、其余涂白）对 grsai 不适用**（返回整图尺寸但只有选区内容）；gr sai 请用普通模式或反向遮罩。
- **参考图**：`[image 1]` 恒为选区切片，`[image 2]`+ 按标记顺序（MCP 快照 `referenceOrder` 给出，`[image N] = referenceOrder + 1`）；参考图被排除出处理队列与 ZIP 导出；仅 grsai 生效。
- 全局提示词是基底，区域级提示词**追加**在其后（非替换）。

## MCP 桥接（genai-bridge-mcp，人机协作改图）

- 三层：`mcp/server.py`（FastMCP 工具翻译）→ `bridge/server.mjs`（Node，127.0.0.1:3100，HTTP+WS+文件中转，MCP 自动拉起）→ `hooks/useBridge.ts`（浏览器侧，命令映射到 App 处理器 + 状态快照推送）。
- **注册在 `E:\LEON\小说` 项目级 opencode 配置**（非本仓库）；完整用法见全局 skill `genai-image-patcher`。
- 契约要点：所有工具返回**字符串**（成功为 JSON，失败以 `Error: ` 前缀）；`generate` 异步触发，轮询到 `processingState === "DONE"` **且 `generationSeq` 等于返回值**（否则可能是旧 DONE 或 noop）；`get_full_image`/`get_region_patch` 返回带 `kind`；blob URL 出不了浏览器，取图必须走工具（base64 经 WS 中转）。
- 快照字段：`generationSeq`、`updatedAt`（变化=状态变动需重读 id）、region `errorMessage`、image `referenceOrder`。

## 环境注意事项（本机）

- **HTTP_PROXY（127.0.0.1:7897）会破坏 PowerShell 的 `Invoke-RestMethod` 访问 127.0.0.1**（返回 502）——调试桥接用 Node fetch/curl 或先清代理变量；Python httpx 调用本机桥接需 `trust_env=False`。
- Python MCP 依赖：**`mcp>=1.0,<2`**（2.x 移除了 `FastMCP`，API 不兼容）；桥接 Node 依赖仅 `ws`。
- 本机环境有 OPENAI_API_KEY 占位（6 位），真实 key 在 opencode.json 的 grsai-mcp 配置里。

## 验证与流程约定

- **仓库无测试框架**：验证 = `npx tsc --noEmit` + `npm run build`（仅既有 chunk-size 警告）+ 手动浏览器清单。
- 设计文档在 `docs/superpowers/specs/`，实现计划在 `docs/superpowers/plans/`；功能走 设计→计划→子代理执行→oracle 审查 流程。
- 用浏览器实际测 API/桥接前，先用探测脚本（Node/Python 直调）确认服务端契约，再改代码。

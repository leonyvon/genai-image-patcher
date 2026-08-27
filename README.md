# GenAI Patcher Pro

GenAI Patcher Pro 是一个运行在浏览器中的 AI 局部修图与漫画翻译工作台。它允许用户上传一张或多张图片，在画布上绘制多个百分比选区，然后把选区切片、遮罩图或人工生成的补丁交给 AI，最后将补丁重新拼合回原图。

当前版本已经不是“前端页面 + 自有后端”的结构：图片、选区、补丁和处理状态主要存在浏览器内存中；AI provider 由浏览器直接调用；可选的 IOPaint、检测/OCR 服务以及 MCP 自动化通过本机 HTTP 接入。

## 项目定位

- React 19 + Vite 的单页工作台。
- 支持 Google Gemini、OpenAI 兼容接口和 grsai（GPT Image 2）。
- 支持局部编辑、全图遮罩、反向遮罩、翻译、手动补丁、漫画工具和本地 IOPaint 擦除。
- 支持 Codex/其他 MCP agent 通过 `mcp/server.py` 驱动本地工作台。
- 不持久化图库图片：刷新页面后，当前图片和生成结果会消失；配置和侧栏折叠状态会写入浏览器 `localStorage`。

## 快速开始

### 前置依赖

- Node.js 与 npm。
- 仅使用浏览器工作台时不需要 Python。
- 使用 MCP bridge 时需要 Python 3.11+、`uv`，依赖声明在 [`mcp/pyproject.toml`](mcp/pyproject.toml) 中。
- 使用本地擦除时需要单独安装 IOPaint；本机启动脚本默认尝试使用 `D:\anaconda3\envs\llm\python.exe`。

### 安装与启动

```powershell
npm install
npm run dev
```

打开 <http://127.0.0.1:3000>。

`npm run dev` 会先执行 `predev`。它会快速探测 `127.0.0.1:8080`，如果 IOPaint 不可达则在后台尝试启动 `anime-lama`，但不会等待模型加载完成，因此 IOPaint 不会阻塞 Vite 工作台启动。

也可以使用带端口竞态保护的启动脚本：

```powershell
npm run start:workbench
```

该脚本会使用 Windows 用户级互斥锁串行化启动检查，确保多个 MCP/终端调用不会同时抢占 3000 端口。`start:workbench` 内部等待 Vite 可访问后退出；`-OpenBrowser` 参数会调用系统默认浏览器：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\start-patcher.ps1 -OpenBrowser
```

### 启动 Node bridge

MCP server 会按需自动启动 bridge；需要单独调试时可以运行：

```powershell
npm run bridge
```

bridge 默认监听 `http://127.0.0.1:3100`，前端通过 `ws://127.0.0.1:3100/ws` 连接。可用 `BRIDGE_PORT` 覆盖端口。

### 启动 MCP server

从仓库根目录运行：

```powershell
uv sync --project .\mcp
uv run --project .\mcp genai-bridge
```

等价入口是 `python mcp/server.py`，但推荐使用 `uv`，这样会按照 [`mcp/pyproject.toml`](mcp/pyproject.toml) 中的版本范围安装 `mcp>=1.0,<2` 与 `httpx>=0.27`。

MCP 首次调用工具时会尝试启动 Vite 和 Node bridge。若返回 `appConnected=false`，需要在 Codex 内置浏览器打开：

```text
http://127.0.0.1:3000
```

然后重新调用 `get_status`。MCP 只负责本地服务和命令桥接，不注册 MCP Apps UI，也不会替代 agent 打开 Codex 内置浏览器。

## 基本使用流程

1. 在左侧图库上传单张图片、多个文件或文件夹，也可以在画布外按 `Ctrl+V` 粘贴图片。
2. 在中央画布拖拽绘制一个或多个矩形选区。选区坐标使用相对于整图的百分比 `0-100`，拖动或八个控制点可以移动、缩放选区。
3. 在左侧提示词区填写全局提示词；也可以给图片或单个选区填写追加提示词。
4. 在“连接设置”中选择 provider，填写 API 地址、模型和 API key。
5. 选择 API 生成模式并点击“开始生成”，或切换到“Codex 生成”/手动模式，直接粘贴或上传补丁。
6. 生成后切到“预览”查看所有已完成补丁；回到“编辑”继续调整。
7. 通过“下载结果”导出当前图片，或在图库中导出 `results.zip`。

可选操作包括：标记 grsai 参考图、自动检测漫画气泡、OCR、框选还原、涂抹还原、AI 可见草图画笔、水平翻转、调整选区大小、局部 IOPaint 擦除，以及把整图/单个选区应用为新的原图。

## 核心数据与分辨率规则

`types.ts` 定义了当前主要数据模型：

| 对象 | 作用 |
| --- | --- |
| `UploadedImage` | 图库图片、原图/预览 URL、选区、历史、整图结果和草图线条 |
| `Region` | 相对于整图的百分比矩形、状态、补丁 URL、锚点、提示词、还原信息 |
| `ImageHistoryState` | “应用为原图”时保存的可撤销快照 |
| `SketchStroke` | AI 输入用的矢量草图线条，不属于最终输出 |
| `RestoreBox` | 补丁内需要还原原内容的相对矩形 |

图片有三种重要 URL 语义：

- `originalUrl`：全分辨率 Blob Object URL，是 AI 局部裁剪和最终拼合的源。不要用压缩后的预览 URL 替代它。
- `previewUrl`：显示和部分遮罩处理使用的 URL。在 `performanceMode=balanced` 时最长边压到 2048 像素并使用 JPEG，降低大画布瞬时内存。
- `processedImageUrl`：一个选区的 AI/手动/IOPaint 补丁 URL，配合 `anchorX/Y/Width/Height` 进行拼合。

处理结果不是修改原图文件，而是“原图 + 已完成补丁”的叠放。标准拼合会按选区坐标裁剪，并按补丁锚点和 `object-fit: contain` 规则绘制；`fullImageOpaquePercent` 控制全图返回结果切片边缘的羽化范围。

浏览器中的中间图像尽量使用 Blob Object URL，只有在 AI API 或 MCP 文件传输需要时才转成 base64。删除图库、替换补丁、清空图库和历史淘汰时会释放 Object URL。大图仍会产生较高的瞬时 Canvas 内存峰值，这是浏览器图像处理的固有成本。

## 生成管线

### 标准局部生成

默认情况下，`useImageProcessor` 对每个待处理选区执行：

1. 以全分辨率 `originalUrl` 裁剪选区。
2. 将该选区内的 `sketchStrokes` 合成到发送给 AI 的切片中。
3. 按设置进行正方形填充和目标 KB 压缩；压缩只改变编码大小，不改变目标像素尺寸。
4. 调用所选 provider。
5. 将返回结果转换为 Blob URL；如果启用了正方形填充，先去除填充。
6. 写入 `processedImageUrl`，保存生成时的锚点，并在预览/下载时与原图拼合。

全局提示词始终是基础提示词；图片级和选区级用户提示词会追加在其后，不会把全局约束静默替换掉。翻译缓存块也会追加到最终 prompt 中。

### 全图遮罩与反向遮罩

启用 `useFullImageMasking` 后，应用创建全图尺寸的遮罩输入：

- 普通全图遮罩：选区可见，其余区域涂白。
- 反向遮罩：原图可见，选区涂白，AI 生成背景，再把原图选区覆盖回去。

反向模式会保存 `fullAiResultUrl` 和 `finalResultUrl`，移动或缩放选区后会重新拼合预览。`useInvertedMasking` 开启时正方形填充会在 UI 中禁用，因为反向模式的整图结果不需要那次往返。

对 gpt-image-2 来说，白色遮罩区域具有“保留/不重绘”的模型语义，因此需要局部重绘时应优先使用标准局部模式，或明确使用反向遮罩验证结果，不要把普通全图白遮罩当成通用的 gpt-image-2 重绘方式。

### 同尺寸完全重制

“同尺寸重制”是 grsai 标准局部模式的专用开关：

- 不发送选区切片。
- 根据选区百分比和原图尺寸计算精确的 `W×H` 像素尺寸。
- 将尺寸追加到 prompt，并把 grsai `aspectRatio` 设置为该精确尺寸。
- 仍然可以发送已经标记的全局参考图。

该开关在非 grsai provider 或全图遮罩模式下不可用。它要求模型从提示词/参考图重建选区，不是对原选区做保真编辑。

## Provider 与设置

### Google Gemini

使用 `@google/genai` 的原生 SDK，通过 `models.generateContent` 发送图片和 prompt。API key 可以在设置面板填写，也可以通过 Vite 环境变量 `GEMINI_API_KEY`/`API_KEY` 注入。默认模型是 `gemini-2.5-flash-image`，实际使用的模型可在设置中修改。

### OpenAI / Compatible

浏览器直接请求：

```text
<baseUrl>/v1/chat/completions
```

请求使用多模态 `messages`，支持普通 JSON 响应和可选 SSE 流式响应。结果解析支持兼容服务常见的 `message.images`、Markdown 图片、HTTP 图片 URL 和 base64 内容。模型列表按钮请求 `<baseUrl>/v1/models`（如果 base URL 已以 `/v1` 结尾则直接追加 `/models`）。

### grsai / GPT Image 2

请求固定发往：

```text
POST https://grsai.dakka.com.cn/v1/api/generate
```

普通局部编辑的请求数组是：

```text
images[0] = 选区切片
images[1..n] = 按标记顺序排列的全局参考图
```

因此普通局部模式下 prompt 中的 `[image 1]` 指选区切片，参考图从 `[image 2]` 开始。全尺寸重制会省略选区切片；此时发送数组中只有全局参考图，不能继续假设某张图一定是 `[image 2]`。

图库中的图片可通过星标标记为 grsai 参考图。标记时会压缩为最长边 1024、约 200 KB 的 base64，并写入 `config.grsaiReferenceImages`；有效参考图会从普通处理队列和 ZIP 导出中排除。参考图配置会在删除图库图片或清空图库时同步清理。

API key 会保存在浏览器 `localStorage` 配置中。项目没有自有后端代理，也没有把 key 写入仓库；在共享机器或不受信任的浏览器 profile 中使用前请自行评估风险。

## 漫画工具与手动画布

### Manga Mode

全局设置中的 Manga Mode 是漫画功能总开关，下方可以分别启用：

- 气泡/文字区域自动检测：调用配置中的 `detectionApiUrl`，默认 `http://localhost:5000/detect`。
- OCR：对选区调用 `ocrApiUrl`，默认 `http://localhost:5000/ocr`。
- 手动编辑器：打开懒加载的 `PatchEditor`，支持画笔和文字对象。
- 默认竖排文字与面板边界吸附。

检测服务和 OCR 服务不包含在本仓库中。它们必须支持浏览器 CORS，并按 `services/detectionService.ts` 中的 multipart 请求格式返回 JSON。

### 面板吸附

`panelSnapService.ts` 会在降采样灰度图上寻找白色分隔缝和连续深色格线，在约 80 原始像素范围内把新画出的矩形边缘吸附到可信面板边界。探测器在图片切换、原图变化或关闭设置时释放，不会阻塞拖框；尚未准备好时会退化为不吸附。

### 框选还原

结果视图中的“框选还原”是只读结果审阅后的修正工具，支持：

- 在补丁内部绘制普通还原框：还原该区域的原内容。
- 反向还原框：保留补丁区域、还原框外的内容。
- 涂抹式还原 mask。

这些数据写在 `Region.restoreBoxes`/`restoreMaskUrl` 中，仅影响拼合时的补丁显示。

### AI 草图画笔

编辑视图中的画笔保存为 `SketchStroke[]`，坐标仍是整图百分比。线条只会合成进下一次 AI 输入：

- 普通局部模式中，线条被裁剪到选区切片。
- 全图遮罩模式中，线条被合成到全图遮罩。
- 结果视图临时隐藏线条。
- 下载、ZIP、MCP `get_full_image` 和最终拼合都不会把线条写入成品。
- 橡皮擦按整条矢量线删除；清空按钮需要二次确认。

画笔重叠采用“后画覆盖先画”的扁平合成，不会因为透明度叠加而越来越深。

### IOPaint 擦除

IOPaint 是可选的本地 LaMa 擦除服务，不属于 React 应用后端。应用向：

```text
POST http://127.0.0.1:8080/api/v1/inpaint
```

发送 `{ image, mask }`，其中 mask 白色表示要重绘/移除区域。服务返回整图结果后，应用再按选区切出补丁并写回现有补丁管线。画布上的自由涂抹移除也会先生成任意形状 mask，再用涂抹区域外接矩形创建新的 Region。

## MCP 自动化

### 三层结构

```text
MCP agent
  │ stdio / FastMCP
  ▼
mcp/server.py
  │ HTTP 127.0.0.1:3100
  ▼
bridge/server.mjs
  │ WebSocket /ws
  ▼
hooks/useBridge.ts → App.tsx handlers
```

- `mcp/server.py`：FastMCP 工具层，负责自动启动 Vite/bridge、上传本地文件、落盘 MCP 返回的 base64。
- `bridge/server.mjs`：本机 HTTP + WebSocket + 临时文件中转；只绑定 `127.0.0.1`。
- `hooks/useBridge.ts` 与 `services/bridgeClient.ts`：浏览器侧连接、重连、命令分发和状态快照推送。
- `App.tsx`：把 MCP action 映射到真实 UI/React 状态操作。

### 当前 MCP 工具

| 工具 | 用途 |
| --- | --- |
| `start_patcher` | 确保 Vite/bridge 启动，返回工作台 URL 与 `appConnected` |
| `get_status` | 读取处理状态、图库、选区、参考图顺序和配置摘要 |
| `upload_image` | 从本地路径上传图片到浏览器图库 |
| `select_image` | 选择当前图片 |
| `mark_reference` / `unmark_reference` | 管理 grsai 全局参考图 |
| `set_prompt` | 设置全局、图片级或选区级完整 prompt |
| `set_region_full_redraw` | 开关 grsai 同尺寸完全重制 |
| `get_image` | 取图库原图，供 agent 临时落盘目检 |
| `review_references` | 在生成前逐张校准本次参考图集合 |
| `generate` | 生成当前图或全部未跳过图片，并阻塞等待完成 |
| `get_full_image` | 保存原图 + 补丁的最终整图 |
| `get_region_patch` | 保存单个选区补丁 |
| `set_region_patch` | 将本地生成图片作为已有选区的手动补丁 |

工具返回值是字符串：成功通常是 JSON，失败以 `Error: ` 开头。`get_full_image` 返回 `kind=full`，`get_region_patch` 返回 `kind=patch`，`get_image` 返回 `kind=original`。

### 参考图校准硬门禁

bridge 对 `generate` 实施系统级校准门禁。每次实际开始生成前都要调用：

```text
review_references(task_description, keep, remove, add)
```

推荐流程是：

1. `get_status` 读取当前参考图及其 `referenceOrder`。
2. 必要时用 `get_image` 将参考图保存到临时目录并进行目检。
3. `review_references` 明确本次保留、删除和新增的参考图。
4. 设置 prompt/选区后调用 `generate`。

`keep + remove` 必须覆盖当前所有参考图，不能漏掉一张，也不能同时放入两边。校准签名按参考图顺序生成；参考图集合变化后旧校准立即失效。一次校准只允许一次实际开始的生成消耗；`noop`、API 失败或尚未开始生成不会消耗它，可以直接修复后重试。

`set_region_patch` 是 Codex 原生生图/手动补丁链路，不需要参考图校准；它只替换已有选区，不会替 agent 创建选区。

### bridge HTTP/WS 端点

| 端点 | 作用 |
| --- | --- |
| `GET /health` | 返回 bridge 是否正常以及 `appConnected` |
| `GET /state` | 返回最新浏览器快照与校准状态 |
| `POST /command` | 将 action 转发给浏览器；`generate` 最长等待 10 分钟 |
| `POST /files?name=...` | 写入临时文件并返回 bridge `/files/...` URL |
| `GET /files/:id` | 读取临时文件 |
| `WS /ws` | 浏览器发送 state/result，bridge 发送 command |

bridge 临时文件目录是系统临时目录下的 `genai-bridge`。它不是长期资源存储，自动化流程应把需要保留的结果复制到项目外的明确输出目录。

## 目录结构

```text
.
├─ App.tsx                         # 顶层编排、MCP handlers、上传/导出/工具动作
├─ types.ts                        # Region、UploadedImage、AppConfig 等数据模型
├─ index.tsx / index.html          # React 挂载和 HTML 壳
├─ index.css                       # Tailwind v4、light/dark 主题变量
├─ components/
│  ├─ EditorCanvas.tsx             # 主画布、选区、预览、还原、画笔、IOPaint 涂抹
│  ├─ Sidebar.tsx                  # 图库、模式、prompt、执行、导出
│  ├─ PatchEditor.tsx               # 懒加载的局部画笔/文字编辑器
│  ├─ GlobalSettings.tsx            # 漫画、遮罩、翻译、IOPaint 等高级设置
│  ├─ HelpModal.tsx                 # 内置帮助
│  └─ sidebar/                      # 侧栏分区、漫画工具和手动补丁行
├─ hooks/
│  ├─ useImageManager.ts            # normalized store、Object URL 生命周期、历史与拼合缓存
│  ├─ useImageProcessor.ts          # 选区/整图生成、翻译、并发、停止、失败状态
│  ├─ useCanvasInteraction.ts       # 画布绘制/移动/缩放事件
│  ├─ usePanelSnap.ts               # 面板边界吸附生命周期
│  ├─ useConfig.ts                  # localStorage 配置、迁移和默认值
│  └─ useBridge.ts                  # 浏览器侧 WS bridge 接入
├─ services/
│  ├─ imageUtils.ts                 # 裁剪、遮罩、草图、去填充、还原和拼合
│  ├─ aiService.ts                  # Gemini/OpenAI-compatible/grsai provider
│  ├─ detectionService.ts           # 检测/OCR HTTP 客户端
│  ├─ iopaintService.ts             # 本地 IOPaint inpaint 客户端
│  ├─ panelSnapService.ts            # 纯 Canvas 面板检测算法
│  ├─ translations.ts               # 中英双语文案
│  └─ concurrencyUtils.ts            # semaphore 与并发任务调度
├─ bridge/
│  ├─ server.mjs                    # 本地 HTTP/WS bridge
│  └─ smoke.mjs                     # bridge 冒烟测试
├─ mcp/
│  ├─ server.py                     # FastMCP 工具服务
│  └─ pyproject.toml                # Python 依赖与入口
├─ scripts/
│  ├─ start-patcher.ps1             # 端口/并发安全的 Vite 启动器
│  └─ start-iopaint.ps1             # 异步启动可选 IOPaint
└─ docs/superpowers/                # 历史设计文档与实现计划
```

## 配置概览

配置键为 `genai_patcher_config_v3`，由 `hooks/useConfig.ts` 读取和迁移。主要配置组如下：

- Provider：`provider`、各 provider 的 base URL、API key、model、OpenAI stream。
- 执行：`executionMode`、`concurrencyLimit`、`apiTimeout`、`maxRetries`。
- 性能：`performanceMode`、AI payload 压缩和翻译/重绘目标 KB。
- 画布/生成：全局 prompt、全图遮罩、反向遮罩、羽化比例、正方形填充。
- 漫画：Manga Mode、气泡检测、OCR、手动编辑器、竖排文字、面板吸附。
- 翻译：翻译 endpoint、模型、上下文遮罩、翻译 prompt 和缓存槽位。
- 辅助服务：检测 URL、OCR URL、IOPaint URL。
- 界面：`light`/`dark` 主题和 `zh`/`en` 语言。

旧配置会合并默认值并执行字段迁移；历史上保存的 `ocean`、`rose`、`forest` 主题会自动回退为 `light`。不要删除这些迁移逻辑，否则已有用户的 localStorage 配置可能出现未定义字段。

## 开发与验证

仓库当前没有独立测试框架。日常验证使用：

```powershell
# TypeScript 类型检查
npx tsc --noEmit -p .

# Vite 生产构建
npm run build

# 可选：先启动 bridge，再运行 bridge 冒烟测试
npm run bridge
node .\bridge\smoke.mjs
```

生产构建可能提示 chunk size warning；应区分 warning 与真正的 TypeScript/build error。涉及 MCP、浏览器事件、Canvas 或大图内存的改动，还需要在真实浏览器中检查：

- `http://127.0.0.1:3000` 是否加载并连接 bridge。
- 上传、重复选择同一个文件、粘贴图片和文件夹上传是否有效。
- 选区绘制/移动/缩放、预览只读和结果拼合是否正确。
- 生成后实际补丁尺寸、整图尺寸和边缘融合是否符合预期。
- MCP `get_status` 的 `generationSeq`、`processingState`、选区 `errorMessage` 和 `referenceOrder` 是否反映本次操作。
- 大图在 `unlimited` 与 `balanced` 模式下的内存和速度是否可接受。

## 已知边界与维护要点

- 浏览器直连 AI API 受 CORS、provider 请求格式和服务商限流影响；本项目不会替 provider 修复兼容性。
- 图片不会写入数据库或磁盘；MCP 的 `get_*` 工具只有在显式提供输出路径时才将结果落盘。
- API key 存在浏览器 localStorage，不能视为加密密钥库。
- IOPaint、检测和 OCR 是外部服务；它们不可达时，AI 生成主流程仍可使用，但对应功能会失败。
- `generate` 会并发处理多个图片/选区，实际并发数受全局执行模式、`concurrencyLimit` 和 semaphore 共同约束；停止操作通过 AbortController 取消未完成请求并将 processing 选区退回 pending。
- 每张图片的应用历史最多保留 3 个快照；`PatchEditor` 自己有独立的局部编辑历史。不要把大图 base64 直接塞回 React state。
- `result` 视图是终审视图：它显示所有已完成补丁，禁止通过主画布移动/缩放选区；还原工具只在此视图工作。
- grsai 参考图校准是硬门禁。修改 `bridge/server.mjs`、`mcp/server.py` 或参考图顺序逻辑时，必须同时检查签名一致性和一次性消耗语义。
- bridge 的生成命令超时为 600 秒；如果调整浏览器/API 的最长生成时间，也要同步检查 bridge 和 MCP 的 HTTP timeout，并重启旧的 bridge/MCP 进程。

## 重要实现约定

修改代码前先阅读本目录的 [`AGENTS.md`](AGENTS.md)。当前最容易回归的约定包括：

1. `originalUrl` 是 AI 裁剪和最终拼合的全分辨率源；不要把 `previewUrl` 重新当作最终基图。
2. 文件上传必须先 `Array.from(input.files)`，再清空 `input.value`；`FileList` 是实时视图。
3. MCP 的 `set_region_patch` 必须复用 `handleManualPatchUpdate`，以便统一写入补丁状态、锚点和特殊全图分支。
4. EditorCanvas 回调的 `(imageId, regionId)` 两参数必须完整透传，错误的单参数包装会造成静默 no-op。
5. 草图画笔是独立 AI 输入层，不得写入最终拼合、下载、ZIP 或 MCP 取图结果。
6. 修改参考图校准门禁时，同时保持 bridge 与 MCP 的排序/签名算法一致；每次实际生成后校准应失效。

本 README 描述的是当前工作区代码，而不是旧版本的截图或历史功能列表。设计文档位于 [`docs/superpowers/specs/`](docs/superpowers/specs/)，实现计划位于 [`docs/superpowers/plans/`](docs/superpowers/plans/)。

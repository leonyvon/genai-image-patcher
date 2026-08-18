# genai-image-patcher MCP 桥接设计（人机协作）

日期：2026-08-15
状态：待实现

## 背景与目标

让 coding agent（如 opencode 中的 agent）能够通过 MCP 驱动本应用，形成"人机协作改图"闭环：

- **人**：在浏览器里框选选区、挂参考图、在对话中告诉 agent 要改什么
- **Agent**：通过 API 自动获取应用最新状态、上传图片、标记参考图、写提示词、触发生成、读取结果并迭代

应用是纯浏览器端 React 应用（状态在 React state + localStorage，无后端），Agent 的 MCP 服务器是本地 stdio 进程，两者之间需要一条本地桥接通路。

## 需求决策记录（已与用户确认）

| 决策点 | 结论 |
|---|---|
| Agent 能力范围 | **完整闭环**：读状态、上传图、标记/取消参考图、写提示词、选区切换、触发生成、读取结果、批量处理 |
| 选区归属 | 仅人框选，Agent 不程序化增删选区 |
| MCP 实现 | **Python FastMCP + uv**（与现有 grsai-mcp 一致） |
| 桥接架构 | **方案 A：独立 Node 桥接服务**（HTTP+WS+文件中转），由 MCP 启动时自动拉起 |
| 激活时机 | **dev 下应用自动连接**（`import.meta.env.DEV`），未连接时应用照常工作 |

## 架构

```
┌─────────────┐ stdio(MCP) ┌─────────────────┐ HTTP+WS ┌────────────────────┐ WS ┌──────────────┐
│ Coding Agent│ ◄────────► │ Python MCP 服务器│ ◄──────► │ Node 桥接服务        │ ◄─► │ React 应用    │
│  (opencode) │   (tools)  │  (FastMCP 工具层)│  :3100   │ (HTTP API+WS+文件)  │     │ (useBridge)  │
└─────────────┘            └─────────────────┘          └────────────────────┘     └──────────────┘
```

### 组件职责

1. **Python MCP 服务器**（`mcp/`，FastMCP + uv）
   - 只做工具翻译：Agent 调用 → HTTP 请求桥接服务
   - 启动时 spawn Node 桥接进程，退出时 kill

2. **Node 桥接服务**（`bridge/server.mjs`，依赖仅 `ws`，绑定 `127.0.0.1:3100`）
   - 解决关键约束：**blob URL 出不了浏览器**，图片字节必须经 WS 中转
   - HTTP 端点 + WebSocket 双通道

3. **React 侧 `useBridge`**（`hooks/useBridge.ts` + `services/bridgeClient.ts`）
   - dev 下自动连 `ws://127.0.0.1:3100`，断线每 3s 静默重试
   - 命令映射到应用现有处理器（见下表），状态变化防抖 300ms 推送快照

## 桥接协议

### HTTP（MCP → 桥接）

| 端点 | 用途 |
|---|---|
| `GET /health` | 存活检查（含 appConnected） |
| `GET /state` | 应用推送的最新状态快照（缓存，Agent 读状态零往返） |
| `POST /command` | `{action, params}` → WS 转发应用 → 阻塞等结果 → `{ok, result?}` |
| `POST /files` | 上传临时文件（Agent 本地图），返回 `{url, id}` |
| `GET /files/<id>` | 应用侧加载上传的图（blob） |

### WS 消息（桥接 ↔ 应用）

- 应用 → 桥接：`{type:'state', snapshot}`（防抖 300ms）、`{type:'result', id, ok, result?}`（命令回执）、`{type:'image-data', requestId, mime, base64}`（get_image 字节回传）
- 桥接 → 应用：`{type:'command', id, action, params}`

### 命令模型

`upload` / `select_image` / `mark_reference` / `unmark_reference` / `set_prompt` / `generate` / `get_image`

- **阻塞命令**：`generate` **阻塞至生成完成才返回**（结果含 `processingState`：DONE=正常/IDLE=出错停止；单次最长 10 分钟，bridge 与 MCP httpx 超时均已放宽）；`get_image` 为请求-响应（应用把结果 blob 转 base64 经 WS 回传，MCP 落盘）

## MCP 工具清单（FastMCP）

| 工具 | 参数 | 返回 |
|---|---|---|
| `get_status` | — | appConnected、processingState、图片列表（id/名称/尺寸/区域及状态与提示词/是否参考图/有无结果）、配置摘要（provider/model/全局提示词/参考图数） |
| `upload_image` | `paths: str[]` | 新增图片 id 列表 |
| `select_image` | `image_id` | ok |
| `mark_reference` | `image_id` | ok |
| `unmark_reference` | `image_id` | ok |
| `set_prompt` | `prompt`，`image_id?`，`region_id?` | ok（缺省=全局；有 region_id=区域；只给 image_id=图片） |
| `generate` | `scope: 'single'\|'all'` | 触发确认（含当前 processingState） |
| `get_image` | `image_id`，`region_id?`，`output_path` | 保存路径；无结果时明确报错提示先 generate |

## 应用侧命令 → 处理器映射

| 命令 | 应用处理器 |
|---|---|
| `upload` | fetch `/files/<id>` → File → `addImageFiles` |
| `select_image` | `handleSelectImage` |
| `mark_reference` / `unmark_reference` | `handleToggleReference`（按 isReference 分支） |
| `set_prompt` | region_id → `handleUpdateRegionPrompt`；image_id → `handleUpdateImagePrompt`；缺省 → `setConfig(prompt)` |
| `generate` | `handleProcess(scope === 'all')` |
| `get_image` | 把 image.finalResultUrl / region.processedImageUrl 转 base64 经 WS 回传 |

## 状态快照内容

- `images`: id、file name、originalWidth/Height、regions[{id, status, customPrompt, x,y,width,height, hasResult}]、isReference、hasResult
- `config`: provider、model（按 provider）、全局 prompt、processingMode、参考图数量
- `processingState`、`selectedImageId`、`bridgeConnected`

> 注意：blob URL 不出快照（Agent 无法访问），只给 `hasResult` 布尔；取结果走 `get_image`。

## 应用侧 UI

- **桥接状态徽标**：侧边栏顶部，绿=已连接、灰=未连接，悬停显示地址
- **Agent 操作实时可见**：复用同一套处理器，浏览器 UI 天然实时反映
- **连接降级**：任何一端不在，另一端照常工作

## 文件与安全

- 绑定 `127.0.0.1`，仅本机；无鉴权（本地开发工具，与 grsai-mcp 同信任模型）
- 临时文件：`os.tmpdir()/genai-bridge/`，随机 id，只读
- `get_image` 落盘到 Agent 指定 `output_path`（Agent 即用户进程，路径信任）
- 依赖：Node 仅 `ws`；Python `fastmcp` + `httpx`

## 目录结构新增

```
bridge/server.mjs          # Node 桥接（http + ws + 文件）
hooks/useBridge.ts         # React hook（连接 + 命令映射 + 状态快照）
services/bridgeClient.ts   # WS 客户端与协议封装（供 useBridge 使用）
mcp/server.py              # FastMCP 工具层
mcp/pyproject.toml         # uv 配置（仿 grsai-mcp）
```

package.json 新增：`ws` 依赖、`npm run bridge` 脚本。
opencode.json 注册 `genai-bridge-mcp`（`uv run --directory mcp server`，复用现有 MCP 配置模式）。

## 不做的事（YAGNI）

- Agent 程序化增删选区（人框选）
- 桥接鉴权 / 加密（本地单用户工具）
- 生产构建（build+preview）下启用桥接（dev 专用）
- Agent 直接改 API Key / 模型配置（由人在设置面板配置）

## 验证方式

- `npx tsc --noEmit` 与 `npm run build` 通过
- 手动验证：
  1. `npm run dev` 起应用 → 徽标变绿（桥接被 MCP 拉起或 `npm run bridge` 独立起）
  2. `get_status` 返回真实状态（上传图后能看到图片/区域）
  3. `upload_image` 上传本地图 → 浏览器图库出现
  4. `mark_reference` → 图库星标变金、角标出现
  5. `set_prompt` → 侧边栏提示词同步变化
  6. `generate` + 轮询 `get_status` → 完成后 `get_image` 落盘 → Agent 读到结果文件
  7. 桥接关闭时应用照常工作，徽标变灰

# 生成模式重命名 + codex 直接替换选区补丁 + 模式帮助 设计文档

- 日期：2026-08-25
- 状态：已批准（待实现计划）

## 1. 背景与目标

1. **模式标签重命名**：把「工作流模式」语义改为「生成模式」，两个子模式分别更名——「AI 自动生成」→「内置生成」、「手动修补工坊」→「codex生成」。`processingMode` 枚举值（`'api' | 'manual'`）与存储格式不变，只改显示文案。
2. **新能力：codex 直接替换选区补丁**。「手动修补工坊」的原始功能（人机协作、codex 通过 MCP 驱动）保留并作为 codex 生成模式的基础。新增：在 codex 生成模式下，codex 在本地产出图片后，可通过新增 MCP 工具 `set_region_patch(image_id, region_id, file_path)` **按现有手动修补链路**把该图片替换为选区的补丁（`processedImageUrl` + `status='completed'` + 锚点对齐），复用现有拼合/应用为原图/下载/ZIP 全链路。
3. **模式帮助**：生成模式区块标题旁新增圆形「?」图标，点击弹出帮助，解释「内置生成」与「codex生成」两种模式的区别。
4. **文档同步**：更新全局 skill `genai-image-patcher` 与 codex 插件缓存下的同名 skill，登记新工具与新模式语义。

设计决定（已与用户确认）：
- 英文标签：`codex生成` → `Codex Generation`；侧边栏 manual 区块标题 `workbenchTitle`（补丁工坊/Patch Workbench）同步更名保持一致。
- `set_region_patch` **任意生成模式可用**，不受 `processingMode` 门禁（桥接连接即可用）。
- 复用现有 `handleManualPatchUpdate` 链路，**不新增独立的状态写入逻辑**。

## 2. 标签重命名

`services/translations.ts`（zh 约 100-106 行，en 约 382-388 行）：

| key | zh（改后） | en（改后） |
|---|---|---|
| `modeTitle` | 生成模式 | Generation Mode |
| `modeApi` | 内置生成 | Built-in Generation |
| `modeManual` | codex生成 | Codex Generation |
| `workbenchTitle` | codex生成 | Codex Generation |

附带：`translations.ts` 与 `types.ts:106` 的 `// Workflow Mode(s)` 注释改为 `// Generation Mode(s)`。`types.ts` 的 `ProcessingMode` 类型与字段名 `processingMode` 不改。

## 3. 新 MCP 工具 `set_region_patch`

### 3.1 链路（与现有 manual 链路完全一致）

```
codex → mcp/server.py set_region_patch(image_id, region_id, file_path)
      → 读本地文件 → POST bridge /files?name=... 拿 {url}
      → POST bridge /command {action:'set_region_patch', params:{image_id, region_id, url}}
      → WS → App.tsx bridgeHandlers.set_region_patch
      → handleManualPatchUpdate(image_id, region_id, url)   // 现有入口，零新增状态逻辑
```

- `bridge/server.mjs` **零改动**（命令透传）。
- 不受 `review_references` 门禁约束（不是 generate）。

### 3.2 `mcp/server.py` 新工具

```python
@mcp.tool()
def set_region_patch(image_id: str, region_id: str, file_path: str) -> str:
    """把本地生成的图片文件作为补丁替换到指定选区。..."""
```

实现模式完全仿 `upload_image`：
1. `_ensure_bridge()` 校验桥接可达。
2. `Path(file_path).expanduser()` 校验文件存在，否则 `Error: 文件不存在: ...`。
3. `httpx.post(f"{BRIDGE_URL}/files?name={path.name}", content=path.read_bytes(), timeout=120, trust_env=False)` → `fdata["url"]`。
4. `_cmd("set_region_patch", {"image_id": image_id, "region_id": region_id, "url": fdata["url"]})`。
5. 成功 `_ok(res)`，失败 `_err(...)`。

### 3.3 `App.tsx` bridge handler

```ts
set_region_patch: async ({ image_id, region_id, url }) => {
  const img = images.find((i) => i.id === image_id);
  if (!img) return { ok: false, error: `image not found: ${image_id}` };
  const specialIds = ['special-full-image-mask', 'manual-full-image'];
  if (!specialIds.includes(region_id) && !img.regions.some((r) => r.id === region_id))
    return { ok: false, error: `region not found: ${region_id}` };
  if (typeof url !== 'string' || !url) return { ok: false, error: 'url is required' };
  handleManualPatchUpdate(image_id, region_id, url);
  return { ok: true, result: { image_id, region_id, status: 'completed' } };
},
```

要点：
- 校验 image 存在、region 存在（`special-full-image-mask` / `manual-full-image` 两个特殊 id 透传给现有 handler，维持既有全图遮罩语义）。
- `handleManualPatchUpdate` 已处理：单选区 → 设 `processedImageUrl`、`status='completed'`、`anchorX/Y/W/H = region.x/y/w/h`；全图遮罩 → 逐选区裁切或反向拼合。历史快照同样更新。
- 旧 `processedImageUrl` 为 blob URL 时 `releaseObjectURL` 释放；桥接 http URL 时是无害 no-op。
- 快照经 ~300ms 防抖自动推送，codex 后续 `get_status` / `get_region_patch` / `get_full_image` 直接可用。

### 3.4 契约要点（写进 skill 文档）

- 仅替换**已有**选区补丁；选区仍只能由人在浏览器框选（分工铁律不变，本工具不创建选区）。
- `file_path` 为 codex 本地生成的图片绝对路径（任意图片格式，与手动粘贴路径等价）。
- 与 `review_references` 门禁无关；任意生成模式可用。
- `region_id='special-full-image-mask'` 仅在应用启用「全图遮罩」模式时有意义。

## 4. 「?」模式帮助图标

- 位置：`components/Sidebar.tsx` 生成模式 `Section`（约 488 行）标题右侧。
- 组件扩展：`components/sidebar/Section.tsx` 新增可选 `onHelp?: () => void`，渲染一个圆形「?」小按钮（置于标题与折叠箭头之间），点击 `stopPropagation` 不触发展开/折叠。
- 交互：点击「?」弹出帮助层，解释两种模式。实现方式由设计者定（推荐：Section 内绝对定位的 popover，外层点击关闭）；禁止打开全局 HelpModal 这种重型交互。
- 文案：新增翻译 key（zh/en）：
  - `modeHelpTitle`：「两种生成模式」/「Two Generation Modes」
  - `modeHelpApiTitle`：「内置生成」/「Built-in Generation」
  - `modeHelpApiDesc`：内置 AI 生成。在应用内直接调用 AI 服务（grsai/OpenAI/Gemini）：框选选区 → 填提示词 → 点击生成，结果自动替换选区补丁。适合快速迭代、全程在浏览器完成。
  - `modeHelpCodexTitle`：「codex生成」/「Codex Generation」
  - `modeHelpCodexDesc`：Codex（编码 Agent）驱动改图。框选选区后，Codex 通过 MCP 工具读取选区/参考图/提示词、在对话内生成图片，并用 set_region_patch 把图片替换到选区。适合复杂任务、需要 Agent 自主判断的修图。
- 文案为设计基线，@designer 可微调排版，但不得改变两种模式的语义说明。

## 5. 文档同步

1. 全局 skill `C:\Users\LEON\.config\opencode\skills\genai-image-patcher\SKILL.md`：
   - 工具表 9 → 10，新增 `set_region_patch` 行（参数/返回/要点）。
   - 新增「codex 生成（set_region_patch）」小节：场景、调用序列（`get_status` 读 region x/y/w/h → 目检 → 生成 → `set_region_patch` → 取结果验证）。
   - 说明其与 `generate` 的关系（互不门禁、任意模式可用、不创建选区）。
2. codex 插件缓存 `C:\Users\LEON\.codex\plugins\cache\personal\leon-artist-agent\0.1.0+codex.20260817144358\skills\genai-image-patcher\SKILL.md`：
   - **该文件是独立演进版本**（含 `[image N]` 编号规则、同尺寸完全重制小节，比全局版新），**不能整体覆盖**。
   - 仅同步新增：工具表/正文加入 `set_region_patch` 说明与 codex 生成小节（保留其原有内容与结构）。
3. 仓库 `AGENTS.md`：补一条备忘——模式新标签（生成模式/内置生成/codex生成）+ `set_region_patch` 复用 `handleManualPatchUpdate` 链路（防回归：替换选区补丁不得绕过该入口）。

## 6. 验证方案

- `npx tsc --noEmit` + `npm run build`（仅既有 chunk-size 警告）。
- 桥接契约探测（改代码前先确认）：Node/Python 直调 `POST /files` + `POST /command`，验证 `set_region_patch` action 透传与返回。
- 浏览器冒烟：dev server 起后合成选区 → 用真实本地图片走 `set_region_patch`（经 bridge `/command`）→ `get_status` 快照确认 `hasResult=true`、`status=completed` → 截图确认补丁叠显。
- 「?」帮助：点击图标 → 帮助层出现、文案双语正确、外层点击关闭、不触发 Section 折叠。
- 标签：zh/en 切换后四个标签文案正确，`processingMode` 值不受影响。

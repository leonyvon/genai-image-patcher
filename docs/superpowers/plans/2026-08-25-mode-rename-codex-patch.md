# 生成模式重命名 + codex 直接替换选区补丁(set_region_patch) + 模式帮助 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把「工作流模式」标签改为「生成模式/内置生成/codex生成」；新增 MCP 工具 `set_region_patch` 让 codex 用本地图片文件按现有手动修补链路替换选区补丁；在生成模式区块加「?」帮助图标解释两种模式；同步全局与 codex 插件缓存 skill 文档。

**Architecture:** 复用现有 MCP→bridge(WS)→App handler 链路，仅新增一个桥接 action `set_region_patch`，浏览器侧直接调用现有 `handleManualPatchUpdate` 入口（设置 processedImageUrl/status/锚点），bridge/server.mjs 零改动。标签重命名只改 translations 文案，`processingMode` 枚举与存储不变。帮助 UI 扩展现有 Section 组件（可选 `onHelp` prop）+ 侧边栏 popover。

**Tech Stack:** React 19 + Vite + TypeScript；Python FastMCP (mcp>=1.0,<2)；Node bridge (ws)。

**验证基线**（仓库无测试框架）：`npx tsc --noEmit` + `npm run build`；桥接链路用 Node/Python 直调探测；浏览器冒烟用合成选区 + 真实图片。

---

### Task 1: 标签重命名 + modeHelp 翻译键

**Files:**
- Modify: `services/translations.ts:100-106`（zh 模式区）
- Modify: `services/translations.ts:382-388`（en 模式区）
- Modify: `types.ts:106`（注释）

- [ ] **Step 1: 改 zh 模式区（translations.ts 100-106 行）**

将：

```ts
    // Workflow Modes
    modeTitle: "工作流模式",
    modeApi: "AI 自动生成",
    modeManual: "手动修补工坊",
    
    // Manual Workbench
    workbenchTitle: "补丁工坊",
```

改为：

```ts
    // Generation Modes
    modeTitle: "生成模式",
    modeApi: "内置生成",
    modeManual: "codex生成",
    
    // Manual Workbench
    workbenchTitle: "codex生成",
```

- [ ] **Step 2: 改 en 模式区（translations.ts 382-388 行）**

将：

```ts
    // Workflow Modes
    modeTitle: "Workflow Mode",
    modeApi: "AI Generation",
    modeManual: "Patch Workbench",
    
    // Manual Workbench
    workbenchTitle: "Patch Workbench",
```

改为：

```ts
    // Generation Modes
    modeTitle: "Generation Mode",
    modeApi: "Built-in Generation",
    modeManual: "Codex Generation",
    
    // Manual Workbench
    workbenchTitle: "Codex Generation",
```

- [ ] **Step 3: 新增 zh 帮助键（translations.ts，`noRegions` 行之后插入）**

```ts
    // Generation Mode Help
    modeHelpTitle: "两种生成模式",
    modeHelpApiTitle: "内置生成",
    modeHelpApiDesc: "在应用内直接调用 AI 服务（grsai/OpenAI/Gemini）：框选选区 → 填写提示词 → 点击生成，结果自动替换选区补丁。适合快速迭代，全程在浏览器完成。",
    modeHelpCodexTitle: "codex生成",
    modeHelpCodexDesc: "由 Codex（编码 Agent）通过 MCP 工具驱动改图：框选选区后，Codex 读取选区与参考图、在对话内生成图片，并用 set_region_patch 把图片替换到选区。适合复杂任务，需要 Agent 自主判断。",
```

- [ ] **Step 4: 新增 en 帮助键（translations.ts 对应 en 区块）**

```ts
    // Generation Mode Help
    modeHelpTitle: "Two Generation Modes",
    modeHelpApiTitle: "Built-in Generation",
    modeHelpApiDesc: "Generate in-app via AI providers (grsai/OpenAI/Gemini): draw a region, write a prompt, click Generate — the result replaces the region patch automatically. Best for quick iteration, all inside the browser.",
    modeHelpCodexTitle: "Codex Generation",
    modeHelpCodexDesc: "Codex (a coding agent) drives the app via MCP tools: after you draw a region, Codex reads the region and references, generates an image in-chat, then swaps it into the region via set_region_patch. Best for complex tasks needing agent judgment.",
```

- [ ] **Step 5: 改 types.ts 注释**

`types.ts:106`：`  // Workflow Mode` → `  // Generation Mode`

- [ ] **Step 6: 验证**

Run: `npx tsc --noEmit`
Expected: 无错误（仅可能既有警告）。

- [ ] **Step 7: 提交**

```bash
git add services/translations.ts types.ts
git commit -m "feat: 生成模式重命名（内置生成/codex生成）+ 模式帮助文案键"
```

---

### Task 2: App.tsx 新增 bridge handler `set_region_patch`

**Files:**
- Modify: `App.tsx:249`（`set_region_full_redraw` handler 之后、`generate` 之前插入）

- [ ] **Step 1: 在 bridgeHandlers 中新增 handler**

在 `App.tsx` 第 249 行 `set_region_full_redraw` 闭包结束 `},` 之后、第 250 行 `generate:` 之前插入：

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

注意：
- `handleManualPatchUpdate`（App.tsx:347）已存在，处理单选区/全图遮罩/整图三种 region_id，勿改动它。
- `images`、`handleManualPatchUpdate` 均在 handler 闭包作用域内（同 `bridgeHandlers` 定义处）。

- [ ] **Step 2: 验证**

Run: `npx tsc --noEmit`
Expected: 无错误。

- [ ] **Step 3: 提交**

```bash
git add App.tsx
git commit -m "feat: bridge 新增 set_region_patch action，复用 handleManualPatchUpdate 替换选区补丁"
```

---

### Task 3: mcp/server.py 新增工具 `set_region_patch`

**Files:**
- Modify: `mcp/server.py`（`get_region_patch` 工具之后、`def main()` 之前插入）

- [ ] **Step 1: 新增 MCP 工具**

在 `mcp/server.py` 第 307 行 `get_region_patch` 的 `return _ok({...})` 之后、第 310 行 `def main():` 之前插入：

```python
@mcp.tool()
def set_region_patch(image_id: str, region_id: str, file_path: str) -> str:
    """把本地生成的图片文件作为补丁替换到指定选区（codex 生成模式）。file_path 为本地图片绝对路径（codex 自行生成的图片）。
    应用侧按现有手动修补链路把该图设为选区补丁（status→completed、锚点对齐），之后 get_region_patch / get_full_image 立即可取。
    注意：只替换已有选区，不创建选区；与 generate 的参考图门禁无关，任意生成模式可用。"""
    if not _ensure_bridge():
        return _err("桥接服务不可达")
    path = Path(file_path).expanduser()
    if not path.is_file():
        return _err(f"文件不存在: {file_path}")
    try:
        r = httpx.post(
            f"{BRIDGE_URL}/files?name={path.name}",
            content=path.read_bytes(),
            timeout=120,
            trust_env=False,
        )
        r.raise_for_status()
        fdata = r.json()
    except Exception as e:
        return _err(f"上传文件失败 {file_path}: {e}")
    res = _cmd("set_region_patch", {"image_id": image_id, "region_id": region_id, "url": fdata["url"]})
    return _ok(res) if res.get("ok") else _err(str(res.get("error")))
```

- [ ] **Step 2: 语法验证**

Run: `mcp\.venv\Scripts\python.exe -m py_compile mcp\server.py`
Expected: 无输出（成功）。

- [ ] **Step 3: 提交**

```bash
git add mcp/server.py
git commit -m "feat: MCP 新增 set_region_patch 工具（codex 本地图片替换选区补丁）"
```

---

### Task 4: 「?」模式帮助 UI（@designer lane）

**Files:**
- Modify: `components/sidebar/Section.tsx`
- Modify: `components/Sidebar.tsx:488`（生成模式 Section）

**需求（设计基线，视觉/交互由 designer 自由发挥但不得改变语义）：**

- [ ] **Step 1: Section 组件扩展可选 `onHelp` prop**

`Section.tsx` props 新增 `onHelp?: () => void`。当存在时，在标题与折叠箭头之间渲染一个圆形「?」小按钮，`onClick={(e) => { e.stopPropagation(); onHelp(); }}`（不得触发展开/折叠）。样式跟随现有 `text-skin-*` 体系。`title` prop 保持 string 类型不变（其他 Section 调用点不受影响）。

- [ ] **Step 2: Sidebar 生成模式区块接入帮助 popover**

`components/Sidebar.tsx:488` 的生成模式 `<Section>` 传 `onHelp={() => setModeHelpOpen(true)}`。帮助层推荐为 Section 内绝对定位 popover（或等效轻量浮层），内容用 Task 1 新增键渲染：

```tsx
t(lang, 'modeHelpTitle')
t(lang, 'modeHelpApiTitle')   + t(lang, 'modeHelpApiDesc')
t(lang, 'modeHelpCodexTitle') + t(lang, 'modeHelpCodexDesc')
```

交互要求：
- 点击「?」打开；外层点击 / Esc 关闭；打开状态下不干扰 Section 展开/折叠与模式切换按钮。
- 双层结构清晰区分「内置生成 / codex生成」，视觉层级：标题加粗、描述次要（参考 HelpModal 的 `renderSection` 层级，但尺寸更小）。
- 移动端（窄侧栏）下 popover 不得溢出屏幕。
- **禁止**打开全局 HelpModal。

- [ ] **Step 3: 验证**

Run: `npx tsc --noEmit` + `npm run build`
Expected: 无错误，仅既有 chunk-size 警告。

- [ ] **Step 4: 浏览器冒烟**

dev server 起后：切换 zh/en 各点一次「?」→ 帮助层出现、文案正确、外层点击关闭、Section 折叠行为不受影响。截图确认。

- [ ] **Step 5: 提交**

```bash
git add components/sidebar/Section.tsx components/Sidebar.tsx
git commit -m "feat: 生成模式区块新增「?」帮助，解释内置生成与 codex生成"
```

---

### Task 5: 文档同步（全局 skill + codex 插件缓存 skill + AGENTS.md）

**Files:**
- Modify: `C:\Users\LEON\.config\opencode\skills\genai-image-patcher\SKILL.md`
- Modify: `C:\Users\LEON\.codex\plugins\cache\personal\leon-artist-agent\0.1.0+codex.20260817144358\skills\genai-image-patcher\SKILL.md`（**独立演进版本，保留其 [image N]/同尺寸完全重制内容，只做增量**）
- Modify: `AGENTS.md`

- [ ] **Step 1: 全局 skill 工具表 + 新增小节**

`C:\Users\LEON\.config\opencode\skills\genai-image-patcher\SKILL.md`：
1. 概述中「9 个工具」→「10 个工具」。
2. 工具速查表追加一行：

```markdown
| `set_region_patch` | `image_id`, `region_id`, `file_path` | ok + `{"image_id","region_id","status":"completed"}` | **codex 生成模式**：把本地生成的图片文件替换为选区补丁（复用手动修补链路：status→completed、锚点对齐）。不创建选区；与参考图门禁无关；任意模式可用。之后 `get_region_patch`/`get_full_image` 立即可取 |
```

3. 「标准工作流」后新增小节：

```markdown
## codex 生成模式（set_region_patch，不触发 AI 生成）

应用处于「codex生成」模式时，codex 可绕过内置 AI 管线，把自己生成的图片直接替换进选区：

1. `get_status` 读目标 region（快照 region 含 `x/y/width/height` 百分比与 `hasResult`），确认 id 有效
2. `get_image(image_id, tmp.png)` 目检原图 → 在 codex 对话内生成/编辑选区图片（本地保存）
3. `set_region_patch(image_id, region_id, file_path)` 把该图片替换为选区补丁
4. `get_region_patch` 或 `get_full_image` 导出验证

**注意**：`set_region_patch` 只替换**已有**选区，不创建选区（分工铁律不变）；不经 `review_references` 门禁、不消耗校准；任意生成模式可用。参考图仍是 generate 专用约束，与替换补丁无关。
```

- [ ] **Step 2: codex 插件缓存 skill 增量同步**

`C:\Users\LEON\.codex\plugins\cache\personal\leon-artist-agent\0.1.0+codex.20260817144358\skills\genai-image-patcher\SKILL.md`：**保留该文件全部现有内容**（[image N] 编号规则、同尺寸完全重制、参考图组合策略等），仅：
1. 概述处「提供一组工具」保持不动（它未写死数量）。
2. 「标准工作流」第 9 步后追加同样标题的「codex 生成模式（set_region_patch…）」小节（内容同 Step 1 的第 3 条，含工具速查行）。
3. 在「陷阱与边界」追加一条：`set_region_patch` 只替换已有选区、不经参考图门禁、任意模式可用。

- [ ] **Step 3: 仓库 AGENTS.md 备忘**

`AGENTS.md` 「关键陷阱」区块末尾追加：

```markdown
- **模式标签**：工作流模式已更名「生成模式」（子项：内置生成=api / codex生成=manual）；`processingMode` 枚举不变。
- **set_region_patch**（codex 生成链路）：MCP 工具 → bridge `/files` 上传 → `App.tsx bridgeHandlers.set_region_patch` → **必须复用 `handleManualPatchUpdate`** 设 `processedImageUrl`+`status='completed'`+锚点（勿绕过该入口直接改 Region；全图遮罩走 `special-full-image-mask` 分支）。
```

- [ ] **Step 4: 提交（仅仓库内文件）**

```bash
git add AGENTS.md
git commit -m "docs: AGENTS.md 记录生成模式新标签与 set_region_patch 复用链路"
```

（全局 skill / codex 缓存 skill 在仓库外，不提交。）

---

### Task 6: 集成验证

**Files:** 无（只验证）

- [ ] **Step 1: 静态构建**

Run: `npx tsc --noEmit && npm run build`
Expected: 无 TS 错误；build 仅既有 chunk-size 警告。

- [ ] **Step 2: 桥接契约探测（改代码后的真实链路）**

先启动 dev server 并打开浏览器（`npm run dev`，仅 dev 构建连桥接），再手动起 bridge：`node bridge\server.mjs`（或让 MCP 拉起）。

用 Node 探测脚本（临时文件 `C:\Users\LEON\AppData\Local\Temp\opencode\probe-set-region-patch.mjs`）：

```js
// 1) 上传本地图片到 bridge
const fs = await import('node:fs');
const imgPath = process.argv[2]; // 一张本地测试图
const up = await fetch('http://127.0.0.1:3100/files?name=probe.png', { method: 'POST', body: fs.readFileSync(imgPath) });
const { url } = await up.json();
console.log('uploaded url:', url);
// 2) 读 state 拿 image_id / region_id
const state = await (await fetch('http://127.0.0.1:3100/state')).json();
const img = state.images[0];
console.log('image_id:', img?.id, 'first region:', img?.regions?.[0]?.id);
// 3) 发 set_region_patch 命令
const res = await fetch('http://127.0.0.1:3100/command', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ action: 'set_region_patch', params: { image_id: img.id, region_id: img.regions[0].id, url } }),
});
console.log('command result:', JSON.stringify(await res.json()));
```

Expected：`command result` 含 `"ok":true`；再 `get_status`（桥接 `/state`）确认该 region `hasResult:true`、浏览器中补丁叠显。

- [ ] **Step 3: 「?」帮助与标签冒烟**

浏览器 zh/en 各验证：模式标签文案（生成模式/内置生成/codex生成）、「?」帮助层文案与关闭交互、切换模式后 `processingMode` 值不变（`/state` 的 config.processingMode）。

- [ ] **Step 4: 最终提交（如有验证期修复）**

```bash
git add -A
git commit -m "fix: 集成验证修复"
```
（仅当 Step 1-3 发现问题时执行；干净则跳过。）

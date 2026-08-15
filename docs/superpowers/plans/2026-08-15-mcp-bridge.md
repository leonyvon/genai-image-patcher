# genai-image-patcher MCP 桥接实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 coding agent 通过 Python MCP 服务器驱动浏览器端改图应用，形成"人框选 + Agent 操作"的协作闭环。

**Architecture:** 三层：Python FastMCP 服务器（工具翻译）→ Node 桥接服务（`127.0.0.1:3100`，HTTP+WS+文件中转）→ React 应用 `useBridge` hook（命令映射到现有处理器、状态快照推送）。命令经 WS 转发应用执行并回执；`generate` 异步触发后轮询状态；`get_image` 把 blob 结果转 base64 经 WS 回传落盘。

**Tech Stack:** Node `ws`、React/TS、Python FastMCP + httpx（uv）。设计文档：`docs/superpowers/specs/2026-08-15-mcp-bridge-design.md`。

**验证方式说明（与仓库既有实践一致）：** 本仓库无测试框架。前端改动以 `npx tsc --noEmit` + `npm run build` 验收；桥接与 MCP 用独立 smoke 脚本验证（`bridge/smoke.mjs`、`python -c` 直调工具函数）；端到端以手动清单验收。

---

### Task 1: Node 桥接服务 + package.json 依赖

**Files:**
- Modify: `package.json`（依赖 + 脚本）
- Create: `bridge/server.mjs`
- Create: `bridge/smoke.mjs`（可重复的冒烟测试工具）

- [ ] **Step 1: package.json 增加 ws 依赖与 bridge 脚本**

修改 `package.json` 的 `dependencies`（`"jszip": "3.10.1",` 之后）增加：

```json
    "ws": "^8.18.0",
```

修改 `scripts`（`"preview": "vite preview"` 之后）增加：

```json
    "bridge": "node bridge/server.mjs",
```

Run: `npm install`
Expected: 安装完成，`node_modules/ws` 存在。

- [ ] **Step 2: 创建 bridge/server.mjs**

创建 `bridge/server.mjs`：

```js
// bridge/server.mjs — genai-image-patcher 本地桥接服务
// HTTP API + WebSocket + 文件中转。仅绑定 127.0.0.1。由 MCP 服务器自动拉起，或 npm run bridge 独立运行。
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { promises as fs, createWriteStream, createReadStream } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = Number(process.env.BRIDGE_PORT || 3100);
const HOST = '127.0.0.1';
const FILE_DIR = path.join(os.tmpdir(), 'genai-bridge');
const COMMAND_TIMEOUT_MS = 120000;

await fs.mkdir(FILE_DIR, { recursive: true });

let appSocket = null; // 应用（浏览器）的 WS 连接
let latestState = {
  processingState: 'IDLE',
  selectedImageId: null,
  images: [],
  config: {},
};
const pendingCommands = new Map(); // id -> { timer, resolve, reject }

const json = (res, code, obj) => {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
};

const httpServer = createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (req.method === 'GET' && url.pathname === '/health') {
    json(res, 200, { ok: true, appConnected: !!appSocket });
    return;
  }
  if (req.method === 'GET' && url.pathname === '/state') {
    json(res, 200, latestState);
    return;
  }
  if (req.method === 'POST' && url.pathname === '/command') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      let cmd;
      try { cmd = JSON.parse(body); } catch { json(res, 400, { error: 'bad json' }); return; }
      if (!appSocket) { json(res, 503, { error: 'app not connected' }); return; }
      const id = randomUUID();
      const timer = setTimeout(() => {
        if (pendingCommands.delete(id)) json(res, 504, { error: 'command timeout' });
      }, COMMAND_TIMEOUT_MS);
      pendingCommands.set(id, {
        timer,
        resolve: (outcome) => { clearTimeout(timer); json(res, 200, outcome); },
        reject: (err) => { clearTimeout(timer); json(res, 502, { ok: false, error: String(err) }); },
      });
      appSocket.send(JSON.stringify({ type: 'command', id, action: cmd.action, params: cmd.params || {} }));
    });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/files') {
    const id = randomUUID();
    const ext = path.extname(url.searchParams.get('name') || '');
    const filePath = path.join(FILE_DIR, id + ext);
    const out = createWriteStream(filePath);
    req.pipe(out);
    req.on('end', () => {
      json(res, 200, { id, url: `http://${HOST}:${PORT}/files/${id}${ext}` });
    });
    req.on('error', () => { json(res, 500, { error: 'write failed' }); });
    return;
  }
  if (req.method === 'GET' && url.pathname.startsWith('/files/')) {
    const filePath = path.join(FILE_DIR, path.basename(url.pathname));
    createReadStream(filePath).on('error', () => { json(res, 404, { error: 'not found' }); }).pipe(res);
    return;
  }
  json(res, 404, { error: 'not found' });
});

const { WebSocketServer } = await import('ws');
const wss = new WebSocketServer({ server: httpServer, path: '/ws' });
wss.on('connection', (socket) => {
  appSocket = socket;
  socket.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.type === 'state') {
      latestState = msg.snapshot;
    } else if (msg.type === 'result') {
      const p = pendingCommands.get(msg.id);
      if (p) {
        pendingCommands.delete(msg.id);
        clearTimeout(p.timer);
        msg.ok ? p.resolve({ ok: true, result: msg.result ?? null }) : p.resolve({ ok: false, error: msg.error || 'command failed' });
      }
    }
  });
  socket.on('close', () => { if (appSocket === socket) appSocket = null; });
});

httpServer.listen(PORT, HOST, () => {
  console.log(`[bridge] listening on http://${HOST}:${PORT}`);
});
```

- [ ] **Step 3: 创建 bridge/smoke.mjs（冒烟测试）**

创建 `bridge/smoke.mjs`：

```js
// bridge/smoke.mjs — 冒烟测试：需先启动桥接（npm run bridge）
// 验证 /health、/state、WS 状态推送、/command 无应用时的 503。
import WebSocket from 'ws';

const BASE = 'http://127.0.0.1:3100';
const assert = (cond, label) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}: ${label}`);
  if (!cond) process.exitCode = 1;
};

const health = await fetch(`${BASE}/health`).then((r) => r.json());
assert(health.ok === true, '/health ok');

const state0 = await fetch(`${BASE}/state`).then((r) => r.json());
assert(Array.isArray(state0.images), '/state 返回 images 数组');

// WS 推送状态 → /state 回读
const ws = new WebSocket('ws://127.0.0.1:3100/ws');
await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
ws.send(JSON.stringify({ type: 'state', snapshot: { bridgeConnected: true, fake: 'hello', images: [1] } }));
await new Promise((r) => setTimeout(r, 300));
const state1 = await fetch(`${BASE}/state`).then((r) => r.json());
assert(state1.fake === 'hello', 'WS 状态推送回读');
ws.close();

// 无应用时 /command 返回 503
const cmdRes = await fetch(`${BASE}/command`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ action: 'select_image', params: { image_id: 'x' } }),
});
assert(cmdRes.status === 503, '/command 无应用时 503');

console.log('smoke done');
```

- [ ] **Step 4: 运行冒烟测试**

Run: `npm run bridge`（后台/另一终端）
Run: `node bridge/smoke.mjs`
Expected: 全部 `PASS`，退出码 0。

- [ ] **Step 5: 提交**

```bash
git add package.json package-lock.json bridge/
git commit -m "feat: Node 桥接服务（HTTP+WS+文件中转）与冒烟测试"
```

---

### Task 2: services/bridgeClient.ts（WS 协议客户端）

**Files:**
- Create: `services/bridgeClient.ts`

- [ ] **Step 1: 创建 BridgeClient**

创建 `services/bridgeClient.ts`：

```ts
// services/bridgeClient.ts — 浏览器侧桥接 WS 客户端。
// 负责连接/重连、命令请求-响应、状态快照推送。
export interface BridgeRegionInfo {
  id: string;
  status: string;
  x: number; y: number; width: number; height: number;
  customPrompt: string | null;
  hasResult: boolean;
}

export interface BridgeImageInfo {
  id: string;
  name: string;
  width: number;
  height: number;
  isReference: boolean;
  hasResult: boolean;
  regions: BridgeRegionInfo[];
}

export interface BridgeStateSnapshot {
  processingState: string;
  selectedImageId: string | null;
  images: BridgeImageInfo[];
  config: {
    provider: string;
    model: string;
    prompt: string;
    processingMode: string;
    referenceCount: number;
  };
}

export interface BridgeOutcome {
  ok: boolean;
  result?: any;
  error?: string;
}

type CommandHandler = (action: string, params: any) => Promise<any>;

export class BridgeClient {
  private ws: WebSocket | null = null;
  private url: string;
  private commandHandler: CommandHandler | null = null;
  private connectionHandler: ((connected: boolean) => void) | null = null;
  private commandResolvers = new Map<string, (r: BridgeOutcome) => void>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  connected = false;

  constructor(url: string) {
    this.url = url;
  }

  setCommandHandler(h: CommandHandler) {
    this.commandHandler = h;
  }

  setConnectionHandler(h: (connected: boolean) => void) {
    this.connectionHandler = h;
  }

  connect() {
    if (this.closed) return;
    const ws = new WebSocket(this.url);
    this.ws = ws;

    ws.onopen = () => {
      this.connected = true;
      this.connectionHandler?.(true);
    };

    ws.onmessage = async (ev) => {
      let msg: any;
      try { msg = JSON.parse(ev.data as string); } catch { return; }
      if (msg.type !== 'command') return;
      let outcome: BridgeOutcome;
      try {
        const result = this.commandHandler ? await this.commandHandler(msg.action, msg.params ?? {}) : { error: 'no handler' };
        outcome = result && typeof result === 'object' && 'ok' in result ? result as BridgeOutcome : { ok: true, result };
      } catch (e) {
        outcome = { ok: false, error: (e as Error).message || String(e) };
      }
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'result', id: msg.id, ...outcome }));
      }
    };

    ws.onclose = () => {
      this.connected = false;
      this.connectionHandler?.(false);
      this.commandResolvers.forEach((r) => r({ ok: false, error: 'bridge disconnected' }));
      this.commandResolvers.clear();
      if (!this.closed) {
        this.reconnectTimer = setTimeout(() => this.connect(), 3000);
      }
    };

    ws.onerror = () => { /* close follows */ };
  }

  sendState(snapshot: BridgeStateSnapshot) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'state', snapshot }));
    }
  }

  close() {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
  }
}
```

- [ ] **Step 2: 类型检查**

Run: `npx tsc --noEmit`
Expected: exit 0

- [ ] **Step 3: 提交**

```bash
git add services/bridgeClient.ts
git commit -m "feat: 浏览器侧桥接 WS 客户端"
```

---

### Task 3: useImageManager 返回 id + hooks/useBridge.ts + App 接线

**Files:**
- Modify: `hooks/useImageManager.ts:122-171`（addImageFiles 返回新增 id）
- Create: `hooks/useBridge.ts`
- Modify: `App.tsx`（快照 useMemo、handlers、useBridge 调用、bridgeConnected 传递）

- [ ] **Step 1: addImageFiles 返回新增图片 id**

把 `hooks/useImageManager.ts` 的 `addImageFiles` 签名改为返回 `Promise<string[]>`，并在函数末尾 `if (newImages.length > 0) {...}` 块之后返回 id 列表。修改三处：

签名（第 122 行）：
```ts
  const addImageFiles = async (fileList: File[]): Promise<string[]> => {
```

在 `setStore(...)` 与 `handleSelectImage` 逻辑之后（第 186 行附近 `handleSelectImage(firstAddedId);` 之后、函数闭合 `};` 前）追加：

```ts
    return newImages.map((i) => i.id);
```

并把函数末尾现有的 `}` 改为 `};`（若尚未闭合）。同时在 `if (newImages.length > 0) {` 块之前无需改动——`newImages` 空数组时返回 `[]` 即可（在 `return newImages.map(...)` 前无需提前 return）。

Run: `npx tsc --noEmit` → Expected: exit 0

- [ ] **Step 2: 创建 hooks/useBridge.ts**

创建 `hooks/useBridge.ts`：

```ts
// hooks/useBridge.ts — 把桥接命令映射到应用处理器，并推送状态快照。
import { useEffect, useRef, useState } from 'react';
import { BridgeClient, BridgeStateSnapshot } from '../services/bridgeClient';

export interface BridgeHandlerMap {
  [action: string]: (params: any) => Promise<any> | any;
}

export interface UseBridgeOptions {
  enabled: boolean;
  url?: string;
  snapshot: BridgeStateSnapshot | null;
  handlers: BridgeHandlerMap;
}

export function useBridge({ enabled, url = 'ws://127.0.0.1:3100/ws', snapshot, handlers }: UseBridgeOptions) {
  const [connected, setConnected] = useState(false);
  const clientRef = useRef<BridgeClient | null>(null);
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;
  const pushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!enabled) return;
    const client = new BridgeClient(url);
    clientRef.current = client;
    client.setConnectionHandler(setConnected);
    client.setCommandHandler(async (action, params) => {
      const h = handlersRef.current[action];
      if (!h) return { error: `unknown action: ${action}` };
      return h(params);
    });
    client.connect();
    return () => {
      client.close();
      clientRef.current = null;
      if (pushTimerRef.current) clearTimeout(pushTimerRef.current);
    };
  }, [enabled, url]);

  useEffect(() => {
    if (!enabled || !connected || !snapshot) return;
    if (pushTimerRef.current) clearTimeout(pushTimerRef.current);
    pushTimerRef.current = setTimeout(() => {
      clientRef.current?.sendState(snapshotRef.current!);
    }, 300);
  }, [enabled, connected, snapshot]);

  return { connected };
}
```

- [ ] **Step 3: App.tsx 接线**

在 App.tsx 顶部导入处追加（第 3-13 行区域）：

```ts
import { useBridge, BridgeHandlerMap } from './hooks/useBridge';
import { BridgeStateSnapshot } from './services/bridgeClient';
```

（`urlToBase64` 与 `isEffectiveReference` 已在 imageUtils 导入中——确认 `isEffectiveReference` 在现有 imageUtils 导入列表中，若没有则追加。）

在 `handleToggleReference` / `handleDeleteImageWithReferenceCleanup` 定义之后（约第 121 行之后）插入：

```tsx
  // --- MCP Bridge ---
  // 快照不含 bridgeConnected 字段（该字段已从 BridgeStateSnapshot 类型移除）；
  // 连接状态由桥接 /health 的 appConnected 提供，Agent 经 get_status 读取。
  const bridgeSnapshot = useMemo<BridgeStateSnapshot | null>(() => ({
    processingState,
    selectedImageId,
    images: images.map((img) => ({
      id: img.id,
      name: img.file.name,
      width: img.originalWidth,
      height: img.originalHeight,
      isReference: isEffectiveReference(img, config.grsaiReferenceImages),
      hasResult: !!img.finalResultUrl || img.regions.some((r) => !!r.processedImageUrl),
      regions: img.regions.map((r) => ({
        id: r.id,
        status: r.status,
        x: r.x, y: r.y, width: r.width, height: r.height,
        customPrompt: r.customPrompt ?? null,
        hasResult: !!r.processedImageUrl,
      })),
    })),
    config: {
      provider: config.provider,
      model: config.provider === 'openai' ? config.openaiModel : config.provider === 'grsai' ? config.grsaiModel : config.geminiModel,
      prompt: config.prompt,
      processingMode: config.processingMode,
      referenceCount: config.grsaiReferenceImages.length,
    },
  }), [images, config, processingState, selectedImageId]);

  const bridgeHandlers: BridgeHandlerMap = {
    upload: async ({ files }) => {
      if (!Array.isArray(files) || files.length === 0) return { error: 'no files in params' };
      try {
        const fileObjs = await Promise.all(files.map(async (f: any) => {
          const blob = await fetch(f.url).then((r) => r.blob());
          return new File([blob], f.name || 'upload.png', { type: blob.type || 'image/png' });
        }));
        const ids = await addImageFiles(fileObjs);
        return { ok: true, result: { ids } };
      } catch (e) {
        return { error: (e as Error).message || String(e) };
      }
    },
    select_image: async ({ image_id }) => {
      if (!images.some((i) => i.id === image_id)) return { error: `image not found: ${image_id}` };
      handleSelectImage(image_id);
      return { ok: true };
    },
    mark_reference: async ({ image_id }) => {
      const img = images.find((i) => i.id === image_id);
      if (!img) return { error: `image not found: ${image_id}` };
      if (isEffectiveReference(img, config.grsaiReferenceImages)) return { ok: true };
      await handleToggleReference(image_id);
      return { ok: true };
    },
    unmark_reference: async ({ image_id }) => {
      const img = images.find((i) => i.id === image_id);
      if (!img) return { error: `image not found: ${image_id}` };
      if (!isEffectiveReference(img, config.grsaiReferenceImages)) return { ok: true };
      await handleToggleReference(image_id);
      return { ok: true };
    },
    set_prompt: async ({ prompt, image_id, region_id }) => {
      if (typeof prompt !== 'string' || !prompt) return { error: 'prompt is required' };
      if (image_id && region_id) {
        handleUpdateRegionPrompt(image_id, region_id, prompt);
      } else if (image_id) {
        handleUpdateImagePrompt(image_id, prompt);
      } else {
        setConfig((prev) => ({ ...prev, prompt }));
      }
      return { ok: true };
    },
    generate: async ({ scope }) => {
      handleProcess(scope === 'all');
      return { ok: true };
    },
    get_image: async ({ image_id, region_id }) => {
      const img = images.find((i) => i.id === image_id);
      if (!img) return { error: `image not found: ${image_id}` };
      let url: string | null = null;
      if (region_id) {
        url = img.regions.find((r) => r.id === region_id)?.processedImageUrl ?? null;
      } else {
        url = img.finalResultUrl ?? img.fullAiResultUrl ?? null;
      }
      if (!url) return { error: 'no result available yet — run generate first' };
      const dataUrl = await urlToBase64(url);
      const [header, base64] = dataUrl.split(',');
      const mime = header.match(/:(.*?);/)?.[1] || 'image/png';
      return { ok: true, result: { mime, base64 } };
    },
  };

  const { connected: bridgeConnected } = useBridge({
    enabled: import.meta.env.DEV,
    snapshot: bridgeSnapshot,
    handlers: bridgeHandlers,
  });
```

> 声明顺序说明：`bridgeSnapshot` 的 `useMemo` 在 `useBridge` 调用之前声明，且快照不再引用 `bridgeConnected`，不存在 TDZ/声明前引用问题。`bridgeConnected` 仅用于徽标展示与 `/health` 无关，Agent 侧连接状态以 `get_status`（桥接 `/health` 的 appConnected）为准。

把 `<Sidebar` 的 props（约第 548 行 `getStitchedUrl={getStitchedUrl}` 之前）增加：

```tsx
        bridgeConnected={bridgeConnected}
```

- [ ] **Step 4: 类型检查与构建**

Run: `npx tsc --noEmit` → Expected: exit 0
Run: `npm run build` → Expected: built，仅既有 chunk-size 警告

- [ ] **Step 5: 提交**

```bash
git add hooks/useImageManager.ts hooks/useBridge.ts App.tsx
git commit -m "feat: useBridge 接线（命令映射/状态快照/生成与结果获取）"
```

---

### Task 4: 侧边栏桥接状态徽标

**Files:**
- Modify: `components/Sidebar.tsx`（props 类型 + 解构 + 徽标 JSX）

- [ ] **Step 1: SidebarProps 增加 bridgeConnected**

在 `SidebarProps` 接口（`getStitchedUrl: (image: UploadedImage) => Promise<string>;` 之后）增加：

```ts
  /** MCP bridge connection status, shown as a status dot in the header. */
  bridgeConnected: boolean;
```

在组件函数解构（`getStitchedUrl` 之后）增加：

```ts
  bridgeConnected,
```

- [ ] **Step 2: 头部增加徽标**

在头部右上角按钮组（`<div className="absolute top-3 right-3 flex gap-1">` 内，齿轮按钮之前）插入：

```tsx
             <span
               className={`self-center w-2 h-2 rounded-full transition-colors ${bridgeConnected ? 'bg-emerald-500' : 'bg-zinc-400'}`}
               title={bridgeConnected ? 'MCP Bridge connected (127.0.0.1:3100)' : 'MCP Bridge disconnected'}
             />
```

- [ ] **Step 3: 类型检查与构建**

Run: `npx tsc --noEmit` → Expected: exit 0
Run: `npm run build` → Expected: built

- [ ] **Step 4: 提交**

```bash
git add components/Sidebar.tsx
git commit -m "feat: 侧边栏桥接状态徽标"
```

---

### Task 5: Python MCP 服务器

**Files:**
- Create: `mcp/pyproject.toml`
- Create: `mcp/server.py`

- [ ] **Step 1: 创建 mcp/pyproject.toml**

创建 `mcp/pyproject.toml`（结构与 grsai-mcp 对齐）：

```toml
[project]
name = "genai-bridge-mcp"
version = "0.1.0"
requires-python = ">=3.11"
dependencies = [
    "mcp>=1.0",
    "httpx>=0.27",
]

[project.scripts]
genai-bridge = "server:main"

[build-system]
requires = ["setuptools>=61"]
build-backend = "setuptools.build_meta"
```

- [ ] **Step 2: 创建 mcp/server.py**

创建 `mcp/server.py`：

```python
"""MCP server for genai-image-patcher bridge.

Coding agents use these tools to drive the browser app: read state, upload
images, mark reference images, write prompts, trigger generation and retrieve
results. Requires the Node bridge (bridge/server.mjs) to be reachable; this
server attempts to spawn it from the repo if it is not running.
"""

import atexit
import base64
import json
import os
import shutil
import subprocess
import time
from pathlib import Path

import httpx
from mcp.server.fastmcp import FastMCP

BRIDGE_URL = os.environ.get("GENAI_BRIDGE_URL", "http://127.0.0.1:3100")
REPO_ROOT = Path(__file__).resolve().parent.parent
BRIDGE_SCRIPT = REPO_ROOT / "bridge" / "server.mjs"

mcp = FastMCP("genai-bridge")
_bridge_proc: subprocess.Popen | None = None


def _ensure_bridge() -> bool:
    """Return True if the bridge is reachable, spawning it when needed."""
    try:
        return httpx.get(f"{BRIDGE_URL}/health", timeout=2).status_code == 200
    except Exception:
        pass
    global _bridge_proc
    node = shutil.which("node")
    if not node or not BRIDGE_SCRIPT.is_file():
        return False
    try:
        _bridge_proc = subprocess.Popen(
            [node, str(BRIDGE_SCRIPT)],
            cwd=str(REPO_ROOT),
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    except Exception:
        return False
    for _ in range(25):
        try:
            if httpx.get(f"{BRIDGE_URL}/health", timeout=1).status_code == 200:
                return True
        except Exception:
            pass
        time.sleep(0.2)
    return False


def _get() -> dict:
    r = httpx.get(f"{BRIDGE_URL}/state", timeout=10)
    r.raise_for_status()
    return r.json()


def _cmd(action: str, params: dict | None = None) -> dict:
    r = httpx.post(
        f"{BRIDGE_URL}/command",
        json={"action": action, "params": params or {}},
        timeout=180,
    )
    r.raise_for_status()
    return r.json()


def _ok(data) -> str:
    return json.dumps(data, ensure_ascii=False)


def _err(msg: str) -> str:
    return f"Error: {msg}"


@mcp.tool()
def get_status() -> str:
    """获取应用当前状态：连接状态、处理进度、图库图片列表（含选区与提示词）、配置摘要。"""
    if not _ensure_bridge():
        return _err(f"桥接服务不可达（{BRIDGE_URL}）。请先运行 npm run dev 启动应用。")
    try:
        return _ok(_get())
    except Exception as e:
        return _err(str(e))


@mcp.tool()
def upload_image(paths: list[str]) -> str:
    """上传本地图片到应用图库。paths 为本地文件路径列表。返回新增图片 id 列表。"""
    if not _ensure_bridge():
        return _err("桥接服务不可达")
    added: list[str] = []
    for p in paths:
        path = Path(p).expanduser()
        if not path.is_file():
            return _err(f"文件不存在: {p}")
        try:
            r = httpx.post(
                f"{BRIDGE_URL}/files?name={path.name}",
                content=path.read_bytes(),
                timeout=120,
            )
            r.raise_for_status()
            fdata = r.json()
        except Exception as e:
            return _err(f"上传文件失败 {p}: {e}")
        res = _cmd("upload", {"files": [{"url": fdata["url"], "name": path.name}]})
        if not res.get("ok"):
            return _err(str(res.get("error")))
        added.extend(res.get("result") or [])
    return _ok({"added": added})


@mcp.tool()
def select_image(image_id: str) -> str:
    """切换应用当前选中的图片（后续 generate(scope='single') 默认处理该图）。"""
    if not _ensure_bridge():
        return _err("桥接服务不可达")
    res = _cmd("select_image", {"image_id": image_id})
    return _ok(res) if res.get("ok") else _err(str(res.get("error")))


@mcp.tool()
def mark_reference(image_id: str) -> str:
    """把图库中的一张图片标记为 grsai 参考图（提示词从 [image 2] 开始引用）。"""
    if not _ensure_bridge():
        return _err("桥接服务不可达")
    res = _cmd("mark_reference", {"image_id": image_id})
    return _ok(res) if res.get("ok") else _err(str(res.get("error")))


@mcp.tool()
def unmark_reference(image_id: str) -> str:
    """取消图片的参考图标记。"""
    if not _ensure_bridge():
        return _err("桥接服务不可达")
    res = _cmd("unmark_reference", {"image_id": image_id})
    return _ok(res) if res.get("ok") else _err(str(res.get("error")))


@mcp.tool()
def set_prompt(prompt: str, image_id: str | None = None, region_id: str | None = None) -> str:
    """设置提示词。缺省=全局提示词；给 image_id=该图片提示词；给 image_id+region_id=该选区提示词。"""
    if not _ensure_bridge():
        return _err("桥接服务不可达")
    res = _cmd("set_prompt", {"prompt": prompt, "image_id": image_id, "region_id": region_id})
    return _ok(res) if res.get("ok") else _err(str(res.get("error")))


@mcp.tool()
def generate(scope: str = "single") -> str:
    """触发生成。scope: 'single'（当前选中图）或 'all'（全部未跳过图）。立即返回，轮询 get_status 的 processingState 直到 IDLE。"""
    if not _ensure_bridge():
        return _err("桥接服务不可达")
    res = _cmd("generate", {"scope": scope})
    return _ok(res) if res.get("ok") else _err(str(res.get("error")))


@mcp.tool()
def get_image(image_id: str, output_path: str, region_id: str | None = None) -> str:
    """把生成结果保存为本地文件。image_id 必填；region_id 给定时取该选区补丁，否则取整图结果。无结果时提示先 generate。"""
    if not _ensure_bridge():
        return _err("桥接服务不可达")
    res = _cmd("get_image", {"image_id": image_id, "region_id": region_id})
    if not res.get("ok"):
        return _err(str(res.get("error")))
    result = res.get("result") or {}
    b64 = result.get("base64")
    if not b64:
        return _err("未获得图片数据（可能尚无结果，请先 generate）")
    try:
        out = Path(output_path).expanduser()
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_bytes(base64.b64decode(b64))
    except Exception as e:
        return _err(f"写文件失败: {e}")
    return _ok({"path": str(out), "mime": result.get("mime", "image/png")})


def main():
    atexit.register(lambda: _bridge_proc and _bridge_proc.terminate())
    mcp.run()


if __name__ == "__main__":
    main()
```

- [ ] **Step 3: 依赖安装与函数级验证**

Run（在仓库根目录）：
```powershell
cd mcp; uv sync; cd ..
```
Expected: 创建 `.venv`，安装 mcp/httpx。

启动桥接：`npm run bridge`（后台）。然后验证工具函数（不经过 MCP 传输，直接调 Python 函数，需要桥接与浏览器应用——无浏览器时 get_status 仍返回默认快照）：

Run: `uv run --directory mcp python -c "import server; print(server.get_status())"`
Expected: 输出包含 `"bridgeConnected"` 与 `"images"` 的 JSON（桥接在跑；应用未连时 images 为空数组）。

- [ ] **Step 4: 提交**

```bash
git add mcp/
git commit -m "feat: Python MCP 服务器（8 个工具）"
```

---

### Task 6: opencode.json 注册 + 端到端验证

**Files:**
- Modify: `C:\Users\LEON\.config\opencode\opencode.json`（注册 MCP）

- [ ] **Step 1: 注册 genai-bridge-mcp**

在 `C:\Users\LEON\.config\opencode\opencode.json` 的 `"mcp": {}` 块内（`"grsai-mcp": {...}` 之后）增加：

```json
    "genai-bridge-mcp": {
      "type": "local",
      "command": [
        "uv",
        "run",
        "--directory",
        "E:\\LEON\\genai-image-patcher\\mcp",
        "genai-bridge"
      ],
      "enabled": true
    }
```

- [ ] **Step 2: 端到端手动验证清单**

按以下顺序验证（需 `npm run dev` 起应用 + opencode 已加载新 MCP）：
1. 浏览器打开应用 → 侧边栏顶部出现**绿色**桥接徽标（桥接由 MCP 自动拉起）
2. `get_status` → 返回真实图片列表/选区/配置
3. `upload_image` 上传本地图 → 浏览器图库出现新图
4. `mark_reference` → 图库星标变金、`[image N]` 角标出现
5. `set_prompt` → 侧边栏提示词同步更新
6. 人框选一个区域 → `get_status` 能看到该选区 → `generate` → 轮询 `get_status` 至 `processingState: "DONE"` → `get_image` 落盘 → 读取结果文件评估
7. 关闭浏览器/桥接 → 其余功能不受影响

- [ ] **Step 3: 提交（opencode.json 不入仓库，跳过 git；如有其他尾料一并提交）**

```bash
git status --short
```

若有未提交的本次功能文件，追加提交；无则跳过。

---

## 自审说明

**与 TDD 的偏离（有意）**：仓库无测试框架，前端沿用 tsc+build 验收；桥接与 MCP 用 `bridge/smoke.mjs` 与 `python -c` 直调做函数级验证；端到端以手动清单收尾。与既有 grsai 集成、参考图功能的验证模式一致。

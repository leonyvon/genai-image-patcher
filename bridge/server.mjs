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
const COMMAND_TIMEOUT_MS = 600000; // 10 min — generate 现为阻塞式，需覆盖整次生成耗时

await fs.mkdir(FILE_DIR, { recursive: true });

let appSocket = null; // 应用（浏览器）的 WS 连接
let latestState = {
  processingState: 'IDLE',
  selectedImageId: null,
  images: [],
  config: {},
};
const pendingCommands = new Map(); // id -> { timer, resolve, reject }

// —— 参考图校准门禁（系统层强制）——
// 校准签名 = 按 referenceOrder 升序的参考图 id 列表（紧凑 JSON，与 mcp/server.py 的
// json.dumps(..., separators=(',', ':')) 完全一致，勿改格式）。generate 前必须匹配，否则拦截。
// 校准为一次性：仅当 generate 实际开始生成（结果带 generationSeq）后才被消耗；
// API 失败 / noop / 未开始生成不消耗，可直接重试。set_prompt、重新框选不影响校准。
let calibration = null; // { signature: string, task: string, at: number } | null — 当前有效校准（一次性）
let lastCalibration = null; // 最近一次校准记录（仅用于错误提示，不参与门禁）

function refSignature(state) {
  const refs = (state?.images || [])
    .filter((i) => i.isReference)
    .sort((a, b) => (a.referenceOrder ?? 0) - (b.referenceOrder ?? 0))
    .map((i) => i.id);
  return JSON.stringify(refs);
}

function gateGenerate() {
  const current = refSignature(latestState);
  const currentRefs = (latestState?.images || [])
    .filter((i) => i.isReference)
    .sort((a, b) => (a.referenceOrder ?? 0) - (b.referenceOrder ?? 0))
    .map((i) => ({ id: i.id, name: i.name, referenceOrder: i.referenceOrder }));
  if (!calibration) {
    const hint = lastCalibration
      ? `上次校准（${lastCalibration.task}）已被一次实际开始的生成消耗，需重新校准`
      : '尚未校准参考图';
    return {
      ok: false,
      error: `REFERENCE_CALIBRATION_REQUIRED: ${hint}。当前参考图: ${JSON.stringify(currentRefs)}。请先调用 review_references(task_description, keep, remove, add) 逐张检查是否需要删除/添加，再 generate。`,
    };
  }
  if (calibration.signature !== current) {
    return {
      ok: false,
      error: `REFERENCE_CALIBRATION_REQUIRED: 参考图自上次校准后已变动（当前: ${JSON.stringify(currentRefs)}，校准于: ${calibration.task}）。必须重新调用 review_references 校准后再 generate。`,
    };
  }
  return null;
}

const json = (res, code, obj) => {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
};

const originAllowed = (origin) => {
  if (!origin) return true; // 非浏览器调用（MCP/curl/smoke）
  return origin.startsWith('http://localhost:') || origin.startsWith('http://127.0.0.1:');
};

const httpServer = createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method !== 'OPTIONS' && !originAllowed(req.headers.origin)) {
    json(res, 403, { error: 'origin not allowed' });
    return;
  }
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (req.method === 'GET' && url.pathname === '/health') {
    json(res, 200, { ok: true, appConnected: !!appSocket });
    return;
  }
  if (req.method === 'GET' && url.pathname === '/state') {
    json(res, 200, {
      ...latestState,
      calibration: calibration
        ? { ...calibration, current: calibration.signature === refSignature(latestState) }
        : null,
    });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/command') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      let cmd;
      try { cmd = JSON.parse(body); } catch { json(res, 400, { error: 'bad json' }); return; }
      if (!appSocket) { json(res, 503, { error: 'app not connected' }); return; }
      // 参考图校准门禁：generate 前强制校验（不在此消耗校准——只有实际开始生成后才消耗）
      if (cmd.action === 'generate') {
        const blocked = gateGenerate();
        if (blocked) { json(res, 200, blocked); return; }
      }
      // 校准记录（由 review_references 工具调用）
      if (cmd.action === 'set_calibration') {
        const { signature, task } = cmd.params || {};
        if (typeof signature !== 'string') { json(res, 200, { ok: false, error: 'signature is required' }); return; }
        calibration = { signature, task: task || '', at: Date.now() };
        lastCalibration = calibration;
        json(res, 200, { ok: true, result: { calibrated: true, signature, task: task || '' } });
        return;
      }
      const id = randomUUID();
      const timer = setTimeout(() => {
        if (pendingCommands.delete(id)) json(res, 504, { error: 'command timeout' });
      }, COMMAND_TIMEOUT_MS);
      pendingCommands.set(id, {
        timer,
        action: cmd.action,
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
    out.on('error', () => { try { json(res, 500, { error: 'write failed' }); } catch {} });
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
const wss = new WebSocketServer({
  server: httpServer,
  path: '/ws',
  verifyClient: (info, cb) => cb(originAllowed(info.origin)),
});
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
        // 一次性校准：仅当 generate 实际开始生成（结果带 generationSeq）才消耗；
        // noop / API 失败 / 未开始生成不消耗，允许直接重试。
        if (p.action === 'generate' && msg.ok && msg.result && typeof msg.result.generationSeq === 'number') {
          calibration = null;
        }
        msg.ok ? p.resolve({ ok: true, result: msg.result ?? null }) : p.resolve({ ok: false, error: msg.error || 'command failed' });
      }
    }
  });
  socket.on('close', () => {
    if (appSocket === socket) appSocket = null;
    pendingCommands.forEach((p) => {
      clearTimeout(p.timer);
      p.resolve({ ok: false, error: 'app disconnected' });
    });
    pendingCommands.clear();
  });
});

httpServer.listen(PORT, HOST, () => {
  console.log(`[bridge] listening on http://${HOST}:${PORT}`);
});

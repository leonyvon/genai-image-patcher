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

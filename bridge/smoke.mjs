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

// 等待 WS 完全关闭，确保服务端 appSocket 已清空后再测 /command（避免关闭竞态）
const closed = new Promise((res) => ws.on('close', res));
ws.close();
await closed;

// 无应用时 /command 返回 503
const cmdRes = await fetch(`${BASE}/command`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ action: 'select_image', params: { image_id: 'x' } }),
});
assert(cmdRes.status === 503, '/command 无应用时 503');

console.log('smoke done');

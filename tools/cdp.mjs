// 通用 CDP 命令行：node cdp.mjs <端口> "<JS表达式>"
// 附加到已运行的 Copilot 主界面，执行表达式并打印结果（支持 async）
import fs from 'node:fs';

const PORT = Number(process.argv[2]);
const EXPR = process.argv[3];
if (!PORT || !EXPR) { console.error('用法: node cdp.mjs <端口> "<表达式>"'); process.exit(1); }

const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = targets.find((t) => t.type === 'page' && (t.url || '').includes('tauri.localhost'));
if (!page) { console.error('没找到主界面'); process.exit(1); }

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.addEventListener('open', r, { once: true }); ws.addEventListener('error', j, { once: true }); });
let id = 0; const pending = new Map();
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); }
});
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const i = ++id; pending.set(i, { resolve, reject }); ws.send(JSON.stringify({ id: i, method, params }));
});

const r = await send('Runtime.evaluate', { expression: EXPR, returnByValue: true, awaitPromise: true, userGesture: true });
if (r.exceptionDetails) console.error('异常:', r.exceptionDetails.exception?.description || r.exceptionDetails.text);
else console.log(typeof r.result.value === 'string' ? r.result.value : JSON.stringify(r.result.value, null, 2));
ws.close();

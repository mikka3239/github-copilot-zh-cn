// 通过 CDP 截取主界面画面，保存为 PNG
// 用法: node shot.mjs <端口> <输出文件名> [要先点击的按钮文字]
import fs from 'node:fs';
import path from 'node:path';

const PORT = Number(process.argv[2]);
const OUT = process.argv[3] || 'shot.png';
const CLICK = process.argv[4] || '';

const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = targets.find((t) => t.type === 'page' && (t.url || '').includes('tauri.localhost'));
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.addEventListener('open', r, { once: true }); });
let id = 0; const pending = new Map();
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); }
});
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const i = ++id; pending.set(i, { resolve, reject }); ws.send(JSON.stringify({ id: i, method, params }));
});
const evalJs = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: `(async () => { ${expr} })()`, returnByValue: true, awaitPromise: true, userGesture: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result?.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await send('Page.enable');

if (CLICK) {
  const ok = await evalJs(`
    const norm = (s) => (s || '').replace(/\\s+/g, ' ').trim();
    const fire = (el) => { const r = el.getBoundingClientRect();
      const o = { bubbles: true, cancelable: true, clientX: r.x + r.width/2, clientY: r.y + r.height/2, pointerId: 1, isPrimary: true, button: 0 };
      for (const t of ['pointerover','pointerdown','mousedown','pointerup','mouseup','click']) el.dispatchEvent(t.startsWith('pointer') ? new PointerEvent(t, o) : new MouseEvent(t, o)); };
    const dialogOf = () => [...document.querySelectorAll('[role="dialog"]')].find(d => /设置|Settings/.test(d.getAttribute('aria-label') || ''));
    let dlg = dialogOf();
    if (!dlg) {
      const btn = [...document.querySelectorAll('button,[role="button"]')].find(n => norm(n.getAttribute('aria-label')).startsWith('设置'));
      if (btn) { fire(btn); await new Promise(r => setTimeout(r, 1500)); }
      dlg = dialogOf();
    }
    if (!dlg) return 'no-dialog';
    const el = [...dlg.querySelectorAll('button,[role="button"],[role="tab"],a,div[tabindex]')]
      .filter(n => n.getBoundingClientRect().x < 500)
      .find(n => norm(n.innerText || n.getAttribute('aria-label') || '').startsWith(${JSON.stringify(CLICK)}));
    if (!el) return 'not-found';
    fire(el);
    await new Promise(r => setTimeout(r, 800));
    if (!dialogOf()) {                       // 面板被关掉了，重开一次再点
      const btn = [...document.querySelectorAll('button,[role="button"]')].find(n => norm(n.getAttribute('aria-label')).startsWith('设置'));
      if (btn) { fire(btn); await new Promise(r => setTimeout(r, 1500)); }
      const again = dialogOf();
      if (!again) return 'closed';
      const el2 = [...again.querySelectorAll('button,[role="button"],[role="tab"],a,div[tabindex]')]
        .filter(n => n.getBoundingClientRect().x < 500)
        .find(n => norm(n.innerText || n.getAttribute('aria-label') || '').startsWith(${JSON.stringify(CLICK)}));
      if (!el2) return 'ok-reopen-not-found';
      fire(el2);
    }
    return 'ok';
  `);
  console.log('点击', CLICK, '->', ok);
  await sleep(7000);
}

const { data } = await send('Page.captureScreenshot', { format: 'png' });
const out = path.join(path.dirname(new URL(import.meta.url).pathname.slice(1)), 'reports', OUT);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, Buffer.from(data, 'base64'));
console.log('截图写入', out);
ws.close();
process.exit(0);

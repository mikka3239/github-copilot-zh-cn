// 采集当前页面里仍是英文的文本节点「原文片段」，用于建片段词典
// 用法: node frag-scan.mjs <端口> <输出名>
import fs from 'node:fs';
import path from 'node:path';

const PORT = Number(process.argv[2]);
const NAME = process.argv[3] || 'frag';

const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = targets.find((t) => t.type === 'page' && (t.url || '').includes('tauri.localhost'));
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => { ws.addEventListener('open', r, { once: true }); });
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

const out = await evalJs(`
  const hasLatin = (s) => /[A-Za-z]{3,}/.test(s);
  const CJK = /[\\u4e00-\\u9fff]/;
  const rows = [];
  const skip = (el) => !el || (el.closest && el.closest('code,pre,kbd,svg,canvas,input,textarea,[contenteditable="true"]'));
  const walk = (root) => {
    const it = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = it.nextNode())) {
      const t = n.nodeValue || '';
      const s = t.trim();
      if (s.length < 8 || !hasLatin(s) || CJK.test(s)) continue;
      const raw = n.parentElement && n.parentElement.closest('#__ccn_i') ? true : false;
      const p = n.parentElement;
      if (skip(p)) continue;
      if (!p || !p.getClientRects().length) continue;                // 只取可见
      rows.push({
        text: s,
        tag: p.tagName.toLowerCase(),
        cls: (p.className || '').toString().slice(0, 60),
        parent: (p.parentElement && p.parentElement.tagName.toLowerCase()) || '',
        siblingText: [...(p.parentElement ? p.parentElement.childNodes : [])].map(c => (c.nodeType === 3 ? c.nodeValue.trim() : '<' + c.nodeName.toLowerCase() + '>')).filter(Boolean).join(' | ').slice(0, 200),
        done: raw
      });
    }
  };
  const dlg = [...document.querySelectorAll('[role="dialog"]')].find(d => /设置|Settings/.test(d.getAttribute('aria-label') || ''));
  walk(dlg || document.body);
  return rows;
`);

const file = path.join(path.dirname(new URL(import.meta.url).pathname.slice(1)), 'reports', `frag-${NAME}.txt`);
fs.mkdirSync(path.dirname(file), { recursive: true });
const lines = out.map((r, i) => `#${i}\t${r.done ? '[done]' : '[raw]'}\t<${r.tag} class="${r.cls}"> parent=<${r.parent}>\n    文本: ${r.text}\n    兄弟: ${r.siblingText}`);
fs.writeFileSync(file, lines.join('\n'), 'utf8');
console.log('采集', out.length, '条 →', file);
ws.close();
process.exit(0);

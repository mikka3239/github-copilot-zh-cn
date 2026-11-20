// GitHub Copilot 桌面版 简体中文运行时汉化启动器（自建版）
// 原理：给 WebView2 开本机调试端口 -> 通过 CDP 注入翻译脚本 -> 监听 DOM 变化持续替换文字
// 不修改官方安装目录、不替换 github.exe。

import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_EXE = process.env.COPILOT_EXE || 'D:\\GitHub Copilot\\github.exe';
const DICT_FILE = path.join(__dirname, 'zh-CN.json');
const ENGINE_FILE = path.join(__dirname, 'inject.js');
const OUT_DIR = path.join(__dirname, 'reports');

const args = process.argv.slice(2);
const MODE = args.includes('--dump') ? 'dump' : 'translate'; // dump: 只采集界面英文，不翻译
const LOG_FILE = path.join(__dirname, 'reports', 'launcher.log');
const LOG = (...a) => {
  const line = `[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ` + a.map(String).join(' ');
  console.log(line);
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    fs.appendFileSync(LOG_FILE, line + '\n', 'utf8');
  } catch { /* 日志写失败不影响主流程 */ }
};

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForTarget(port, timeoutMs = 60000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      const list = await res.json();
      const page = list.find(
        (t) => t.type === 'page' && typeof t.webSocketDebuggerUrl === 'string' && (t.url || '').includes('tauri.localhost')
      );
      if (page) return page;
    } catch { /* 端口还没起来 */ }
    await sleep(600);
  }
  throw new Error('等待 WebView2 调试端口超时');
}

class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.id = 0;
    this.pending = new Map();
    this.ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      }
    });
  }
  ready() {
    return new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true });
      this.ws.addEventListener('error', (e) => reject(new Error('WebSocket 连接失败')), { once: true });
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP 超时: ${method}`));
        }
      }, 20000);
    });
  }
  async evaluate(expression, awaitPromise = false) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise,
      userGesture: true,
    });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text || 'JS 异常');
    return r.result?.value;
  }
}

function buildScript() {
  const engine = fs.readFileSync(ENGINE_FILE, 'utf8');
  let dict = {};
  if (MODE === 'translate' && fs.existsSync(DICT_FILE)) {
    try { dict = JSON.parse(fs.readFileSync(DICT_FILE, 'utf8')); } catch (e) { LOG('词典解析失败，按空词典运行:', e.message); }
  }
  return `(() => { const DICT = ${JSON.stringify(dict)}; const MODE = ${JSON.stringify(MODE)}; ${engine}\n})();`;
}

function saveReport(kind, data) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, kind), JSON.stringify(data, null, 2), 'utf8');
}

async function main() {
  LOG(`模式: ${MODE}`);
  LOG(`目标程序: ${APP_EXE}`);
  if (!fs.existsSync(APP_EXE)) { LOG('找不到 github.exe，请用环境变量 COPILOT_EXE 指定路径'); process.exit(1); }

  // 已有实例会占用用户数据目录且没有调试端口，必须先退出
  const port = await freePort();
  const env = { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}` };
  LOG(`调试端口: ${port}，启动官方程序…`);
  const child = spawn(APP_EXE, [], { detached: true, stdio: 'ignore', env });
  child.unref();

  const target = await waitForTarget(port);
  LOG('已抓到主界面 WebView，连接 CDP');
  const cdp = new CDP(target.webSocketDebuggerUrl);
  await cdp.ready();
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');

  const script = buildScript();
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: script });
  await cdp.evaluate(script);
  LOG('注入完成');

  // 心跳：页面重载后自动补注入
  let alive = true;
  const tick = setInterval(async () => {
    if (!alive) return;
    try {
      const ok = await cdp.evaluate('!!(window.__ccn && window.__ccn.ok)');
      if (!ok) { await cdp.evaluate(script); LOG('检测到页面重载，已重新注入'); }
    } catch { alive = false; clearInterval(tick); }
  }, 4000);

  // 采集未翻译文案，供扩词典
  let lastMissing = '';
  const collect = setInterval(async () => {
    if (!alive) return;
    try {
      const json = await cdp.evaluate('JSON.stringify(window.__ccn ? window.__ccn.snapshot() : null)');
      if (json && json !== lastMissing) {
        lastMissing = json;
        saveReport(MODE === 'dump' ? 'ui-dump.json' : 'untranslated.json', JSON.parse(json));
      }
    } catch { /* ignore */ }
  }, 3000);

  // 等待应用退出
  const waitExit = setInterval(() => {
    try { process.kill(child.pid, 0); }
    catch {
      LOG('Copilot 已退出，启动器结束');
      alive = false;
      clearInterval(tick); clearInterval(collect); clearInterval(waitExit);
      try { cdp.ws.close(); } catch {}
      process.exit(0);
    }
  }, 2000);
}

main().catch((e) => { LOG('出错:', e.message); process.exit(1); });

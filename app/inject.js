// 注入到页面执行的翻译引擎（由 launcher 拼接 DICT / MODE 后注入）
// 设计要点：只改文本/属性；预建索引避免重复计算；DOM 变化合并成批，单轮限流，防止拖死主线程。

(() => {
  const SKIP_SELECTOR = [
    'code', 'pre', 'kbd',
    'textarea', 'input',
    '[contenteditable="true"]', '[contenteditable="plaintext-only"]',
    '.cm-editor', '.monaco-editor', '[class*="monaco"]',
    '[class*="xterm"]', '[data-testid*="terminal-pane"]', '[data-testid*="terminal-output"]',
    '[data-testid*="terminal-view"]', '[data-testid*="terminal-emulator"]',
    '[class*="markdown"]', '[class*="prose"]',
    '[class*="diff"]', '[class*="code-block"]',
    '[data-testid*="minigame"]', '[id*="minigame"]',
    'svg', 'canvas',
    '[data-ccn-skip]'
  ].join(',');

  const MAX_LEN = 90;
  const BATCH = 400;           // 单轮最多处理节点数
  const cache = new Map();
  const missing = new Set();
  const done = new WeakSet();
  const cursors = new WeakMap();   // 大子树续扫游标
  const pending = new Set();
  let scheduled = false;
  let count = 0;

  const norm = (s) => s
    .replace(/\s+/g, ' ')
    .replace(/[\u2019\u2018]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .trim();

  // ---- 词典索引：一次性预建 ----
  const exact = new Map();
  const lowered = new Map();
  const templates = [];        // [{ tpl, out }]
  const NUM = /\b\d[\d,.]*\s*(s|m|h|d|ms|%|kB|MB|GB)?\b/gi;

  const templatize = (s) => norm(s).replace(NUM, '⟦n⟧');

  for (const [k, v] of Object.entries(DICT)) {
    const nk = norm(k);                       // 键也做同样的标点/空白归一
    exact.set(nk, v);
    lowered.set(nk.toLowerCase(), v);
    if (nk.includes('⟦n⟧')) templates.push({ tpl: templatize(nk), out: v });
  }

  const RULES = [
    [/^(.+), view details$/, '$1，查看详情'],
    [/^(.+), view skill$/, '$1，查看技能'],
    [/^Actions for (.+)$/, '$1 的操作'],
    [/^Connect (.+)$/, '连接 $1'],
    [/^Add server, (.+)$/, '添加服务器 · $1'],
    [/^Add server: (.+)$/, '添加服务器 · $1'],
    [/^Install: (.+)$/, '安装 · $1'],
    [/^Install skill: (.+)$/, '安装技能 · $1'],
    [/^Enable: (.+)$/, '启用 · $1'],
    [/^New automation, (.+)$/, '新建自动化 · $1'],
    [/^New session for (.+)$/, '$1 的新会话'],
    [/^(.+), open user menu$/, '$1，打开用户菜单'],
    [/^(.+), no repository$/, '$1（未选择仓库）'],
    [/^MCP Servers · (.+)$/, 'MCP 服务器 · $1'],
    [/^Search (\d+) skills?…?$/, '搜索 $1 个技能…'],
    [/^Search (\d+) palettes?…?$/, '搜索 $1 个配色方案…'],
    [/^Terminal font, (.+)$/, '终端字体：$1'],
    [/^Chat messages quota: (\d+)% used(, .+)?$/, '对话额度已用 $1%$2'],
    [/^Chat messages used: (\d+)%$/, '已用对话额度：$1%'],
    [/^Up to date\. Last checked on (.+)$/, '已是最新版本。上次检查：$1'],
    [/^(.+), Run on$/, '$1，运行于'],
    [/^(.+), model and reasoning(, .+)?$/, '$1，模型与推理$2'],
    [/^Mode: (.+)$/, '模式：$1'],
    [/^Error checking for updates: (.+)$/, '检查更新失败：$1'],
    [/^(.+) announcements$/, '$1播报'],
    [/^Not installed · (.+)$/, '未安装 · $1'],
    [/^Preview: (.+)$/, '预览：$1'],
    [/^Provided by the GitHub account (.+) on github\.com\.$/, '由 github.com 上的 GitHub 账户 $1 提供。'],
    [/^Model provider status checked: (.+) connected\.$/, '模型服务商状态已检查：$1 个已连接。'],
    [/^(\d+) seconds?$/, '$1 秒'],
    [/^(\d+) days?$/, '$1 天'],
    [/^(\d+) minutes? ago$/, '$1 分钟前'],
    [/^(\d+) hours? ago$/, '$1 小时前'],
  ];

  // 日期里的英文月份换中文：November 20, 2026, at 4:56 PM -> 2026年11月20日 16:56
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  function localizeDate(s) {
    return s.replace(
      /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),\s*(\d{4})(?:,\s*at\s+(\d{1,2}):(\d{2})\s*(AM|PM)?)?/g,
      (m, mon, day, year, h, mi, ap) => {
        let out = `${year}年${MONTHS.indexOf(mon) + 1}月${Number(day)}日`;
        if (h) {
          let hh = Number(h);
          if (ap === 'PM' && hh !== 12) hh += 12;
          if (ap === 'AM' && hh === 12) hh = 0;
          out += ` ${String(hh).padStart(2, '0')}:${mi}`;
        }
        return out;
      }
    );
  }

  function lookup(text) {
    const t = norm(text);
    if (cache.has(t)) return cache.get(t);
    let out = null;
    if (exact.has(t)) out = exact.get(t);
    else if (lowered.has(t.toLowerCase())) out = lowered.get(t.toLowerCase());
    else {
      for (const [re, rep] of RULES) { if (re.test(t)) { out = t.replace(re, rep); break; } }
      if (!out && templates.length) {
        const tt = templatize(t);
        for (const { tpl, out: v } of templates) {
          if (tpl === tt) {
            const nums = t.match(NUM) || [];
            let i = 0;
            out = v.replace(/⟦n⟧/g, () => (nums[i] !== undefined ? nums[i++].trim() : ''));
            break;
          }
        }
      }
    }
    if (out) {
      if (/Up to date|Last checked/.test(t)) out = localizeDate(out);
      cache.set(t, out);
    }
    return out;
  }

  const hasLatin = (s) => /[A-Za-z]/.test(s);
  const hasCJK = (s) => /[\u4e00-\u9fff]/.test(s);

  // 明显不是界面文案的内容：路径、kebab 标识、无空格单词、用户名
  function notUiText(t) {
    const noSpace = !/\s/.test(t);
    if (noSpace && (t.includes('/') || t.includes('\\'))) return true;   // 路径
    if (noSpace && /^[a-z0-9]+(-[a-z0-9]+)+$/i.test(t)) return true;      // kebab 标识
    if (noSpace && !exact.has(t)) return true;                            // 用户名 / 短标识
    return false;
  }

  // 祖先是否属于「不该翻」的区域；按元素缓存，避免每个文本节点重复爬链
  const skipCache = new WeakMap();
  function isSkipEl(el) {
    if (!el || el === document.body) return false;
    let v = skipCache.get(el);
    if (v !== undefined) return v;
    v = (el.matches && el.matches(SKIP_SELECTOR)) ||
        el.getAttribute?.('contenteditable') === 'true' ||
        el.getAttribute?.('contenteditable') === 'plaintext-only';
    skipCache.set(el, v);
    return v;
  }

  const placeholderCache = new WeakMap();
  function inSkipZone(node) {
    const pe = node.parentElement;
    if (!pe) return false;
    // 占位符浮层通常放在可编辑区域内，这类要翻
    let ph = placeholderCache.get(pe);
    if (ph === undefined) {
      ph = !!(pe.closest && pe.closest('[class*="placeholder"], [data-placeholder], [class*="pointer-events-none"]'));
      placeholderCache.set(pe, ph);
    }
    if (ph) return false;
    let el = pe;
    while (el && el !== document.body) {
      if (isSkipEl(el)) return true;
      el = el.parentElement;
    }
    return false;
  }

  function isCodeLike(t) {
    if (/\s/.test(t)) return false;            // 含空格的是句子，不当代码
    return /^[a-z]+[A-Z]/.test(t) || /^[A-Z_]{3,}$/.test(t) || /[{}<>;$\\]/.test(t) ||
      /^[\w.-]+\.(js|ts|json|md|py|yml|yaml)$/.test(t);
  }

  function visitText(node) {
    if (!node || done.has(node)) return;
    const raw = node.nodeValue;
    if (!raw || !hasLatin(raw)) { done.add(node); return; }
    const t = norm(raw);
    if (!t || !hasLatin(t)) { done.add(node); return; }
    const hit = isDictHit(t);
    if (!hit && t.length > MAX_LEN) { done.add(node); return; }
    if (hasCJK(t) || isCodeLike(t) || notUiText(t)) { done.add(node); return; }
    if (inSkipZone(node)) { done.add(node); return; }

    if (MODE === 'dump') { if (!/^\d+$/.test(t)) missing.add(t); return; }
    const zh = lookup(t);
    if (zh && zh !== t) {
      const lead = raw.match(/^\s*/)[0];
      const tail = raw.match(/\s*$/)[0];
      node.nodeValue = lead + zh + tail;
      count++;
    } else if (!zh) missing.add(t);
    done.add(node);
  }

  function visitAttrs(el) {
    if (!el.getAttribute) return;
    for (const attr of ATTRS) {
      const v = el.getAttribute(attr);
      if (!v || !hasLatin(v)) continue;
      const n = norm(v);
      if (hasCJK(n)) continue;
      if (!isDictHit(n) && n.length > MAX_LEN) continue;
      const zh = MODE === 'dump' ? null : lookup(n);
      if (zh && zh !== v) el.setAttribute(attr, zh);
      else if (!zh && !notUiText(n)) missing.add(n);
    }
  }
  const ATTRS = ['placeholder', 'aria-label', 'title', 'alt', 'data-placeholder', 'aria-placeholder'];

  function isDictHit(t) {
    return exact.has(t) || lowered.has(t.toLowerCase());
  }

  // ---- 变化队列：合并 + 限流 ----
  function enqueue(node) {
    if (!node) return;
    pending.add(node);
    if (!scheduled) {
      scheduled = true;
      setTimeout(flush, 80);
    }
  }

  function visitAny(node) {
    if (!node) return;
    if (node.nodeType === 3) { done.delete(node); visitText(node); return; }
    if (node.nodeType !== 1 && node.nodeType !== 9) return;
    visitAttrs(node);
    if (!node.firstChild) return;

    // 用游标记录上次扫到哪，配合时间片避免长任务
    const start = cursors.get(node) || node.firstChild;
    const tw = document.createTreeWalker(node, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
    // TreeWalker 从根开始，需要先定位到游标
    let n = tw.nextNode();
    while (n && n !== start) n = tw.nextNode();
    if (!n) { cursors.delete(node); return; }

    const t0 = performance.now();
    while (n) {
      if (n.nodeType === 3) visitText(n); else visitAttrs(n);
      if (performance.now() - t0 > 14) {
        cursors.set(node, n);            // 下次从当前节点继续（重复处理一次无害）
        pending.add(node);
        return;
      }
      n = tw.nextNode();
    }
    cursors.delete(node);
  }

  function flush() {
    scheduled = false;
    let budget = 12;
    for (const node of pending) {
      pending.delete(node);
      if (budget-- <= 0) break;
      visitAny(node);
    }
    if (pending.size) { scheduled = true; setTimeout(flush, 50); }
  }

  const obs = new MutationObserver((muts) => {
    for (const m of muts) {
      if (m.type === 'characterData') enqueue(m.target);
      else if (m.type === 'attributes') enqueue(m.target);
      else for (const added of m.addedNodes) enqueue(added);
    }
  });

  function start() {
    // 首轮全量扫描改为分批入队，避免长任务
    enqueue(document.body);
    obs.observe(document.documentElement, {
      subtree: true, childList: true, characterData: true,
      attributes: true, attributeFilter: ATTRS,
    });
  }

  window.__ccn = {
    ok: true,
    get count() { return count; },
    rescan: () => { count = 0; missing.clear(); cache.clear(); enqueue(document.body); },
    snapshot: () => ({
      mode: MODE,
      translated: count,
      totalDict: exact.size,
      missingCount: missing.size,
      missing: [...missing].sort(),
    }),
  };

  if (document.body) start();
  else document.addEventListener('DOMContentLoaded', start, { once: true });
})();

#!/usr/bin/env node
/**
 * 快速查看调试窗口当前状态（不做导航，避免超时）。
 *   node _tools/quick-state.js
 */
const CONFIG = require('./config');

class S {
  constructor(ws) { this.ws = ws; this.id = 0; this.p = new Map(); }
  static async open(u) {
    const ws = new WebSocket(u);
    await new Promise((r, j) => { ws.onopen = r; ws.onerror = () => j(new Error('ws fail')); });
    const s = new S(ws);
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.id && s.p.has(m.id)) { const { r, j } = s.p.get(m.id); s.p.delete(m.id); m.error ? j(new Error(JSON.stringify(m.error))) : r(m.result); }
    };
    return s;
  }
  send(method, params = {}, t = 15000) {
    const id = ++this.id;
    return new Promise((r, j) => {
      this.p.set(id, { r, j });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.p.has(id)) { this.p.delete(id); j(new Error('timeout ' + method)); } }, t);
    });
  }
  async ev(expr) {
    try {
      const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true });
      if (r.exceptionDetails) return { error: r.exceptionDetails.exception?.description || 'err' };
      return { value: r.result.value };
    } catch (e) { return { error: e.message }; }
  }
}

(async () => {
  const list = await (await fetch(`http://127.0.0.1:${CONFIG.cdpPort}/json/list`, { signal: AbortSignal.timeout(5000) })).json();
  const pages = list.filter((t) => t.type === 'page');
  console.log('标签页:');
  pages.forEach((p, i) => console.log(`  [${i}] ${p.url.slice(0, 110)}`));

  const p = pages.find((x) => /yuketang/i.test(x.url)) || pages[0];
  if (!p) { console.log('无可用页面'); process.exit(0); }

  const s = await S.open(p.webSocketDebuggerUrl);
  await s.send('Runtime.enable');
  const r = await s.ev(`JSON.stringify({
    url: location.href,
    title: document.title,
    hasTool: !!window.__yktTool,
    toolVersion: window.__yktTool ? window.__yktTool.version : null,
    cards: document.querySelectorAll('section.studentCard').length,
    courseNames: [].slice.call(document.querySelectorAll('section.studentCard')).slice(0,20)
      .map(function(c){ var t=c.querySelector('.course-name,.title,[class*=name]'); return t?(t.innerText||'').trim().slice(0,26):'' }).filter(Boolean),
    text: (document.body.innerText||'').replace(/\\s+/g,' ').slice(0,200),
  })`);
  console.log('\n页面状态:');
  try {
    const d = JSON.parse(r.value);
    Object.keys(d).forEach((k) => {
      const v = d[k];
      if (Array.isArray(v)) console.log(`  ${k}: ${JSON.stringify(v)}`);
      else console.log(`  ${k}: ${v}`);
    });
  } catch (e) { console.log(' ', r.value || r.error); }
  s.ws.close();
  process.exit(0);
})().catch((e) => { console.error('异常:', e && e.message); process.exit(1); });

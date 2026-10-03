#!/usr/bin/env node
/**
 * 直接检查 __yktTool 上暴露了哪些 API（排查自检接口取不到的问题）。
 *   node _tools/probe-tool-api.js
 */
const fs = require('fs');
const path = require('path');
const CONFIG = require('./config');
const USERSCRIPT = path.join(__dirname, '..', 'dist', 'changjiang-yuketang-auto.user.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class S {
  constructor(ws) { this.ws = ws; this.id = 0; this.p = new Map(); this.ex = []; }
  static async open(u) {
    const ws = new WebSocket(u);
    await new Promise((r, j) => { ws.onopen = r; ws.onerror = () => j(new Error('ws fail')); });
    const s = new S(ws);
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.id && s.p.has(m.id)) { const { r, j } = s.p.get(m.id); s.p.delete(m.id); m.error ? j(new Error(JSON.stringify(m.error))) : r(m.result); }
      else if (m.method === 'Runtime.exceptionThrown') s.ex.push((m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text || '').slice(0, 300));
    };
    return s;
  }
  send(method, params = {}, t = 30000) {
    const id = ++this.id;
    return new Promise((r, j) => {
      this.p.set(id, { r, j });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.p.has(id)) { this.p.delete(id); j(new Error('timeout ' + method)); } }, t);
    });
  }
  async json(expr, aw = false) {
    try {
      const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: aw, userGesture: true });
      if (r.exceptionDetails) return { __err: r.exceptionDetails.exception?.description || 'err' };
      const v = r.result.value;
      return typeof v === 'string' ? JSON.parse(v) : (v || {});
    } catch (e) { return { __err: e.message }; }
  }
}

(async () => {
  const list = await (await fetch(`http://127.0.0.1:${CONFIG.cdpPort}/json/list`)).json();
  const pages = list.filter((t) => t.type === 'page');
  const ctl = await S.open(pages[0].webSocketDebuggerUrl);
  await ctl.send('Page.enable');
  const nt = await ctl.send('Target.createTarget', { url: 'about:blank' });
  ctl.ws.close();
  await sleep(1200);
  const fresh = (await (await fetch(`http://127.0.0.1:${CONFIG.cdpPort}/json/list`)).json())
    .filter((t) => t.type === 'page').find((x) => x.id === nt.targetId);
  const s = await S.open(fresh.webSocketDebuggerUrl);
  await s.send('Page.enable'); await s.send('Runtime.enable');

  const src = fs.readFileSync(USERSCRIPT, 'utf8');
  await s.send('Page.addScriptToEvaluateOnNewDocument', { source: src });
  await s.send('Page.navigate', { url: CONFIG.url.studentLog() });
  await sleep(15000);

  const r = await s.json(`(function(){
    var t = window.__yktTool;
    if (!t) return JSON.stringify({ hasTool: false });
    var keys = Object.keys(t);
    var out = { hasTool: true, keys: keys, version: t.version };
    try { out.verifyType = typeof t.verify; } catch(e) { out.verifyType = 'ERR ' + e.message }
    try { out.verifyResultsType = typeof t.verifyResults; } catch(e) { out.verifyResultsType = 'ERR ' + e.message }
    try {
      var d = Object.getOwnPropertyDescriptor(window, '__yktTool');
      out.descriptor = { configurable: d.configurable, enumerable: d.enumerable, hasValue: !!d.value };
    } catch(e) { out.descriptor = 'ERR ' + e.message }
    try {
      var proto = Object.getPrototypeOf(t);
      out.protoKeys = Object.getOwnPropertyNames(proto);
    } catch(e) {}
    return JSON.stringify(out);
  })()`);
  console.log('__yktTool 暴露情况:');
  console.log(JSON.stringify(r, null, 1));

  // 直接试着调用
  const call = await s.json(`(async function(){
    try {
      if (!window.__yktTool) return JSON.stringify({ err: 'no tool' });
      if (typeof window.__yktTool.verifyResults !== 'function') return JSON.stringify({ err: 'not a function', t: typeof window.__yktTool.verifyResults });
      var x = await window.__yktTool.verifyResults();
      return JSON.stringify({ ok: true, pass: x.pass, fail: x.fail, warn: x.warn, n: (x.lines||[]).length });
    } catch(e) { return JSON.stringify({ err: String(e) }) }
  })()`, true);
  console.log('\n直接调用 verifyResults():');
  console.log(' ', JSON.stringify(call));

  if (s.ex.length) {
    console.log('\n页面异常:');
    s.ex.slice(0, 6).forEach((e) => console.log('  ' + e.split('\n')[0]));
  }

  s.ws.close();
  process.exit(0);
})().catch((e) => { console.error('异常:', e && e.stack || e); process.exit(1); });

#!/usr/bin/env node
/**
 * 在页面里挂钩 fetch/XHR，自动找出「哪个接口返回了含 leaf_id 的数据」，
 * 并把该接口的 URL、请求参数、响应结构记录下来。
 *
 *   node _tools/find-leaf-api.js
 */
const CONFIG = require('./config');
const PORT = Number(process.env.CDP_PORT || 9222);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Session {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); }
  static async connect(u) {
    const ws = new WebSocket(u);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws fail')); });
    const s = new Session(ws);
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && s.pending.has(m.id)) {
        const { res, rej } = s.pending.get(m.id); s.pending.delete(m.id);
        m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
      }
    };
    return s;
  }
  send(method, params = {}, t = 40000) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error('timeout ' + method)); } }, t);
    });
  }
  async eval(expr, aw = false) {
    try {
      const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: aw, userGesture: true });
      if (r.exceptionDetails) return { error: r.exceptionDetails.exception?.description || 'err' };
      return { value: r.result.value };
    } catch (e) { return { error: e.message }; }
  }
}

const HOOK = `(function(){
  if (window.__leafProbe) return 'already';
  window.__leafProbe = { hits: [] };
  var MAX = 400000;

  function scan(url, text, via) {
    if (!text || text.length > MAX) return;
    if (text.indexOf('leaf_id') < 0) return;
    var hit = { url: String(url).slice(0, 220), via: via, len: text.length, keys: null, sample: null, leafs: [] };
    try {
      var j = JSON.parse(text);
      var stack = [j], guard = 0;
      var leafs = [];
      while (stack.length && guard++ < 5000) {
        var cur = stack.pop();
        if (!cur || typeof cur !== 'object') continue;
        if (Array.isArray(cur)) { cur.forEach(function(x){ stack.push(x); }); continue; }
        if (cur.leaf_id !== undefined) {
          leafs.push({ id: cur.leaf_id, name: (cur.name || cur.title || '').slice(0, 40), type: cur.leaf_type, done: cur.is_done !== undefined ? cur.is_done : cur.schedule });
          if (leafs.length > 8) break;
        }
        Object.keys(cur).forEach(function(k){ var v = cur[k]; if (v && typeof v === 'object') stack.push(v); });
      }
      hit.leafs = leafs;
      hit.keys = j && j.data && typeof j.data === 'object' && !Array.isArray(j.data) ? Object.keys(j.data).slice(0, 15) : (Array.isArray(j.data) ? ['[array len ' + j.data.length + ']'] : null);
    } catch (e) { hit.parseErr = String(e).slice(0, 60); }
    window.__leafProbe.hits.push(hit);
  }

  var of = window.fetch;
  window.fetch = function(input, init) {
    var url = typeof input === 'string' ? input : (input && input.url) || '';
    var p = of.apply(this, arguments);
    p.then(function(res){
      try {
        var ct = (res.headers.get('content-type') || '');
        if (ct.indexOf('json') < 0 && ct.indexOf('text') < 0) return;
        res.clone().text().then(function(t){ scan(url, t, 'fetch'); }).catch(function(){});
      } catch(e){}
    }).catch(function(){});
    return p;
  };

  var oo = XMLHttpRequest.prototype.open, os = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function(m, u) { try { this.__u = u; } catch(e){} return oo.apply(this, arguments); };
  XMLHttpRequest.prototype.send = function() {
    var self = this;
    this.addEventListener('load', function(){ try { scan(self.__u, self.responseText, 'xhr'); } catch(e){} });
    return os.apply(this, arguments);
  };
  return 'hooked';
})()`;

(async () => {
  const pages = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).filter((t) => t.type === 'page');
  const target = pages.find((p) => /yuketang/i.test(p.url)) || pages[0];
  const s = await Session.connect(target.webSocketDebuggerUrl);
  await s.send('Page.enable'); await s.send('Runtime.enable');
  try { await s.send('Page.bringToFront'); } catch (e) { }

  // 先装钩子，再刷新 → 这样页面初始化时的接口请求都能被抓到
  console.log('注册 document-start 钩子…');
  await s.send('Page.addScriptToEvaluateOnNewDocument', { source: HOOK });

  console.log('加载课程页…');
  await s.send('Page.navigate', { url: CONFIG.origin + `/v2/web/studentLog/${CONFIG.classroom}` });
  await sleep(16000);

  const r = await s.eval(`JSON.stringify(window.__leafProbe ? window.__leafProbe.hits : 'no probe')`);
  let hits = [];
  try { hits = JSON.parse(r.value); } catch (e) { }
  if (!Array.isArray(hits)) { console.log('探针结果:', r.value); s.ws.close(); process.exit(0); }

  console.log(`\n命中 ${hits.length} 个含 leaf_id 的响应\n`);
  const seen = new Set();
  hits.forEach((h) => {
    const key = h.url.split('?')[0];
    if (seen.has(key) && !h.leafs.length) return;
    seen.add(key);
    console.log(`▸ [${h.via}] ${h.url}`);
    console.log(`   长度=${h.len} data字段=${JSON.stringify(h.keys)} ${h.parseErr ? '解析错误=' + h.parseErr : ''}`);
    (h.leafs || []).slice(0, 6).forEach((l) => console.log(`     leaf_id=${l.id} t=${l.type} done=${l.done} «${l.name}»`));
    console.log('');
  });

  s.ws.close();
  process.exit(0);
})().catch((e) => { console.error('异常:', e && e.stack || e); process.exit(1); });

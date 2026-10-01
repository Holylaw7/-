#!/usr/bin/env node
/**
 * 列出调试窗口里篡改猴的所有脚本（名称/版本/启用状态/源码长度）。
 *   node _tools/tm-list-scripts.js
 */
const PORT = Number(process.env.CDP_PORT || 9222);
const TM_ID = 'iikmkjmpaadaobahmlepeloendndfphd';

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
  send(method, params = {}, t = 30000) {
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

const QUERY = `(async function(){
  var all = await chrome.storage.local.get(null);
  var metas = {};
  Object.keys(all).forEach(function (k) {
    var m = k.match(/^!extdb\\.@meta#(.+)$/);
    if (!m) return;
    var v = all[k];
    var val = (v && v.value) ? v.value : v;
    metas[m[1]] = {
      name: val.name, version: val.version, enabled: val.enabled,
      matches: (val.options && val.options.orig_matches) || val.matches,
      uuid: m[1], position: val.position,
    };
  });
  var srcLens = {};
  Object.keys(all).forEach(function (k) {
    var m = k.match(/^!extdb\\.@source#(.+)$/);
    if (!m) return;
    var v = all[k];
    srcLens[m[1]] = String((v && v.value) ? v.value : v || '').length;
  });
  return JSON.stringify(Object.keys(metas).map(function (u) {
    return Object.assign({}, metas[u], { sourceLen: srcLens[u] || 0 });
  }), null, 2);
})()`;

(async () => {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const sw = list.find((t) => t.type === 'service_worker' && t.url.includes(TM_ID));
  if (!sw) { console.error('篡改猴后台未运行'); process.exit(1); }
  const s = await Session.connect(sw.webSocketDebuggerUrl);
  await s.send('Runtime.enable');
  const r = await s.eval(QUERY, true);
  console.log(r.value || r.error);
  s.ws.close();
  process.exit(0);
})().catch((e) => { console.error('异常:', e && e.stack || e); process.exit(1); });

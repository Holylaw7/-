#!/usr/bin/env node
/**
 * 检查篡改猴里目标脚本存储的完整性（头部/源码是否匹配、是否损坏）。
 *   node _tools/tm-inspect-script.js
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

const INSPECT = `(async function(){
  var all = await chrome.storage.local.get(null);
  var uuid = null, meta = null;
  Object.keys(all).forEach(function (k) {
    var m = k.match(/^!extdb\\.@meta#(.+)$/);
    if (!m) return;
    var v = all[k]; var val = (v && v.value) ? v.value : v;
    if (val && val.name === '长江雨课堂 · 自动刷课助手') { uuid = m[1]; meta = val; }
  });
  if (!uuid) return JSON.stringify({ err: 'script not found' });

  var srcKey = '!extdb.@source#' + uuid;
  var sv = all[srcKey];
  var src = String((sv && sv.value) ? sv.value : sv || '');

  var header = meta.header || '';
  var headerName = (header.match(/@name\\s+(.+)/) || [])[1];
  var headerVersion = (header.match(/@version\\s+(\\S+)/) || [])[1];
  var srcFirstLine = src.split('\\n')[0];
  var srcHasUserscriptBlock = src.indexOf('// ==UserScript==') === 0 || src.indexOf('// ==UserScript==') > -1;
  var srcVersion = (src.match(/@version\\s+(\\S+)/) || [])[1];
  var srcName = (src.match(/@name\\s+(.+)/) || [])[1];

  return JSON.stringify({
    uuid: uuid,
    enabled: meta.enabled,
    metaVersion: meta.version,
    metaHeaderVersion: headerVersion,
    metaName: meta.name,
    srcLen: src.length,
    srcFirstLine: srcFirstLine.slice(0, 60),
    srcHasUserscriptBlock: srcHasUserscriptBlock,
    srcName: srcName, srcVersion: srcVersion,
    srcTailIsIife: src.trim().endsWith('})();'),
    metaHeaderMatchesSrcName: headerName === srcName,
    metaHeaderMatchesSrcVersion: headerVersion === srcVersion,
    srcHead: src.slice(0, 260),
    srcTail: src.slice(-160),
  }, null, 2);
})()`;

(async () => {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const sw = list.find((t) => t.type === 'service_worker' && t.url.includes(TM_ID));
  if (!sw) { console.error('篡改猴后台未运行'); process.exit(1); }
  const s = await Session.connect(sw.webSocketDebuggerUrl);
  await s.send('Runtime.enable');
  const r = await s.eval(INSPECT, true);
  console.log(r.value || r.error);
  s.ws.close();
  process.exit(0);
})().catch((e) => { console.error('异常:', e && e.stack || e); process.exit(1); });

#!/usr/bin/env node
/**
 * 查看调试窗口里篡改猴已安装的脚本列表与当前启用版本。
 *   node _tools/tm-scripts.js
 */
const PORT = Number(process.env.CDP_PORT || 9222);
const TM_ID = 'iikmkjmpaadaobahmlepeloendndfphd';
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

(async () => {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();

  // 优先连篡改猴的 service worker（能直接问它脚本列表）
  const sw = list.find((t) => t.type === 'service_worker' && t.url.includes(TM_ID));
  if (sw) {
    console.log('=== 通过篡改猴后台查询脚本列表 ===');
    const s = await Session.connect(sw.webSocketDebuggerUrl);
    await s.send('Runtime.enable');
    const r = await s.eval(`(async function(){
      try {
        if (typeof chrome === 'undefined' || !chrome.runtime) return 'no chrome.runtime';
        // 篡改猴把脚本存在 chrome.storage.local 里
        var all = await chrome.storage.local.get(null);
        var keys = Object.keys(all);
        var scripts = [];
        keys.forEach(function(k){
          var v = all[k];
          if (v && typeof v === 'object' && v.name && v.header) {
            scripts.push({ key: k, name: v.name, version: v.version, enabled: v.enabled, matches: (v.options && v.options.orig_matches) || v.matches });
          }
        });
        return JSON.stringify({ totalKeys: keys.length, scripts: scripts,
          sampleKeys: keys.filter(function(k){ return /script|userscript|@/i.test(k) }).slice(0, 20) }, null, 2);
      } catch (e) { return 'ERR ' + String(e); }
    })()`, true);
    console.log(r.value || r.error);
    s.ws.close();
  } else {
    console.log('没有找到篡改猴 service worker');
  }

  // 顺便看看扩展页能否读出脚本列表
  const extPage = list.find((t) => t.type === 'page' && t.url.includes(TM_ID));
  if (extPage) {
    console.log('\n=== 扩展页 ===');
    console.log('  URL:', extPage.url);
  }

  process.exit(0);
})().catch((e) => { console.error('异常:', e && e.stack || e); process.exit(1); });

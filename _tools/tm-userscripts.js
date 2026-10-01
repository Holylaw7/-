#!/usr/bin/env node
/**
 * 查询 chrome.userScripts 里实际注册的脚本（MV3 下篡改猴真正注入的内容）。
 *   node _tools/tm-userscripts.js
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

(async () => {
  const list = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json());
  const sw = list.find((t) => t.type === 'service_worker' && t.url.includes(TM_ID));
  if (!sw) { console.error('篡改猴后台未运行'); process.exit(1); }
  const s = await Session.connect(sw.webSocketDebuggerUrl);
  await s.send('Runtime.enable');

  const r = await s.eval(`(async function(){
    try {
      var arr = await chrome.userScripts.getScripts();
      return JSON.stringify(arr.map(function (x) {
        return { id: x.id, matches: x.matches, jsLen: (x.js && x.js[0] && x.js[0].code) ? x.js[0].code.length : 0,
                 runAt: x.runAt, world: x.world, allFrames: x.allFrames,
                 head: (x.js && x.js[0] && x.js[0].code) ? x.js[0].code.slice(0, 120) : null };
      }), null, 2);
    } catch (e) { return 'ERR ' + String(e); }
  })()`, true);
  console.log('=== chrome.userScripts.getScripts() ===');
  console.log(r.value || r.error);

  // 看 registered 里有没有我们的脚本
  const check = await s.eval(`(async function(){
    try {
      var arr = await chrome.userScripts.getScripts();
      var hit = arr.filter(function(x){ return JSON.stringify(x).indexOf('__yktTool') >= 0 || JSON.stringify(x).indexOf('长江雨课堂') >= 0; });
      return JSON.stringify({ total: arr.length, ours: hit.length,
        ids: arr.map(function(x){ return x.id; }) });
    } catch (e) { return 'ERR ' + String(e); }
  })()`, true);
  console.log('\n=== 是否包含我们的脚本 ===');
  console.log(check.value || check.error);

  s.ws.close();
  process.exit(0);
})().catch((e) => { console.error('异常:', e && e.stack || e); process.exit(1); });

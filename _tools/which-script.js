#!/usr/bin/env node
/**
 * 查明页面里到底跑的是哪个版本的脚本：
 *   · Tampermonkey 注入的（应有 __yktTool）
 *   · 还是之前 CDP 注入残留的（没有 __yktTool）
 *   node _tools/which-script.js
 */
const PORT = Number(process.env.CDP_PORT || 9222);

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
  async eval(expr) {
    try {
      const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, userGesture: true });
      if (r.exceptionDetails) return { error: r.exceptionDetails.exception?.description || 'err' };
      return { value: r.result.value };
    } catch (e) { return { error: e.message }; }
  }
}

(async () => {
  const pages = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).filter((t) => t.type === 'page');
  const p = pages.find((x) => /yuketang/i.test(x.url));
  if (!p) { console.error('没有雨课堂标签页'); process.exit(1); }
  console.log('目标页:', p.url.slice(0, 90), '\n');

  const s = await Session.connect(p.webSocketDebuggerUrl);
  await s.send('Page.enable');
  await s.send('Runtime.enable');

  const r = await s.eval(`JSON.stringify({
    hasTool: !!window.__yktTool,
    toolKeys: window.__yktTool ? Object.keys(window.__yktTool) : null,
    stateVersion: window.__yktTool && window.__yktTool.state ? window.__yktTool.state.version : null,
    panel: !!document.getElementById('ykt-tool-host'),
    panelVersionText: (function(){
      var h = document.getElementById('ykt-tool-host');
      if (!h || !h.shadowRoot) return null;
      var v = h.shadowRoot.querySelector('.hd .v');
      return v ? (v.innerText || '').trim() : null;
    })(),
    panelButtons: (function(){
      var h = document.getElementById('ykt-tool-host');
      if (!h || !h.shadowRoot) return null;
      return [].slice.call(h.shadowRoot.querySelectorAll('.mini')).map(function(b){ return (b.innerText||'').trim(); });
    })(),
    panelLogTail: (function(){
      var h = document.getElementById('ykt-tool-host');
      if (!h || !h.shadowRoot) return null;
      var log = h.shadowRoot.getElementById('log');
      if (!log) return null;
      return (log.innerText||'').split('\\n').filter(Boolean).slice(0, 3);
    })(),
    hasRawProbe: !!window.__yktRaw,
    bridgeNode: !!document.getElementById('__ykt_speed_bridge__'),
    guardPatched: typeof HTMLMediaElement !== 'undefined' && !!(HTMLMediaElement.prototype.pause && HTMLMediaElement.prototype.pause.__yktPatched),
  })`);
  console.log('页面脚本状态:');
  console.log(r.value || r.error);

  // 列出该页注册过的 CDP 注入脚本
  console.log('\n（本工具不清理注入；如需彻底干净，重建标签页即可）');

  s.ws.close();
  process.exit(0);
})().catch((e) => { console.error('异常:', e && e.stack || e); process.exit(1); });

#!/usr/bin/env node
/**
 * 查篡改猴运行状态与 userScripts 权限（当前实时状态）。
 *   node _tools/tm-live-status.js
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
  console.log('=== 目标列表 ===');
  list.forEach((t) => console.log(`  [${t.type}] ${t.url.slice(0, 92)}`));

  const sw = list.find((t) => t.type === 'service_worker' && t.url.includes(TM_ID));
  console.log(`\n篡改猴 service worker: ${sw ? '✓ 运行中' : '✗ 未运行'}`);

  if (sw) {
    const s = await Session.connect(sw.webSocketDebuggerUrl);
    await s.send('Runtime.enable');
    const r = await s.eval(`(async function(){
      var out = {};
      try { var me = await chrome.management.getSelf(); out.self = { name: me.name, version: me.version, enabled: me.enabled }; } catch(e){ out.selfErr = String(e); }
      out.hasUserScriptsApi = !!chrome.userScripts;
      try { if (chrome.userScripts) { var s2 = await chrome.userScripts.getScripts(); out.registered = s2.length; } } catch(e){ out.usErr = String(e); }
      try { var p = await chrome.permissions.getAll(); out.permissions = p.permissions; } catch(e){}
      try { var all = await chrome.storage.local.get(null);
        out.scriptCount = Object.keys(all).filter(function(k){ return /@meta#/.test(k) }).length; } catch(e){}
      return JSON.stringify(out, null, 2);
    })()`, true);
    console.log('\n=== 篡改猴状态 ===');
    console.log(r.value || r.error);
    s.ws.close();
  }

  // 打开一个雨课堂页，看脚本有没有注入 + 控制台有没有报错
  const pages = list.filter((t) => t.type === 'page');
  const p = pages.find((x) => /yuketang/i.test(x.url)) || pages[0];
  if (p) {
    const s = await Session.connect(p.webSocketDebuggerUrl);
    await s.send('Runtime.enable');
    const errs = [];
    s.ws.addEventListener('message', (ev) => {
      try {
        const m = JSON.parse(ev.data);
        if (m.method === 'Runtime.exceptionThrown') {
          errs.push((m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text || '').slice(0, 200));
        }
      } catch (e) { }
    });
    await s.send('Page.reload', { ignoreCache: true }).catch(() => { });
    await sleep(14000);
    const r = await s.eval(`JSON.stringify({
      url: location.pathname,
      hasTool: !!window.__yktTool,
      panel: !!document.getElementById('ykt-tool-host'),
      video: !!document.querySelector('video'),
    })`);
    console.log('\n=== 刷新后页面状态 ===');
    console.log('  ' + (r.value || r.error));
    if (errs.length) {
      console.log('\n=== 页面异常 ===');
      errs.slice(0, 8).forEach((e) => console.log('  ' + e));
    } else {
      console.log('  （页面无未捕获异常）');
    }
    s.ws.close();
  }

  process.exit(0);
})().catch((e) => { console.error('异常:', e && e.stack || e); process.exit(1); });

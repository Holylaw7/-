#!/usr/bin/env node
/**
 * 用全新标签页做一次干净的注入验证（避免旧页面/旧注入干扰）。
 *   node _tools/fresh-injection-check.js [url]
 */
const CONFIG = require('./config');
const PORT = Number(process.env.CDP_PORT || 9222);
const URL_ARG = process.argv.find((a) => /^https?:\/\//.test(a))
  || CONFIG.origin + `/ai-workspace/lms-graph/${CONFIG.classroom}/video/${LEAF}?is_chapter=1`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LEAF = CONFIG.leaf || process.argv[2] || CONFIG.PLACEHOLDER;

class Session {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.consoleLogs = []; this.exceptions = []; }
  static async connect(u) {
    const ws = new WebSocket(u);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws fail')); });
    const s = new Session(ws);
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && s.pending.has(m.id)) {
        const { res, rej } = s.pending.get(m.id); s.pending.delete(m.id);
        m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
      } else if (m.method === 'Runtime.consoleAPICalled') {
        const txt = (m.params.args || []).map((a) => a.value ?? a.description ?? '').join(' ');
        s.consoleLogs.push(txt.slice(0, 200));
      } else if (m.method === 'Runtime.exceptionThrown') {
        s.exceptions.push((m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text || '').slice(0, 300));
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
  async eval(expr) {
    try {
      const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, userGesture: true });
      if (r.exceptionDetails) return { error: r.exceptionDetails.exception?.description || 'err' };
      return { value: r.result.value };
    } catch (e) { return { error: e.message }; }
  }
}

(async () => {
  // 用一个空白标签页做控制端
  const list = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).filter((t) => t.type === 'page');
  const ctl = await Session.connect(list[0].webSocketDebuggerUrl);
  await ctl.send('Page.enable');

  console.log('创建全新标签页…');
  const nt = await ctl.send('Target.createTarget', { url: 'about:blank' });
  ctl.ws.close();
  await sleep(1500);
  const fresh = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json())
    .filter((t) => t.type === 'page').find((p) => p.id === nt.targetId);
  if (!fresh) { console.error('无法创建标签页'); process.exit(1); }

  const s = await Session.connect(fresh.webSocketDebuggerUrl);
  await s.send('Page.enable'); await s.send('Runtime.enable');

  console.log('导航到:', URL_ARG.slice(0, 90));
  await s.send('Page.navigate', { url: URL_ARG });
  await sleep(16000);

  const r = await s.eval(`JSON.stringify({
    url: location.pathname,
    hasTool: !!window.__yktTool,
    version: window.__yktTool ? window.__yktTool.state.version : null,
    panel: !!document.getElementById('ykt-tool-host'),
    buttons: (function(){
      var h = document.getElementById('ykt-tool-host');
      if (!h || !h.shadowRoot) return null;
      return [].slice.call(h.shadowRoot.querySelectorAll('.mini')).map(function(b){ return (b.innerText||'').trim(); });
    })(),
    bridge: !!document.getElementById('__ykt_speed_bridge__'),
    hasRaw: !!window.__yktRaw,
    guardPatched: !!(HTMLMediaElement.prototype.pause && HTMLMediaElement.prototype.pause.__yktPatched),
    running: window.__yktTool ? window.__yktTool.state.running : null,
    phase: window.__yktTool ? window.__yktTool.state.phase : null,
    rate: window.__yktTool ? window.__yktTool.state.rate : null,
    prog: window.__yktTool ? window.__yktTool.state.progress : null,
    video: (function(){ var v=document.querySelector('video'); return v?{t:+v.currentTime.toFixed(1),dur:Math.round(v.duration),rate:v.playbackRate,paused:v.paused}:null })(),
  })`);
  console.log('\n=== 页面状态 ===');
  try { console.log(JSON.stringify(JSON.parse(r.value), null, 2)); } catch (e) { console.log(r.value || r.error); }

  console.log('\n=== 控制台 [刷课助手] 日志 ===');
  const helper = s.consoleLogs.filter((l) => /刷课助手/.test(l));
  console.log(helper.length ? helper.slice(0, 12).map((l) => '  ' + l.replace(/%c/g, '').trim()).join('\n') : '  （没有）');

  console.log('\n=== 全部控制台日志（前 15 条）===');
  s.consoleLogs.slice(0, 15).forEach((l) => console.log('  ' + l.slice(0, 150)));

  if (s.exceptions.length) {
    console.log('\n=== 页面异常 ===');
    s.exceptions.slice(0, 6).forEach((e) => console.log('  ' + e));
  }

  s.ws.close();
  process.exit(0);
})().catch((e) => { console.error('异常:', e && e.stack || e); process.exit(1); });

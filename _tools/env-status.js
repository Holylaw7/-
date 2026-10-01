#!/usr/bin/env node
/**
 * 环境总检查：调试端口 / 篡改猴加载状态 / 当前页面 / 脚本注入情况
 *   node _tools/env-status.js
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
  send(method, params = {}, t = 20000) {
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
  console.log('=== 1. 调试端口 ===');
  let version = null;
  try {
    version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`, { signal: AbortSignal.timeout(3000) })).json();
    console.log('  ✓', version.Browser);
  } catch (e) {
    console.log('  ✗ 端口未开启（调试窗口没在运行）');
    process.exit(1);
  }

  console.log('\n=== 2. 所有调试目标 ===');
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  list.forEach((t) => console.log(`  [${t.type}] ${String(t.title || '').slice(0, 22).padEnd(24)} ${t.url.slice(0, 95)}`));

  const tm = list.filter((t) => t.url.includes(TM_ID));
  console.log(`\n篡改猴目标: ${tm.length ? '✓ ' + tm.map((t) => t.type).join(',') : '✗ 未加载'}`);

  console.log('\n=== 3. 页面侧状态 ===');
  const pages = list.filter((t) => t.type === 'page');
  for (const p of pages.slice(0, 4)) {
    const s = await Session.connect(p.webSocketDebuggerUrl);
    await s.send('Runtime.enable');
    const r = await s.eval(`JSON.stringify({
      url: location.href,
      hasTool: !!window.__yktTool,
      panel: !!document.getElementById('ykt-tool-host'),
      cards: document.querySelectorAll('section.studentCard').length,
      video: (function(){ var v=document.querySelector('video'); return v?{t:+v.currentTime.toFixed(1),rate:v.playbackRate,paused:v.paused}:null })(),
      speedBtn: !!document.querySelector('.xt_video_player_speed, xt-speedbutton'),
      ls: (function(){ try { return Object.keys(localStorage).filter(function(k){return k.indexOf('ykt_tool')>=0}).map(function(k){return k+'='+localStorage.getItem(k)}); } catch(e){ return null } })(),
    })`);
    console.log(`  ▸ ${p.url.slice(0, 80)}`);
    console.log(`     ${r.value}`);
    s.ws.close();
  }

  process.exit(0);
})().catch((e) => { console.error('异常:', e && e.stack || e); process.exit(1); });

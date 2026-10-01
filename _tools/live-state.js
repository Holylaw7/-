#!/usr/bin/env node
/**
 * 实时观察真实站点上脚本的运行状态（面板日志 + 视频 + 诊断接口）。
 *   node _tools/live-state.js [观察秒数]
 */
const PORT = Number(process.env.CDP_PORT || 9222);
const DURATION = Number(process.argv[2] || 30);
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
  async eval(expr) {
    try {
      const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, userGesture: true });
      if (r.exceptionDetails) return { error: r.exceptionDetails.exception?.description || 'err' };
      return { value: r.result.value };
    } catch (e) { return { error: e.message }; }
  }
}

const PROBE = `JSON.stringify({
  path: location.pathname,
  leaf: (function(){ var m = location.pathname.match(/\\/video\\/(\\d+)/); return m ? m[1] : null })(),
  hasTool: !!window.__yktTool,
  toolInIframeWorld: (function(){ try { return typeof __yktTool !== 'undefined' } catch(e){ return 'no' } })(),
  panelLog: (function(){
    var h = document.getElementById('ykt-tool-host');
    if (!h || !h.shadowRoot) return null;
    var log = h.shadowRoot.getElementById('log');
    if (!log) return null;
    return (log.innerText||'').split('\\n').filter(Boolean);
  })(),
  panelStat: (function(){
    var h = document.getElementById('ykt-tool-host');
    if (!h || !h.shadowRoot) return null;
    var g = function(id){ var e = h.shadowRoot.getElementById(id); return e ? (e.innerText||'').trim() : null };
    return { page: g('s-page'), prog: g('s-prog'), rate: g('s-rate'), guard: g('s-guard') };
  })(),
  rateDetail: (function(){ var e=document.querySelector('.rate-detail .text'); return e?(e.innerText||'').trim():null })(),
  video: (function(){ var v=document.querySelector('video');
    return v?{t:+v.currentTime.toFixed(1), dut:isFinite(v.duration)?Math.round(v.duration):null, rate:v.playbackRate, paused:v.paused}:null })(),
  speedUi: (function(){ var e=document.querySelector('.xt_video_player_common_value, xt-speedvalue'); return e?(e.innerText||'').trim():null })(),
})`;

(async () => {
  const list = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).filter((t) => t.type === 'page');
  const p = list.find((x) => /yuketang/i.test(x.url));
  if (!p) { console.error('没有雨课堂标签页'); process.exit(1); }
  console.log('观察:', p.url.slice(0, 95), `（${DURATION} 秒）\n`);

  const s = await Session.connect(p.webSocketDebuggerUrl);
  await s.send('Runtime.enable');

  const t0 = Date.now();
  let lastSig = '';
  while (Date.now() - t0 < DURATION * 1000) {
    const r = await s.eval(PROBE);
    if (!r.error && r.value) {
      const d = JSON.parse(r.value);
      const live = d.video ? `t=${d.video.t}/${d.video.dut} rate=${d.video.rate}${d.video.paused ? ' 暂停' : ' 播放'}` : '无视频';
      const sig = `${d.leaf}|${live}|${d.rateDetail}|${d.speedUi}|${JSON.stringify(d.panelStat)}`;
      if (sig !== lastSig) {
        console.log(`[${((Date.now() - t0) / 1000).toFixed(0).padStart(3)}s] leaf=${d.leaf}  ${live}`);
        console.log(`       站点标记=${d.rateDetail}  播放器界面=${d.speedUi}  面板=${JSON.stringify(d.panelStat)}`);
        lastSig = sig;
      }
    }
    await sleep(1500);
  }

  const fin = await s.eval(PROBE);
  const d = JSON.parse(fin.value);
  console.log('\n=== 面板最近日志 ===');
  (d.panelLog || []).slice(-14).forEach((l) => console.log('  ' + l));
  console.log('\nhasTool:', d.hasTool, ' 查看世界:', d.toolInIframeWorld);
  s.ws.close();
  process.exit(0);
})().catch((e) => { console.error('异常:', e && e.stack || e); process.exit(1); });

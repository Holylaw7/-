#!/usr/bin/env node
/**
 * 持续观察真实页面上脚本的运行情况（不注入、不导航，只看）。
 *   node _tools/real-watch.js [观察秒数]
 */
const PORT = Number(process.env.CDP_PORT || 9222);
const SECONDS = Number(process.argv[2]) || 40;
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
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, userGesture: true });
    if (r.exceptionDetails) return { error: r.exceptionDetails.exception?.description || 'err' };
    return { value: r.result.value };
  }
}

const PROBE = `JSON.stringify({
  url: location.href,
  frame: (function(){ try { return window.top === window.self ? 'top' : 'iframe' } catch(e){ return 'cross' } })(),
  panel: !!document.getElementById('ykt-tool-host'),
  tool: window.__yktTool ? {
    running: window.__yktTool.state.running, phase: window.__yktTool.state.phase,
    done: window.__yktTool.state.doneReason, prog: window.__yktTool.state.progress,
    rate: window.__yktTool.state.rate, paused: window.__yktTool.state.paused,
    t: window.__yktTool.state.currentTime, dur: window.__yktTool.state.duration,
    media: window.__yktTool.state.mediaTag, streak: window.__yktTool.state.sameLeafStreak,
    fixes: window.__yktTool.state.rateStats ? window.__yktTool.state.rateStats.fixCount : 0,
    blockedPause: window.__yktTool.state.guard.blockedPause,
  } : null,
  rateText: (function(){ var el=document.querySelector('xt-speedvalue, .xt_video_player_speed'); return el?(el.innerText||'').trim():null })(),
  rateDetail: (function(){ var el=document.querySelector('.rate-detail .text'); return el?(el.innerText||'').trim():null })(),
  video: (function(){ var v=document.querySelector('video'); return v?{paused:v.paused,rate:v.playbackRate,t:+v.currentTime.toFixed(1),dur:Math.round(v.duration),muted:v.muted}:null })(),
})`;

(async () => {
  const pages = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).filter((t) => t.type === 'page');
  const target = pages.find((p) => /yuketang/i.test(p.url)) || pages[0];
  if (!target) { console.error('没有可用标签页'); process.exit(1); }
  const s = await Session.connect(target.webSocketDebuggerUrl);
  await s.send('Runtime.enable');
  console.log(`观察 ${SECONDS} 秒（目标标签页: ${target.url.slice(0, 90)}）\n`);
  console.log('时刻   frame  running phase 进度  倍速  暂停   播放位置        完成依据');
  console.log('-'.repeat(96));
  const t0 = Date.now();
  let last = '';
  while ((Date.now() - t0) / 1000 < SECONDS) {
    const r = await s.eval(PROBE);
    if (!r.error) {
      const d = JSON.parse(r.value);
      const el = ((Date.now() - t0) / 1000).toFixed(0).padStart(3);
      if (d.tool) {
        const line = `${el}s  ${d.frame.padEnd(6)} ${String(d.tool.running).padEnd(7)} ${String(d.tool.phase).padEnd(5)} `
          + `${String(d.tool.prog).padStart(3)}%  ${String(d.rateText || d.tool.rate).padEnd(5)} `
          + `${String(d.tool.paused).padEnd(6)} ${String(d.tool.t).padStart(7)}/${String(d.tool.dur).padEnd(7)} ${d.tool.done || '-'}`;
        if (line.slice(6) !== last) { console.log(line); last = line.slice(6); }
      } else if (d.url !== 'about:blank') {
        const line = `${el}s  ${d.frame.padEnd(6)} （本帧无脚本） ${d.url.slice(0, 60)}`;
        if (line.slice(6) !== last) { console.log(line); last = line.slice(6); }
      }
    }
    await sleep(2000);
  }
  const r = await s.eval(PROBE);
  if (!r.error) console.log('\n最终状态:\n' + JSON.stringify(JSON.parse(r.value), null, 2));
  s.ws.close();
  process.exit(0);
})().catch((e) => { console.error('异常:', e && e.stack || e); process.exit(1); });

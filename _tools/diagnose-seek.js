#!/usr/bin/env node
/**
 * 聚焦：拖到结尾后，脚本的完成判定各信号分别读到什么（找出为什么没判定完成）。
 *   node _tools/diagnose-seek.js [leafId]
 */
const CONFIG = require('./config');
const fs = require('fs');
const path = require('path');
const PORT = Number(process.env.CDP_PORT || 9222);
const CLASSROOM = CONFIG.classroom;
const LEAF = process.argv[2] || `${LEAF}`;
const USERSCRIPT = path.join(__dirname, '..', 'dist', 'changjiang-yuketang-auto.user.js');
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

// 逐一读取脚本完成判定所用的每个信号
const SIGNALS = `JSON.stringify({
  media: (function(){ var v=document.querySelector('video');
    return v?{ t:+v.currentTime.toFixed(2), dur:+Number(v.duration).toFixed(2), ended:v.ended, paused:v.paused, rate:v.playbackRate,
      nearEnd: (isFinite(v.duration) && v.duration>0) ? +( (v.duration - v.currentTime) ).toFixed(2) : null }:null })(),
  rateDetailText: (function(){ var e=document.querySelector('.rate-detail .text'); return e?(e.innerText||'').replace(/\\s+/g,' ').trim():null })(),
  rateDetailFull: (function(){ var e=document.querySelector('.rate-detail'); return e?(e.innerText||'').replace(/\\s+/g,' ').trim():null })(),
  navProgressNum: (function(){ var e=document.querySelector('.nav-progress .progress-num'); return e?(e.innerText||'').trim():null })(),
  progressWrapText: (function(){ var e=document.querySelector('.progress-wrap .text'); return e?(e.innerText||'').trim():null })(),
  playerTimeDisplay: (function(){ var e=document.querySelector('.xt_video_player_current_time_display'); return e?(e.innerText||'').trim():null })(),
  nextBtn: (function(){ var b=document.querySelector('.nav-footer .nav-next, .nav-next');
    return b?{ text:(b.innerText||'').replace(/\\s+/g,' ').trim(), disabled:b.classList.contains('is-disabled') }:null })(),
  panelProg: (function(){ var h=document.getElementById('ykt-tool-host'); if(!h||!h.shadowRoot) return null;
    var e=h.shadowRoot.getElementById('s-prog'); return e?(e.innerText||'').trim():null })(),
  panelLog: (function(){ var h=document.getElementById('ykt-tool-host'); if(!h||!h.shadowRoot) return null;
    var l=h.shadowRoot.getElementById('log'); return l?(l.innerText||'').split('\\n').filter(Boolean).slice(-6):null })(),
})`;

(async () => {
  const list = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).filter((t) => t.type === 'page');
  const ctl = await Session.connect(list[0].webSocketDebuggerUrl);
  await ctl.send('Page.enable');
  const nt = await ctl.send('Target.createTarget', { url: 'about:blank' });
  ctl.ws.close();
  await sleep(1200);
  const fresh = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json())
    .filter((t) => t.type === 'page').find((p) => p.id === nt.targetId);
  const s = await Session.connect(fresh.webSocketDebuggerUrl);
  await s.send('Page.enable'); await s.send('Runtime.enable');

  await s.send('Page.addScriptToEvaluateOnNewDocument', { source: fs.readFileSync(USERSCRIPT, 'utf8') });
  await s.send('Page.navigate', { url: `${CONFIG.origin}/ai-workspace/lms-graph/${CLASSROOM}/video/${LEAF}?is_chapter=1` });
  await sleep(14000);

  console.log('=== 拖动前 ===');
  let d = JSON.parse((await s.eval(SIGNALS)).value);
  console.log('  media:', JSON.stringify(d.media));
  console.log('  .rate-detail .text:', JSON.stringify(d.rateDetailText));
  console.log('  .nav-progress .progress-num:', JSON.stringify(d.navProgressNum));
  console.log('  播放器时间:', JSON.stringify(d.playerTimeDisplay));
  console.log('  下一个按钮:', JSON.stringify(d.nextBtn));
  console.log('  面板进度:', JSON.stringify(d.panelProg));

  console.log('\n=== 执行拖动到结尾 ===');
  const seek = await s.eval(`(function(){
    var v = document.querySelector('video');
    if (!v) return 'no video';
    v.currentTime = Math.max(0, v.duration - 0.4);
    return JSON.stringify({ t: +v.currentTime.toFixed(2), dur: +v.duration.toFixed(2) });
  })()`);
  console.log('  ', seek.value);

  for (let i = 1; i <= 8; i++) {
    await sleep(2500);
    d = JSON.parse((await s.eval(SIGNALS)).value);
    console.log(`\n--- 拖动后 ${i * 2.5}s ---`);
    console.log('  media:', JSON.stringify(d.media));
    console.log('  .rate-detail .text:', JSON.stringify(d.rateDetailText));
    console.log('  播放器时间:', JSON.stringify(d.playerTimeDisplay));
    console.log('  面板进度:', JSON.stringify(d.panelProg));
    console.log('  面板日志尾:', JSON.stringify((d.panelLog || []).slice(-3)));
    if (d.panelLog && d.panelLog.join(' ').indexOf('完成') >= 0) break;
  }

  s.ws.close();
  process.exit(0);
})().catch((e) => { console.error('异常:', e && e.stack || e); process.exit(1); });

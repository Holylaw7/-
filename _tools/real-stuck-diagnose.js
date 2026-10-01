#!/usr/bin/env node
/**
 * 现场诊断：脚本为什么卡在某一节不动。
 *   node _tools/real-stuck-diagnose.js
 */
const PORT = Number(process.env.CDP_PORT || 9222);
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

const PROBE = `JSON.stringify({
  url: location.href,
  path: location.pathname,
  title: (function(){ var t=document.querySelector('.video-box .title, .rate-detail, .title'); return t?(t.innerText||'').replace(/\\s+/g,' ').trim().slice(0,60):null })(),
  rateDetail: (function(){ var e=document.querySelector('.rate-detail'); return e?(e.innerText||'').replace(/\\s+/g,' ').trim():null })(),
  navProgress: (function(){ var e=document.querySelector('.nav-progress .progress-num'); return e?(e.innerText||'').trim():null })(),
  nextBtn: (function(){ var b=document.querySelector('.nav-footer .nav-next, .nav-next');
    return b?{ text:(b.innerText||'').replace(/\\s+/g,' ').trim(), disabled:b.classList.contains('is-disabled') }:null })(),
  prevBtn: (function(){ var b=document.querySelector('.nav-footer .nav-prev, .nav-prev');
    return b?{ text:(b.innerText||'').replace(/\\s+/g,' ').trim(), disabled:b.classList.contains('is-disabled') }:null })(),
  video: (function(){ var v=document.querySelector('video');
    return v?{ t:+v.currentTime.toFixed(1), dur:isFinite(v.duration)?Math.round(v.duration):String(v.duration), paused:v.paused, rate:v.playbackRate, ended:v.ended, rs:v.readyState, seeking:v.seeking }:null })(),
  mediaCount: document.querySelectorAll('video,audio').length,
  tool: window.__yktTool ? {
    running: window.__yktTool.state.running, phase: window.__yktTool.state.phase,
    done: window.__yktTool.state.doneReason, prog: window.__yktTool.state.progress,
    streak: window.__yktTool.state.sameLeafStreak, rate: window.__yktTool.state.rate,
    paused: window.__yktTool.state.paused, t: window.__yktTool.state.currentTime,
    dur: window.__yktTool.state.duration, leaf: window.__yktTool.state.route.leafId,
    sameLeaf: window.__yktTool.state.sameLeafStreak,
  } : null,
  panelLog: (function(){ var h=document.getElementById('ykt-tool-host');
    if(!h||!h.shadowRoot) return null;
    var log=h.shadowRoot.getElementById('log');
    return log ? (log.innerText||'').split('\\n').slice(-14) : null })(),
})`;

(async () => {
  const pages = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).filter((t) => t.type === 'page');
  const target = pages.find((p) => /yuketang/i.test(p.url));
  if (!target) {
    console.log('没有雨课堂标签页。当前页面:');
    pages.forEach((p) => console.log('  ' + p.url.slice(0, 110)));
    process.exit(0);
  }
  const s = await Session.connect(target.webSocketDebuggerUrl);
  await s.send('Runtime.enable');
  const r = await s.eval(PROBE);
  const d = JSON.parse(r.value);
  console.log('=== 现场状态 ===');
  console.log('URL        :', d.url);
  console.log('小节标题   :', d.title);
  console.log('.rate-detail:', d.rateDetail);
  console.log('导航进度   :', d.navProgress);
  console.log('下一个按钮 :', JSON.stringify(d.nextBtn));
  console.log('上一个按钮 :', JSON.stringify(d.prevBtn));
  console.log('视频       :', JSON.stringify(d.video));
  console.log('媒体元素数 :', d.mediaCount);
  console.log('脚本状态   :', JSON.stringify(d.tool, null, 2));
  console.log('\n=== 面板最近日志 ===');
  (d.panelLog || []).forEach((l) => console.log('  ' + l));

  // 采样 12 秒看播放位置是否推进
  console.log('\n=== 采样 12 秒，看播放是否在推进 ===');
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < 12000) {
    const cur = JSON.parse((await s.eval(PROBE)).value);
    const tag = `t=${cur.video ? cur.video.t : '-'} paused=${cur.video ? cur.video.paused : '-'} rate=${cur.video ? cur.video.rate : '-'} prog=${cur.tool ? cur.tool.prog : '-'}% phase=${cur.tool ? cur.tool.phase : '-'} streak=${cur.tool ? cur.tool.streak : '-'}`;
    if (tag !== last) { console.log(`  [${((Date.now() - t0) / 1000).toFixed(0)}s] ${tag}`); last = tag; }
    await sleep(1500);
  }
  s.ws.close();
  process.exit(0);
})().catch((e) => { console.error('异常:', e && e.stack || e); process.exit(1); });

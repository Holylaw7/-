#!/usr/bin/env node
/**
 * 自动播放拦截诊断（真实站点）
 *   node _tools/diagnose-autoplay.js
 *
 * 抓取：媒体元素状态、静音状态、用户激活状态、play() 的真实拒绝原因。
 */
const fs = require('fs');
const path = require('path');
const CONFIG = require('./config');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Session {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.console = []; }
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
        s.console.push((m.params.args || []).map((a) => a.value ?? a.description ?? '').join(' ').replace(/%c/g, '').slice(0, 180));
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
  async eval(expr, aw = false) {
    try {
      const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: aw, userGesture: true });
      if (r.exceptionDetails) return { error: r.exceptionDetails.exception?.description || 'err' };
      return { value: r.result.value };
    } catch (e) { return { error: e.message }; }
  }
}

const PROBE = `JSON.stringify({
  media: (function(){ var v=document.querySelector('video');
    if(!v) return null;
    return { tag:v.tagName, muted:v.muted, defaultMuted:v.defaultMuted, volume:v.volume,
      attrMuted: v.hasAttribute('muted'), autoplayAttr: v.hasAttribute('autoplay'),
      paused:v.paused, ended:v.ended, readyState:v.readyState, networkState:v.networkState,
      currentTime:+v.currentTime.toFixed(2), duration:isFinite(v.duration)?Math.round(v.duration):null,
      src: (v.currentSrc||v.src||'').slice(0,80) }; })(),
  allMedia: document.querySelectorAll('video,audio').length,
  userActivation: (function(){
    try { return { isActive: navigator.userActivation.isActive, hasBeenActive: navigator.userActivation.hasBeenActive }; }
    catch(e){ return 'unavailable'; } })(),
  panelLog: (function(){ var h=document.getElementById('ykt-tool-host'); if(!h||!h.shadowRoot) return null;
    var l=h.shadowRoot.getElementById('log'); if(!l) return null;
    return (l.innerText||'').split('\\n').filter(Boolean).slice(-10); })(),
  guard: (function(){ var h=document.getElementById('ykt-tool-host'); if(!h||!h.shadowRoot) return null;
    var g=h.shadowRoot.getElementById('s-guard'); return g?(g.innerText||'').trim():null; })(),
  hasTool: !!window.__yktTool,
  playFail: window.__yktTool ? window.__yktTool.state.playFailCount : null,
  rate: window.__yktTool ? window.__yktTool.state.rate : null,
})`;

(async () => {
  if (!CONFIG.require('diagnose-autoplay.js')) process.exit(1);
  const leaf = await CONFIG.requireLeaf('diagnose-autoplay.js');
  if (!leaf) process.exit(1);

  const list = (await (await fetch(`http://127.0.0.1:${CONFIG.cdpPort}/json/list`)).json()).filter((t) => t.type === 'page');
  const ctl = await Session.connect(list[0].webSocketDebuggerUrl);
  await ctl.send('Page.enable');
  const nt = await ctl.send('Target.createTarget', { url: 'about:blank' });
  ctl.ws.close();
  await sleep(1200);
  const fresh = (await (await fetch(`http://127.0.0.1:${CONFIG.cdpPort}/json/list`)).json())
    .filter((t) => t.type === 'page').find((p) => p.id === nt.targetId);
  const s = await Session.connect(fresh.webSocketDebuggerUrl);
  await s.send('Page.enable'); await s.send('Runtime.enable');

  const src = fs.readFileSync(path.join(__dirname, '..', 'dist', 'changjiang-yuketang-auto.user.js'), 'utf8');
  await s.send('Page.addScriptToEvaluateOnNewDocument', { source: src });

  console.log('打开播放页（不模拟任何用户手势，观察自动播放是否被拦截）…');
  await s.send('Page.navigate', { url: CONFIG.url.video(leaf) });
  await sleep(16000);

  console.log('\n=== 首次探测 ===');
  let d = JSON.parse((await s.eval(PROBE)).value);
  console.log('  媒体元素:', JSON.stringify(d.media, null, 1).replace(/\n/g, '\n  '));
  console.log('  用户激活:', JSON.stringify(d.userActivation));
  console.log('  脚本 playFailCount:', d.playFail, '  倍速:', d.rate);
  console.log('  守卫:', d.guard);
  console.log('  面板日志:');
  (d.panelLog || []).forEach((l) => console.log('    ' + l));

  // 直接尝试 play() 并抓取真实错误
  console.log('\n=== 直接调用 play() 看真实错误 ===');
  const r = await s.eval(`(async function(){
    var v = document.querySelector('video');
    if (!v) return 'no video';
    var before = { muted: v.muted, volume: v.volume, paused: v.paused, hasBeenActive: (function(){try{return navigator.userActivation.hasBeenActive}catch(e){return 'na'}})() };
    var out = { before: before };
    try { await v.play(); out.mutedPlay = 'OK'; }
    catch (e) { out.mutedPlay = 'REJECTED ' + e.name + ': ' + e.message; }
    out.afterMutedPlay = { paused: v.paused, currentTime: +v.currentTime.toFixed(2) };
    return JSON.stringify(out, null, 1);
  })()`, true);
  console.log(r.value || r.error);

  // 模拟一次真实用户手势后再试（验证"是否只差一个手势"）
  console.log('\n=== 用 CDP 真实鼠标点击页面后再看 ===');
  await s.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 60, y: 60, button: 'left', clickCount: 1 });
  await s.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 60, y: 60, button: 'left', clickCount: 1 });
  await sleep(3000);

  d = JSON.parse((await s.eval(PROBE)).value);
  console.log('  用户激活:', JSON.stringify(d.userActivation));
  console.log('  媒体:', JSON.stringify(d.media));
  console.log('  playFailCount:', d.playFail);
  console.log('  面板日志:');
  (d.panelLog || []).slice(-6).forEach((l) => console.log('    ' + l));

  console.log('\n=== 脚本控制台里的拦截告警 ===');
  s.console.filter((l) => /拦截|play|播放/.test(l)).slice(-8).forEach((l) => console.log('  ' + l));

  s.ws.close();
  process.exit(0);
})().catch((e) => { console.error('异常:', e && e.stack || e); process.exit(1); });

#!/usr/bin/env node
/**
 * 查看真实播放器 unRatehandler 的实现，并尝试用它同步倍速。
 *   node _tools/real-ratehandler.js
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
  send(method, params = {}, t = 40000) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error('timeout ' + method)); } }, t);
    });
  }
  async eval(expr, aw = false) {
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: aw, userGesture: true });
    if (r.exceptionDetails) return { error: r.exceptionDetails.exception?.description || 'err' };
    return { value: r.result.value };
  }
}

(async () => {
  const pages = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).filter((t) => t.type === 'page');
  const target = pages.find((p) => /yuketang/i.test(p.url)) || pages[0];
  const s = await Session.connect(target.webSocketDebuggerUrl);
  await s.send('Runtime.enable');
  console.log('目标页:', target.url.slice(0, 100), '\n');

  const src = await s.eval(`(function(){
    var root = document.querySelector('.xt_video_player_container, .xtplayer, .video-box');
    var vm = root && root.__vue__;
    var p = vm && vm.$data && vm.$data.player;
    if (!p) return 'no player';
    return JSON.stringify({
      unRatehandler: String(p.unRatehandler).slice(0, 1200),
      unMutedhandler: String(p.unMutedhandler).slice(0, 600),
      speedValue: p.speed,
      optionsSpeedKeys: p.options ? Object.keys(p.options).filter(function(k){return /speed|rate/i.test(k)}) : null,
      optionsSpeedVals: p.options ? (function(){ var o={}; Object.keys(p.options).forEach(function(k){ if(/speed|rate/i.test(k)) o[k]=p.options[k] }); return o })() : null,
    }, null, 2);
  })()`);
  console.log('=== unRatehandler 源码 ===');
  console.log(src.value);

  console.log('\n=== 尝试调用 unRatehandler 并观察界面 ===');
  const before = await s.eval(`JSON.stringify({
    uiText: (function(){var e=document.querySelector('.xt_video_player_common_value, xt-speedvalue');return e?(e.innerText||'').trim():null})(),
    videoRate: (function(){var v=document.querySelector('video');return v?v.playbackRate:null})(),
    playerSpeed: (function(){var r=document.querySelector('.xt_video_player_container, .xtplayer, .video-box');var p=r&&r.__vue__&&r.__vue__.$data.player;return p?p.speed:null})()
  })`);
  console.log('调用前:', before.value);

  const call = await s.eval(`(function(){
    var root = document.querySelector('.xt_video_player_container, .xtplayer, .video-box');
    var p = root && root.__vue__ && root.__vue__.$data.player;
    if (!p) return 'no player';
    var log = [];
    var v = document.querySelector('video');
    // 先把内部 speed 设成目标值，再触发它的处理函数
    try { p.speed = 2; log.push('p.speed=2'); } catch(e){ log.push('set speed fail '+e.message) }
    try { if (v) v.playbackRate = 2; log.push('v.playbackRate=2'); } catch(e){}
    try { p.unRatehandler(); log.push('p.unRatehandler() 已调用'); } catch(e){ log.push('unRatehandler fail: '+e.message) }
    return log.join(' | ');
  })()`);
  console.log('操作:', call.value);

  await sleep(1500);
  const after = await s.eval(`JSON.stringify({
    uiText: (function(){var e=document.querySelector('.xt_video_player_common_value, xt-speedvalue');return e?(e.innerText||'').trim():null})(),
    videoRate: (function(){var v=document.querySelector('video');return v?v.playbackRate:null})(),
    playerSpeed: (function(){var r=document.querySelector('.xt_video_player_container, .xtplayer, .video-box');var p=r&&r.__vue__&&r.__vue__.$data.player;return p?p.speed:null})()
  })`);
  console.log('1.5 秒后:', after.value);

  s.ws.close();
  process.exit(0);
})().catch((e) => { console.error('异常:', e && e.stack || e); process.exit(1); });

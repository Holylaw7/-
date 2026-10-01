#!/usr/bin/env node
/**
 * 判定：播放器的倍速界面文字是静态的，还是由 options.speed.value 响应式渲染的？
 *   node _tools/real-speed-ui-truth.js
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

  const r = await s.eval(`(async function () {
    var out = {};
    var valEl = document.querySelector('.xt_video_player_common_value, xt-speedvalue');
    var root = document.querySelector('.xt_video_player_container, .xtplayer, .video-box');
    var vm = root && root.__vue__;
    var p = vm && vm.$data && vm.$data.player;
    var v = document.querySelector('video');

    out.beforeText = valEl ? valEl.innerText.trim() : null;
    out.beforeOptionsValue = p && p.options && p.options.speed ? p.options.speed.value : null;

    // 1) 改内部值，看界面文字是否变化（判断是否响应式）
    if (p && p.options && p.options.speed) p.options.speed.value = 2;
    await new Promise(function (r) { setTimeout(r, 900) });
    out.afterSetInternalText = valEl ? valEl.innerText.trim() : null;
    out.afterSetInternalOptionsValue = p && p.options && p.options.speed ? p.options.speed.value : null;

    // 2) 直接改文字节点，看是否会被播放器覆盖回去
    if (valEl) valEl.innerText = '2.00X';
    out.rightAfterTextHack = valEl.innerText.trim();
    await new Promise(function (r) { setTimeout(r, 2000) });
    out.afterWaitTextHack = valEl ? valEl.innerText.trim() : null;

    // 3) 播放器的 speedValue 候选列表与当前值
    out.optionsSpeedDump = p && p.options && p.options.speed ? JSON.parse(JSON.stringify(p.options.speed)) : null;

    // 4) 播放器上所有可能是「设速」的函数
    if (p) {
      var fns = [];
      var o = p;
      for (var i = 0; i < 3 && o && o !== Object.prototype; i++) {
        Object.getOwnPropertyNames(o).forEach(function (k) {
          try { if (typeof o[k] === 'function' && /rate|speed|playback/i.test(k)) fns.push(k); } catch (e) { }
        });
        o = Object.getPrototypeOf(o);
      }
      out.speedFns = Array.from(new Set(fns));
    }

    out.finalVideoRate = v ? v.playbackRate : null;
    return JSON.stringify(out, null, 2);
  })()`, true);

  console.log(r.error ? ('失败: ' + r.error) : r.value);
  s.ws.close();
  process.exit(0);
})().catch((e) => { console.error('异常:', e && e.stack || e); process.exit(1); });

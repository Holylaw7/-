#!/usr/bin/env node
/**
 * 深入真实播放器的 Vue 实例，找出倍速相关字段与方法，并尝试直接设置。
 *   node _tools/real-player-set.js
 */
const CONFIG = require('./config');
const PORT = Number(process.env.CDP_PORT || 9222);
const URL_ARG = process.argv.find((a) => /^https?:\/\//.test(a))
  || CONFIG.origin + `/ai-workspace/lms-graph/${CONFIG.classroom}/video/${LEAF}?is_chapter=1`;
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

const DIG = `(function () {
const LEAF = CONFIG.leaf || process.argv[2] || CONFIG.PLACEHOLDER;
  var root = document.querySelector('.xt_video_player_container, .xtplayer, .video-box');
  var vm = root && root.__vue__;
  if (!vm) return JSON.stringify({ err: 'no vue on player root' });
  var d = vm.$data || {};
  var out = { dataKeys: Object.keys(d) };

  // player 对象的方法与属性
  var p = d.player;
  if (p) {
    var protoNames = [];
    var o = p;
    for (var i = 0; i < 3 && o && o !== Object.prototype; i++) {
      Object.getOwnPropertyNames(o).forEach(function (n) { protoNames.push(n); });
      o = Object.getPrototypeOf(o);
    }
    out.playerKeys = Array.from(new Set(protoNames));
    out.playerSpeedish = out.playerKeys.filter(function (k) { return /speed|rate|playback/i.test(k); });
    try { out.playerOwnValues = {}; Object.keys(p).forEach(function (k) { if (/speed|rate/i.test(k)) out.playerOwnValues[k] = p[k]; }); } catch (e) { }
  } else out.noPlayer = true;

  // 组件自身 methods
  try {
    var m = vm.$options && vm.$options.methods ? Object.keys(vm.$options.methods) : [];
    out.methods = m;
    out.methodsSpeedish = m.filter(function (k) { return /speed|rate|playback/i.test(k); });
    out.props = vm.$options && vm.$options.props ? Object.keys(vm.$options.props) : [];
    out.propsSpeedish = (out.props || []).filter(function (k) { return /speed|rate|playback/i.test(k); });
  } catch (e) { out.methodsErr = String(e); }

  // 组件计算属性 / $refs
  try { out.refs = Object.keys(vm.$refs || {}); } catch (e) { }
  try { out.computed = Object.keys(vm.$options.computed || {}).filter(function (k) { return /speed|rate/i.test(k) }); } catch (e) { }

  return JSON.stringify(out, null, 2);
})()`;

const SET2 = `(function () {
  var root = document.querySelector('.xt_video_player_container, .xtplayer, .video-box');
  var vm = root && root.__vue__;
  var v = document.querySelector('video');
  var log = [];
  if (!vm) return JSON.stringify({ err: 'no vm' });
  var p = (vm.$data || {}).player;

  // 逐个尝试可能的 API
  function tryCall(name) {
    try {
      if (p && typeof p[name] === 'function') {
        p[name](2);
        log.push('p.' + name + '(2) 调用成功');
        return true;
      }
    } catch (e) { log.push('p.' + name + ' 失败: ' + e.message); }
    return false;
  }
  ['setSpeed', 'setPlaybackRate', 'changeSpeed', 'setRate', 'speed'].forEach(tryCall);

  // 直接给 player 上的倍速属性赋值
  if (p) {
    ['speed', 'playbackRate', 'rate', 'playSpeed'].forEach(function (k) {
      if (k in p) { try { p[k] = 2; log.push('p.' + k + ' = 2'); } catch (e) { } }
    });
  }
  // 组件 data 上的倍速属性
  var d = vm.$data || {};
  ['speed', 'playbackRate', 'rate'].forEach(function (k) {
    if (k in d) { try { vm[k] = 2; vm.$set(d, k, 2); log.push('$data.' + k + ' = 2'); } catch (e) { } }
  });

  // 兜底：媒体元素
  if (v) { v.playbackRate = 2; log.push('video.playbackRate = 2'); }

  return JSON.stringify({ log: log, videoRate: v ? v.playbackRate : null,
    uiText: (function(){ var e=document.querySelector('.xt_video_player_common_value, xt-speedvalue'); return e?(e.innerText||'').trim():null })() });
})()`;

(async () => {
  const pages = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).filter((t) => t.type === 'page');
  const target = pages.find((p) => /yuketang/i.test(p.url)) || pages[0];
  const s = await Session.connect(target.webSocketDebuggerUrl);
  await s.send('Runtime.enable');
  await s.send('Page.enable');
  if (!/lms-graph/.test(target.url)) {
    console.log('导航到视频页…');
    await s.send('Page.navigate', { url: URL_ARG });
    await sleep(11000);
  } else {
    console.log('复用当前视频页:', target.url.slice(0, 100));
  }
  await sleep(1500);

  const r1 = await s.eval(DIG);
  console.log('=== 播放器实例结构 ===');
  console.log(r1.error ? ('失败: ' + r1.error) : r1.value);

  console.log('\n=== 尝试直接设置倍速 ===');
  const r2 = await s.eval(SET2);
  console.log(r2.error ? ('失败: ' + r2.error) : r2.value);
  await sleep(1500);
  const fins = await s.eval(`JSON.stringify({
    videoRate: (function(){var v=document.querySelector('video');return v?v.playbackRate:null})(),
    uiText: (function(){var e=document.querySelector('.xt_video_player_common_value, xt-speedvalue');return e?(e.innerText||'').trim():null})()
  })`);
  console.log('1.5 秒后:', fins.value);

  s.ws.close();
  process.exit(0);
})().catch((e) => { console.error('异常:', e && e.stack || e); process.exit(1); });

#!/usr/bin/env node
/**
 * 挖掘真实播放器的内部状态：找到控制倍速显示的 Vue/组件实例与数据字段。
 *   node _tools/real-player-internals.js [视频URL]
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
  function decribeVue(el, label) {
    if (!el) return { label: label, missing: true };
    var keys = Object.keys(el).filter(function (k) { return k.indexOf('__vue') === 0 || k.indexOf('__vnode') === 0; });
    var out = { label: label, tag: el.tagName.toLowerCase(), vueKeys: keys };
    var vm = el.__vue__ || el.__vueParentComponent || null;
    if (vm) {
      out.hasVm = true;
      out.vmKeys = Object.keys(vm).slice(0, 40);
      try { out.dataKeys = vm.$data ? Object.keys(vm.$data) : (vm.data ? Object.keys(vm.data) : null); } catch (e) { }
      try {
        var d = vm.$data || vm.data || {};
        out.speedish = {};
        Object.keys(d).forEach(function (k) {
          if (/speed|rate|playback/i.test(k)) out.speedish[k] = d[k];
        });
      } catch (e) { out.dataErr = String(e); }
    }
    return out;
  }
  var res = {};
  res.video = decribeVue(document.querySelector('video'), 'video');
  res.wrap = decribeVue(document.querySelector('xt-wrap'), 'xt-wrap');
  res.speedBtn = decribeVue(document.querySelector('.xt_video_player_speed, xt-speedbutton'), 'xt-speedbutton');
  res.speedValue = decribeVue(document.querySelector('.xt_video_player_common_value, xt-speedvalue'), 'xt-speedvalue');
  res.player = decribeVue(document.querySelector('.xt_video_player_container, .xtplayer, .video-box'), 'player-root');

  // 顺带看看组件实例里有没有明显的 setSpeed / changeSpeed 方法
  try {
    var vm = (document.querySelector('video') || {}).__vue__ || (document.querySelector('xt-wrap') || {}).__vueParentComponent;
    if (vm) {
      var names = [];
      var proto = vm;
      for (var i = 0; i < 3 && proto; i++) {
        Object.getOwnPropertyNames(proto).forEach(function (n) { if (/speed|rate|playback|setSpeed/i.test(n)) names.push(n); });
        proto = Object.getPrototypeOf(proto);
      }
      res.methods = Array.from(new Set(names));
    }
  } catch (e) { res.methodsErr = String(e); }

  // 全局变量里有没有播放器实例
  try {
    res.globals = Object.keys(window).filter(function (k) { return /player|xt|video|ykt|playerCtx/i.test(k) && typeof window[k] === 'object'; }).slice(0, 25);
  } catch (e) { }

  return JSON.stringify(res, null, 2);
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
  }
  const r = await s.eval(DIG);
  console.log(r.error ? ('失败: ' + r.error) : r.value);
  s.ws.close();
  process.exit(0);
})().catch((e) => { console.error('异常:', e && e.stack || e); process.exit(1); });

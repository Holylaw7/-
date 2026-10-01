#!/usr/bin/env node
/**
 * 高速采样 playbackRate，抓出「谁在反复把倍速改回 1」。
 *   node _tools/real-rate-probe.js [采样毫秒数]
 */
const PORT = Number(process.env.CDP_PORT || 9222);
const MS = Number(process.argv[2]) || 6000;
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
  send(method, params = {}, t = 60000) {
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
  if (!target) { console.error('没有可用标签页'); process.exit(1); }
  const s = await Session.connect(target.webSocketDebuggerUrl);
  await s.send('Runtime.enable');
  console.log('目标页:', target.url.slice(0, 110), '\n');

  // 1) 统计「谁」触发了 ratechange：记录调用栈
  console.log(`高速采样 ${MS}ms，并在 ratechange 时抓取调用栈…\n`);
  const res = await s.eval(`(async function () {
    var v = document.querySelector('video');
    if (!v) return 'no video';
    var log = [];
    var stacks = [];
    var t0 = performance.now();
    // 每秒记录一次采样快照
    var timer = setInterval(function () {
      log.push([Math.round(performance.now() - t0), v.playbackRate]);
    }, 50);
    // ratechange 时抓栈
    var onRate = function () {
      var e = new Error('ratechange');
      stacks.push({
        at: Math.round(performance.now() - t0),
        rate: v.playbackRate,
        stack: (e.stack || '').split('\\n').slice(2, 7).join(' | '),
      });
    };
    v.addEventListener('ratechange', onRate);
    await new Promise(function (r) { setTimeout(r, ${MS}) });
    clearInterval(timer);
    v.removeEventListener('ratechange', onRate);
    var rates = log.map(function (x) { return x[1]; });
    var uniq = {}; rates.forEach(function (r) { uniq[r] = (uniq[r] || 0) + 1 });
    // 统计「值切换」次数
    var flips = 0;
    for (var i = 1; i < rates.length; i++) if (rates[i] !== rates[i-1]) flips++;
    return JSON.stringify({
      samples: rates.length,
      dist: uniq,
      flips: flips,
      ratechangeEvents: stacks.length,
      sampleTrace: log.filter(function (x, i) { return i < 40 || i > log.length - 10 }).map(function(x){return x[0]+'ms:'+x[1]}),
      stacks: stacks.slice(-6),
    }, null, 2);
  })()`, true);

  console.log(res.error ? ('探测失败: ' + res.error) : res.value);

  console.log('\n=== 脚本自身的倍速统计 ===');
  const rs = await s.eval(`JSON.stringify(window.__yktTool ? window.__yktTool.state.rateStats : null)`);
  console.log(rs.value);

  console.log('\n=== 站点播放器内部状态（尝试读取 Vue 实例） ===');
  const vu = await s.eval(`(function(){
    var wrap = document.querySelector('xt-wrap');
    var out = {};
    try {
      var keys = Object.keys(wrap || {});
      out.wrapKeys = keys.slice(0, 20);
      var vue = wrap && (wrap.__vue__ || wrap.__vue_parent__);
      if (vue) {
        out.hasVue = true;
        out.vueKeys = Object.keys(vue).slice(0, 30);
        out.dataKeys = vue.$data ? Object.keys(vue.$data).slice(0, 40) : null;
      } else out.hasVue = false;
    } catch (e) { out.err = String(e); }
    return JSON.stringify(out, null, 2);
  })()`);
  console.log(vu.value);

  s.ws.close();
  process.exit(0);
})().catch((e) => { console.error('异常:', e && e.stack || e); process.exit(1); });

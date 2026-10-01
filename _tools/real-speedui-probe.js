#!/usr/bin/env node
/**
 * 检查真实页面倍速菜单的可见性/结构与点击可行性。
 *   node _tools/real-speedui-probe.js
 */
const PORT = Number(process.env.CDP_PORT || 9222);

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

const PROBE = `(function () {
  function info(el, label) {
    if (!el) return { label: label, missing: true };
    var cs = getComputedStyle(el);
    var r = el.getBoundingClientRect();
    return {
      label: label,
      tag: el.tagName.toLowerCase(),
      cls: (typeof el.className === 'string' ? el.className : '') || null,
      rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
      display: cs.display, visibility: cs.visibility, opacity: cs.opacity,
      pointerEvents: cs.pointerEvents, overflow: cs.overflow,
      parentDisplay: el.parentElement ? getComputedStyle(el.parentElement).display : null,
      text: (el.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 60),
    };
  }
  var btn = document.querySelector('xt-speedbutton, .xt_video_player_speed');
  var list = document.querySelector('xt-speedlist, .xt_video_player_common_list_wrap');
  var value = document.querySelector('xt-speedvalue');
  var ul = list ? list.querySelector('ul') : null;
  var opts = list ? [].slice.call(list.querySelectorAll('li, xt-button')) : [];
  return JSON.stringify({
    speedValue: info(value, 'xt-speedvalue'),
    speedButton: info(btn, 'xt-speedbutton'),
    speedList: info(list, 'xt-speedlist'),
    ul: info(ul, 'ul'),
    options: opts.map(function (o, i) { return info(o, 'option[' + i + '] ' + (o.getAttribute('data-speed') || '')); }),
    // 菜单容器的完整 class 链，便于写对选择器
    btnClassChain: btn ? (function () { var a = [], e = btn; while (e && a.length < 6) { a.push(e.tagName.toLowerCase() + (e.className ? '.' + String(e.className).trim().split(/\\s+/).join('.') : '')); e = e.parentElement; } return a; })() : null,
    // 有没有别的「倍速」相关元素（例如 hover 才出现的浮层）
    allSpeedish: [].slice.call(document.querySelectorAll('[class*=speed], xt-speedlist, xt-speedvalue')).map(function (el) {
      var r = el.getBoundingClientRect();
      return { tag: el.tagName.toLowerCase(), cls: (typeof el.className === 'string' ? el.className : '') || null, w: Math.round(r.width), h: Math.round(r.height), text: (el.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 40) };
    }),
    currentRate: (function(){ var v=document.querySelector('video'); return v?v.playbackRate:null })(),
  }, null, 2);
})()`;

(async () => {
  const pages = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).filter((t) => t.type === 'page');
  const target = pages.find((p) => /yuketang/i.test(p.url)) || pages[0];
  if (!target) { console.error('没有可用标签页'); process.exit(1); }
  const s = await Session.connect(target.webSocketDebuggerUrl);
  await s.send('Runtime.enable');
  console.log('目标页:', target.url.slice(0, 110), '\n');

  const r = await s.eval(PROBE);
  console.log(r.error ? ('失败: ' + r.error) : r.value);

  console.log('\n=== 脚本日志（倍速相关） ===');
  const logs = await s.eval(`JSON.stringify((window.__yktTool ? [] : []))`);
  const st = await s.eval(`JSON.stringify(window.__yktTool ? {
    rate: window.__yktTool.state.rate,
    rateStats: window.__yktTool.state.rateStats,
    speedUiMatches: null,
  } : null)`);
  console.log(st.value);

  s.ws.close();
  process.exit(0);
})().catch((e) => { console.error('异常:', e && e.stack || e); process.exit(1); });

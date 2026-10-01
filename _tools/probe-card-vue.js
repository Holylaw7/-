#!/usr/bin/env node
/**
 * 挖掘雨课堂课程卡片的 Vue 实例：找出真正的点击处理方法并调用。
 * 依据：油猴中文网建议「优先拿 vue 实例直接触发」。
 *
 *   node _tools/probe-card-vue.js "示例小节A"
 */
const CONFIG = require('./config');
const PORT = Number(process.env.CDP_PORT || 9222);
const CLASSROOM = CONFIG.classroom;
const KEYWORD = process.argv[2] || '示例小节';
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
    try {
      const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: aw, userGesture: true });
      if (r.exceptionDetails) return { error: r.exceptionDetails.exception?.description || 'err' };
      return { value: r.result.value };
    } catch (e) { return { error: e.message }; }
  }
}

const DIG = `(function () {
  var kw = ${JSON.stringify(KEYWORD)};
  var out = { steps: [] };

  // 1) 找目标卡片
  var card = null;
  var nodes = document.querySelectorAll('section.studentCard, div.activity-box, div.content-box, section.activity__wrap');
  for (var i = 0; i < nodes.length; i++) {
    var t = (nodes[i].innerText || '').replace(/\\s+/g, ' ').trim();
    if (t.indexOf(kw) >= 0) { card = nodes[i]; out.cardCls = nodes[i].className; break; }
  }
  if (!card) { out.err = 'no card'; return JSON.stringify(out); }

  // 2) 从卡片向上/向下找带 __vue__ 的元素
  var chain = [];
  var el = card;
  for (var d = 0; d < 8 && el; d++) {
    var hasVue = !!el.__vue__;
    var r = el.getBoundingClientRect();
    chain.push({ tag: el.tagName, cls: String(el.className || '').slice(0, 50), hasVue: hasVue,
                 w: Math.round(r.width), h: Math.round(r.height) });
    if (hasVue) {
      var vm = el.__vue__;
      out.vmFound = { tag: el.tagName, cls: String(el.className || '').slice(0, 50) };
      try { out.dataKeys = vm.$data ? Object.keys(vm.$data) : null; } catch (e) { }
      try {
        var m = vm.$options && vm.$options.methods ? Object.keys(vm.$options.methods) : [];
        out.methods = m.slice(0, 40);
        out.clickMethods = m.filter(function (k) { return /click|detail|go|jump|open|enter|handle|select/i.test(k); });
      } catch (e) { out.methodsErr = String(e); }
      break;
    }
    el = el.parentElement;
  }
  out.ancestorChain = chain;

  // 3) 也在卡片内部找（有些把实例挂在子元素上）
  if (!out.vmFound) {
    var inner = card.querySelectorAll('*');
    for (var j = 0; j < inner.length && j < 60; j++) {
      if (inner[j].__vue__) {
        out.vmFoundInner = { tag: inner[j].tagName, cls: String(inner[j].className || '').slice(0, 50) };
        var vm2 = inner[j].__vue__;
        try { out.methods = vm2.$options && vm2.$options.methods ? Object.keys(vm2.$options.methods).slice(0, 40) : null; } catch (e) { }
        break;
      }
    }
  }

  // 4) 记录卡片的直接子元素，便于定位真正的点击目标
  out.cardChildren = [].slice.call(card.children).slice(0, 10).map(function (c) {
    var r = c.getBoundingClientRect();
    return { tag: c.tagName, cls: String(c.className || '').slice(0, 50), text: (c.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 30),
             w: Math.round(r.width), h: Math.round(r.height), hasVue: !!c.__vue__ };
  });

  return JSON.stringify(out, null, 2);
})()`;

(async () => {
  const pages = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).filter((t) => t.type === 'page');
  let target = pages.find((p) => /yuketang/i.test(p.url));
  if (!target) target = pages.find((p) => p.url === 'about:blank') || pages[0];
  const s = await Session.connect(target.webSocketDebuggerUrl);
  await s.send('Page.enable'); await s.send('Runtime.enable');
  try { await s.send('Page.bringToFront'); } catch (e) { }

  if (!/studentLog/.test(target.url)) {
    await s.send('Page.navigate', { url: `${CONFIG.origin}/v2/web/studentLog/${CLASSROOM}` });
    await sleep(12000);
  }
  const r = await s.eval(DIG);
  console.log(r.error ? ('失败: ' + r.error) : r.value);
  s.ws.close();
  process.exit(0);
})().catch((e) => { console.error('异常:', e && e.stack || e); process.exit(1); });

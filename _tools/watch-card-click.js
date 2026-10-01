#!/usr/bin/env node
/**
 * 验证「点击课程卡片」到底发生了什么：
 *   · 是外层 document 跳转？（CDP 的 Page.frameNavigated）
 *   · 还是 iframe 内部换页？
 *   · 还是只是展开/弹出面板？
 *
 *   node _tools/watch-card-click.js "示例小节A"
 */
const CONFIG = require('./config');
const PORT = Number(process.env.CDP_PORT || 9222);
const CLASSROOM = CONFIG.classroom;
const KEYWORD = process.argv[2] || '示例小节';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Session {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.events = []; }
  static async connect(u) {
    const ws = new WebSocket(u);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws fail')); });
    const s = new Session(ws);
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && s.pending.has(m.id)) {
        const { res, rej } = s.pending.get(m.id); s.pending.delete(m.id);
        m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
      } else if (m.method) {
        s.events.push(m);
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

(async () => {
  const pages = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).filter((t) => t.type === 'page');
  let target = pages.find((p) => /yuketang/i.test(p.url));
  if (!target) target = pages.find((p) => p.url === 'about:blank') || pages[0];
  const s = await Session.connect(target.webSocketDebuggerUrl);
  await s.send('Page.enable'); await s.send('Runtime.enable'); await s.send('Network.enable');
  try { await s.send('Page.bringToFront'); } catch (e) { }

  if (!/studentLog/.test(target.url)) {
    await s.send('Page.navigate', { url: `${CONFIG.origin}/v2/web/studentLog/${CLASSROOM}` });
    await sleep(13000);
  }

  console.log('=== 点击前的页面快照 ===');
  const before = JSON.parse((await s.eval(`JSON.stringify({
    topUrl: location.href,
    iframeCount: window.frames.length,
    iframes: [].slice.call(document.querySelectorAll('iframe')).map(function(f){
      var r = f.getBoundingClientRect();
      return { src: (f.src||'').slice(0,110), w: Math.round(r.width), h: Math.round(r.height) };
    }),
    cards: document.querySelectorAll('section.studentCard').length,
  })`)).value);
  console.log(JSON.stringify(before, null, 2));

  s.events.length = 0;

  console.log(`\n=== 给卡片补上 hasMouse 并点击「${KEYWORD}」===`);
  const clicked = await s.eval(`(function(){
    var kw = ${JSON.stringify(KEYWORD)};
    var cards = document.querySelectorAll('section.studentCard');
    var card = null;
    for (var i = 0; i < cards.length; i++) {
      if ((cards[i].innerText||'').indexOf(kw) >= 0) { card = cards[i]; break; }
    }
    if (!card) return 'no card';
    var r = card.getBoundingClientRect();
    var x = Math.round(r.left + r.width/2), y = Math.round(r.top + r.height/2);

    function fire(el, type, cx, cy) {
      var ev = new MouseEvent(type, { bubbles: true, cancelable: true, view: window, button: 0, buttons: type==='mousedown'?1:0 });
      try { Object.defineProperty(ev, 'clientX', { value: cx, configurable: true }); } catch(e){}
      try { Object.defineProperty(ev, 'clientY', { value: cy, configurable: true }); } catch(e){}
      el.dispatchEvent(ev);
    }
    // 在卡片及其中间层都补 mousemove，确保 hasMouse/mouseTarget 被设置
    fire(card, 'mousemove', 9999, 9999);
    fire(card, 'mouseover', 9999, 9999);
    fire(card, 'mousemove', x, y);
    var inner = card.querySelector('.activity-box') || card;
    fire(inner, 'mousemove', 9999, 9999);
    fire(inner, 'mousemove', x, y);
    // 点击
    [card, inner].forEach(function(el){
      fire(el, 'mousedown', x, y); fire(el, 'mouseup', x, y); fire(el, 'click', x, y);
    });
    return JSON.stringify({ cardCls: card.className, x: x, y: y, innerCls: inner.className });
  })()`);
  console.log('  ', clicked.value);
  await sleep(8000);

  console.log('\n=== 点击后的页面快照 ===');
  const after = JSON.parse((await s.eval(`JSON.stringify({
    topUrl: location.href,
    iframeCount: window.frames.length,
    iframes: [].slice.call(document.querySelectorAll('iframe')).map(function(f){
      var r = f.getBoundingClientRect();
      return { src: (f.src||'').slice(0,110), w: Math.round(r.width), h: Math.round(r.height) };
    }),
    dialogsVisible: [].slice.call(document.querySelectorAll('.el-dialog__wrapper, [class*=drawer], [class*=popup]'))
      .filter(function(d){ var r=d.getBoundingClientRect(); return r.width>50 && r.height>50; }).length,
    bodyTextSample: (document.body.innerText||'').replace(/\\s+/g,' ').slice(0, 220),
  })`)).value);
  console.log(JSON.stringify(after, null, 2));

  // 是否发生了框架导航 / 请求
  const navs = s.events.filter((e) => e.method === 'Page.frameNavigated').map((e) => e.params.frame.url);
  const reqs = s.events.filter((e) => e.method === 'Network.requestWillBeSent')
    .map((e) => e.params.request.url).filter((u) => /lms-graph|studycontent|pro\/lms|lesson|leaf/i.test(u));
  console.log('\n点击期间发生的框架导航:', navs.length ? navs : '（无）');
  console.log('相关的网络请求:', reqs.length ? reqs.slice(0, 8) : '（无）');

  console.log('\n结论:', after.topUrl !== before.topUrl ? '外层文档发生了导航'
    : (reqs.length ? '有相关请求但未导航（可能是 iframe/内部路由）' : '点击没有产生任何导航或请求 → 事件仍未通过校验'));

  s.ws.close();
  process.exit(0);
})().catch((e) => { console.error('异常:', e && e.stack || e); process.exit(1); });

#!/usr/bin/env node
/**
 * 探测仿真站点倍速按钮的点击/展开行为，定位桥为什么打不开菜单。
 *   node _tools/probe-menu.js
 */
const CONFIG = require('./config');
const PORT = Number(process.env.CDP_PORT || 9222);
const APP = CONFIG.mock.origin();
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
  async click(x, y) {
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons: 0 });
    await sleep(120);
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
    await sleep(80);
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
  }
}

const PROBE = `JSON.stringify((function(){
const LEAF = CONFIG.leaf || process.argv[2] || String(CONFIG.mock.leafBase);
  function box(sel){ var el=document.querySelector(sel); if(!el) return null; var r=el.getBoundingClientRect();
    return { sel: sel, x: Math.round(r.left+r.width/2), y: Math.round(r.top+r.height/2), w: Math.round(r.width), h: Math.round(r.height),
             display: getComputedStyle(el).display, cls: el.className }; }
  var list = document.querySelector('xt-speedlist');
  var btn = document.querySelector('xt-speedbutton');
  return {
    btn: box('xt-speedbutton'),
    list: box('xt-speedlist'),
    listParent: list ? { tag: list.parentElement.tagName, cls: list.parentElement.className } : null,
    btnParentOpen: btn ? btn.classList.contains('open') : null,
    optionCount: document.querySelectorAll('xt-speedlist xt-button[data-speed]').length,
    optionBoxes: [].slice.call(document.querySelectorAll('xt-speedlist xt-button[data-speed]')).map(function(b){
      var r=b.getBoundingClientRect();
      return { speed: b.getAttribute('data-speed'), text:(b.innerText||'').trim(), w:Math.round(r.width), h:Math.round(r.height), display:getComputedStyle(b).display };
    }),
    // 检查是否有元素遮挡按钮
    topAtBtn: (function(){
      if(!btn) return null; var r=btn.getBoundingClientRect();
      var el = document.elementFromPoint(r.left+r.width/2, r.top+r.height/2);
      return el ? (el.tagName + '.' + (el.className||'')) : null;
    })(),
  };
})())`;

(async () => {
  const pages = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).filter((t) => t.type === 'page');
  const target = pages.find((p) => p.url === 'about:blank') || pages[0];
  const s = await Session.connect(target.webSocketDebuggerUrl);
  await s.send('Page.enable'); await s.send('Runtime.enable');
  await s.send('Page.navigate', { url: `${APP}/web` });
  await sleep(1200);
  await s.eval(`document.getElementById('btn-login') && document.getElementById('btn-login').click(), true`);
  await sleep(2000);
  await s.send('Page.navigate', { url: `${APP}/ai-workspace/lms-graph/${CONFIG.mock.classroom}/video/${LEAF}?is_chapter=1` });
  await sleep(4000);
  try { await s.send('Page.bringToFront'); } catch (e) { }
  await sleep(500);

  console.log('=== 初始状态 ===');
  let st = JSON.parse((await s.eval(PROBE)).value);
  console.log(JSON.stringify(st, null, 2));

  console.log('\n=== 用 CDP 真实点击按钮 ===');
  await s.click(st.btn.x, st.btn.y);
  await sleep(900);
  st = JSON.parse((await s.eval(PROBE)).value);
  console.log('按钮 open 类:', st.btnParentOpen);
  console.log('菜单 display:', st.list.display, '宽:', st.list.w);
  console.log('按钮位置命中元素:', st.topAtBtn);

  console.log('\n=== 若仍未展开，用 JS 直接 click() 按钮 ===');
  if (st.list.display === 'none') {
    await s.eval(`document.querySelector('xt-speedbutton').click(); true`);
    await sleep(700);
    st = JSON.parse((await s.eval(PROBE)).value);
    console.log('按钮 open 类:', st.btnParentOpen, ' 菜单 display:', st.list.display, '宽:', st.list.w);
  }

  console.log('\n=== 选项坐标 ===');
  console.log(JSON.stringify(st.optionBoxes, null, 2));

  s.ws.close();
  process.exit(0);
})().catch((e) => { console.error('异常:', e && e.stack || e); process.exit(1); });

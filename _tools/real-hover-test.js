#!/usr/bin/env node
/**
 * 用 CDP 派发「真实鼠标输入」测试倍速菜单能否被展开并点击。
 *   node _tools/real-hover-test.js
 *
 * 背景：合成 MouseEvent 不会触发 CSS :hover，而雨课堂的倍速菜单正是靠 hover 展开的。
 *      这里用 Input.dispatchMouseEvent 从浏览器输入层发真实事件，验证是否可行。
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

const SPEED_INFO = `JSON.stringify((function(){
  var btn = document.querySelector('.xt_video_player_speed, xt-speedbutton');
  var val = document.querySelector('.xt_video_player_common_value, xt-speedvalue');
  var list = btn ? btn.querySelector('.xt_video_player_common_list_wrap, xt-speedlist') : null;
  function box(el){ if(!el) return null; var r=el.getBoundingClientRect(); var cs=getComputedStyle(el);
    return { x:Math.round(r.left), y:Math.round(r.top), w:Math.round(r.width), h:Math.round(r.height),
             display:cs.display, opacity:cs.opacity, hovered: el.matches(':hover') }; }
  var opts = list ? [].slice.call(list.querySelectorAll('li, xt-button, [data-speed]')).map(function(o){
    var r = o.getBoundingClientRect();
    return { text:(o.innerText||'').trim(), speed:o.getAttribute('data-speed'),
             x:Math.round(r.left+r.width/2), y:Math.round(r.top+r.height/2), w:Math.round(r.width), h:Math.round(r.height) };
  }) : [];
  return {
    btnText: val ? (val.innerText||'').trim() : null,
    btnBox: box(btn),
    listBox: box(list),
    listHtmlLen: list ? (list.innerHTML||'').length : null,
    listHtml: list ? (list.innerHTML||'').replace(/\\s+/g,' ').slice(0,300) : null,
    options: opts,
    videoRate: (function(){var v=document.querySelector('video');return v?v.playbackRate:null})(),
  };
})())`;

(async () => {
  const pages = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).filter((t) => t.type === 'page');
  const target = pages.find((p) => /yuketang/i.test(p.url)) || pages[0];
  if (!target) { console.error('没有可用标签页'); process.exit(1); }
  const s = await Session.connect(target.webSocketDebuggerUrl);
  await s.send('Runtime.enable');
  await s.send('Page.enable');
  console.log('目标页:', target.url.slice(0, 110), '\n');

  const before = JSON.parse((await s.eval(SPEED_INFO)).value);
  console.log('=== 操作前 ===');
  console.log('按钮文字:', before.btnText, ' 按钮框:', JSON.stringify(before.btnBox));
  console.log('菜单框  :', JSON.stringify(before.listBox));
  console.log('菜单内 HTML 长度:', before.listHtmlLen);
  console.log('菜单 HTML:', before.listHtml);
  console.log('选项数:', before.options.length);
  console.log('video.playbackRate:', before.videoRate);

  if (!before.btnBox) { console.error('找不到倍速按钮'); process.exit(1); }

  const cx = before.btnBox.x + before.btnBox.w / 2;
  const cy = before.btnBox.y + before.btnBox.h / 2;

  console.log('\n=== 先把标签页调到前台（否则鼠标输入到不了页面） ===');
  try { await s.send('Page.bringToFront'); } catch (e) { console.log('  bringToFront 失败:', e.message); }
  await sleep(600);
  // 先把鼠标移开再移入，制造真正的 mouseover 过渡
  await s.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 10, y: 10, buttons: 0 });
  await sleep(200);

  console.log(`=== 用 CDP 派发真实鼠标移动到 (${cx}, ${cy}) ===`);
  await s.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: cx - 12, y: cy, buttons: 0 });
  await sleep(150);
  await s.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: cx, y: cy, buttons: 0 });
  await sleep(800);

  const hovered = JSON.parse((await s.eval(SPEED_INFO)).value);
  console.log('hover 后按钮 :hover =', hovered.btnBox && hovered.btnBox.hovered);
  console.log('hover 后菜单框:', JSON.stringify(hovered.listBox));
  console.log('hover 后选项数:', hovered.options.length);
  console.log('选项明细:', JSON.stringify(hovered.options, null, 2));

  // 找 2.00X 选项
  const opt = hovered.options.find((o) => o.speed === '2' || /^2(\.0+)?X$/i.test(o.text));
  if (!opt) {
    console.log('\n✗ hover 后仍找不到 2.00X 选项 → 菜单不是纯 hover 展开，或结构不同');
  } else {
    console.log(`\n=== 点击 2.00X 选项 (${opt.x}, ${opt.y}) ===`);
    await s.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: opt.x, y: opt.y, buttons: 0 });
    await sleep(150);
    await s.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: opt.x, y: opt.y, button: 'left', buttons: 1, clickCount: 1 });
    await sleep(60);
    await s.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: opt.x, y: opt.y, button: 'left', buttons: 0, clickCount: 1 });
    await sleep(1500);

    const after = JSON.parse((await s.eval(SPEED_INFO)).value);
    console.log('\n=== 点击后 ===');
    console.log('按钮文字:', after.btnText, '（目标 2.00X）');
    console.log('video.playbackRate:', after.videoRate);
    console.log(after.btnText && /2(\.0+)?X/i.test(after.btnText)
      ? '✓ 播放器倍速界面已同步为 2x —— CDP 真实鼠标输入可行！'
      : '✗ 界面仍未同步');
  }

  s.ws.close();
  process.exit(0);
})().catch((e) => { console.error('异常:', e && e.stack || e); process.exit(1); });

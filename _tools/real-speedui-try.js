#!/usr/bin/env node
/**
 * 在真实视频页上，尝试让播放器倍速界面同步到 2x。
 *   node _tools/real-speedui-try.js [课程视频URL]
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

const READ = `JSON.stringify({
const LEAF = CONFIG.leaf || process.argv[2] || CONFIG.PLACEHOLDER;
  url: location.pathname,
  uiText: (function(){ var v=document.querySelector('.xt_video_player_common_value, xt-speedvalue'); return v?(v.innerText||'').trim():null })(),
  videoRate: (function(){ var v=document.querySelector('video'); return v?v.playbackRate:null })(),
  activeItem: (function(){ var a=document.querySelector('.xt_video_player_common_list .xt_video_player_common_active'); return a?a.getAttribute('data-speed'):null })(),
  listDisplay: (function(){ var l=document.querySelector('.xt_video_player_common_list_wrap, xt-speedlist'); return l?getComputedStyle(l).display:null })(),
  focus: document.hasFocus(),
  hasTool: !!window.__yktTool,
})`;

(async () => {
  const pages = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).filter((t) => t.type === 'page');
  const target = pages.find((p) => /yuketang/i.test(p.url)) || pages[0];
  const s = await Session.connect(target.webSocketDebuggerUrl);
  await s.send('Runtime.enable');
  await s.send('Page.enable');
  try { await s.send('Page.bringToFront'); } catch (e) { }

  console.log('导航到视频页:', URL_ARG.slice(0, 100));
  await s.send('Page.navigate', { url: URL_ARG });
  await sleep(11000);
  try { await s.send('Page.bringToFront'); } catch (e) { }

  const show = async (label) => {
    const d = JSON.parse((await s.eval(READ)).value);
    console.log(`  [${label}] 界面=${d.uiText}  video.rate=${d.videoRate}  菜单active=${d.activeItem}  菜单display=${d.listDisplay}  focus=${d.focus}  脚本=${d.hasTool}`);
    return d;
  };
  console.log('\n初始:');
  const init = await show('初始');
  if (init.videoRate === null) { console.log('没有视频，退出'); s.ws.close(); process.exit(1); }

  // ---- 方案 A：合成 click 到 li ----
  console.log('\n=== A: 合成 click 到 li[data-speed=2] ===');
  await s.eval(`(function(){
    var li = document.querySelector('.xt_video_player_common_list li[data-speed="2"]');
    if (!li) return 'no';
    ['mouseover','mousedown','mouseup','click'].forEach(function(t){
      li.dispatchEvent(new MouseEvent(t, {bubbles:true, cancelable:true, view:window}));
    });
    return 'ok';
  })()`);
  await sleep(1200);
  await show('A后');

  // ---- 方案 B：临时显示菜单 + 元素级 click() ----
  console.log('\n=== B: 临时显示菜单后 li.click() ===');
  await s.eval(`(function(){
    var list = document.querySelector('.xt_video_player_common_list_wrap, xt-speedlist');
    if (list) { list.style.setProperty('display','block','important'); list.style.setProperty('opacity','1','important'); }
    var li = document.querySelector('.xt_video_player_common_list li[data-speed="2"]');
    if (li) { li.style.display='block'; li.click(); }
    return true;
  })()`);
  await sleep(1500);
  await show('B后');

  // ---- 方案 C：CDP 真实鼠标 hover 到按钮（页面已在前台） ----
  console.log('\n=== C: CDP 真实鼠标移入倍速按钮 ===');
  const box = JSON.parse((await s.eval(`JSON.stringify((function(){
    var b=document.querySelector('.xt_video_player_speed, xt-speedbutton');
    if(!b) return null; var r=b.getBoundingClientRect();
    return {x:Math.round(r.left+r.width/2), y:Math.round(r.top+r.height/2)};
  })())`)).value);
  if (box) {
    await s.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 5, buttons: 0 });
    await sleep(150);
    await s.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y, buttons: 0 });
    await sleep(900);
    const st = JSON.parse((await s.eval(`JSON.stringify((function(){
      var b=document.querySelector('.xt_video_player_speed');
      var l=document.querySelector('.xt_video_player_common_list_wrap, xt-speedlist');
      var r=l?l.getBoundingClientRect():null;
      return { btnHovered: b?b.matches(':hover'):null, listDisplay:l?getComputedStyle(l).display:null, listW:r?Math.round(r.width):null };
    })())`)).value);
    console.log('  hover 结果:', JSON.stringify(st));
    // 若菜单展开，则真实点击 2.00X
    if (st.listW > 0) {
      const optBox = JSON.parse((await s.eval(`JSON.stringify((function(){
        var li=document.querySelector('.xt_video_player_common_list li[data-speed="2"]');
        if(!li) return null; var r=li.getBoundingClientRect();
        return {x:Math.round(r.left+r.width/2), y:Math.round(r.top+r.height/2)};
      })())`)).value);
      if (optBox) {
        console.log('  真实点击 2.00X @', JSON.stringify(optBox));
        await s.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: optBox.x, y: optBox.y, buttons: 0 });
        await sleep(150);
        await s.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: optBox.x, y: optBox.y, button: 'left', buttons: 1, clickCount: 1 });
        await sleep(60);
        await s.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: optBox.x, y: optBox.y, button: 'left', buttons: 0, clickCount: 1 });
        await sleep(1200);
      }
    }
  }
  const fin = await show('C后');

  console.log('\n=== 结论 ===');
  console.log(fin.uiText && /2(\.0+)?X/i.test(fin.uiText)
    ? '✓ 播放器倍速界面成功同步为 2x'
    : `✗ 界面仍为 ${fin.uiText}；但 video.playbackRate=${fin.videoRate}（实际播放倍速以此为准）`);

  s.ws.close();
  process.exit(0);
})().catch((e) => { console.error('异常:', e && e.stack || e); process.exit(1); });

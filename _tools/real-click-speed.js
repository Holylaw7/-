#!/usr/bin/env node
/**
 * 实验：完全用「真实鼠标输入」点开播放器倍速菜单并选 2.00X，
 *      验证能否让站点自己的逻辑把倍速（内部变量 + UI + playbackRate）一次性设对。
 *
 *   node _tools/real-click-speed.js [视频URL]
 */
const CONFIG = require('./config');
const PORT = Number(process.env.CDP_PORT || 9222);
const URL_ARG = process.argv.find((a) => /^https?:\/\//.test(a))
  || CONFIG.origin + `/ai-workspace/lms-graph/${CONFIG.classroom}/video/${LEAF}?is_chapter=1`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LEAF = CONFIG.leaf || process.argv[2] || CONFIG.PLACEHOLDER;

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
  async move(x, y, steps = 1) {
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons: 0 });
    if (steps > 1) await sleep(60);
  }
  async click(x, y) {
    await this.move(x, y);
    await sleep(120);
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
    await sleep(80);
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
  }
}

const STATE = `JSON.stringify({
  uiText: (function(){ var v=document.querySelector('.xt_video_player_common_value, xt-speedvalue'); return v?(v.innerText||'').trim():null })(),
  videoRate: (function(){ var v=document.querySelector('video'); return v?v.playbackRate:null })(),
  optValue: (function(){ var r=document.querySelector('.xt_video_player_container, .xtplayer, .video-box'); var p=r&&r.__vue__&&r.__vue__.$data.player; return (p&&p.options&&p.options.speed)?p.options.speed.value:null })(),
  active: (function(){ var a=document.querySelector('.xt_video_player_common_list .xt_video_player_common_active'); return a?a.getAttribute('data-speed'):null })(),
  listW: (function(){ var l=document.querySelector('.xt_video_player_common_list_wrap, xt-speedlist'); return l?Math.round(l.getBoundingClientRect().width):null })(),
  btnHover: (function(){ var b=document.querySelector('.xt_video_player_speed, xt-speedbutton'); return b?b.matches(':hover'):null })(),
  tool: !!window.__yktTool,
})`;

(async () => {
  const pages = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).filter((t) => t.type === 'page');
  const target = pages.find((p) => /yuketang/i.test(p.url)) || pages[0];
  const s = await Session.connect(target.webSocketDebuggerUrl);
  await s.send('Runtime.enable');
  await s.send('Page.enable');
  try { await s.send('Page.bringToFront'); } catch (e) { }

  if (!/lms-graph/.test(target.url)) {
    console.log('导航到视频页…');
    await s.send('Page.navigate', { url: URL_ARG });
    await sleep(11000);
  }
  try { await s.send('Page.bringToFront'); } catch (e) { }
  await sleep(1200);

  const show = async (l) => {
    const d = JSON.parse((await s.eval(STATE)).value);
    console.log(`  [${l}] UI=${d.uiText} video.rate=${d.videoRate} 内部值=${d.optValue} 菜单active=${d.active} 菜单宽=${d.listW} 按钮hover=${d.btnHover}`);
    return d;
  };

  console.log('=== 基线 ===');
  const base = await show('基线');
  if (base.videoRate === null) { console.log('页面没有视频，退出'); s.ws.close(); process.exit(1); }

  const box = JSON.parse((await s.eval(`JSON.stringify((function(){
    var b=document.querySelector('.xt_video_player_speed, xt-speedbutton');
    if(!b) return null; var r=b.getBoundingClientRect();
    return { x:Math.round(r.left+r.width/2), y:Math.round(r.top+r.height/2), w:Math.round(r.width), h:Math.round(r.height) };
  })())`)).value);
  console.log('\n倍速按钮:', JSON.stringify(box));
  if (!box) { s.ws.close(); process.exit(1); }

  console.log('\n=== 步骤1：真实鼠标移入倍速按钮（渐进移动，模拟真人）===');
  await s.move(10, 10);
  await sleep(300);
  for (let i = 1; i <= 8; i++) {
    const x = Math.round(10 + (box.x - 10) * i / 8);
    const y = Math.round(10 + (box.y - 10) * i / 8);
    await s.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons: 0 });
    await sleep(70);
  }
  await sleep(900);
  const hov = await show('hover后');

  let menuW = hov.listW || 0;
  if (menuW <= 0) {
    console.log('\n  hover 未展开菜单 → 补一次真实点击按钮（真人也会这么做）');
    await s.click(box.x, box.y);
    await sleep(1000);
    const after = await show('点击按钮后');
    menuW = after.listW || 0;
  }

  if (menuW <= 0) {
    console.log('\n✗ 菜单仍未展开，此路不通');
    s.ws.close();
    process.exit(1);
  }

  console.log('\n=== 步骤2：真实鼠标点击 2.00X ===');
  const opt = JSON.parse((await s.eval(`JSON.stringify((function(){
    var li=document.querySelector('.xt_video_player_common_list li[data-speed="2"]');
    if(!li) return null; var r=li.getBoundingClientRect();
    return { x:Math.round(r.left+r.width/2), y:Math.round(r.top+r.height/2), w:Math.round(r.width), h:Math.round(r.height) };
  })())`)).value);
  console.log('  2.00X 选项:', JSON.stringify(opt));
  await s.click(opt.x, opt.y);
  await sleep(1800);
  const fin = await show('点击后');

  console.log('\n=== 结论 ===');
  const uiOk = fin.uiText && /2(\.0+)?X/i.test(fin.uiText);
  const rateOk = Number(fin.videoRate) >= 1.9;
  const internalOk = Number(fin.optValue) === 2;
  console.log(uiOk ? `✓ 播放器 UI 显示 ${fin.uiText}` : `✗ UI 仍为 ${fin.uiText}`);
  console.log(rateOk ? `✓ video.playbackRate = ${fin.videoRate}` : `✗ playbackRate = ${fin.videoRate}`);
  console.log(internalOk ? `✓ 站点内部值 = ${fin.optValue}（走的是它自己的逻辑）` : `✗ 内部值 = ${fin.optValue}`);

  console.log('\n再等 8 秒，看站点会不会把它改回 1x（判断是否被"劫持/回滚"）…');
  await sleep(8000);
  const stable = await show('8秒后');
  console.log(stable.uiText && /2(\.0+)?X/i.test(stable.uiText) && Number(stable.videoRate) >= 1.9
    ? '✓ 稳定保持 2x —— 走站点自身逻辑没有被回滚'
    : '✗ 被改回去了');

  s.ws.close();
  process.exit(0);
})().catch((e) => { console.error('异常:', e && e.stack || e); process.exit(1); });

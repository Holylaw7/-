#!/usr/bin/env node
/**
 * 决定性测试：强制菜单可见 + CDP 真实鼠标按下/抬起，能否触发播放器的倍速切换。
 *   node _tools/real-menu-realclick.js [视频URL]
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
  async realClick(x, y) {
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons: 0 });
    await sleep(150);
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
    await sleep(90);
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
  }
}

const READ = `JSON.stringify({
const LEAF = CONFIG.leaf || process.argv[2] || CONFIG.PLACEHOLDER;
  uiText: (function(){var e=document.querySelector('.xt_video_player_common_value, xt-speedvalue');return e?(e.innerText||'').trim():null})(),
  videoRate: (function(){var v=document.querySelector('video');return v?v.playbackRate:null})(),
  optValue: (function(){var r=document.querySelector('.xt_video_player_container, .xtplayer, .video-box');var p=r&&r.__vue__&&r.__vue__.$data.player;return (p&&p.options&&p.options.speed)?p.options.speed.value:null})(),
  active: (function(){var a=document.querySelector('.xt_video_player_common_list .xt_video_player_common_active');return a?a.getAttribute('data-speed'):null})(),
})`;

(async () => {
  const pages = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).filter((t) => t.type === 'page');
  const target = pages.find((p) => /yuketang/i.test(p.url)) || pages[0];
  const s = await Session.connect(target.webSocketDebuggerUrl);
  await s.send('Runtime.enable');
  await s.send('Page.enable');
  try { await s.send('Page.bringToFront'); } catch (e) { }

  if (!/lms-graph/.test(target.url)) {
    await s.send('Page.navigate', { url: URL_ARG });
    await sleep(11000);
  }
  await sleep(800);
  try { await s.send('Page.bringToFront'); } catch (e) { }
  await sleep(400);

  const show = async (l) => {
    const d = JSON.parse((await s.eval(READ)).value);
    console.log(`  [${l}] 界面=${d.uiText} video.rate=${d.videoRate} options.speed.value=${d.optValue} active=${d.active}`);
    return d;
  };

  console.log('=== 基线 ===');
  const base = await show('基线');
  if (base.videoRate === null) { console.log('无视频'); s.ws.close(); process.exit(1); }

  // 恢复菜单原本的内联样式，确保不是我用 style 强改导致的异常
  await s.eval(`(function(){
    var l=document.querySelector('.xt_video_player_common_list_wrap, xt-speedlist');
    if(l){ l.style.removeProperty('display'); l.style.removeProperty('opacity'); }
    var p=document.querySelector('.xt_video_player_container, .xtplayer, .video-box');
    var pl=p&&p.__vue__&&p.__vue__.$data.player;
    if(pl&&pl.options&&pl.options.speed){ pl.options.speed.value = 1; }
    return true;
  })()`);
  await sleep(600);
  await show('复位后');

  console.log('\n=== 用真实鼠标 hover 到倍速按钮（触发它自己的展开逻辑）===');
  const btn = JSON.parse((await s.eval(`JSON.stringify((function(){
    var b=document.querySelector('.xt_video_player_speed, xt-speedbutton');
    if(!b) return null; var r=b.getBoundingClientRect();
    return { x:Math.round(r.left+r.width/2), y:Math.round(r.top+r.height/2) };
  })())`)).value);
  await s.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 3, y: 3, buttons: 0 });
  await sleep(250);
  // 渐进移动，更接近真实鼠标轨迹
  for (let i = 1; i <= 5; i++) {
    await s.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: Math.round(3 + (btn.x - 3) * i / 5),
      y: Math.round(3 + (btn.y - 3) * i / 5),
      buttons: 0,
    });
    await sleep(80);
  }
  await sleep(900);
  const hov = await show('hover 后');

  let menuW = (await s.eval(`(function(){
    var l=document.querySelector('.xt_video_player_common_list_wrap, xt-speedlist');
    return l?Math.round(l.getBoundingClientRect().width):0;
  })()`)).value;
  console.log(`  鼠标 hover 后菜单宽度 = ${menuW}`);

  // hover 不奏效时，试「真实点击按钮」——这是普通用户的实际操作
  if (menuW <= 0) {
    console.log('\n  hover 没能展开菜单 → 改用真实点击倍速按钮');
    await s.realClick(btn.x, btn.y);
    await sleep(1200);
    await show('点击按钮后');
    menuW = (await s.eval(`(function(){
      var l=document.querySelector('.xt_video_player_common_list_wrap, xt-speedlist');
      return l?Math.round(l.getBoundingClientRect().width):0;
    })()`)).value;
    console.log(`  点击按钮后菜单宽度 = ${menuW}`);
    const hovState = await s.eval(`JSON.stringify({
      btnHovered: (function(){var b=document.querySelector('.xt_video_player_speed, xt-speedbutton');return b?b.matches(':hover'):null})(),
      btnClasses: (function(){var b=document.querySelector('.xt_video_player_speed, xt-speedbutton');return b?b.className:null})(),
      listClasses: (function(){var l=document.querySelector('.xt_video_player_common_list_wrap, xt-speedlist');return l?l.className:null})(),
      listDisplay: (function(){var l=document.querySelector('.xt_video_player_common_list_wrap, xt-speedlist');return l?getComputedStyle(l).display:null})(),
    })`);
    console.log('  状态:', hovState.value);
  }

  if (menuW > 0) {
    console.log('\n=== 菜单已展开 → 真实鼠标点击 2.00X ===');
    const li = JSON.parse((await s.eval(`JSON.stringify((function(){
      var x=document.querySelector('.xt_video_player_common_list li[data-speed="2"]');
      if(!x) return null; var r=x.getBoundingClientRect();
      return { x:Math.round(r.left+r.width/2), y:Math.round(r.top+r.height/2) };
    })())`)).value);
    console.log('  2.00X 坐标:', JSON.stringify(li));
    await s.realClick(li.x, li.y);
    await sleep(1600);
    const after = await show('点击后');
    console.log('\n=== 结论 ===');
    console.log(after.uiText && /2(\.0+)?X/i.test(after.uiText) ? '✓ 界面已同步 2x' : '✗ 界面未变');
    console.log(Number(after.videoRate) >= 1.9 ? '✓ 实际倍速 2x' : '✗ 实际倍速 ' + after.videoRate);
  } else {
    console.log('\n  ✗ 菜单未展开，无法点击');
  }

  s.ws.close();
  process.exit(0);
})().catch((e) => { console.error('异常:', e && e.stack || e); process.exit(1); });

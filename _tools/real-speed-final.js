#!/usr/bin/env node
/**
 * 最终方案验证：先改播放器内部状态 p.options.speed.value，再触发它自己的
 * 菜单项点击处理，使界面与媒体同步到 2 倍速。
 *
 *   node _tools/real-speed-final.js [视频URL]
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
  async move(x, y) { await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons: 0 }); }
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
    console.log('导航到视频页…');
    await s.send('Page.navigate', { url: URL_ARG });
    await sleep(11000);
  }
  await sleep(1000);
  try { await s.send('Page.bringToFront'); } catch (e) { }

  const show = async (l) => {
    const d = JSON.parse((await s.eval(READ)).value);
    console.log(`  [${l}] 界面=${d.uiText} video.rate=${d.videoRate} options.speed.value=${d.optValue} 菜单active=${d.active}`);
    return d;
  };

  console.log('=== 基线 ===');
  const base = await show('基线');
  if (base.videoRate === null) { console.log('无视频，退出'); s.ws.close(); process.exit(1); }

  console.log('\n=== 步骤1：改播放器内部状态 options.speed.value = 2 ===');
  const step1 = await s.eval(`(function(){
    var r=document.querySelector('.xt_video_player_container, .xtplayer, .video-box');
    var p=r&&r.__vue__&&r.__vue__.$data.player;
    if(!p) return 'no player';
    try { p.options.speed.value = 2; } catch(e){ return 'fail: '+e.message }
    // 通知 Vue 数据变化（player 是普通对象，试探性调用 $forceUpdate）
    try { r.__vue__.$forceUpdate(); } catch(e){}
    return 'options.speed.value -> ' + p.options.speed.value;
  })()`);
  console.log('  ' + step1.value);
  await sleep(800);
  await show('改内部值后');

  console.log('\n=== 步骤2：带用户手势点击菜单项，触发播放器自己的处理函数 ===');
  // 确保菜单可见
  await s.eval(`(function(){
    var l=document.querySelector('.xt_video_player_common_list_wrap, xt-speedlist');
    if(l){ l.style.setProperty('display','block','important'); l.style.setProperty('opacity','1','important'); }
    return true;
  })()`);
  await sleep(300);
  const box = JSON.parse((await s.eval(`JSON.stringify((function(){
    var li=document.querySelector('.xt_video_player_common_list li[data-speed="2"]');
    if(!li) return null; var r=li.getBoundingClientRect();
    return { x:Math.round(r.left+r.width/2), y:Math.round(r.top+r.height/2), w:Math.round(r.width) };
  })())`)).value);
  console.log('  2.00X 选项坐标:', JSON.stringify(box));
  if (box && box.w > 0) {
    await s.move(box.x, box.y);
    await sleep(150);
    // 用 Runtime.evaluate + userGesture 派发真实 HTMLElement.click()（带用户激活）
    await s.eval(`(function(){
      var li=document.querySelector('.xt_video_player_common_list li[data-speed="2"]');
      if(li) li.click();
      return true;
    })()`);
    await sleep(1500);
  } else {
    console.log('  选项不可点（宽度 0）');
  }
  await show('点击后');

  console.log('\n=== 步骤3：恢复菜单样式 + 再点一次（如果还没生效）===');
  await s.eval(`(function(){
    var li=document.querySelector('.xt_video_player_common_list li[data-speed="2"]');
    if(li){ ['mouseover','mousedown','mouseup','click'].forEach(function(t){
      li.dispatchEvent(new MouseEvent(t,{bubbles:true,cancelable:true,view:window})); }); li.click(); }
    return true;
  })()`);
  await sleep(1500);
  const fin = await show('最终');

  console.log('\n=== 结论 ===');
  const uiOk = fin.uiText && /2(\.0+)?X/i.test(fin.uiText);
  const rateOk = Number(fin.videoRate) >= 1.9;
  console.log(uiOk ? `✓ 播放器界面已显示 ${fin.uiText}` : `✗ 界面仍为 ${fin.uiText}`);
  console.log(rateOk ? `✓ 实际播放倍速 ${fin.videoRate}x` : `✗ 实际倍速 ${fin.videoRate}x`);

  s.ws.close();
  process.exit(0);
})().catch((e) => { console.error('异常:', e && e.stack || e); process.exit(1); });

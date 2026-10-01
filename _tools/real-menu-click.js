#!/usr/bin/env node
/**
 * 验证：通过播放器自己的倍速菜单点击，能否真正改变 video.playbackRate？
 * （脚本保持关闭，避免干扰；用 CDP 真实鼠标输入，因为菜单靠 hover 展开）
 *
 *   node _tools/real-menu-click.js [视频URL]
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
  async move(x, y) { await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons: 0 }); }
  async click(x, y) {
    await this.move(x, y);
    await sleep(120);
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
    await sleep(70);
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
  }
}

const READ = `JSON.stringify({
  uiText: (function(){ var v=document.querySelector('.xt_video_player_common_value, xt-speedvalue'); return v?(v.innerText||'').trim():null })(),
  videoRate: (function(){ var v=document.querySelector('video'); return v?v.playbackRate:null })(),
  activeSpeed: (function(){ var a=document.querySelector('.xt_video_player_common_list .xt_video_player_common_active'); return a?a.getAttribute('data-speed'):null })(),
  listW: (function(){ var l=document.querySelector('.xt_video_player_common_list_wrap, xt-speedlist'); return l?Math.round(l.getBoundingClientRect().width):null })(),
  tool: !!window.__yktTool,
})`;

(async () => {
  const pages = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).filter((t) => t.type === 'page');
  const target = pages.find((p) => /yuketang/i.test(p.url)) || pages[0];
  const s = await Session.connect(target.webSocketDebuggerUrl);
  await s.send('Runtime.enable');
  await s.send('Page.enable');
  try { await s.send('Page.bringToFront'); } catch (e) { }

  await s.send('Page.navigate', { url: URL_ARG });
  await sleep(11000);
  try { await s.send('Page.bringToFront'); } catch (e) { }
  await sleep(500);

  const show = async (l) => {
    const d = JSON.parse((await s.eval(READ)).value);
    console.log(`  [${l}] 界面=${d.uiText} video.rate=${d.videoRate} 菜单active=${d.activeSpeed} 菜单宽=${d.listW} 脚本=${d.tool}`);
    return d;
  };

  console.log('=== 基线（脚本不介入） ===');
  const base = await show('基线');
  if (base.videoRate === null) { console.log('无视频，退出'); s.ws.close(); process.exit(1); }

  // 取倍速按钮坐标
  const box = JSON.parse((await s.eval(`JSON.stringify((function(){
    var b=document.querySelector('.xt_video_player_speed, xt-speedbutton');
    if(!b) return null; var r=b.getBoundingClientRect();
    return {x:Math.round(r.left+r.width/2), y:Math.round(r.top+r.height/2)};
  })())`)).value);
  if (!box) { console.log('找不到倍速按钮'); s.ws.close(); process.exit(1); }
  console.log(`\n倍速按钮位置: ${JSON.stringify(box)}`);

  console.log('\n=== 步骤1：真实鼠标 hover 展开菜单 ===');
  await s.move(5, 5);
  await sleep(200);
  await s.move(box.x, box.y);
  await sleep(900);
  const hov = await show('hover后');

  if (!hov.listW) { console.log('菜单没展开，退出'); s.ws.close(); process.exit(1); }

  console.log('\n=== 步骤2：真实点击 2.00X 选项 ===');
  const opt = JSON.parse((await s.eval(`JSON.stringify((function(){
    var li=document.querySelector('.xt_video_player_common_list li[data-speed="2"]');
    if(!li) return null; var r=li.getBoundingClientRect();
    return { x:Math.round(r.left+r.width/2), y:Math.round(r.top+r.height/2), w:Math.round(r.width), h:Math.round(r.height) };
  })())`)).value);
  console.log('  选项坐标:', JSON.stringify(opt));
  if (!opt) { s.ws.close(); process.exit(1); }

  await s.click(opt.x, opt.y);
  const afterClick = await show('点击后');

  console.log('\n=== 步骤3：再 hover 一次保持菜单，确认 active 项 ===');
  await s.move(box.x, box.y);
  await sleep(600);
  const final = await show('最终');

  console.log('\n=== 结论 ===');
  const ok = Number(final.videoRate) > 1.5 || (final.uiText && /2(\.0+)?X/i.test(final.uiText)) || final.activeSpeed === '2';
  console.log(ok
    ? `✓ 通过播放器菜单成功切到 2 倍速（界面=${final.uiText} video.rate=${final.videoRate} active=${final.activeSpeed}）`
    : `✗ 点击菜单项无效（界面=${final.uiText} video.rate=${final.videoRate} active=${final.activeSpeed}）`);

  s.ws.close();
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error('异常:', e && e.stack || e); process.exit(1); });

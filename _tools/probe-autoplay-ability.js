#!/usr/bin/env node
/**
 * 最小实验：静音状态下 play() 在本题环境里能否成功？
 *   node _tools/probe-autoplay-ability.js
 *
 * 目的：区分「浏览器策略拦住了自动播放」和「仿真站点自身的播放逻辑有问题」。
 */
const CONFIG = require('./config');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class S {
  constructor(ws) { this.ws = ws; this.id = 0; this.p = new Map(); }
  static async open(u) {
    const ws = new WebSocket(u);
    await new Promise((r, j) => { ws.onopen = r; ws.onerror = () => j(new Error('ws fail')); });
    const s = new S(ws);
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.id && s.p.has(m.id)) { const { r, j } = s.p.get(m.id); s.p.delete(m.id); m.error ? j(new Error(JSON.stringify(m.error))) : r(m.result); }
    };
    return s;
  }
  send(method, params = {}, t = 20000) {
    const id = ++this.id;
    return new Promise((r, j) => {
      this.p.set(id, { r, j });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.p.has(id)) { this.p.delete(id); j(new Error('timeout ' + method)); } }, t);
    });
  }
  async json(expr, aw = false) {
    try {
      const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: aw });
      if (r.exceptionDetails) return { __err: r.exceptionDetails.exception?.description || 'err' };
      const v = r.result.value;
      return typeof v === 'string' ? JSON.parse(v) : (v || {});
    } catch (e) { return { __err: e.message }; }
  }
}

(async () => {
  const list = await (await fetch(`http://127.0.0.1:${CONFIG.cdpPort}/json/list`)).json();
  const ctl = await S.open(list.filter((t) => t.type === 'page')[0].webSocketDebuggerUrl);
  await ctl.send('Page.enable');
  const nt = await ctl.send('Target.createTarget', { url: 'about:blank' });
  await sleep(1200);
  const info = (await (await fetch(`http://127.0.0.1:${CONFIG.cdpPort}/json/list`)).json())
    .filter((t) => t.type === 'page').find((x) => x.id === nt.targetId);
  const s = await S.open(info.webSocketDebuggerUrl);
  await s.send('Page.enable'); await s.send('Runtime.enable');
  try { await s.send('Page.bringToFront'); } catch (e) { }

  console.log('打开仿真播放页（不注入脚本，排除脚本干扰）…');
  await s.send('Page.navigate', { url: CONFIG.mock.video(CONFIG.mock.leafBase) });
  await sleep(6000);

  const st = await s.json(`(function(){ var v=document.getElementById('mock-media');
    return JSON.stringify({ hasMedia: !!v,
      muted: v?v.muted:null, volume: v?v.volume:null, paused: v?v.paused:null,
      readyState: v?v.readyState:null, dur: v&&isFinite(v.duration)?Math.round(v.duration):null,
      err: v&&v.error?{code:v.error.code,msg:v.error.message}:null,
      ua: (function(){ try { return { hasBeenActive: navigator.userActivation.hasBeenActive }; } catch(e){ return 'na' } })(),
    }); })()`);
  console.log('初始状态:', JSON.stringify(st));

  console.log('\n=== 测试 A：静音后 play() ===');
  const a = await s.json(`(async function(){ var v=document.getElementById('mock-media');
    if(!v) return JSON.stringify({err:'no media'});
    v.muted = true; v.volume = 0;
    try { await v.play(); return JSON.stringify({ result:'OK', paused:v.paused, t:+v.currentTime.toFixed(2) }); }
    catch(e) { return JSON.stringify({ result:'REJECTED', name:e.name, msg:String(e.message).slice(0,140) }); }
  })()`, true);
  console.log(' ', JSON.stringify(a));

  console.log('\n=== 测试 B：不静音 play() ===');
  const b = await s.json(`(async function(){ var v=document.getElementById('mock-media');
    if(!v) return JSON.stringify({err:'no media'});
    v.pause(); v.muted = false; v.volume = 0.3;
    try { await v.play(); return JSON.stringify({ result:'OK', paused:v.paused }); }
    catch(e) { return JSON.stringify({ result:'REJECTED', name:e.name, msg:String(e.message).slice(0,140) }); }
  })()`, true);
  console.log(' ', JSON.stringify(b));

  console.log('\n=== 测试 C：真实点击后再静音 play() ===');
  for (const type of ['mousePressed', 'mouseReleased']) {
    await s.send('Input.dispatchMouseEvent', { type, x: 50, y: 50, button: 'left', clickCount: 1 });
  }
  await sleep(600);
  const c = await s.json(`(async function(){ var v=document.getElementById('mock-media');
    if(!v) return JSON.stringify({err:'no media'});
    v.pause(); v.muted = true; v.volume = 0;
    var ua = (function(){ try { return navigator.userActivation.hasBeenActive } catch(e){ return 'na' } })();
    try { await v.play(); return JSON.stringify({ result:'OK', paused:v.paused, ua:ua }); }
    catch(e) { return JSON.stringify({ result:'REJECTED', name:e.name, ua:ua, msg:String(e.message).slice(0,140) }); }
  })()`, true);
  console.log(' ', JSON.stringify(c));

  console.log('\n=== 结论 ===');
  if (a.result === 'OK') console.log('  ✓ 本环境**可以**静音自动播放 → 仿真失败是站点/脚本逻辑问题');
  else console.log('  ✗ 本环境**即使静音也拒绝**自动播放 → 属测试环境策略限制');
  if (b.result === 'REJECTED') console.log('  · 不静音确实被策略拒绝（符合预期）');

  s.ws.close(); ctl.ws.close();
  process.exit(0);
})().catch((e) => { console.error('异常:', e && e.stack || e); process.exit(1); });

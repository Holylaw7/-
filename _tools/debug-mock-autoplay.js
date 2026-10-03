#!/usr/bin/env node
/**
 * 用与 e2e 完全相同的浏览器参数，观察仿真站点的自动播放行为。
 *   node _tools/debug-mock-autoplay.js
 *
 * 用于区分：是浏览器策略拦了自动播放，还是仿真站点/脚本自身的问题。
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const CONFIG = require('./config');

const PORT = 9334;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const EDGE = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].find((p) => fs.existsSync(p));

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
  send(method, params = {}, t = 25000) {
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

const PLAYER_LOG = `JSON.stringify({
  log: (window.__playerLog||[]).slice(-16).map(function(x){ return x[1]; }),
  media: (function(){ var v=document.getElementById('mock-media');
    return v?{ muted:v.muted, volume:v.volume, paused:v.paused, readyState:v.readyState,
      t:+v.currentTime.toFixed(2), dur:isFinite(v.duration)?Math.round(v.duration):null,
      err: v.error?{code:v.error.code,msg:v.error.message}:null }:null })(),
})`;

(async () => {
  if (!EDGE) { console.error('找不到 msedge.exe'); process.exit(1); }
  const profile = path.join(os.tmpdir(), 'ykt-dbg-' + Date.now());

  // 与 e2e 完全相同的参数：注意 --autoplay-policy=no-user-gesture-required
  const args = [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu',
    '--disable-features=Translate,OptimizationHints',
    '--autoplay-policy=no-user-gesture-required',
    '--lang=zh-CN',
    'about:blank',
  ];
  console.log('启动无头 Edge（与 e2e 参数一致，含 --autoplay-policy=no-user-gesture-required）…');
  const browser = spawn(EDGE, args, { stdio: 'ignore' });

  let ok = false;
  for (let i = 0; i < 60 && !ok; i++) {
    await sleep(500);
    try { ok = (await fetch(`http://127.0.0.1:${PORT}/json/version`, { signal: AbortSignal.timeout(1500) })).ok; } catch (e) { }
  }
  if (!ok) { console.error('✗ 浏览器未就绪'); process.exit(1); }
  console.log('✓ 就绪\n');

  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const p = list.find((t) => t.type === 'page');
  const s = await S.open(p.webSocketDebuggerUrl);
  await s.send('Page.enable'); await s.send('Runtime.enable');

  const url = CONFIG.mock.video(CONFIG.mock.leafBase);

  // 先登录（仿真站点：打开 /web 点一键登录），否则播放页会 302 到登录页
  console.log('登录仿真站点…');
  await s.send('Page.navigate', { url: `${CONFIG.mock.origin()}/web` });
  await sleep(2000);
  await s.json(`(function(){ var b=document.getElementById('btn-login'); if(b){ b.click(); return 'clicked' } return 'no button' })()`);
  await sleep(2500);
  const logged = await s.json(`JSON.stringify({ url: location.pathname, loggedIn: !/\\/web/.test(location.pathname) })`);
  console.log('  登录后:', JSON.stringify(logged));

  console.log('\n=== 场景 A：不注入脚本，只看仿真站点自己能否自动播放 ===');
  await s.send('Page.navigate', { url });
  await sleep(6000);
  let d = await s.json(PLAYER_LOG);
  console.log('  媒体:', JSON.stringify(d.media));
  (d.log || []).forEach((l) => console.log('    ' + l));

  console.log('\n=== 场景 B：注入脚本后 ===');
  const src = fs.readFileSync(path.join(__dirname, '..', 'dist', 'changjiang-yuketang-auto.user.js'), 'utf8');
  await s.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `try { localStorage.setItem('ykt_tool:autoStart','true'); localStorage.setItem('ykt_tool:autoNext','true'); } catch(e){}`,
  });
  await s.send('Page.addScriptToEvaluateOnNewDocument', { source: src });
  await s.send('Page.navigate', { url });
  await sleep(12000);
  d = await s.json(PLAYER_LOG);
  console.log('  媒体:', JSON.stringify(d.media));
  (d.log || []).forEach((l) => console.log('    ' + l));

  const tool = await s.json(`(function(){ try { var t=window.__yktTool.state;
    return JSON.stringify({ running:t.running, rate:t.rate, paused:t.paused, muted:t.muted,
      autoplayBlocked:t.autoplayBlocked, blockCount:t.autoplayBlockCount, playFail:t.playFailCount,
      mediaTag:t.mediaTag, rateDetail:t.progress }); } catch(e){ return JSON.stringify({err:String(e)}) } })()`);
  console.log('\n  脚本状态:', JSON.stringify(tool));

  console.log('\n=== 场景 C：从浏览器侧强制 play()（判断是环境还是逻辑）===');
  const forced = await s.json(`(async function(){ var v=document.getElementById('mock-media');
    if(!v) return JSON.stringify({err:'no media'});
    v.muted = true; v.volume = 0;
    try { await v.play(); return JSON.stringify({result:'OK', paused:v.paused, t:+v.currentTime.toFixed(2)}); }
    catch(e) { return JSON.stringify({result:'REJECTED', name:e.name, msg:String(e.message).slice(0,160)}); }
  })()`, true);
  console.log('  强制静音后 play():', JSON.stringify(forced));

  const forced2 = await s.json(`(async function(){ var v=document.getElementById('mock-media');
    if(!v) return JSON.stringify({err:'no media'});
    v.pause(); v.muted = false; v.volume = 0.8;
    try { await v.play(); return JSON.stringify({result:'OK', paused:v.paused}); }
    catch(e) { return JSON.stringify({result:'REJECTED', name:e.name, msg:String(e.message).slice(0,160)}); }
  })()`, true);
  console.log('  取消静音后 play():', JSON.stringify(forced2));

  console.log('\n=== 结论 ===');
  if (forced.result === 'OK') console.log('  · 本环境可以静音自动播放');
  else console.log('  · 本环境连静音自动播放都拒绝 → 属环境限制');
  if (forced2.result === 'OK') console.log('  · 本环境允许有声自动播放（autoplay-policy 标志生效）');
  else console.log('  · 本环境拒绝有声自动播放');

  try { browser.kill(); } catch (e) { }
  s.ws.close();
  process.exit(0);
})().catch((e) => { console.error('异常:', e && e.stack || e); process.exit(1); });

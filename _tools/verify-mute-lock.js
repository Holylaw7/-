#!/usr/bin/env node
/**
 * 验证「静音锁」：注入最新构建后，站点是否还能取消静音。
 *   node _tools/verify-mute-lock.js
 */
const fs = require('fs');
const path = require('path');
const CONFIG = require('./config');
const USERSCRIPT = path.join(__dirname, '..', 'dist', 'changjiang-yuketang-auto.user.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const check = (n, ok, d = '') => { ok ? pass++ : fail++; console.log(`  ${ok ? '✓' : '✗'} ${n}${d ? '  — ' + d : ''}`); };

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
  send(method, params = {}, t = 40000) {
    const id = ++this.id;
    return new Promise((r, j) => {
      this.p.set(id, { r, j });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.p.has(id)) { this.p.delete(id); j(new Error('timeout ' + method)); } }, t);
    });
  }
  async json(expr, aw = false) {
    try {
      const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: aw, userGesture: true });
      if (r.exceptionDetails) return { __err: r.exceptionDetails.exception?.description || 'err' };
      const v = r.result.value;
      return typeof v === 'string' ? JSON.parse(v) : (v || {});
    } catch (e) { return { __err: e.message }; }
  }
}

(async () => {
  if (!CONFIG.require('verify-mute-lock.js')) process.exit(1);

  const list = await (await fetch(`http://127.0.0.1:${CONFIG.cdpPort}/json/list`)).json();
  const p = list.find((t) => t.type === 'page' && /yuketang/.test(t.url)) || list.find((t) => t.type === 'page');

  // 小节 id：优先用配置 / 命令行，其次从当前页面 URL 取
  let leaf = CONFIG.leaf || '';
  if (!leaf) {
    for (const t of list.filter((x) => x.type === 'page')) {
      const parsed = CONFIG.parseUrl(t.url);
      if (parsed.leaf) { leaf = parsed.leaf; break; }
    }
  }
  if (!leaf) leaf = String(CONFIG.mock.leafBase);
  console.log('使用小节 leaf =', leaf);

  const s = await S.open(p.webSocketDebuggerUrl);
  await s.send('Page.enable'); await s.send('Runtime.enable');
  try { await s.send('Page.bringToFront'); } catch (e) { }

  const src = fs.readFileSync(USERSCRIPT, 'utf8');
  console.log(`注入最新构建（${(src.match(/@version\s+(\S+)/) || [])[1]}）并打开 leaf=${leaf}\n`);
  await s.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `try {
      localStorage.setItem('ykt_tool:autoStart','true');
      localStorage.setItem('ykt_tool:autoNext','true');
      localStorage.setItem('ykt_tool:rate','2');
      localStorage.setItem('ykt_tool:mute','true');
      localStorage.setItem('ykt_tool:background','true');
    } catch(e){}`,
  });
  await s.send('Page.addScriptToEvaluateOnNewDocument', { source: src });
  await s.send('Page.navigate', { url: CONFIG.url.video(leaf) });
  await sleep(16000);

  const st = await s.json(`(function(){ try { var G=window.__yktTool.state.guard;
    return JSON.stringify({ muteLocked: G.active, blockedUnmute: G.blockedUnmute, blockedPause: G.blockedPause,
      notes: (G.notes||[]).slice(-4) }); } catch(e){ return JSON.stringify({err:String(e)}) } })()`);
  console.log('守卫状态:', JSON.stringify(st));
  check('静音锁已装载', st.blockedUnmute !== undefined && st.muteLocked === true, `muteLocked=` + st.muteLocked + ` blockedUnmute=` + st.blockedUnmute);

  console.log('\n=== 观察 20 秒内 muted 是否被站点取消 ===');
  let unmuted = 0, samples = 0, blockedGrow = 0;
  const first = await s.json(`(function(){ var G=window.__yktTool.state.guard; return JSON.stringify({b:G.blockedUnmute||0}) })()`);
  for (let i = 0; i < 10; i++) {
    const d = await s.json(`(function(){ var v=document.querySelector('video'); var G=window.__yktTool.state.guard;
      return JSON.stringify({ muted: v?v.muted:null, vol: v?v.volume:null, paused: v?v.paused:null,
        rate: v?v.playbackRate:null, t: v?+v.currentTime.toFixed(1):null, blocked: G.blockedUnmute||0,
        autoplayBlocked: window.__yktTool.state.autoplayBlocked }); })()`);
    samples++;
    if (d.muted === false) unmuted++;
    console.log(`  ${i * 2}s: muted=${d.muted} vol=${d.vol} rate=${d.rate} paused=${d.paused} t=${d.t} 已拦取消静音=${d.blocked} 自动播放被拦=${d.autoplayBlocked}`);
    if (d.blocked > (first.b || 0)) blockedGrow = d.blocked - (first.b || 0);
    await sleep(2000);
  }
  check('静音始终保持（站点无法取消）', unmuted === 0, `${samples} 次采样中 muted=false 出现 ${unmuted} 次`);
  check('确实拦截了站点的取消静音', blockedGrow > 0, `本次观察到拦截 ${blockedGrow} 次`);

  const fin = await s.json(`(function(){ var v=document.querySelector('video');
    return JSON.stringify({ paused: v?v.paused:null, rate: v?v.playbackRate:null, t: v?+v.currentTime.toFixed(1):null,
      dur: v&&isFinite(v.duration)?Math.round(v.duration):null }); })()`);
  console.log('\n最终:', JSON.stringify(fin));
  check('视频仍在 2 倍速播放', fin.paused === false && Math.abs(fin.rate - 2) < 0.01, `rate=${fin.rate} paused=${fin.paused}`);

  // 脚本自带自检
  console.log('\n=== 脚本自带自检 ===');
  const v = await s.json(`(async function(){ var r=await window.__yktTool.verifyResults();
    return JSON.stringify({pass:r.pass,fail:r.fail,warn:r.warn,lines:r.lines}); })()`, true);
  if (v.lines) v.lines.forEach((l) => console.log('  ' + l));
  check('脚本自带自检全部通过', v.fail === 0, `通过 ${v.pass} / 失败 ${v.fail} / 提示 ${v.warn}`);

  s.ws.close();
  console.log(`\n${fail === 0 ? '✅ 全部通过' : '❌ 存在失败项'}  通过 ${pass} / 失败 ${fail}`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('异常:', e && e.stack || e); process.exit(1); });

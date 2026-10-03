#!/usr/bin/env node
/**
 * 用全新标签页做真实站点最终验证（避免多次注入叠加、避免旧页面干扰）
 *   node _tools/real-verify-clean.js
 */
const fs = require('fs');
const path = require('path');
const CONFIG = require('./config');

const USERSCRIPT = path.join(__dirname, '..', 'dist', 'changjiang-yuketang-auto.user.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const check = (n, ok, d = '') => { ok ? pass++ : fail++; console.log(`  ${ok ? '✓' : '✗'} ${n}${d ? '  — ' + d : ''}`); };

class S {
  constructor(ws) { this.ws = ws; this.id = 0; this.p = new Map(); this.console = []; this.ex = []; }
  static async open(u) {
    const ws = new WebSocket(u);
    await new Promise((r, j) => { ws.onopen = r; ws.onerror = () => j(new Error('ws fail')); });
    const s = new S(ws);
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.id && s.p.has(m.id)) { const { r, j } = s.p.get(m.id); s.p.delete(m.id); m.error ? j(new Error(JSON.stringify(m.error))) : r(m.result); }
      else if (m.method === 'Runtime.consoleAPICalled') {
        const t = (m.params.args || []).map((a) => a.value ?? a.description ?? '').join(' ');
        if (/刷课助手/.test(t)) s.console.push(t.replace(/%c/g, '').replace(/color:#2563eb/, '').trim().slice(0, 160));
      } else if (m.method === 'Runtime.exceptionThrown') s.ex.push((m.params.exceptionDetails.exception?.description || '').slice(0, 200));
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

const PROBE = `(function(){ var v=document.querySelector('video');
  return JSON.stringify({
    path: location.pathname,
    leaf: (function(){ var m=location.pathname.match(/\\/video\\/([^/?#]+)/); return m?m[1]:null })(),
    running: window.__yktTool ? window.__yktTool.state.running : null,
    video: v?{ t:+v.currentTime.toFixed(1), dur:isFinite(v.duration)?Math.round(v.duration):null,
      rate:v.playbackRate, paused:v.paused, muted:v.muted } : null,
    rateDetail: (function(){ var e=document.querySelector('.rate-detail .text'); return e?(e.innerText||'').trim():null })(),
    panelLog: (function(){ var h=document.getElementById('ykt-tool-host'); if(!h||!h.shadowRoot) return [];
      var l=h.shadowRoot.getElementById('log'); return l?(l.innerText||'').split('\\n').filter(Boolean).slice(-8):[] })(),
  }); })()`;

(async () => {
  if (!CONFIG.require('real-verify-clean.js')) process.exit(1);

  const list = await (await fetch(`http://127.0.0.1:${CONFIG.cdpPort}/json/list`)).json();
  const pages = list.filter((t) => t.type === 'page');
  const ctl = await S.open(pages[0].webSocketDebuggerUrl);
  await ctl.send('Page.enable');
  const nt = await ctl.send('Target.createTarget', { url: 'about:blank' });
  ctl.ws.close();
  await sleep(1500);

  const fresh = (await (await fetch(`http://127.0.0.1:${CONFIG.cdpPort}/json/list`)).json())
    .filter((t) => t.type === 'page').find((x) => x.id === nt.targetId);
  const s = await S.open(fresh.webSocketDebuggerUrl);
  await s.send('Page.enable'); await s.send('Runtime.enable');
  try { await s.send('Page.bringToFront'); } catch (e) { }

  // 全新标签页 localStorage 是干净的；只开自动开始与自动跳转，静音保持默认关闭
  const src = fs.readFileSync(USERSCRIPT, 'utf8');
  console.log(`全新标签页 · 注入 v${(src.match(/@version\s+(\S+)/) || [])[1]}\n`);
  await s.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `try { localStorage.setItem('ykt_tool:autoStart','true'); localStorage.setItem('ykt_tool:autoNext','true'); } catch(e){}`,
  });
  await s.send('Page.addScriptToEvaluateOnNewDocument', { source: src });

  console.log('从课程目录页开始…');
  await s.send('Page.navigate', { url: CONFIG.url.studentLog() });

  // 等它停在未完成且视频就绪的小节
  console.log('\n=== 等待脚本稳定在未完成小节（最多 120 秒）===');
  let st = null, lastLeaf = '', same = 0;
  const t0 = Date.now();
  while (Date.now() - t0 < 120000) {
    const cur = await s.json(PROBE);
    if (cur.leaf && cur.leaf === lastLeaf) same++; else { same = 0; lastLeaf = cur.leaf; }
    if (cur.video && cur.video.dur && cur.video.paused === false && !/已完成|100%/.test(cur.rateDetail || '') && same >= 2) { st = cur; break; }
    await sleep(3000);
  }
  if (!st) {
    const cur = await s.json(PROBE);
    console.log('  未稳定，当前:', JSON.stringify(cur));
    (cur.panelLog || []).forEach((l) => console.log('    ' + l));
    check('脚本自动进入并播放未完成小节', false);
    s.ws.close(); console.log(`\n通过 ${pass} / 失败 ${fail}`); process.exit(1);
  }
  console.log('  稳定在:', JSON.stringify(st));

  console.log('\n=== 结果 ===');
  check('已自动进入视频页（接口导航，未点击卡片）', !!st.leaf, `leaf=${st.leaf}`);
  check('脚本处于运行状态', st.running === true);
  check('已捕获视频元素', !!st.video, `时长=${st.video && st.video.dur}s`);
  check('倍速已锁定为 2x', st.video && Math.abs(st.video.rate - 2) < 0.01, `rate=${st.video && st.video.rate}`);
  check('未静音（符合默认设置）', st.video && st.video.muted === false, `muted=${st.video && st.video.muted}`);
  check('视频正在播放', st.video && st.video.paused === false, `paused=${st.video && st.video.paused}`);

  const b = (await s.json(PROBE)).video;
  await sleep(3000);
  const a = (await s.json(PROBE)).video;
  const adv = (a && b) ? a.t - b.t : 0;
  check('进度真实推进（2 倍速生效）', adv > 3, `${b && b.t} → ${a && a.t}，3 秒前进 ${adv.toFixed(1)} 秒`);

  console.log('\n=== 脚本自带完整自检 ===');
  const v = await s.json(`(async function(){ var r=await window.__yktTool.verifyResults();
    return JSON.stringify({pass:r.pass,fail:r.fail,warn:r.warn,lines:r.lines}); })()`, true);
  if (v.lines) v.lines.forEach((l) => console.log('  ' + l));
  check('脚本自带自检全部通过', v.fail === 0, `通过 ${v.pass} / 失败 ${v.fail} / 提示 ${v.warn}`);

  console.log('\n=== 控制台日志 ===');
  s.console.slice(-14).forEach((l) => console.log('  ' + l));
  if (s.ex.length) { console.log('\n=== 页面异常 ==='); s.ex.slice(0, 5).forEach((e) => console.log('  ' + e.split('\n')[0])); }

  s.ws.close();
  console.log(`\n${fail === 0 ? '✅ 全部通过' : '❌ 存在失败项'}  通过 ${pass} / 失败 ${fail}`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('异常:', e && e.stack || e); process.exit(1); });

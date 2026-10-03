#!/usr/bin/env node
/**
 * 真实站点完整验证（注入最新构建，逐步报告状态）
 *   node _tools/real-verify-live.js [--no-inject]
 *
 * 前提：调试窗口已登录雨课堂，且 _tools/local.config.json 里有你的教室号。
 */
const fs = require('fs');
const path = require('path');
const CONFIG = require('./config');

const INJECT = !process.argv.includes('--no-inject');
const USERSCRIPT = path.join(__dirname, '..', 'dist', 'changjiang-yuketang-auto.user.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const check = (n, ok, d = '') => { ok ? pass++ : fail++; console.log(`  ${ok ? '✓' : '✗'} ${n}${d ? '  — ' + d : ''}`); };

class S {
  constructor(ws) { this.ws = ws; this.id = 0; this.p = new Map(); this.console = []; this.exceptions = []; }
  static async open(u) {
    const ws = new WebSocket(u);
    await new Promise((r, j) => { ws.onopen = r; ws.onerror = () => j(new Error('ws fail')); });
    const s = new S(ws);
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.id && s.p.has(m.id)) { const { r, j } = s.p.get(m.id); s.p.delete(m.id); m.error ? j(new Error(JSON.stringify(m.error))) : r(m.result); }
      else if (m.method === 'Runtime.consoleAPICalled') {
        const t = (m.params.args || []).map((a) => a.value ?? a.description ?? '').join(' ');
        if (/刷课助手/.test(t)) s.console.push(t.replace(/%c/g, '').replace(/color:#2563eb/, '').trim().slice(0, 150));
      } else if (m.method === 'Runtime.exceptionThrown') {
        s.exceptions.push((m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text || '').slice(0, 200));
      }
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
  async ev(expr, aw = false) {
    try {
      const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: aw, userGesture: true });
      if (r.exceptionDetails) return { error: r.exceptionDetails.exception?.description || 'err' };
      return { value: r.result.value };
    } catch (e) { return { error: e.message }; }
  }
  async json(expr, aw = false) {
    const r = await this.ev(expr, aw);
    if (r.error) return { __err: r.error };
    try { return typeof r.value === 'string' ? JSON.parse(r.value) : (r.value || {}); } catch (e) { return { __raw: r.value }; }
  }
}

const PROBE = `JSON.stringify({
  path: location.pathname,
  leaf: (function(){ var m=location.pathname.match(/\\/video\\/([^/?#]+)/); return m?m[1]:null })(),
  isLog: /studentLog/.test(location.pathname),
  hasTool: !!window.__yktTool,
  ver: window.__yktTool ? window.__yktTool.version : null,
  panel: !!document.getElementById('ykt-tool-host'),
  logItems: document.querySelectorAll('.leaf-item').length,
  cards: document.querySelectorAll('section.studentCard').length,
  video: (function(){ var v=document.querySelector('video');
    return v?{ t:+v.currentTime.toFixed(1), dur:isFinite(v.duration)?Math.round(v.duration):null,
      rate:v.playbackRate, paused:v.paused, muted:v.muted }:null })(),
  speedUi: (function(){ var e=document.querySelector('.xt_video_player_common_value, xt-speedvalue'); return e?(e.innerText||'').trim():null })(),
  rateDetail: (function(){ var e=document.querySelector('.rate-detail .text'); return e?(e.innerText||'').trim():null })(),
  notice: (function(){ var h=document.getElementById('ykt-tool-host'); if(!h||!h.shadowRoot) return null;
    var n=h.shadowRoot.getElementById('notice'); return (n && !n.hidden) ? (n.innerText||'').trim() : null })(),
  panelLog: (function(){ var h=document.getElementById('ykt-tool-host'); if(!h||!h.shadowRoot) return null;
    var l=h.shadowRoot.getElementById('log'); return l?(l.innerText||'').split('\\n').filter(Boolean).slice(-12):null })(),
})`;

(async () => {
  if (!CONFIG.require('real-verify-live.js')) process.exit(1);

  const list = await (await fetch(`http://127.0.0.1:${CONFIG.cdpPort}/json/list`, { signal: AbortSignal.timeout(5000) })).json();
  const pages = list.filter((t) => t.type === 'page');
  const p = pages.find((x) => /yuketang/i.test(x.url)) || pages[0];
  if (!p) { console.error('没有可用标签页'); process.exit(1); }
  console.log('目标标签页:', p.url.slice(0, 100));

  const s = await S.open(p.webSocketDebuggerUrl);
  await s.send('Page.enable');
  await s.send('Runtime.enable');
  try { await s.send('Page.bringToFront'); } catch (e) { }

  if (INJECT) {
    const src = fs.readFileSync(USERSCRIPT, 'utf8');
    console.log(`注入最新构建 ${(src.length / 1024).toFixed(1)} KB（v${(src.match(/@version\s+(\S+)/) || [])[1]}）`);
    await s.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `try {
        localStorage.setItem('ykt_tool:autoStart','true');
        localStorage.setItem('ykt_tool:autoNext','true');
        localStorage.setItem('ykt_tool:rate','2');
        sessionStorage.removeItem('ykt_tool:stuck');
      } catch(e){}`,
    });
    await s.send('Page.addScriptToEvaluateOnNewDocument', { source: src });
  }

  // ---------- ① 课程目录页 ----------
  console.log('\n=== ① 打开课程目录页 ===');
  await s.send('Page.navigate', { url: CONFIG.url.studentLog() });
  await sleep(16000);
  let d = await s.json(PROBE);
  console.log('  ', JSON.stringify(d));
  // 脚本可能已经自动跳进某个小节（这正是它的工作），所以这里只要求"注入成功"
  check('脚本已注入（目录页）', d.hasTool === true, `版本=${d.ver}`);
  check('控制面板已出现', d.panel === true);

  // 等接口拉取课程列表
  console.log('\n=== ② 观察接口取列表 + 自动跳转（最多 60 秒）===');
  let jumped = false, listMsg = '';
  const t0 = Date.now();
  while (Date.now() - t0 < 60000) {
    d = await s.json(PROBE);
    const lm = (d.panelLog || []).find((l) => /课程列表|接口模式|自动跳转|进入/.test(l));
    if (lm && lm !== listMsg) { listMsg = lm; console.log(`  [${((Date.now() - t0) / 1000).toFixed(0)}s] ${lm}`); }
    if (d.leaf) { jumped = true; break; }
    await sleep(2500);
  }
  check('已自动进入视频页（未点击卡片）', jumped, d.leaf ? `leaf=${d.leaf}` : '仍在目录页');
  const gotList = s.console.concat(d.panelLog || []).some((l) => /课程列表获取完成|共 \d+ 项/.test(l));
  check('通过接口取到了课程列表', gotList, (d.panelLog || []).find((l) => /课程列表/.test(l)) || '');

  if (!jumped) {
    console.log('\n=== 目录页诊断（未能跳转）===');
    console.log('  控制台日志:');
    s.console.slice(-15).forEach((l) => console.log('    ' + l));
    console.log('  面板日志:');
    (d.panelLog || []).forEach((l) => console.log('    ' + l));
    if (s.exceptions.length) { console.log('  页面异常:'); s.exceptions.slice(0, 5).forEach((e) => console.log('    ' + e)); }
    s.ws.close();
    console.log(`\n通过 ${pass} / 失败 ${fail}`);
    process.exit(1);
  }

  // ---------- ③ 等停在一个「未完成」的小节上再测 ----------
  //
  //  脚本会连续跳过已完成的小节，若在切换途中采样会读到 dur=null / rate=1 的空档。
  //  所以这里先等它稳定：连续两次采样都是同一个 leaf、且 video 已就绪、且未标记完成。
  console.log('\n=== ③ 等待脚本停留在可测的未完成小节（最多 90 秒）===');
  let stable = null, lastLeaf = '', sameCount = 0;
  const t1 = Date.now();
  while (Date.now() - t1 < 90000) {
    const cur = await s.json(PROBE);
    const ready = cur.video && cur.video.dur && !/已完成|100%/.test(cur.rateDetail || '');
    if (cur.leaf && cur.leaf === lastLeaf) sameCount++; else { sameCount = 0; lastLeaf = cur.leaf; }
    if (ready && sameCount >= 2) { stable = cur; break; }
    await sleep(2500);
  }
  if (!stable) {
    const cur = await s.json(PROBE);
    console.log('  未等到稳定小节，当前状态:', JSON.stringify(cur));
    console.log('  面板日志:'); (cur.panelLog || []).forEach((l) => console.log('    ' + l));
    check('找到可测的未完成小节', false, '脚本可能仍在连续跳过已完成的节');
    s.ws.close();
    console.log(`\n通过 ${pass} / 失败 ${fail}`);
    process.exit(1);
  }
  d = stable;
  console.log('  稳定在:', JSON.stringify(d));
  check('已捕获视频元素', !!d.video, d.video ? `时长=${d.video.dur}s` : '未找到');
  check('倍速已锁定为 2x（media.playbackRate）', d.video && Math.abs(d.video.rate - 2) < 0.01, `rate=${d.video && d.video.rate}`);
  check('播放器界面显示 2.00X', /2(\.0+)?X/i.test(d.speedUi || ''), `界面=${d.speedUi}`);
  check('静音状态符合设置（默认不静音）', d.video ? (d.video.muted === false) : false, `muted=${d.video && d.video.muted}`);
  check('视频正在播放', d.video && d.video.paused === false, `paused=${d.video && d.video.paused}`);

  // ---------- ④ 进度真实推进 ----------
  console.log('\n=== ④ 进度是否真实推进（3 秒）===');
  const before = (await s.json(PROBE)).video;
  await sleep(3000);
  const after = (await s.json(PROBE)).video;
  const adv = (after && before) ? after.t - before.t : 0;
  check('进度真实推进（2 倍速生效）', adv > 3, `${before && before.t} → ${after && after.t}，3 秒前进 ${adv.toFixed(1)} 秒`);

  // ---------- ⑤ 自动播放策略 ----------
  console.log('\n=== ⑤ 自动播放策略 ===');
  if (d.notice) console.log('  面板提示:', d.notice);
  const ig = await s.json(`(function(){ try { return JSON.stringify({
    seen: window.__yktTool.state.userGesture.seen,
    browserActive: window.__yktTool.state.userGesture.browserActive,
    autoplayBlocked: window.__yktTool.state.autoplayBlocked,
    playFailCount: window.__yktTool.state.playFailCount,
  }); } catch(e){ return JSON.stringify({err:String(e)}) } })()`);
  console.log('  ', JSON.stringify(ig));
  check('未被自动播放策略拦截', ig.autoplayBlocked === false, `autoplayBlocked=${ig.autoplayBlocked}, playFail=${ig.playFailCount}`);

  // ---------- ⑥ 后台守卫 ----------
  console.log('\n=== ⑥ 后台守卫 ===');
  const g = await s.json(`(function(){ try { var G=window.__yktTool.state.guard; return JSON.stringify({
    active:G.active, blockedEvents:G.blockedEvents, blockedPause:G.blockedPause,
    fakeReads:G.fakeReads, seen:G.seenEvents, selfTest:G.selfTest, notes:(G.notes||[]).slice(-3) }); }
    catch(e){ return JSON.stringify({err:String(e)}) } })()`);
  console.log('  ', JSON.stringify(g));
  check('守卫已装载', g.active === true);
  check('事件拦截自检通过', g.selfTest && g.selfTest.ok === true,
    g.selfTest ? `原生可达=${g.selfTest.rawDelivered} 拦截后=${g.selfTest.blockedDelivered}` : '未执行');

  // ---------- ⑦ 脚本自带自检 ----------
  console.log('\n=== ⑦ 脚本自带完整自检 ===');
  const v = await s.json(`(async function(){ var r = await window.__yktTool.verifyResults();
    return JSON.stringify({pass:r.pass,fail:r.fail,warn:r.warn,lines:r.lines}); })()`, true);
  if (v.lines) v.lines.forEach((l) => console.log('  ' + l));
  check('脚本自带自检全部通过', v.fail === 0, `通过 ${v.pass} / 失败 ${v.fail} / 提示 ${v.warn}`);

  console.log('\n=== 控制台日志 ===');
  s.console.slice(-16).forEach((l) => console.log('  ' + l));
  if (s.exceptions.length) {
    console.log('\n=== 页面异常 ===');
    s.exceptions.slice(0, 6).forEach((e) => console.log('  ' + e));
  }

  s.ws.close();
  console.log(`\n${fail === 0 ? '✅ 全部通过' : '❌ 存在失败项'}  通过 ${pass} / 失败 ${fail}`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('异常:', e && e.stack || e); process.exit(1); });

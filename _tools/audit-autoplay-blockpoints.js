#!/usr/bin/env node
/**
 * 自动播放拦截环节排查（真实站点）
 *   node _tools/audit-autoplay-blockpoints.js
 *
 * 逐个检查「可能导致 play() 被拒」的环节：
 *   环节1 首次进入播放页（无任何用户手势）
 *   环节2 脚本跳转下一节（整页导航 → 用户激活被浏览器清零）
 *   环节3 脚本重试 play() 的频率与是否空转
 *   环节4 媒体被换掉（旧元素失效）时的报错
 *   环节5 页面切到后台/窗口失焦时
 *   环节6 用户手势能否恢复
 *
 * 依赖 CDP 的 Input.dispatchMouseEvent / Input.dispatchKeyEvent 产生「真实输入」。
 */
const fs = require('fs');
const path = require('path');
const CONFIG = require('./config');
const USERSCRIPT = path.join(__dirname, '..', 'dist', 'changjiang-yuketang-auto.user.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
const note = (step, verdict, detail) => {
  results.push({ step, verdict, detail });
  const mark = verdict === 'OK' ? '✓' : verdict === 'RISK' ? '⚠' : '·';
  console.log(`  ${mark} [${step}] ${verdict}  ${detail}`);
};

class S {
  constructor(ws) { this.ws = ws; this.id = 0; this.p = new Map(); this.console = []; }
  static async open(u) {
    const ws = new WebSocket(u);
    await new Promise((r, j) => { ws.onopen = r; ws.onerror = () => j(new Error('ws fail')); });
    const s = new S(ws);
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.id && s.p.has(m.id)) { const { r, j } = s.p.get(m.id); s.p.delete(m.id); m.error ? j(new Error(JSON.stringify(m.error))) : r(m.result); }
      else if (m.method === 'Runtime.consoleAPICalled') {
        const t = (m.params.args || []).map((a) => a.value ?? a.description ?? '').join(' ');
        if (/刷课助手/.test(t)) s.console.push({ ts: Date.now(), text: t.replace(/%c/g, '').replace(/color:#2563eb/, '').trim().slice(0, 170) });
      }
    };
    return s;
  }
  send(method, params = {}, t = 30000) {
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

const ST = `(function(){ var v=document.querySelector('video');
  var t = window.__yktTool ? window.__yktTool.state : null;
  return JSON.stringify({
    leaf: (function(){ var m=location.pathname.match(/\\/video\\/([^/?#]+)/); return m?m[1]:null })(),
    paused: v?v.paused:null, rate: v?v.playbackRate:null, t: v?+v.currentTime.toFixed(1):null,
    muted: v?v.muted:null, vol: v?v.volume:null,
    mediaTag: v ? (v.tagName + '#' + (v.id||'').slice(0,8)) : null,
    autoplayBlocked: t?t.autoplayBlocked:null,
    blockCount: t?t.autoplayBlockCount:null,
    gestureSeen: t?t.userGesture.seen:null,
    browserActive: t?t.userGesture.browserActive:null,
    playFail: t?t.playFailCount:null,
    running: t?t.running:null,
  }); })()`;

async function newTab(ctl, s0) {
  const nt = await ctl.send('Target.createTarget', { url: 'about:blank' });
  await sleep(1200);
  const info = (await (await fetch(`http://127.0.0.1:${CONFIG.cdpPort}/json/list`)).json())
    .filter((t) => t.type === 'page').find((x) => x.id === nt.targetId);
  const s = await S.open(info.webSocketDebuggerUrl);
  await s.send('Page.enable'); await s.send('Runtime.enable');
  return s;
}

(async () => {
  if (!CONFIG.require('audit-autoplay-blockpoints.js')) process.exit(1);

  const list = await (await fetch(`http://127.0.0.1:${CONFIG.cdpPort}/json/list`)).json();
  const ctl = await S.open(list.filter((t) => t.type === 'page')[0].webSocketDebuggerUrl);
  await ctl.send('Page.enable');

  const src = fs.readFileSync(USERSCRIPT, 'utf8');
  console.log(`排查自动播放拦截环节 · v${(src.match(/@version\s+(\S+)/) || [])[1]}\n`);
  const INJECT = {
    source: `try { localStorage.setItem('ykt_tool:autoStart','true'); localStorage.setItem('ykt_tool:autoNext','true'); } catch(e){}`,
  };

  // ---------------------------------------------------------------- 环节 1
  console.log('=== 环节 1：首次进入播放页（全程无任何用户手势）===');
  const s1 = await newTab(ctl);
  await s1.send('Page.addScriptToEvaluateOnNewDocument', INJECT);
  await s1.send('Page.addScriptToEvaluateOnNewDocument', { source: src });
  const leaf = CONFIG.leaf || String(CONFIG.mock.leafBase);   // 不写死真实小节，默认用仿真值
  await s1.send('Page.navigate', { url: CONFIG.url.video(leaf) });
  await sleep(16000);
  let a = await s1.json(ST);
  console.log('   ', JSON.stringify(a));
  note('1 首次进入', a.paused === false ? 'OK' : 'RISK',
    a.paused === false
      ? `媒体本身已自行播放（rate=${a.rate}）`
      : `脚本未播放：autoplayBlocked=${a.autoplayBlocked} playFail=${a.playFail}（浏览器拒绝）`);
  note('1 声音状态', 'INFO', `muted=${a.muted} volume=${a.vol}（脚本已不再干预音量）`);

  // ---------------------------------------------------------------- 环节 2
  console.log('\n=== 环节 2：观察自动跳转下一节（整页导航会清零用户激活）===');
  // 先把当前节标记为完成：直接跳到结尾
  await s1.json(`(function(){ var v=document.querySelector('video');
    if(!v||!isFinite(v.duration)) return JSON.stringify({err:'no video'});
    v.currentTime = Math.max(0, v.duration - 0.4); return JSON.stringify({t:v.currentTime}); })()`);
  await sleep(2000);
  const leafBefore = a.leaf;
  let jumped = false, leafAfter = leafBefore;
  const t2 = Date.now();
  while (Date.now() - t2 < 60000) {
    const cur = await s1.json(ST);
    if (cur.leaf && cur.leaf !== leafBefore) { jumped = true; leafAfter = cur.leaf; break; }
    // 若被拦，尝试用真实滚轮手势救一次（模拟用户无意滚动）
    if (cur.autoplayBlocked) break;
    await sleep(2500);
  }
  const after2 = await s1.json(ST);
  console.log('   ', JSON.stringify(after2));
  if (jumped) {
    note('2 跳转后', after2.paused === false ? 'OK' : 'RISK',
      `${leafBefore} → ${leafAfter}；paused=${after2.paused} autoplayBlocked=${after2.autoplayBlocked}`);
  } else {
    note('2 跳转后', 'INFO', `未发生跳转（leaf 仍为 ${after2.leaf}），本轮不适用`);
  }

  // ---------------------------------------------------------------- 环节 3
  console.log('\n=== 环节 3：被拦时的重试行为（是否空转刷屏）===');
  const errs = s1.console.filter((c) => /自动播放|play\(\)|AbortError|NotAllowed/.test(c.text));
  const counts = {};
  errs.forEach((e) => {
    const k = e.text.replace(/第 \d+ 次/, '第 N 次').slice(0, 60);
    counts[k] = (counts[k] || 0) + 1;
  });
  const spam = Object.entries(counts).filter(([, n]) => n > 3);
  if (spam.length) {
    spam.forEach(([k, n]) => note('3 重试', 'RISK', `同类告警重复 ${n} 次：${k}`));
  } else {
    note('3 重试', 'OK', `未发现空转刷屏（相关告警共 ${errs.length} 条）`);
  }
  errs.slice(-6).forEach((e) => console.log('       ' + e.text));

  // ---------------------------------------------------------------- 环节 4
  console.log('\n=== 环节 4：媒体元素被换掉时的报错 ===');
  const abortErrs = s1.console.filter((c) => /AbortError/.test(c.text));
  if (abortErrs.length) {
    note('4 媒体替换', 'RISK', `出现 ${abortErrs.length} 条 AbortError（切换小节时对失效媒体调 play()）`);
    abortErrs.slice(-3).forEach((e) => console.log('       ' + e.text));
  } else {
    note('4 媒体替换', 'OK', '未出现 AbortError');
  }

  // ---------------------------------------------------------------- 环节 5
  console.log('\n=== 环节 5：切到后台（新标签页 + bringToFront 回前台）===');
  const bg = await ctl.send('Target.createTarget', { url: 'about:blank' });
  await sleep(5000);
  const mid = await s1.json(ST);
  await s1.send('Page.bringToFront').catch(() => { });
  await sleep(3000);
  const back = await s1.json(ST);
  console.log('    切后台:', JSON.stringify({ paused: mid.paused, t: mid.t }));
  console.log('    回前台:', JSON.stringify({ paused: back.paused, t: back.t }));
  const advanced = (back.t || 0) > (mid.t || 0);
  note('5 后台播放', back.paused === false ? 'OK' : 'RISK',
    back.paused === false ? `后台期间仍在推进（${mid.t} → ${back.t}）` : `回到前台后仍暂停 t=${back.t}`);
  try { await ctl.send('Target.closeTarget', { targetId: bg.targetId }); } catch (e) { }

  // ---------------------------------------------------------------- 环节 6
  console.log('\n=== 环节 6：真实手势能否恢复被拦的播放 ===');
  const s6 = s1;
  await s6.json(`(function(){ var v=document.querySelector('video'); if(v) v.pause(); return 'ok'; })()`);
  await sleep(2500);
  const before6 = await s6.json(ST);
  console.log('    暂停后:', JSON.stringify({ paused: before6.paused, gestureSeen: before6.gestureSeen, blocked: before6.autoplayBlocked }));
  // 真实滚轮手势
  await s6.send('Input.dispatchMouseEvent', {
    type: 'mouseWheel', x: 400, y: 300, deltaX: 0, deltaY: 120, button: 'none', clickCount: 0,
  });
  let rec = false, ms = 0;
  const t6 = Date.now();
  while (Date.now() - t6 < 15000) {
    const cur = await s6.json(ST);
    if (cur.paused === false) { rec = true; ms = Date.now() - t6; break; }
    await sleep(500);
  }
  const after6 = await s6.json(ST);
  console.log('    手势后:', JSON.stringify({ paused: after6.paused, gestureSeen: after6.gestureSeen, rate: after6.rate }));
  note('6 手势恢复', rec ? 'OK' : 'RISK',
    rec ? `滚轮手势后 ${ms}ms 恢复播放（rate=${after6.rate}）` : '手势后仍未恢复');

  // ---------------------------------------------------------------- 汇总
  console.log('\n' + '='.repeat(72));
  const risk = results.filter((r) => r.verdict === 'RISK');
  console.log(`排查完成：${results.length} 项，风险 ${risk.length} 项`);
  if (risk.length) {
    console.log('\n需要处理的环节：');
    risk.forEach((r) => console.log(`  ⚠ [${r.step}] ${r.detail}`));
  }

  s1.ws.close(); ctl.ws.close();
  process.exit(0);
})().catch((e) => { console.error('异常:', e && e.stack || e); process.exit(1); });

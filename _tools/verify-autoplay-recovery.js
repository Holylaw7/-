#!/usr/bin/env node
/**
 * 验证「自动播放被拦 → 用户手势 → 自动恢复」这条路径（真实站点）
 *   node _tools/verify-autoplay-recovery.js
 *
 * 做法：
 *   1) 全新标签页，不静音（默认设置），注入脚本
 *   2) 用 CDP 撤销用户激活（无 API 时退化为"不产生任何手势"）
 *   3) 观察 play() 是否被 NotAllowedError 拦下、脚本给出提示
 *   4) 派发一次**真实滚轮手势**（Input.dispatchMouseEvent type=mouseWheel）
 *   5) 看脚本是否在 1 秒内恢复播放
 */
const fs = require('fs');
const path = require('path');
const CONFIG = require('./config');
const USERSCRIPT = path.join(__dirname, '..', 'dist', 'changjiang-yuketang-auto.user.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const check = (n, ok, d = '') => { ok ? pass++ : fail++; console.log(`  ${ok ? '✓' : '✗'} ${n}${d ? '  — ' + d : ''}`); };

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
        if (/刷课助手/.test(t)) s.console.push(t.replace(/%c/g, '').replace(/color:#2563eb/, '').trim().slice(0, 170));
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
    muted: v?v.muted:null,
    autoplayBlocked: t?t.autoplayBlocked:null,
    blockCount: t?t.autoplayBlockCount:null,
    gestureSeen: t?t.userGesture.seen:null,
    browserActive: t?t.userGesture.browserActive:null,
    playFail: t?t.playFailCount:null,
    notice: (function(){ var h=document.getElementById('ykt-tool-host'); if(!h||!h.shadowRoot) return null;
      var n=h.shadowRoot.getElementById('notice'); return (n && !n.hidden) ? (n.innerText||'').trim().slice(0,60) : null })(),
  }); })()`;

(async () => {
  if (!CONFIG.require('verify-autoplay-recovery.js')) process.exit(1);

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

  const src = fs.readFileSync(USERSCRIPT, 'utf8');
  console.log(`全新标签页 · 不静音（默认）· 注入 v${(src.match(/@version\s+(\S+)/) || [])[1]}\n`);

  // 只开自动开始；静音保持默认关闭，这样才可能触发自动播放策略
  await s.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `try { localStorage.setItem('ykt_tool:autoStart','true'); localStorage.setItem('ykt_tool:autoNext','true'); } catch(e){}`,
  });
  await s.send('Page.addScriptToEvaluateOnNewDocument', { source: src });

  const leaf = CONFIG.leaf || String(CONFIG.mock.leafBase);   // 不写死真实小节，默认用仿真值
  console.log(`打开播放页 leaf=${leaf}（不产生任何用户手势）…`);
  await s.send('Page.navigate', { url: CONFIG.url.video(leaf) });
  await sleep(18000);

  let st = await s.json(ST);
  console.log('\n=== ① 初始状态（无手势）===');
  console.log(' ', JSON.stringify(st));
  console.log('  浏览器判定已激活:', st.browserActive, ' 脚本记录手势:', st.gestureSeen);

  // 主动制造一次"被拦"：让媒体暂停，然后由脚本自动重试
  console.log('\n=== ② 制造拦截：暂停视频，观察脚本重试是否被策略拒绝 ===');
  await s.json(`(function(){ var v=document.querySelector('video'); if(v) v.pause(); return JSON.stringify({paused:v?v.paused:null}); })()`);
  await sleep(4000);
  st = await s.json(ST);
  console.log(' ', JSON.stringify(st));
  check('脚本在尝试恢复播放', st.playFail !== null, `playFailCount=${st.playFail}`);

  // 关键：派发一次真实滚轮手势
  console.log('\n=== ③ 派发一次真实滚轮手势（模拟你无意中的滚动）===');
  const before = st;
  await s.send('Input.dispatchMouseEvent', {
    type: 'mouseWheel', x: 400, y: 300, deltaX: 0, deltaY: 120, button: 'none', clickCount: 0,
  });
  let recovered = false, recoveredAt = 0;
  const t0 = Date.now();
  while (Date.now() - t0 < 12000) {
    const cur = await s.json(ST);
    if (cur.paused === false || cur.gestureSeen === true) {
      if (cur.paused === false) { recovered = true; recoveredAt = Date.now() - t0; break; }
    }
    await sleep(700);
  }
  const after = await s.json(ST);
  console.log(' ', JSON.stringify(after));
  check('滚轮手势被脚本记录', after.gestureSeen === true, `gestureSeen=${after.gestureSeen}`);
  check('视频已恢复播放', after.paused === false, recovered ? `手势后 ${recoveredAt}ms 恢复` : `paused=${after.paused}`);
  check('倍速仍为 2x', Math.abs(after.rate - 2) < 0.01, `rate=${after.rate}`);

  console.log('\n=== ④ 相关日志 ===');
  s.console.filter((l) => /自动播放|手势|恢复|拦截|失败/.test(l)).slice(-10).forEach((l) => console.log('  ' + l));

  s.ws.close();
  console.log(`\n${fail === 0 ? '✅ 全部通过' : '❌ 存在失败项'}  通过 ${pass} / 失败 ${fail}`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('异常:', e && e.stack || e); process.exit(1); });

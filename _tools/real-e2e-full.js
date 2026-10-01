#!/usr/bin/env node
/**
 * 完整链路验证（真实站点）：从课程目录页开始，看脚本能否
 *   ① 用接口拿到课程列表
 *   ② 直接跳 URL 进入视频页（不点卡片）
 *   ③ 自动开 2 倍速
 *   ④ 完成后自动跳下一节（连续多于 1 次）
 *
 *   node _tools/real-e2e-full.js [观察秒数]
 */
const CONFIG = require('./config');
const fs = require('fs');
const path = require('path');
const PORT = Number(process.env.CDP_PORT || 9222);
const CLASSROOM = CONFIG.classroom;
const DURATION = Number(process.argv[2] || 150);
const USERSCRIPT = path.join(__dirname, '..', 'dist', 'changjiang-yuketang-auto.user.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const check = (n, ok, d = '') => { ok ? pass++ : fail++; console.log(`${ok ? '  ✓' : '  ✗'} ${n}${d ? '  — ' + d : ''}`); };

class Session {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.console = []; }
  static async connect(u) {
    const ws = new WebSocket(u);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws fail')); });
    const s = new Session(ws);
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && s.pending.has(m.id)) {
        const { res, rej } = s.pending.get(m.id); s.pending.delete(m.id);
        m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
      } else if (m.method === 'Runtime.consoleAPICalled') {
        const txt = (m.params.args || []).map((a) => a.value ?? a.description ?? '').join(' ');
        if (/刷课助手/.test(txt)) {
          const clean = txt.replace(/%c/g, '').replace(/color:#2563eb/, '').trim();
          s.console.push(clean);
        }
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
  async eval(expr) {
    try {
      const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, userGesture: true });
      if (r.exceptionDetails) return { error: r.exceptionDetails.exception?.description || 'err' };
      return { value: r.result.value };
    } catch (e) { return { error: e.message }; }
  }
}

const STATE = `JSON.stringify({
  path: location.pathname,
  leaf: (function(){ var m = location.pathname.match(/\\/video\\/(\\d+)/); return m ? m[1] : null })(),
  isLog: /studentLog/.test(location.pathname),
  panel: !!document.getElementById('ykt-tool-host'),
  video: (function(){ var v=document.querySelector('video');
    return v?{t:+v.currentTime.toFixed(1), dur:isFinite(v.duration)?Math.round(v.duration):null, rate:v.playbackRate, paused:v.paused}:null })(),
  speedUi: (function(){ var e=document.querySelector('.xt_video_player_common_value, xt-speedvalue'); return e?(e.innerText||'').trim():null })(),
  rateDetail: (function(){ var e=document.querySelector('.rate-detail .text'); return e?(e.innerText||'').trim():null })(),
})`;

(async () => {
  const list = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).filter((t) => t.type === 'page');
  const ctl = await Session.connect(list[0].webSocketDebuggerUrl);
  await ctl.send('Page.enable');
  const nt = await ctl.send('Target.createTarget', { url: 'about:blank' });
  ctl.ws.close();
  await sleep(1500);
  const fresh = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json())
    .filter((t) => t.type === 'page').find((p) => p.id === nt.targetId);
  const s = await Session.connect(fresh.webSocketDebuggerUrl);
  await s.send('Page.enable'); await s.send('Runtime.enable');
  try { await s.send('Page.bringToFront'); } catch (e) { }

  await s.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `try {
      localStorage.setItem('ykt_tool:autoStart','true');
      localStorage.setItem('ykt_tool:autoNext','true');
      localStorage.setItem('ykt_tool:rate','2');
      sessionStorage.removeItem('ykt_tool:stuck');
    } catch(e){}`,
  });
  await s.send('Page.addScriptToEvaluateOnNewDocument', { source: fs.readFileSync(USERSCRIPT, 'utf8') });

  console.log('从课程目录页开始（完整链路）…\n');
  await s.send('Page.navigate', { url: `${CONFIG.origin}/v2/web/studentLog/${CLASSROOM}` });
  await sleep(15000);

  let st = JSON.parse((await s.eval(STATE)).value);
  check('脚本在目录页已注入', st.panel === true);

  // 等它自动进入视频页
  console.log('\n=== 观察脚本自动选节 + 跳转 + 倍速（最多 ' + DURATION + ' 秒）===');
  const t0 = Date.now();
  const visited = [];
  const leavesSeen = new Set();
  let apiGotList = false;
  let lastTag = '';

  while (Date.now() - t0 < DURATION * 1000) {
    const cur = JSON.parse((await s.eval(STATE)).value);
    if (cur.leaf && !leavesSeen.has(cur.leaf)) {
      leavesSeen.add(cur.leaf);
      visited.push({ leaf: cur.leaf, at: ((Date.now() - t0) / 1000).toFixed(0) });
    }
    if (!apiGotList && s.console.some((l) => /课程列表获取完成/.test(l))) apiGotList = true;
    const tag = `${cur.isLog ? '目录页' : 'leaf=' + cur.leaf} rate=${cur.video ? cur.video.rate : '-'} 界面=${cur.speedUi} t=${cur.video ? cur.video.t + '/' + cur.video.dur : '-'} 标记=${cur.rateDetail}`;
    if (tag !== lastTag) { console.log(`  [${((Date.now() - t0) / 1000).toFixed(0).padStart(3)}s] ${tag}`); lastTag = tag; }
    if (leavesSeen.size >= 3) break;
    await sleep(3000);
  }

  const fin = JSON.parse((await s.eval(STATE)).value);
  console.log('\n=== 结果 ===');
  console.log('  经过的小节:', JSON.stringify(visited));
  console.log('  最终状态:', JSON.stringify(fin));

  check('脚本通过接口拿到了课程列表', apiGotList, s.console.filter((l) => /课程列表/.test(l)).slice(0, 2).join(' | '));
  check('自动从目录页进入了视频页（未点击卡片）', leavesSeen.size >= 1 && !fin.isLog, `进入 ${leavesSeen.size} 节`);
  check('自动设置了 2 倍速', Math.abs(Number(fin.video && fin.video.rate) - 2) < 0.01 || /2(\.0+)?X/.test(fin.speedUi || ''),
    `rate=${fin.video && fin.video.rate} 界面=${fin.speedUi}`);
  check('连续自动跳转（经过 >= 2 个小节）', leavesSeen.size >= 2, `经过 ${leavesSeen.size} 节`);

  console.log('\n=== 控制台 [刷课助手] 日志 ===');
  s.console.slice(-30).forEach((l) => console.log('  ' + l.slice(0, 145)));

  s.ws.close();
  console.log(`\n${fail === 0 ? '✅ 全部通过' : '❌ 存在失败项'}  通过 ${pass} / 失败 ${fail}`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('异常:', e && e.stack || e); process.exit(1); });

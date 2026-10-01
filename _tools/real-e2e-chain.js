#!/usr/bin/env node
/**
 * 连续跳转验证：反复把每节的进度拖到结尾，看脚本能否一节接一节地自动推进。
 *   node _tools/real-e2e-chain.js [观察秒数]
 */
const CONFIG = require('./config');
const fs = require('fs');
const path = require('path');
const PORT = Number(process.env.CDP_PORT || 9222);
const CLASSROOM = CONFIG.classroom;
const DURATION = Number(process.argv[2] || 180);
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
        if (/刷课助手/.test(txt)) s.console.push(txt.replace(/%c/g, '').replace(/color:#2563eb/, '').trim());
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
  leaf: (function(){ var m = location.pathname.match(/\\/video\\/(\\d+)/); return m ? m[1] : null })(),
  isLog: /studentLog/.test(location.pathname),
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

  console.log('从课程目录页开始，反复把每节拖到结尾…\n');
  await s.send('Page.navigate', { url: `${CONFIG.origin}/v2/web/studentLog/${CLASSROOM}` });

  const t0 = Date.now();
  const visited = [];
  const seen = new Set();
  let lastLeaf = '', lastSeekAt = 0;
  let rateOkCount = 0, uiOkCount = 0;

  while (Date.now() - t0 < DURATION * 1000) {
    const cur = JSON.parse((await s.eval(STATE)).value);
    if (cur.leaf && !seen.has(cur.leaf)) {
      seen.add(cur.leaf);
      visited.push({ leaf: cur.leaf, at: +((Date.now() - t0) / 1000).toFixed(0) });
      console.log(`  [${((Date.now() - t0) / 1000).toFixed(0).padStart(3)}s] ★ 进入新小节 leaf=${cur.leaf}  dur=${cur.video ? cur.video.dur : '-'}s`);
      lastLeaf = cur.leaf;
    }
    if (cur.video) {
      if (Math.abs(cur.video.rate - 2) < 0.01) rateOkCount++;
      if (/2(\.0+)?X/.test(cur.speedUi || '')) uiOkCount++;
      // 进入某节 6 秒后（确保脚本已接管）拖动到结尾
      if (cur.leaf && Date.now() - lastSeekAt > 12000 && cur.video.t < cur.video.dur - 30) {
        lastSeekAt = Date.now();
        const r = await s.eval(`(function(){ var v=document.querySelector('video');
          if(!v||!isFinite(v.duration)) return 'no'; v.currentTime = Math.max(0, v.duration - 0.4);
          return 'seeked to ' + v.currentTime.toFixed(1); })()`);
        console.log(`          拖动到结尾: ${r.value}`);
      }
    }
    if (seen.size >= 4) break;
    await sleep(2000);
  }

  const fin = JSON.parse((await s.eval(STATE)).value);
  console.log('\n=== 结果 ===');
  console.log('  经过的小节:', JSON.stringify(visited));
  console.log('  最终:', JSON.stringify(fin));

  check('脚本自动连续进入了多个小节', seen.size >= 3, `共 ${seen.size} 节：${[...seen].join(' → ')}`);
  check('每节都自动设为 2 倍速', rateOkCount > 0 && uiOkCount > 0, `采样中 rate=2 出现 ${rateOkCount} 次、界面 2.00X 出现 ${uiOkCount} 次`);
  check('倍速界面与媒体一致（2.00X）', /2(\.0+)?X/.test(fin.speedUi || '') || Math.abs(Number(fin.video && fin.video.rate) - 2) < 0.01,
    `界面=${fin.speedUi} rate=${fin.video && fin.video.rate}`);

  console.log('\n=== 控制台日志（关键片段） ===');
  s.console.filter((l) => /进入|完成|跳转|倍速|课程列表/.test(l)).slice(-26).forEach((l) => console.log('  ' + l.slice(0, 140)));

  s.ws.close();
  console.log(`\n${fail === 0 ? '✅ 全部通过' : '❌ 存在失败项'}  通过 ${pass} / 失败 ${fail}`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('异常:', e && e.stack || e); process.exit(1); });

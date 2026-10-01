#!/usr/bin/env node
/**
 * 拖进度条测试（真实站点）：
 *   1) 用课程活动接口拿到未完成小节的 leaf_id（绕开点不动的课程卡片）
 *   2) 直接打开该视频页，注入脚本（自动跳转开启、倍速桥关闭）
 *   3) 把播放进度拖到结尾，观察脚本能否据此判定完成并自动跳到下一节
 *
 *   node _tools/real-seek-advance.js
 */
const CONFIG = require('./config');
const fs = require('fs');
const path = require('path');
const PORT = Number(process.env.CDP_PORT || 9222);
const CLASSROOM = CONFIG.classroom;
const USERSCRIPT = path.join(__dirname, '..', 'dist', 'changjiang-yuketang-auto.user.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const check = (n, ok, d = '') => { ok ? pass++ : fail++; console.log(`${ok ? '  ✓' : '  ✗'} ${n}${d ? '  — ' + d : ''}`); };

class Session {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.events = []; }
  static async connect(u) {
    const ws = new WebSocket(u);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws fail')); });
    const s = new Session(ws);
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && s.pending.has(m.id)) {
        const { res, rej } = s.pending.get(m.id); s.pending.delete(m.id);
        m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
      } else if (m.method) { s.events.push(m); }
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
  async eval(expr, aw = false) {
    try {
      const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: aw, userGesture: true });
      if (r.exceptionDetails) return { error: r.exceptionDetails.exception?.description || 'err' };
      return { value: r.result.value };
    } catch (e) { return { error: e.message }; }
  }
}

const STATE = `JSON.stringify({
  url: location.pathname,
  leaf: (function(){ var m = location.pathname.match(/\\/video\\/(\\d+)/); return m ? m[1] : null })(),
  hasTool: !!window.__yktTool,
  rateDetail: (function(){ var e=document.querySelector('.rate-detail .text'); return e?(e.innerText||'').trim():null })(),
  video: (function(){ var v=document.querySelector('video');
    return v?{ t:+v.currentTime.toFixed(1), dur:isFinite(v.duration)?Math.round(v.duration):null, paused:v.paused, rate:v.playbackRate, ended:v.ended }:null })(),
  tool: window.__yktTool ? { running: window.__yktTool.state.running, phase: window.__yktTool.state.phase,
    done: window.__yktTool.state.doneReason, prog: window.__yktTool.state.progress, streak: window.__yktTool.state.sameLeafStreak } : null,
})`;

(async () => {
  const pages = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).filter((t) => t.type === 'page');
  let target = pages.find((p) => /yuketang/i.test(p.url));
  if (!target) target = pages.find((p) => p.url === 'about:blank') || pages[0];

  // 用一个干净标签页，避免历史注入叠加
  const tmp = await Session.connect(target.webSocketDebuggerUrl);
  await tmp.send('Page.enable');
  const nt = await tmp.send('Target.createTarget', { url: 'about:blank' });
  tmp.ws.close();
  const fresh = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json())
    .filter((t) => t.type === 'page').find((p) => p.id === nt.targetId);
  const s = await Session.connect(fresh.webSocketDebuggerUrl);
  await s.send('Page.enable'); await s.send('Runtime.enable');
  try { await s.send('Page.bringToFront'); } catch (e) { }

  // ① 先到课程页，用活动接口拿未完成小节
  console.log('=== 步骤1：用活动接口找未完成小节 ===');
  await s.send('Page.navigate', { url: `https://changjiang.yuketang.cn/v2/web/studentLog/${CLASSROOM}` });
  await sleep(14000);

  const listRes = await s.eval(`(async function(){
    var out = [];
    for (var page = 0; page < 40; page++) {
      var res = await fetch('/v2/api/web/logs/learn/${CLASSROOM}?actype=-1&page=' + page + '&offset=20&sort=-1', { credentials: 'include' });
      var j = await res.json();
      var d = j.data || {};
      (d.activities || []).forEach(function(a){
        var c = a.content || {};
        if (c.leaf_id) out.push({ leaf: c.leaf_id, type: a.type, title: a.title });
      });
      if (!d.has_more) break;
    }
    return JSON.stringify(out);
  })()`, true);
  let acts = [];
  try { acts = JSON.parse(listRes.value || '[]'); } catch (e) { }
  console.log(`  取到 ${acts.length} 个带 leaf_id 的小节`);
  if (!acts.length) { console.log('  ✗ 拿不到小节列表，终止'); s.ws.close(); process.exit(1); }

  // 选一个未完成/未开始的视频小节做测试：
  //   优先用 --leaf 指定（或 config 里的 leaf），其次用第一个视频小节
  const pick = (CONFIG.leaf && acts.find((a) => String(a.leaf) === String(CONFIG.leaf)))
    || acts.find((a) => Number(a.type) === 17)
    || acts[0];
  const target1 = pick;
  const next1 = acts[acts.findIndex((a) => a.leaf === target1.leaf) + 1];
  console.log(`  选定测试小节: leaf=${target1.leaf} type=${target1.type} «${target1.title}»`);
  if (next1) console.log(`  它的下一节: leaf=${next1.leaf} «${next1.title}»`);

  // ② 注入脚本（自动跳转开、倍速桥关），打开视频页
  console.log('\n=== 步骤2：打开视频页并注入脚本 ===');
  await s.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `try {
      localStorage.setItem('ykt_tool:autoStart', 'true');
      localStorage.setItem('ykt_tool:autoNext', 'true');
      localStorage.setItem('ykt_tool:speedBridge', 'false');
    } catch(e){}`,
  });
  await s.send('Page.addScriptToEvaluateOnNewDocument', { source: fs.readFileSync(USERSCRIPT, 'utf8') });

  const videoUrl = `https://changjiang.yuketang.cn/ai-workspace/lms-graph/${CLASSROOM}/video/${target1.leaf}?is_chapter=1`;
  console.log('  ', videoUrl);
  await s.send('Page.navigate', { url: videoUrl });
  await sleep(12000);

  let st = JSON.parse((await s.eval(STATE)).value);
  console.log('  进入后:', JSON.stringify(st));
  check('视频页已加载且有 video 元素', !!st.video, `leaf=${st.leaf}`);
  check('脚本已注入', st.hasTool === true);

  // ③ 拖进度条到结尾
  console.log('\n=== 步骤3：把进度条拖到结尾 ===');
  const seek = await s.eval(`(function(){
    var v = document.querySelector('video');
    if (!v) return 'no video';
    if (!isFinite(v.duration) || v.duration <= 0) return 'no duration';
    var before = v.currentTime;
    v.currentTime = Math.max(0, v.duration - 0.5);
    return JSON.stringify({ before: +before.toFixed(1), after: +v.currentTime.toFixed(1), dur: Math.round(v.duration) });
  })()`);
  console.log('  拖动结果:', seek.value);
  check('进度条已拖到结尾', !/no video|no duration/.test(String(seek.value)));

  // ④ 观察脚本反应
  console.log('\n=== 步骤4：观察脚本是否据此完成并跳转（最多 60 秒）===');
  const t0 = Date.now();
  let lastTag = '';
  let jumped = false;
  while (Date.now() - t0 < 60000) {
    const cur = JSON.parse((await s.eval(STATE)).value);
    const tag = `leaf=${cur.leaf} rate=${cur.video ? cur.video.rate : '-'} t=${cur.video ? cur.video.t : '-'}/${cur.video ? cur.video.dur : '-'} 站点标记=${cur.rateDetail} 脚本=${cur.tool ? cur.tool.phase + '/' + cur.tool.prog + '%/' + (cur.tool.done || '-') : '-'}`;
    if (tag !== lastTag) { console.log(`  [${((Date.now() - t0) / 1000).toFixed(0)}s] ${tag}`); lastTag = tag; }
    if (cur.leaf && cur.leaf !== String(target1.leaf)) { jumped = true; break; }
    await sleep(2000);
  }

  const fin = JSON.parse((await s.eval(STATE)).value);
  console.log('\n  最终:', JSON.stringify(fin));
  check('拖到结尾后脚本判定本节完成', !!(fin.tool && fin.tool.done) || jumped,
    `done=${fin.tool && fin.tool.done}`);
  check('已自动跳到下一节', jumped, `当前 leaf=${fin.leaf}（原 ${target1.leaf}${next1 ? '，期望下一节 ' + next1.leaf : ''}）`);

  s.ws.close();
  console.log(`\n${fail === 0 ? '✅ 全部通过' : '❌ 存在失败项'}  通过 ${pass} / 失败 ${fail}`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('异常:', e && e.stack || e); process.exit(1); });

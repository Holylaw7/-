#!/usr/bin/env node
/**
 * 真实站点功能验证（不依赖篡改猴，用 CDP 注入最新构建）：
 *   ① 面板是否出现
 *   ② 倍速能否被设成 2x（脚本自己点播放器菜单）
 *   ③ 拖进度条到结尾 → 是否判定完成并自动跳转下一节
 *   ④ 后台守卫自检
 *
 *   node _tools/real-verify-all.js [leafId]
 */
const CONFIG = require('./config');
const fs = require('fs');
const path = require('path');
const PORT = Number(process.env.CDP_PORT || 9222);
const CLASSROOM = CONFIG.classroom;
const LEAF = process.argv[2] || `${LEAF}`;
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
  path: location.pathname,
  leaf: (function(){ var m = location.pathname.match(/\\/video\\/(\\d+)/); return m ? m[1] : null })(),
  panel: !!document.getElementById('ykt-tool-host'),
  video: (function(){ var v=document.querySelector('video');
    return v?{t:+v.currentTime.toFixed(1), dur:isFinite(v.duration)?Math.round(v.duration):null, rate:v.playbackRate, paused:v.paused}:null })(),
  speedUi: (function(){ var e=document.querySelector('.xt_video_player_common_value, xt-speedvalue'); return e?(e.innerText||'').trim():null })(),
  rateDetail: (function(){ var e=document.querySelector('.rate-detail .text'); return e?(e.innerText||'').trim():null })(),
  optValue: (function(){ var r=document.querySelector('.xt_video_player_container, .xtplayer, .video-box');
    var p=r&&r.__vue__&&r.__vue__.$data.player; return (p&&p.options&&p.options.speed)?p.options.speed.value:null })(),
  panelLog: (function(){ var h=document.getElementById('ykt-tool-host'); if(!h||!h.shadowRoot) return null;
    var l=h.shadowRoot.getElementById('log'); return l?(l.innerText||'').split('\\n').filter(Boolean).slice(-8):null })(),
  guard: (function(){ var h=document.getElementById('ykt-tool-host'); if(!h||!h.shadowRoot) return null;
    var g=h.shadowRoot.getElementById('s-guard'); return g?(g.innerText||'').trim():null })(),
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

  const src = fs.readFileSync(USERSCRIPT, 'utf8');
  console.log(`注入最新构建 ${(src.length / 1024).toFixed(1)} KB\n`);
  await s.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `try {
      localStorage.setItem('ykt_tool:autoStart','true');
      localStorage.setItem('ykt_tool:autoNext','true');
      localStorage.setItem('ykt_tool:rate','2');
      localStorage.removeItem('ykt_tool:speedBridge');
    } catch(e){}`,
  });
  await s.send('Page.addScriptToEvaluateOnNewDocument', { source: src });

  const url = `${CONFIG.origin}/ai-workspace/lms-graph/${CLASSROOM}/video/${LEAF}?is_chapter=1`;
  console.log('打开:', url.slice(0, 90));
  await s.send('Page.navigate', { url });
  await sleep(14000);

  let st = JSON.parse((await s.eval(STATE)).value);
  console.log('\n=== ① 注入与面板 ===');
  check('控制面板已出现', st.panel === true);
  check('面板有守卫状态', !!st.guard, `guard=${st.guard}`);
  check('视频元素已加载', !!st.video, `t=${st.video && st.video.t}/${st.video && st.video.dur}`);

  console.log('\n=== ② 倍速设置（脚本自己点播放器菜单）===');
  console.log('  起始: rate=' + (st.video && st.video.rate) + '  界面=' + st.speedUi + '  站点内部值=' + st.optValue);
  let rateOk = false, uiOk = false;
  for (let i = 0; i < 12; i++) {
    await sleep(2500);
    st = JSON.parse((await s.eval(STATE)).value);
    if (st.video && Math.abs(st.video.rate - 2) < 0.01) { rateOk = true; }
    if (st.speedUi && /2(\.0+)?X/i.test(st.speedUi)) { uiOk = true; }
    if (rateOk && uiOk) break;
  }
  console.log('  结果: rate=' + (st.video && st.video.rate) + '  界面=' + st.speedUi + '  站点内部值=' + st.optValue);
  check('media.playbackRate = 2（真的 2 倍速）', rateOk, `rate=${st.video && st.video.rate}`);
  check('播放器界面显示 2.00X（走站点自己的逻辑）', uiOk, `界面=${st.speedUi}`);
  check('站点内部倍速值 = 2', Number(st.optValue) === 2, `内部值=${st.optValue}`);

  console.log('\n=== ③ 拖进度条到结尾 → 完成判定 + 自动跳转 ===');
  const beforeLeaf = st.leaf;
  const seek = await s.eval(`(function(){
    var v = document.querySelector('video');
    if (!v || !isFinite(v.duration)) return 'no video';
    v.currentTime = Math.max(0, v.duration - 0.5);
    return JSON.stringify({ t: +v.currentTime.toFixed(1), dur: Math.round(v.duration) });
  })()`);
  console.log('  拖动:', seek.value);

  let jumped = false, doneSeen = '';
  const t0 = Date.now();
  while (Date.now() - t0 < 70000) {
    const cur = JSON.parse((await s.eval(STATE)).value);
    if (cur.panelLog && cur.panelLog.join(' ').indexOf('本节完成') >= 0) doneSeen = '本节完成';
    if (cur.leaf && cur.leaf !== beforeLeaf) { jumped = true; console.log(`  已跳转: ${beforeLeaf} → ${cur.leaf}`); break; }
    await sleep(2500);
  }
  const fin = JSON.parse((await s.eval(STATE)).value);
  check('拖到结尾后脚本判定本节完成', !!doneSeen || jumped, doneSeen || `跳到 ${fin.leaf}`);
  check('自动跳转到下一节', jumped, `${beforeLeaf} → ${fin.leaf}`);

  console.log('\n=== ④ 面板日志 ===');
  (fin.panelLog || []).forEach((l) => console.log('  ' + l));

  console.log('\n=== 控制台 [刷课助手] 日志 ===');
  s.console.slice(-12).forEach((l) => console.log('  ' + l.slice(0, 140)));

  s.ws.close();
  console.log(`\n${fail === 0 ? '✅ 全部通过' : '❌ 存在失败项'}  通过 ${pass} / 失败 ${fail}`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('异常:', e && e.stack || e); process.exit(1); });

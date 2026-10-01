#!/usr/bin/env node
/**
 * 真实站点注入测试：把用户脚本通过 CDP 直接注入到你自己已登录的真实页面，
 * 完全绕过篡改猴，用来验证脚本在真站 DOM 上到底能不能工作。
 *
 *   node _tools/real-inject-test.js                 # 用当前打开的雨课堂页面
 *   node _tools/real-inject-test.js --url <URL>     # 指定页面
 *
 * 会做的事：重新加载页面并在 document-start 注入脚本，然后观察：
 *   面板 / 2 倍速 / 静音 / 自动播放 / 完成判定依据 / 守卫自检 / 进度识别
 */
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.CDP_PORT || 9222);
const USERSCRIPT = path.join(__dirname, '..', 'dist', 'changjiang-yuketang-auto.user.js');
const argUrl = (() => { const i = process.argv.indexOf('--url'); return i >= 0 ? process.argv[i + 1] : null; })();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Session {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); }
  static async connect(u) {
    const ws = new WebSocket(u);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws fail')); });
    const s = new Session(ws);
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && s.pending.has(m.id)) {
        const { res, rej } = s.pending.get(m.id); s.pending.delete(m.id);
        m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
      }
    };
    return s;
  }
  send(method, params = {}, t = 60000) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error('timeout ' + method)); } }, t);
    });
  }
  async eval(expr, aw = false) {
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: aw, userGesture: true });
    if (r.exceptionDetails) return { error: r.exceptionDetails.exception?.description || 'err' };
    return { value: r.result.value };
  }
}

const SNAP = `JSON.stringify(window.__yktTool ? {
  url: location.href,
  version: window.__yktTool.state.version,
  running: window.__yktTool.state.running,
  phase: window.__yktTool.state.phase,
  doneReason: window.__yktTool.state.doneReason,
  mediaTag: window.__yktTool.state.mediaTag,
  rate: window.__yktTool.state.rate,
  paused: window.__yktTool.state.paused,
  muted: window.__yktTool.state.muted,
  t: window.__yktTool.state.currentTime,
  dur: window.__yktTool.state.duration,
  rs: window.__yktTool.state.readyState,
  err: window.__yktTool.state.error,
  progressText: window.__yktTool.state.progress,
  playFail: window.__yktTool.state.playFailCount,
  rateStats: window.__yktTool.state.rateStats,
  guard: window.__yktTool.state.guard,
} : { noTool: true, url: location.href, panel: !!document.getElementById('ykt-tool-host') })`;

const DETAIL = `JSON.stringify({
  progressTextSel: (function(){
    var sels = ['.rate-detail .text', '.rate-detail', '.nav-progress .progress-num', '.progress-wrap .text'];
    var out = {};
    sels.forEach(function(s){ var el=document.querySelector(s); out[s]= el ? (el.innerText||'').replace(/\\s+/g,' ').trim() : null; });
    return out;
  })(),
  nextBtn: (function(){
    var b = document.querySelector('.nav-footer .nav-next, .nav-next');
    return b ? { text:(b.innerText||'').replace(/\\s+/g,' ').trim(), disabled:b.classList.contains('is-disabled') } : null;
  })(),
  speedMenuItems: [].slice.call(document.querySelectorAll('xt-speedlist li, xt-speedlist xt-button')).map(function(b){
    return { text:(b.innerText||'').trim(), speed:b.getAttribute('data-speed') };
  }),
  readProgressWouldBe: window.__yktTool ? window.__yktTool.state.progress : null,
  mediaCount: document.querySelectorAll('video,audio').length,
  videoIds: [].slice.call(document.querySelectorAll('video')).map(function(v){return v.id}),
})`;

(async () => {
  if (!fs.existsSync(USERSCRIPT)) { console.error('缺少产物，先 node build.js'); process.exit(1); }
  const src = fs.readFileSync(USERSCRIPT, 'utf8');
  console.log(`脚本 ${(src.length / 1024).toFixed(1)} KB`);

  const pages = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).filter((t) => t.type === 'page');
  let target = pages.find((p) => /yuketang/i.test(p.url));
  if (!target) target = pages.find((p) => p.url === 'about:blank') || pages[0];
  if (!target) { console.error('没有可用标签页'); process.exit(1); }

  const url = argUrl || target.url;
  console.log(`目标页面: ${url}`);

  const s = await Session.connect(target.webSocketDebuggerUrl);
  await s.send('Page.enable');
  await s.send('Runtime.enable');

  // 收集控制台里 [刷课助手] 的日志
  const logs = [];
  s.ws.addEventListener('message', (ev) => {
    try {
      const m = JSON.parse(ev.data);
      if (m.method === 'Runtime.consoleAPICalled') {
        const txt = (m.params.args || []).map((a) => a.value ?? a.description ?? '').join(' ');
        if (/刷课助手/.test(txt)) logs.push(txt);
      }
    } catch (e) { }
  });

  // 注入脚本（document-start）
  await s.send('Page.addScriptToEvaluateOnNewDocument', { source: src });
  console.log('已注册 document-start 注入，开始加载页面…');
  await s.send('Page.navigate', { url });
  await sleep(10000);

  const snap = await s.eval(SNAP);
  const d = JSON.parse(snap.value);
  console.log('\n' + '='.repeat(76));
  console.log('注入后脚本状态');
  console.log('='.repeat(76));
  if (d.noTool) {
    console.log('✗ __yktTool 不存在！脚本没有跑起来');
    console.log(`   URL=${d.url}  面板=${d.panel}`);
    console.log('   控制台日志:', logs.length ? logs : '（没有 [刷课助手] 日志）');
    s.ws.close();
    process.exit(1);
  }
  console.log(`URL          : ${d.url}`);
  console.log(`版本         : ${d.version}`);
  console.log(`控制面板     : ${(await s.eval(`!!document.getElementById('ykt-tool-host')`)).value ? '✓ 已出现' : '✗ 未出现'}`);
  console.log(`running/phase: ${d.running} / ${d.phase}`);
  console.log(`完成判定依据 : ${d.doneReason || '（尚未判定完成）'}`);
  console.log(`媒体         : ${d.mediaTag}  paused=${d.paused} rate=${d.rate} muted=${d.muted}`);
  console.log(`播放位置     : ${d.t} / ${d.dur}  readyState=${d.rs}  err=${JSON.stringify(d.err)}`);
  console.log(`进度读数     : ${d.progressText}%`);
  console.log(`播放失败次数 : ${d.playFail}`);
  console.log(`倍速统计     : ${JSON.stringify(d.rateStats)}`);
  console.log(`守卫         : active=${d.guard.active} 拦截事件=${d.guard.blockedEvents} 拦截pause=${d.guard.blockedPause}`);
  console.log(`拦截自检     : ${JSON.stringify(d.guard.selfTest)}`);
  console.log(`站点监听     : ${JSON.stringify(d.guard.seenEvents)}`);
  console.log(`守卫备注     : ${JSON.stringify((d.guard.notes || []).slice(-4))}`);

  const det = JSON.parse((await s.eval(DETAIL)).value);
  console.log('\n' + '='.repeat(76));
  console.log('真实 DOM 选择器核对');
  console.log('='.repeat(76));
  console.log('进度相关选择器实际取值:', JSON.stringify(det.progressTextSel, null, 2));
  console.log('下一节按钮:', JSON.stringify(det.nextBtn));
  console.log('倍速菜单项:', JSON.stringify(det.speedMenuItems));
  console.log('video 元素 id:', JSON.stringify(det.videoIds));

  console.log('\n' + '='.repeat(76));
  console.log('控制台日志（[刷课助手]）');
  console.log('='.repeat(76));
  logs.slice(-25).forEach((l) => console.log('  ' + l));

  console.log('\n观察 12 秒，看倍速与播放是否稳定…');
  await sleep(12000);
  const snap2 = JSON.parse((await s.eval(SNAP)).value);
  console.log(`  现在: rate=${snap2.rate} paused=${snap2.paused} t=${snap2.t}/${snap2.dur} muted=${snap2.muted} 进度=${snap2.progressText}% 判定=${snap2.doneReason || '-'}`);
  console.log(`  倍速统计: ${JSON.stringify(snap2.rateStats)}`);

  s.ws.close();
  process.exit(0);
})().catch((e) => { console.error('异常:', e && e.stack || e); process.exit(1); });

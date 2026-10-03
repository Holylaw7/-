#!/usr/bin/env node
/**
 * 验证「控制台粘贴版」：把 dist/console-paste.js 当作用户在 DevTools 控制台粘贴的代码，
 * 在页面主世界执行，检查面板是否出现、2 倍速是否锁定、进度是否推进。
 *
 *   node _tools/verify-paste.js
 */
const CONFIG = require('./config');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9373;
const APP = CONFIG.mock.origin();
const PASTE = path.join(__dirname, '..', 'dist', 'console-paste.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (n, ok, d = '') => { ok ? pass++ : fail++; console.log(`${ok ? '  ✓' : '  ✗'} ${n}${d ? '  — ' + d : ''}`); };
const LEAF = CONFIG.leaf || process.argv[2] || String(CONFIG.mock.leafBase);

(async () => {
  await fetch(`${APP}/__reset`);
  const src = fs.readFileSync(PASTE, 'utf8');
  console.log(`粘贴版 ${(src.length / 1024).toFixed(1)} KB`);

  const browser = spawn(EDGE, [
    '--headless=new', `--remote-debugging-port=${PORT}`,
    '--user-data-dir=' + path.join(os.tmpdir(), 'ykt-paste-' + Date.now()),
    '--no-first-run', '--no-default-browser-check', '--disable-gpu',
    '--autoplay-policy=no-user-gesture-required', '--lang=zh-CN', 'about:blank',
  ], { stdio: 'ignore' });

  let ws;
  try {
    let target = null;
    for (let i = 0; i < 50 && !target; i++) {
      try { target = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((t) => t.type === 'page'); } catch (e) { }
      if (!target) await sleep(400);
    }
    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((r, j) => { ws.onopen = r; ws.onerror = () => j(new Error('ws')); });
    let id = 0; const pending = new Map();
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.j(new Error(JSON.stringify(m.error))) : p.r(m.result); }
    };
    const send = (method, params = {}, t = 90000) => new Promise((r, j) => {
      const i = ++id; pending.set(i, { r, j });
      ws.send(JSON.stringify({ id: i, method, params }));
      setTimeout(() => { if (pending.has(i)) { pending.delete(i); j(new Error('timeout ' + method)); } }, t);
    });
    const evalx = async (expr, aw = false) => {
      const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: aw, userGesture: true });
      if (r.exceptionDetails) return { error: r.exceptionDetails.exception?.description || 'eval error' };
      return { value: r.result.value };
    };

    await send('Page.enable'); await send('Runtime.enable');

    // 登录并进入视频页（不注入任何脚本）
    await send('Page.navigate', { url: `${APP}/web` });
    await sleep(1200);
    await evalx(`document.getElementById('btn-login') && document.getElementById('btn-login').click(), true`);
    await sleep(1800);
    await send('Page.navigate', { url: `${APP}/ai-workspace/lms-graph/${CONFIG.mock.classroom}/video/${LEAF}?is_chapter=1` });
    await sleep(1500);

    const before = await evalx(`JSON.stringify({ panel: !!document.getElementById('ykt-tool-host'), tool: !!window.__yktTool })`);
    console.log(`粘贴前: ${before.value}`);
    check('粘贴前面板尚不存在（干净基线）', JSON.parse(before.value).panel === false);

    // ==== 关键动作：完全模拟「在控制台粘贴脚本并回车」 ====
    console.log('模拟控制台粘贴执行…');
    const res = await evalx(src + '\n; "PASTED_OK"');
    check('粘贴执行无异常', res.value === 'PASTED_OK', res.error ? String(res.error).slice(0, 200) : '');
    await sleep(4000);

    const after = JSON.parse((await evalx(`JSON.stringify({
      panel: !!document.getElementById('ykt-tool-host'),
      tool: !!window.__yktTool,
      state: window.__yktTool ? {
        running: window.__yktTool.state.running,
        rate: window.__yktTool.state.rate,
        paused: window.__yktTool.state.paused,
        muted: window.__yktTool.state.muted,
        media: window.__yktTool.state.mediaTag,
        guard: window.__yktTool.state.guard,
      } : null,
    })`)).value);

    console.log(`粘贴后: ${JSON.stringify(after)}`);
    check('控制面板已出现', after.panel === true);
    check('诊断接口已就绪', after.tool === true);
    check('脚本自动开始运行', !!(after.state && after.state.running), `running=${after.state && after.state.running}`);
    check('2 倍速已锁定', !!(after.state && Math.abs(after.state.rate - 2) < 0.01), `rate=${after.state && after.state.rate}`);
    check('视频正在播放', !!(after.state && after.state.paused === false), `paused=${after.state && after.state.paused}`);
    check('后台守卫已生效', !!(after.state && after.state.guard && after.state.guard.active === true));
    const st = after.state && after.state.guard && after.state.guard.selfTest;
    check('事件拦截自检通过（切屏事件无法送达站点监听器）', !!(st && st.ok === true && st.rawDelivered === true && st.blockedDelivered === false),
      st ? `ok=${st.ok} 原生投递可达=${st.rawDelivered} 拦截后可达=${st.blockedDelivered}` : '未执行');

    // 等第一个视频刷完
    console.log('等待第一个视频刷完…');
    let done = false;
    for (let i = 0; i < 40; i++) {
      const st = await (await fetch(`${APP}/__state`)).json();
      if (st.leaves.find((l) => l.id === `${LEAF}`).done) { done = true; break; }
      await sleep(1000);
    }
    check('粘贴版能真正刷完一节（进度正常记账）', done);
    const st2 = await (await fetch(`${APP}/__state`)).json();
    check('未出现后台心跳（守卫有效）', st2.hiddenReports === 0, `hidden=${st2.hiddenReports}, visible=${st2.visibleReports}`);
  } catch (e) {
    console.error('异常:', e && e.stack || e);
    fail++;
  } finally {
    try { ws && ws.close(); } catch (e) { }
    try { browser.kill(); } catch (e) { }
  }
  console.log(`\n${fail === 0 ? '✅ 全部通过' : '❌ 存在失败项'}  通过 ${pass} / 失败 ${fail}`);
  process.exit(fail === 0 ? 0 : 1);
})();

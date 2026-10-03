#!/usr/bin/env node
/**
 * 单页聚焦诊断：只跑第一个视频页，观察「完成 -> 自动跳转」这一步到底发生了什么。
 *   node _tools/diag-advance.js
 */
const CONFIG = require('./config');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9367;
const APP = CONFIG.mock.origin();
const USERSCRIPT = path.join(__dirname, '..', 'dist', 'changjiang-yuketang-auto.user.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LEAF = CONFIG.leaf || process.argv[2] || String(CONFIG.mock.leafBase);

(async () => {
  await fetch(`${APP}/__reset`);
  const browser = spawn(EDGE, [
    '--headless=new', `--remote-debugging-port=${PORT}`,
    '--user-data-dir=' + path.join(os.tmpdir(), 'ykt-adv-' + Date.now()),
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
    let id = 0; const pending = new Map(); const navs = [];
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.j(new Error(JSON.stringify(m.error))) : p.r(m.result); }
      else if (m.method === 'Page.frameNavigated') navs.push(m.params.frame.url);
      else if (m.method === 'Page.javascriptDialogOpening') console.log('!! JS dialog:', JSON.stringify(m.params));
    };
    const send = (method, params = {}, t = 60000) => new Promise((r, j) => {
      const i = ++id; pending.set(i, { r, j });
      ws.send(JSON.stringify({ id: i, method, params }));
      setTimeout(() => { if (pending.has(i)) { pending.delete(i); j(new Error('timeout ' + method)); } }, t);
    });
    const evalx = async (expr, aw = false) => {
      const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: aw, userGesture: true });
      if (r.exceptionDetails) return 'EXC ' + (r.exceptionDetails.exception?.description || '');
      return r.result.value;
    };

    await send('Page.enable'); await send('Runtime.enable');
    await send('Page.addScriptToEvaluateOnNewDocument', { source: fs.readFileSync(USERSCRIPT, 'utf8') });

    await send('Page.navigate', { url: `${APP}/web` });
    await sleep(1200);
    await evalx(`document.getElementById('btn-login') && document.getElementById('btn-login').click(), true`);
    await sleep(1800);
    await send('Page.navigate', { url: `${APP}/ai-workspace/lms-graph/${CONFIG.mock.classroom}/video/${LEAF}?is_chapter=1` });

    for (let i = 0; i < 30; i++) {
      await sleep(2000);
      const snap = await evalx(`JSON.stringify({
        route: location.pathname,
        leafAttr: (function(){var b=document.querySelector('.video-box');return b?b.getAttribute('data-leaf-id'):null})(),
        nextAttr: (function(){var b=document.querySelector('.video-box');return b?b.getAttribute('data-next-leaf'):null})(),
        progressText: (function(){var p=document.querySelector('.progress-wrap .text');return p?p.textContent:null})(),
        media: (function(){var m=document.querySelector('video,audio');return m?{t:+m.currentTime.toFixed(2),paused:m.paused,rate:m.playbackRate,seeking:m.seeking}:null})(),
        tool: window.__yktTool ? { running: window.__yktTool.state.running, phase: window.__yktTool.state.phase, done: window.__yktTool.state.doneReason, prog: window.__yktTool.state.progress } : null,
        lastAuto: sessionStorage.getItem('ykt_tool:auto'),
        playerLog: (window.__playerLog||[]).slice(-6).map(function(x){return x[1]}),
      })`);
      console.log(`[${i * 2}s] ${snap}`);
      if (String(snap).includes(`/video/${LEAF}`)) { console.log('>>> 已跳转到第二节'); break; }
    }

    const st = await fetch(`${APP}/__state`).then((r) => r.json());
    console.log('\n服务端状态:', JSON.stringify(st.leaves.map((l) => ({ n: l.name.slice(0, 6), pct: l.pct, done: l.done }))));
    console.log('导航历史:', JSON.stringify(navs));
    console.log('页面日志:', await evalx(`JSON.stringify((window.__playerLog||[]).map(function(x){return x[1]}))`));
  } catch (e) {
    console.error('异常:', e && e.stack || e);
  } finally {
    try { ws && ws.close(); } catch (e) { }
    try { browser.kill(); } catch (e) { }
  }
  process.exit(0);
})();

#!/usr/bin/env node
/**
 * 快速校验仿真媒体在当前 Edge 构建里能否解码播放（µ-law WAV）。
 *   node _tools/check-media.js
 */
const { spawn } = require('child_process');
const os = require('os');
const path = require('path');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9351;
const APP = `http://127.0.0.1:${process.env.MOCK_PORT || 8099}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const browser = spawn(EDGE, [
    '--headless=new', `--remote-debugging-port=${PORT}`,
    '--user-data-dir=' + path.join(os.tmpdir(), 'ykt-media-' + Date.now()),
    '--no-first-run', '--no-default-browser-check', '--disable-gpu',
    '--autoplay-policy=no-user-gesture-required', 'about:blank',
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
    const send = (method, params = {}) => new Promise((r, j) => { const i = ++id; pending.set(i, { r, j }); ws.send(JSON.stringify({ id: i, method, params })); });
    const evalx = async (expr, aw = false) => {
      const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: aw, userGesture: true });
      return r.exceptionDetails ? 'EXC ' + (r.exceptionDetails.exception?.description || '') : r.result.value;
    };

    await send('Page.enable'); await send('Runtime.enable');
    await send('Page.navigate', { url: `${APP}/media/clip.wav` });
    await sleep(1500);
    console.log('HTTP 内容类型:', await evalx(`document.contentType`));

    await send('Page.navigate', { url: 'about:blank' });
    await sleep(500);
    const res = await evalx(`(async function(){
      var a = document.createElement('audio');
      a.src = ${JSON.stringify(APP + '/media/clip.wav')};
      a.muted = true;
      document.body.appendChild(a);
      var meta = await new Promise(function(res){
        a.addEventListener('loadedmetadata', function(){ res('metadata ok duration=' + a.duration) });
        a.addEventListener('error', function(){ res('ERROR code=' + (a.error && a.error.code)) });
        setTimeout(function(){ res('timeout') }, 6000);
      });
      var play = await (async function(){
        try { await a.play(); return 'play ok'; } catch (e) { return 'play fail ' + e.name + ': ' + e.message; }
      })();
      await new Promise(function(r){ setTimeout(r, 2000) });
      return meta + ' | ' + play + ' | t=' + a.currentTime.toFixed(2) + ' paused=' + a.paused + ' rs=' + a.readyState;
    })()`, true);
    console.log('解码/播放结果:', res);
  } catch (e) {
    console.error('异常:', e && e.stack || e);
  } finally {
    try { ws && ws.close(); } catch (e) { }
    try { browser.kill(); } catch (e) { }
  }
  process.exit(0);
})();

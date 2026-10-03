#!/usr/bin/env node
/**
 * 聚焦诊断：单个视频页的心跳记账是否正确。
 *   node _tools/diag-beats.js
 * 打印页面侧位置采样 与 服务端入账明细，定位「进度少算」的原因。
 */
const CONFIG = require('./config');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9361;
const APP = CONFIG.mock.origin();
const USERSCRIPT = path.join(__dirname, '..', 'dist', 'changjiang-yuketang-auto.user.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LEAF = CONFIG.leaf || process.argv[2] || String(CONFIG.mock.leafBase);

(async () => {
  await fetch(`${APP}/__reset`);
  const browser = spawn(EDGE, [
    '--headless=new', `--remote-debugging-port=${PORT}`,
    '--user-data-dir=' + path.join(os.tmpdir(), 'ykt-beats-' + Date.now()),
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

    // 注入用户脚本（否则仿真站点的自动播放会被浏览器拦截，心跳不会推进）
    const src = fs.readFileSync(USERSCRIPT, 'utf8');
    await send('Page.addScriptToEvaluateOnNewDocument', { source: src });

    await send('Page.navigate', { url: `${APP}/web` });
    await sleep(1200);
    await evalx(`document.getElementById('btn-login') && document.getElementById('btn-login').click(), true`);
    await sleep(1800);
    await send('Page.navigate', { url: `${APP}/ai-workspace/lms-graph/${CONFIG.mock.classroom}/video/${LEAF}?is_chapter=1` });
    await sleep(1000);

    // 每秒采样一次媒体位置
    await evalx(`
      window.__pos = [];
      setInterval(function(){
        var m = document.querySelector('video,audio');
        if (m) window.__pos.push([Math.round(performance.now()/100)/10, +m.currentTime.toFixed(3), m.paused?1:0, m.playbackRate]);
      }, 1000);
      true;
    `);

    console.log('等待 20 秒，让站点自身的心跳跑起来…');
    await sleep(20000);

    const pos = await evalx(`JSON.stringify(window.__pos || [])`);
    console.log('\n===== 页面侧位置采样 (t_s, currentTime, paused, rate) =====');
    try { JSON.parse(pos).forEach((r) => console.log('  ', r.join('\t'))); } catch (e) { console.log(pos); }

    const beats = await fetch(`${APP}/__beats?leaf_id=${LEAF}`).then((r) => r.json()).catch((e) => ({ error: String(e) }));
    console.log('\n===== 服务端入账明细 (t, hidden, reported, rate, credited, total) =====');
    if (Array.isArray(beats.beats)) {
      beats.beats.forEach((b) => console.log('  ', [new Date(b.t).toTimeString().slice(0, 8), b.isHidden, b.reported, b.rate, b.credited, b.total].join('\t')));
      console.log('  合计入账:', beats.total);
    } else {
      console.log(JSON.stringify(beats));
    }

    const st = await fetch(`${APP}/__state`).then((r) => r.json());
    const leaf = st.leaves.find((l) => l.id === `${LEAF}`);
    console.log(`\n小节状态: ${leaf.pct}%  累计=${leaf.seconds}s  done=${leaf.done}`);
    console.log('媒体真实信息:', await evalx(`(function(){var m=document.querySelector('video,audio');return m? JSON.stringify({duration:m.duration, currentTime:m.currentTime, rate:m.playbackRate, paused:m.paused, seeking:m.seeking, loop:m.loop, readyState:m.readyState}) : 'no media'})()`));
  } catch (e) {
    console.error('异常:', e && e.stack || e);
  } finally {
    try { ws && ws.close(); } catch (e) { }
    try { browser.kill(); } catch (e) { }
  }
  process.exit(0);
})();

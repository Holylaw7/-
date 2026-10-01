#!/usr/bin/env node
/**
 * 交互式诊断：加载脚本 -> 打印内部状态 -> 手动尝试 play() 看真实报错。
 *   node _tools/diag.js
 */
const CONFIG = require('./config');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9345;
const APP = `http://127.0.0.1:${process.env.MOCK_PORT || 8099}`;
const USERSCRIPT = path.join(__dirname, '..', 'dist', 'changjiang-yuketang-auto.user.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LEAF = CONFIG.leaf || process.argv[2] || CONFIG.PLACEHOLDER;

class Session {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); }
  static async connect(u) {
    const ws = new WebSocket(u);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws fail')); });
    const s = new Session(ws);
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && s.pending.has(m.id)) {
        const { res, rej } = s.pending.get(m.id);
        s.pending.delete(m.id);
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
  async eval(expr, awaitPromise = false) {
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise, userGesture: true });
    if (r.exceptionDetails) return 'EXC: ' + (r.exceptionDetails.exception?.description || JSON.stringify(r.exceptionDetails));
    return r.result.value;
  }
}

(async () => {
  const browser = spawn(EDGE, [
    '--headless=new', `--remote-debugging-port=${PORT}`,
    '--user-data-dir=' + path.join(os.tmpdir(), 'ykt-diag-' + Date.now()),
    '--no-first-run', '--no-default-browser-check', '--disable-gpu',
    '--autoplay-policy=no-user-gesture-required', '--lang=zh-CN', 'about:blank',
  ], { stdio: 'ignore' });

  let main;
  try {
    let target = null;
    for (let i = 0; i < 50 && !target; i++) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
        target = list.find((t) => t.type === 'page');
      } catch (e) { }
      if (!target) await sleep(400);
    }
    main = await Session.connect(target.webSocketDebuggerUrl);
    await main.send('Page.enable');
    await main.send('Runtime.enable');

    const src = fs.readFileSync(USERSCRIPT, 'utf8');
    await main.send('Page.addScriptToEvaluateOnNewDocument', { source: src });

    // 登录
    await main.send('Page.navigate', { url: `${APP}/web` });
    await sleep(1200);
    await main.eval(`document.getElementById('btn-login') && document.getElementById('btn-login').click(), true`);
    await sleep(2000);

    // 直接进第一个视频页
    await main.send('Page.navigate', { url: `${APP}/ai-workspace/lms-graph/${CONFIG.classroom}/video/${LEAF}?is_chapter=1` });
    await sleep(6000);

    console.log('\n===== 脚本内部状态 =====');
    console.log(JSON.stringify(await main.eval(`window.__yktTool ? window.__yktTool.state : 'NO TOOL'`), null, 2));

    console.log('\n===== 浏览器层面自动播放能力 =====');
    console.log('autoplay allowed:', await main.eval(`(function(){try{var v=document.createElement('video');return 'canPlayType='+v.canPlayType('audio/wav')}catch(e){return 'err'}})()`));

    console.log('\n===== 手动 play() 的真实结果 =====');
    const playRes = await main.eval(`(async function(){
      var m = document.querySelector('video,audio');
      if (!m) return 'no media';
      m.muted = true;
      try { await m.play(); return 'play() OK paused=' + m.paused; }
      catch (e) { return 'play() REJECTED: ' + e.name + ' / ' + e.message; }
    })()`, true);
    console.log(playRes);
    await sleep(2500);
    console.log('播放 2.5s 后:', await main.eval(`(function(){var m=document.querySelector('video,audio');return JSON.stringify({paused:m.paused,t:m.currentTime,rs:m.readyState,ns:m.networkState,err:m.error?m.error.code:null})})()`));

    console.log('\n===== 站点自身是否在阻止播放 =====');
    console.log(await main.eval(`JSON.stringify({ antiCheatEvents: (window.__mock && window.__mock.events || []).slice(-12), hasFocus: document.hasFocus(), hidden: document.hidden, vis: document.visibilityState })`));

    console.log('\n===== 再等 5s（脚本自己的保活循环应续播）=====');
    await sleep(5000);
    console.log(JSON.stringify(await main.eval(`window.__yktTool.state`), null, 2));
  } catch (e) {
    console.error('异常:', e && e.stack || e);
  } finally {
    try { main && main.ws.close(); } catch (e) { }
    try { browser.kill(); } catch (e) { }
  }
  process.exit(0);
})();

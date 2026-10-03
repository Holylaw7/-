#!/usr/bin/env node
/**
 * 重启调试窗口（让篡改猴重新读取脚本源码），然后打开视频页验证新脚本已生效。
 *   node _tools/restart-and-test.js [leafId]
 */
const CONFIG = require('./config');
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const EDGE = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].find((p) => fs.existsSync(p));
const PROJECT_ROOT = path.join(__dirname, '..');
const MIRROR = process.env.YKT_MIRROR_DIR || path.join(PROJECT_ROOT, '_edge-debug-profile');
const TM_EXT = path.join(MIRROR, 'Default', 'Extensions', 'iikmkjmpaadaobahmlepeloendndfphd', '5.5.0_0');
const PORT = 9222;
const CLASSROOM = CONFIG.classroom;
const LEAF = process.argv[2] || `${LEAF}`;
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

(async () => {
  if (!fs.existsSync(TM_EXT)) { console.error('找不到篡改猴解包目录:', TM_EXT); process.exit(1); }

  console.log('关闭调试窗口…');
  try { execSync('powershell -NoProfile -Command "Get-Process msedge -ErrorAction SilentlyContinue | Stop-Process -Force"', { stdio: 'inherit' }); } catch (e) { }
  await sleep(3500);

  console.log('重新启动（带篡改猴 + 调试端口）…');
  const child = spawn(EDGE, [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${MIRROR}`,
    '--profile-directory=Default',
    `--load-extension=${TM_EXT}`,
    '--no-first-run', '--no-default-browser-check',
    `${CONFIG.origin}/ai-workspace/lms-graph/${CLASSROOM}/video/${LEAF}?is_chapter=1`,
  ], { detached: true, stdio: 'ignore' });
  child.unref();

  let ok = false;
  for (let i = 0; i < 60 && !ok; i++) {
    await sleep(500);
    try { ok = (await fetch(`http://127.0.0.1:${PORT}/json/version`, { signal: AbortSignal.timeout(1500) })).ok; } catch (e) { }
  }
  console.log(ok ? '  ✓ 端口就绪' : '  ✗ 端口未就绪');
  if (!ok) process.exit(1);

  console.log('\n等待页面加载 + 脚本注入（18 秒）…');
  await sleep(18000);

  const pages = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).filter((t) => t.type === 'page');
  const p = pages.find((x) => /lms-graph/.test(x.url)) || pages.find((x) => /yuketang/.test(x.url));
  if (!p) { console.error('没有找到雨课堂页面'); process.exit(1); }
  console.log('目标页:', p.url.slice(0, 90));

  const s = await Session.connect(p.webSocketDebuggerUrl);
  await s.send('Runtime.enable');
  const r = await s.eval(`JSON.stringify({
    hasTool: !!window.__yktTool,
    version: window.__yktTool ? window.__yktTool.state.version : null,
    panel: !!document.getElementById('ykt-tool-host'),
    buttons: (function(){
      var h = document.getElementById('ykt-tool-host');
      if (!h || !h.shadowRoot) return null;
      return [].slice.call(h.shadowRoot.querySelectorAll('.mini')).map(function(b){ return (b.innerText||'').trim(); });
    })(),
    bridge: !!document.getElementById('__ykt_speed_bridge__'),
    running: window.__yktTool ? window.__yktTool.state.running : null,
    phase: window.__yktTool ? window.__yktTool.state.phase : null,
    rate: window.__yktTool ? window.__yktTool.state.rate : null,
    paused: window.__yktTool ? window.__yktTool.state.paused : null,
    prog: window.__yktTool ? window.__yktTool.state.progress : null,
    guard: window.__yktTool ? window.__yktTool.state.guard.selfTest : null,
    video: (function(){ var v=document.querySelector('video'); return v?{t:+v.currentTime.toFixed(1),dur:Math.round(v.duration),rate:v.playbackRate}:null })(),
  })`);
  console.log('\n=== 新脚本注入结果 ===');
  console.log(r.value || r.error);

  s.ws.close();
  process.exit(0);
})().catch((e) => { console.error('异常:', e && e.stack || e); process.exit(1); });

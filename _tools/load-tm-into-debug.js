#!/usr/bin/env node
/**
 * 给调试窗口装上篡改猴（Edge 启动时会清理不在注册表里的扩展目录，
 * 所以必须「拷贝后立刻用 --load-extension 启动」，中间不能让 Edge 跑起来）。
 *
 *   node _tools/load-tm-into-debug.js
 */
const CONFIG = require('./config');
const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');

const EDGE = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].find((p) => fs.existsSync(p));
const TM_ID = 'iikmkjmpaadaobahmlepeloendndfphd';
const REAL_EXT = path.join(process.env.LOCALAPPDATA, 'Microsoft', 'Edge', 'User Data', 'Default', 'Extensions', TM_ID);
const PROJECT_ROOT = path.join(__dirname, '..');
const MIRROR = process.env.YKT_MIRROR_DIR || path.join(PROJECT_ROOT, '_edge-debug-profile');
const MIRROR_EXT = path.join(MIRROR, 'Default', 'Extensions', TM_ID);
const PORT = 9222;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function edgeCount() {
  try {
    return Number(execSync('powershell -NoProfile -Command "(Get-Process msedge -ErrorAction SilentlyContinue | Measure-Object).Count"', { encoding: 'utf8' }).trim()) || 0;
  } catch (e) { return 0; }
}

function copyDir(src, dst) {
  let n = 0;
  fs.mkdirSync(dst, { recursive: true });
  for (const name of fs.readdirSync(src)) {
    const s = path.join(src, name), d = path.join(dst, name);
    const st = fs.statSync(s);
    if (st.isDirectory()) n += copyDir(s, d);
    else { fs.copyFileSync(s, d); n++; }
  }
  return n;
}

(async () => {
  if (!EDGE) { console.error('找不到 msedge.exe'); process.exit(1); }
  if (!fs.existsSync(REAL_EXT)) { console.error('真实配置里没有篡改猴:', REAL_EXT); process.exit(1); }

  // 1) 关掉所有 Edge（否则扩展目录被占用 / 会被清理）
  const n = edgeCount();
  if (n > 0) {
    console.log(`关闭 ${n} 个 Edge 进程…`);
    try { execSync('powershell -NoProfile -Command "Get-Process msedge -ErrorAction SilentlyContinue | Stop-Process -Force"', { stdio: 'inherit' }); } catch (e) { }
    for (let i = 0; i < 30 && edgeCount() > 0; i++) await sleep(500);
  }
  console.log('剩余 Edge 进程:', edgeCount());

  // 2) 拷贝篡改猴
  console.log('拷贝篡改猴到镜像…');
  const copied = copyDir(REAL_EXT, MIRROR_EXT);
  console.log(`  已拷贝 ${copied} 个文件`);

  // 找版本目录
  let extDir = null;
  for (const ver of fs.readdirSync(MIRROR_EXT)) {
    const p = path.join(MIRROR_EXT, ver);
    if (fs.existsSync(path.join(p, 'manifest.json'))) { extDir = p; break; }
  }
  if (!extDir) { console.error('  拷贝后找不到 manifest.json'); process.exit(1); }
  console.log('  解包目录:', extDir);

  // 3) 立刻用 --load-extension 启动
  console.log('启动调试窗口（--load-extension 加载篡改猴）…');
  const child = spawn(EDGE, [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${MIRROR}`,
    '--profile-directory=Default',
    `--load-extension=${extDir}`,
    '--no-first-run', '--no-default-browser-check',
    'about:blank',
  ], { detached: true, stdio: 'ignore' });
  child.unref();

  let ok = false;
  for (let i = 0; i < 60 && !ok; i++) {
    await sleep(500);
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`, { signal: AbortSignal.timeout(1500) });
      ok = r.ok;
    } catch (e) { }
  }
  console.log(ok ? '  ✓ 端口就绪' : '  ✗ 端口未就绪');

  await sleep(6000);
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const tm = list.find((t) => t.url.includes(TM_ID));
  console.log('\n篡改猴后台目标:', tm ? `✓ ${tm.type} ${tm.url.slice(0, 70)}` : '✗ 没有');

  // 4) 打开一个雨课堂页面，检查脚本是否被注入
  console.log('\n打开课程页检查脚本注入…');
  const pages = list.filter((t) => t.type === 'page');
  const page = pages[0];
  if (page) {
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((r) => { ws.onopen = r; });
    let id = 0; const pend = new Map();
    ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
    const send = (method, params = {}) => new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
    await send('Page.enable'); await send('Runtime.enable');
    await send('Page.navigate', { url: CONFIG.origin + `/v2/web/studentLog/${CONFIG.classroom}` });
    await sleep(14000);
    const r = await send('Runtime.evaluate', {
      expression: `JSON.stringify({
        url: location.pathname,
        hasTool: !!window.__yktTool,
        panel: !!document.getElementById('ykt-tool-host'),
        cards: document.querySelectorAll('section.studentCard').length,
        tmPresent: (typeof chrome !== 'undefined' && chrome.runtime) ? true : false,
      })`, returnByValue: true,
    });
    console.log('  页面状态:', r.result && r.result.result && r.result.result.value);
    ws.close();
  }

  console.log('\n如果 hasTool 仍为 false：需要在调试窗口的 edge://extensions/ 里');
  console.log('确认篡改猴已启用，并打开它的「允许用户脚本」开关。');
  process.exit(0);
})().catch((e) => { console.error('异常:', e && e.stack || e); process.exit(1); });

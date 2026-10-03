#!/usr/bin/env node
/**
 * 启动调试窗口并停在雨课堂登录页，等待用户扫码登录。
 *   node _tools/open-login.js
 *
 * 说明：Edge 从 M136 起禁止在「默认用户数据目录」上开启 --remote-debugging-port，
 * 所以真实站点验证只能用这份独立的调试配置目录（登录态也独立）。
 */
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const CONFIG = require('./config');

const EDGE = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].find((p) => fs.existsSync(p));

const PROFILE = path.join(__dirname, '..', '_edge-debug-profile');
const TM_ID = 'iikmkjmpaadaobahmlepeloendndfphd';
const EXT_ROOT = path.join(PROFILE, 'Default', 'Extensions', TM_ID);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findTmDir() {
  if (!fs.existsSync(EXT_ROOT)) return null;
  const dirs = fs.readdirSync(EXT_ROOT).filter((d) => /^\d/.test(d));
  if (!dirs.length) return null;
  dirs.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  return path.join(EXT_ROOT, dirs[0]);
}

/** 从主浏览器的 Edge 安装目录里拷贝篡改猴（Edge 的 GC 会删掉调试目录里的副本） */
function ensureTm() {
  let tm = findTmDir();
  if (tm) return tm;
  const src = path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'Edge', 'User Data', 'Default', 'Extensions', TM_ID);
  if (!fs.existsSync(src)) {
    console.log('⚠ 主浏览器里也没找到篡改猴，跳过扩展加载');
    return null;
  }
  fs.mkdirSync(EXT_ROOT, { recursive: true });
  execSync(`xcopy "${src}\\*" "${EXT_ROOT}\\" /E /I /Y /Q`, { stdio: 'ignore' });
  tm = findTmDir();
  console.log(tm ? '✓ 已从主浏览器拷贝篡改猴: ' + path.basename(tm) : '⚠ 拷贝失败');
  return tm;
}

(async () => {
  if (!EDGE) { console.error('找不到 msedge.exe'); process.exit(1); }
  if (!fs.existsSync(PROFILE)) { console.error('找不到调试配置目录: ' + PROFILE); process.exit(1); }

  console.log('关闭旧的调试窗口（只针对调试配置目录，不影响你的主浏览器）…');
  try {
    const out = execSync(
      'powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name=\'msedge.exe\'\\" | '
      + 'Where-Object { $_.CommandLine -like \'*_edge-debug-profile*\' } | '
      + 'Select-Object -ExpandProperty ProcessId"',
      { encoding: 'utf8' }
    );
    const pids = out.split(/\s+/).map((s) => s.trim()).filter((s) => /^\d+$/.test(s));
    if (pids.length) {
      console.log('  关闭调试窗口进程: ' + pids.join(', '));
      execSync(`powershell -NoProfile -Command "Stop-Process -Id ${pids.join(',')} -Force -ErrorAction SilentlyContinue"`, { stdio: 'ignore' });
    } else {
      console.log('  没有正在运行的调试窗口');
    }
  } catch (e) { }
  await sleep(2500);

  const tm = ensureTm();
  const args = [
    `--remote-debugging-port=${CONFIG.cdpPort}`,
    `--user-data-dir=${PROFILE}`,
    '--profile-directory=Default',
    '--no-first-run', '--no-default-browser-check',
    '--new-window',
  ];
  if (tm) args.push(`--load-extension=${tm}`);
  args.push(CONFIG.url.login());

  console.log('启动调试窗口并打开登录页…');
  const child = spawn(EDGE, args, { detached: true, stdio: 'ignore' });
  child.unref();

  let ok = false;
  for (let i = 0; i < 60 && !ok; i++) {
    await sleep(500);
    try { ok = (await fetch(`http://127.0.0.1:${CONFIG.cdpPort}/json/version`, { signal: AbortSignal.timeout(1500) })).ok; } catch (e) { }
  }
  if (!ok) { console.error('✗ 调试端口未就绪'); process.exit(1); }
  console.log(`✓ 调试端口就绪 (${CONFIG.cdpPort})`);

  await sleep(4000);

  // 截图确认页面状态，方便判断登录页是否已显示
  try {
    const list = (await (await fetch(`http://127.0.0.1:${CONFIG.cdpPort}/json/list`)).json())
      .filter((t) => t.type === 'page');
    const p = list.find((t) => /yuketang/i.test(t.url)) || list[0];
    const ws = new WebSocket(p.webSocketDebuggerUrl);
    await new Promise((r, j) => { ws.onopen = r; ws.onerror = () => j(new Error('ws fail')); });
    let id = 1;
    const send = (method, params) => new Promise((res) => {
      const h = (e) => { const x = JSON.parse(e.data); if (x.id === id) { ws.removeEventListener('message', h); res(x.result); } };
      ws.addEventListener('message', h);
      ws.send(JSON.stringify({ id, method, params: params || {} }));
      id++;
    });
    await send('Page.enable');
    await send('Runtime.enable');
    const st = await send('Runtime.evaluate', {
      expression: `JSON.stringify({ url: location.href, title: document.title,
        hasQr: !!document.querySelector('img[src*=qr], canvas, [class*=qrcode], [class*=qr-code]'),
        text: (document.body.innerText||'').replace(/\\s+/g,' ').slice(0,120) })`,
      returnByValue: true,
    });
    console.log('页面状态:', st.result.value);
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    const out = path.join(__dirname, '..', 'screenshots', 'login-page.png');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));
    console.log('已截图:', out);
    ws.close();
  } catch (e) { console.log('截图失败（不影响登录）:', e.message); }

  console.log('\n请在打开的窗口里扫码登录雨课堂。登录完成后告诉我，我继续做真实站点验证。');
  process.exit(0);
})().catch((e) => { console.error('异常:', e && e.stack || e); process.exit(1); });

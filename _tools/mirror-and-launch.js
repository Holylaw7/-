#!/usr/bin/env node
/**
 * 把 Edge 的 Default 配置文件「镜像」到独立目录，并用调试端口启动该镜像。
 *
 * 为什么需要镜像：
 *   Edge / Chromium 136+ 出于安全考虑，**禁止对默认 User Data 目录开启远程调试端口**
 *   （你的 Edge 是 154，属于该范围）。因此直接 `--remote-debugging-port` 指向
 *   `...\Edge\User Data` 不会生效，端口永远起不来。
 *   把配置复制到独立目录后，登录态（Cookie）、扩展、篡改猴脚本都会一起带过去，
 *   端口即可正常工作。
 *
 *   node _tools/mirror-and-launch.js            # 镜像 + 启动
 *   node _tools/mirror-and-launch.js --refresh  # 强制重新镜像（先删旧的）
 *
 * 注意：镜像只复制必要数据（Cookie/登录态/扩展/篡改猴），跳过缓存等大文件。
 */
const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');

const EDGE = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].find((p) => fs.existsSync(p));

const SRC_ROOT = path.join(process.env.LOCALAPPDATA, 'Microsoft', 'Edge', 'User Data');
const MIRROR_ROOT = process.env.YKT_MIRROR_DIR
  || path.join(path.join(__dirname, '..'), '_edge-debug-profile');
const PORT = Number(process.env.CDP_PORT || 9222);
const REFRESH = process.argv.includes('--refresh');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 顶层必需文件
const ROOT_FILES = ['Local State'];
// 配置文件里要复制的关键文件
// 注意：Edge/Chromium 新版把 Cookies / Network 相关文件放在 Default\Network\ 下，
//       只复制 Default\Cookies 会漏掉登录态。
const PROFILE_FILES = [
  'Network', 'Cookies', 'Cookies-journal', 'Login Data', 'Login Data-journal',
  'Web Data', 'Web Data-journal', 'Preferences', 'Secure Preferences',
  'Local Storage', 'Session Storage', 'IndexedDB', 'Extension State',
  'Extension Rules', 'Extension Scripts', 'Local Extension Settings',
  'Sync Extension Settings', 'Managed Extension Settings',
  'Extension Activity', 'WebStorage', 'Platform Notifications',
  'Bookmarks', 'Favicons',
];

function run(cmd) {
  try { return execSync(cmd, { encoding: 'utf8' }).trim(); } catch (e) { return ''; }
}
const edgeCount = () => Number(run('powershell -NoProfile -Command "(Get-Process msedge -ErrorAction SilentlyContinue | Measure-Object).Count"')) || 0;

async function probe() {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/json/version`, { signal: AbortSignal.timeout(1500) });
    return await r.json();
  } catch (e) { return null; }
}

function copyItem(src, dst) {
  try {
    if (!fs.existsSync(src)) return 0;
    const st = fs.statSync(src);
    if (st.isDirectory()) {
      let n = 0;
      fs.mkdirSync(dst, { recursive: true });
      for (const name of fs.readdirSync(src)) {
        n += copyItem(path.join(src, name), path.join(dst, name));
      }
      return n;
    }
    if (/^(LOCK|LOG|LOG\.old|.*\.lock)$/i.test(path.basename(src))) return 0;
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
    return 1;
  } catch (e) {
    return 0;
  }
}

(async () => {
  if (!EDGE) { console.error('找不到 msedge.exe'); process.exit(1); }

  const existing = await probe();
  if (existing && !REFRESH) {
    console.log(`✓ 调试端口 ${PORT} 已经可用：${existing.Browser}`);
    return;
  }

  // 镜像前需要 Edge 完全退出，否则文件被占用
  const n = edgeCount();
  if (n > 0) {
    console.log(`检测到 ${n} 个 msedge 进程，先关闭（镜像需要文件不被占用）…`);
    run('powershell -NoProfile -Command "Get-Process msedge -ErrorAction SilentlyContinue | Stop-Process -Force"');
    for (let i = 0; i < 40; i++) {
      if (edgeCount() === 0) break;
      await sleep(500);
    }
    console.log(`剩余 msedge 进程: ${edgeCount()}`);
  }

  if (REFRESH && fs.existsSync(MIRROR_ROOT)) {
    console.log('清除旧镜像…');
    fs.rmSync(MIRROR_ROOT, { recursive: true, force: true });
  }

  console.log(`\n镜像源  : ${SRC_ROOT}\\Default`);
  console.log(`镜像目标: ${MIRROR_ROOT}\\Default\n`);

  let files = 0;
  const t0 = Date.now();
  for (const f of ROOT_FILES) {
    files += copyItem(path.join(SRC_ROOT, f), path.join(MIRROR_ROOT, f));
  }
  for (const f of PROFILE_FILES) {
    files += copyItem(path.join(SRC_ROOT, 'Default', f), path.join(MIRROR_ROOT, 'Default', f));
  }
  console.log(`已复制 ${files} 个文件，用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  // 篡改猴脚本是否带过来了
  const tmDir = path.join(MIRROR_ROOT, 'Default', 'Local Extension Settings', 'iikmkjmpaadaobahmlepeloendndfphd');
  if (fs.existsSync(tmDir)) {
    const sz = fs.readdirSync(tmDir).reduce((a, f) => a + (fs.statSync(path.join(tmDir, f)).size || 0), 0);
    console.log(`篡改猴存储已镜像: ${(sz / 1024 / 1024).toFixed(1)} MB`);
  } else {
    console.log('⚠ 篡改猴存储未镜像成功');
  }

  console.log(`\n用镜像配置启动 Edge（调试端口 ${PORT}）…`);
  const child = spawn(EDGE, [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${MIRROR_ROOT}`,
    '--profile-directory=Default',
    '--no-first-run',
    '--no-default-browser-check',
    'about:blank',
  ], { detached: true, stdio: 'ignore' });
  child.unref();

  let v = null;
  for (let i = 0; i < 60 && !v; i++) {
    await sleep(500);
    v = await probe();
  }
  if (v) {
    console.log(`\n✓ 已启动并可用：${v.Browser}`);
    console.log(`\n下一步：node _tools/real-site-check.js --navigate`);
  } else {
    console.error('\n✗ 端口仍未就绪。请检查是否有残留 msedge 进程占用该镜像目录。');
    process.exit(1);
  }
})();

#!/usr/bin/env node
/**
 * 在调试窗口里真正安装并启用篡改猴（镜像拷贝扩展文件不会让 Edge 加载它）。
 *   node _tools/install-tm-in-debug.js
 *
 * 做法：用 Edge 自带的 --load-extension 重新启动调试窗口，
 *      指向镜像里已存在的篡改猴解包目录。
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const EDGE = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].find((p) => fs.existsSync(p));
// 项目根由本文件位置推导，避免写死某个人的目录（本文件在 <根>/_tools/ 下）
const PROJECT_ROOT = path.join(__dirname, '..');
const MIRROR = process.env.YKT_MIRROR_DIR || path.join(PROJECT_ROOT, '_edge-debug-profile');
const PORT = 9222;

// 找镜像里的篡改猴解包目录（按扩展 ID 精确定位，不要靠 name 猜）
const TM_ID = 'iikmkjmpaadaobahmlepeloendndfphd';
function findTmDir() {
  const idDir = path.join(MIRROR, 'Default', 'Extensions', TM_ID);
  if (!fs.existsSync(idDir)) return null;
  for (const ver of fs.readdirSync(idDir)) {
    const p = path.join(idDir, ver);
    const mf = path.join(p, 'manifest.json');
    if (fs.existsSync(mf)) {
      try {
        const j = JSON.parse(fs.readFileSync(mf, 'utf8'));
        return { dir: p, id: TM_ID, version: ver, name: j.name, mv: j.manifest_version };
      } catch (e) { }
    }
  }
  return null;
}

(async () => {
  if (!EDGE) { console.error('找不到 msedge.exe'); process.exit(1); }
  const tm = findTmDir();
  console.log('镜像里的篡改猴目录:', tm ? tm.dir : '（未找到）');
  if (tm) console.log(`  版本: ${tm.version}  名称: ${tm.name}`);

  if (!tm) {
    console.error('\n镜像里没有篡改猴的解包文件，无法用 --load-extension 加载。');
    process.exit(1);
  }

  console.log('\n关闭现有调试窗口…');
  try {
    const { execSync } = require('child_process');
    execSync('powershell -NoProfile -Command "Get-Process msedge -ErrorAction SilentlyContinue | Stop-Process -Force"', { stdio: 'inherit' });
  } catch (e) { }
  await new Promise((r) => setTimeout(r, 3000));

  console.log('用 --load-extension 重新启动（加载篡改猴）…');
  const child = spawn(EDGE, [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${MIRROR}`,
    '--profile-directory=Default',
    `--load-extension=${tm.dir}`,
    '--no-first-run', '--no-default-browser-check',
    '--disable-features=OptimizationHints',
    'about:blank',
  ], { detached: true, stdio: 'ignore' });
  child.unref();

  let ok = false;
  for (let i = 0; i < 60 && !ok; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      const v = await (await fetch(`http://127.0.0.1:${PORT}/json/version`, { signal: AbortSignal.timeout(1500) })).json();
      ok = !!v.Browser;
    } catch (e) { }
  }
  console.log(ok ? '\n✓ 调试窗口已重启' : '\n✗ 端口未就绪');

  // 检查篡改猴是否加载
  await new Promise((r) => setTimeout(r, 4000));
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const tmTarget = list.find((t) => /iikmkjmpaadaobahmlepeloendndfphd/.test(t.url));
  console.log('\n篡改猴后台目标:', tmTarget ? `${tmTarget.type} ${tmTarget.url.slice(0, 70)}` : '（仍没有 → 需要手动在扩展页启用）');

  console.log('\n所有目标:');
  list.forEach((t) => console.log(`  [${t.type}] ${t.url.slice(0, 95)}`));

  process.exit(0);
})().catch((e) => { console.error('异常:', e && e.stack || e); process.exit(1); });

#!/usr/bin/env node
/**
 * 用「你自己的 Edge 配置文件」启动一个带远程调试端口的实例，
 * 以便直接在你的真实登录环境下测试脚本。
 *
 *   node _tools/launch-real-edge.js            # 检查状态并给出指引
 *   node _tools/launch-real-edge.js --kill     # 先关闭现有 Edge，再带调试端口启动
 *
 * 说明：
 *   - 使用你原本的 User Data 目录（Default 配置文件），因此登录态/扩展/篡改猴脚本全部保留
 *   - 调试端口只监听 127.0.0.1，仅本机可访问；测试完关掉 Edge 即失效
 *   - 不带 --kill 时只做状态检查，不会动你正在用的浏览器
 */
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const EDGE = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].find((p) => fs.existsSync(p));

const USER_DATA = path.join(process.env.LOCALAPPDATA, 'Microsoft', 'Edge', 'User Data');
const PORT = 9222;
const KILL = process.argv.includes('--kill');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function probe(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) });
    return await r.json();
  } catch (e) {
    return null;
  }
}

function edgeProcesses() {
  try {
    const out = execSync(
      'powershell -NoProfile -Command "Get-Process msedge -ErrorAction SilentlyContinue | Measure-Object | Select-Object -ExpandProperty Count"',
      { encoding: 'utf8' }
    ).trim();
    return Number(out) || 0;
  } catch (e) {
    return 0;
  }
}

(async () => {
  if (!EDGE) {
    console.error('找不到 msedge.exe');
    process.exit(1);
  }
  console.log(`Edge      : ${EDGE}`);
  console.log(`User Data : ${USER_DATA}`);

  const already = await probe(PORT);
  if (already) {
    console.log(`\n✓ 调试端口 ${PORT} 已经可用：`);
    console.log(`   ${already.Browser}  (${already['User-Agent']?.slice(0, 60)})`);
    console.log('\n可以直接运行真实环境诊断：');
    console.log('   node _tools/real-site-check.js');
    return;
  }

  const n = edgeProcesses();
  console.log(`\n当前 msedge 进程数: ${n}`);
  console.log(`调试端口 ${PORT}: 未开启`);

  if (!KILL) {
    console.log(`
──────────────────────────────────────────────────────────────
需要重启一次 Edge 才能开启调试端口（登录态不会丢，都在 Default 里）。

方式一（推荐，你自己操作）：
  1. 关闭所有 Edge 窗口
  2. 双击运行这个文件：E:\\刷课脚本\\_tools\\start-edge-debug.cmd
  3. Edge 会带着你的配置和调试端口重新打开

方式二（我来做）：
  在本对话里让我执行带 --kill 的命令，我会：
    · 关闭现有 Edge 进程（Edge 下次启动会提示恢复标签页）
    · 用你的 Default 配置文件 + 调试端口重新启动
──────────────────────────────────────────────────────────────`);
    return;
  }

  // ---- 关闭现有 Edge ----
  if (n > 0) {
    console.log('\n正在关闭现有 Edge 进程…');
    try {
      execSync('powershell -NoProfile -Command "Get-Process msedge -ErrorAction SilentlyContinue | Stop-Process -Force"', { stdio: 'inherit' });
    } catch (e) { }
    for (let i = 0; i < 30; i++) {
      if (edgeProcesses() === 0) break;
      await sleep(500);
    }
    console.log(`剩余 msedge 进程: ${edgeProcesses()}`);
  }

  // ---- 带调试端口启动 ----
  console.log(`\n正在用你的配置文件启动 Edge（调试端口 ${PORT}）…`);
  const child = spawn(EDGE, [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${USER_DATA}`,
    '--profile-directory=Default',
    '--restore-last-session',
    'about:blank',
  ], { detached: true, stdio: 'ignore' });
  child.unref();

  let v = null;
  for (let i = 0; i < 40 && !v; i++) {
    await sleep(500);
    v = await probe(PORT);
  }
  if (v) {
    console.log(`\n✓ 已启动：${v.Browser}`);
    console.log('\n现在可以运行真实环境诊断：');
    console.log('   node _tools/real-site-check.js');
  } else {
    console.error('\n✗ 端口未就绪。请确认 Edge 已完全退出后再试，或手动运行 start-edge-debug.cmd');
    process.exit(1);
  }
})();

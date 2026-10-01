#!/usr/bin/env node
/**
 * 构建：把 src/*.js 按顺序拼装成一个可直接安装的 Tampermonkey 用户脚本。
 *
 *   node build.js                       # 构建
 *   node build.js --check               # 仅做语法/元数据校验
 *   node build.js --update-url <URL>    # 额外写入 @updateURL/@downloadURL（便于自动更新）
 *
 * 产物：dist/changjiang-yuketang-auto.user.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = __dirname;
const SRC = path.join(ROOT, 'src');
const DIST = path.join(ROOT, 'dist');
const HEADER = path.join(SRC, '00-header.txt');
const ORDER = ['01-core.js', '02-guard.js', '03-player.js', '03b-speed-bridge.js', '04-nav.js', '05-ui.js', '06-run.js'];
const OUT_NAME = 'changjiang-yuketang-auto.user.js';

const argv = process.argv.slice(2);
const checkOnly = argv.includes('--check');
const upIdx = argv.indexOf('--update-url');
const updateUrl = upIdx >= 0 ? argv[upIdx + 1] : (process.env.YKT_UPDATE_URL || '');

const read = (p) => fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '');

// ---------------------------------------------------------------- 组装
const pkg = JSON.parse(read(path.join(ROOT, 'package.json')));
let header = read(HEADER).trimEnd();

// 版本号以 package.json 为准，避免两处不一致
header = header.replace(/^\/\/ @version\s+.*$/m, `// @version      ${pkg.version}`);

// 可选：自动更新地址
if (updateUrl) {
  const extra = `// @updateURL    ${updateUrl}\n// @downloadURL  ${updateUrl}`;
  if (!/@updateURL/.test(header)) header = header.replace(/^(\/\/ ==\/UserScript==)/m, `${extra}\n$1`);
}

const parts = ORDER.map((f) => {
  const p = path.join(SRC, f);
  if (!fs.existsSync(p)) throw new Error('缺少源文件: ' + f);
  return `// ------------------------------ src/${f} ------------------------------\n` + read(p).trimEnd();
});

const body = [
  header,
  `(function () {`,
  `  'use strict';`,
  ...parts.map((s) => s.split('\n').map((l) => (l ? '  ' + l : l)).join('\n')),
  `})();`,
  ``,
].join('\n');

// ---------------------------------------------------------------- 校验
const problems = [];

// 1) JS 语法
try {
  new vm.Script(body, { filename: OUT_NAME });
} catch (e) {
  problems.push('JavaScript 语法错误: ' + e.message);
}

// 2) 元数据块必须在第 1 行且完整
const lines = body.split('\n');
if (lines[0].trim() !== '// ==UserScript==') problems.push('第 1 行必须是 // ==UserScript==');
const endIdx = lines.findIndex((l) => l.trim() === '// ==/UserScript==');
if (endIdx < 0) problems.push('缺少 // ==/UserScript== 结束标记');
else {
  const meta = lines.slice(1, endIdx);
  const getMeta = (k) => {
    const l = meta.find((x) => x.startsWith(`// @${k} `) || x.startsWith(`// @${k}\t`));
    return l ? l.replace(/^\/\/\s*@[\w:-]+\s+/, '').trim() : null;
  };
  for (const req of ['name', 'namespace', 'version', 'description', 'match', 'run-at']) {
    if (!getMeta(req)) problems.push(`元数据缺少 @${req}`);
  }
  const ver = getMeta('version');
  if (ver && ver !== pkg.version) problems.push(`@version(${ver}) 与 package.json(${pkg.version}) 不一致`);
  const matches = meta.filter((l) => l.startsWith('// @match ')).map((l) => l.replace('// @match ', '').trim());
  if (!matches.some((m) => m.includes('yuketang.cn'))) problems.push('@match 未覆盖 yuketang.cn');
  if (!matches.every((m) => /^(https?|\*):\/\//.test(m) && m.includes('://'))) problems.push('存在格式非法的 @match');
  // @grant 与代码实际用到的 API 是否匹配
  const grants = meta.filter((l) => l.startsWith('// @grant ')).map((l) => l.replace('// @grant ', '').trim());
  if (/\bunsafeWindow\b/.test(body) && !grants.includes('unsafeWindow')) {
    problems.push('代码使用了 unsafeWindow，但元数据缺少 @grant unsafeWindow');
  }
  if (/\bGM_[A-Za-z]+/.test(body.replace(/^\/\/.*$/gm, ''))) {
    const used = [...body.matchAll(/\b(GM_[A-Za-z]+)/g)].map((m) => m[1]);
    for (const g of new Set(used)) {
      if (!grants.includes(g)) problems.push(`代码使用了 ${g}，但元数据缺少 @grant ${g}`);
    }
  }
  if (/@require\b/.test(header)) problems.push('不应使用 @require（脚本必须自包含）');
}

if (problems.length) {
  console.error('✗ 校验失败：');
  problems.forEach((p) => console.error('   - ' + p));
  process.exit(1);
}
console.log('✓ 语法与元数据校验通过');

if (checkOnly) process.exit(0);

// ---------------------------------------------------------------- 输出
fs.mkdirSync(DIST, { recursive: true });
const out = path.join(DIST, OUT_NAME);
fs.writeFileSync(out, body, 'utf8');
fs.writeFileSync(path.join(DIST, 'install.html'), installHtml(out, pkg.version), 'utf8');

const kb = (fs.statSync(out).size / 1024).toFixed(1);
console.log(`✓ 已生成 dist/${OUT_NAME}  (${kb} KB, ${lines.length} 行, v${pkg.version})`);
console.log(`✓ 已生成 dist/install.html  (双击即可唤起篡改猴安装页)`);
if (updateUrl) console.log(`  @updateURL = ${updateUrl}`);

// ---------------------------------------------------------------- 安装页
function installHtml(file, version) {
  let fileUrl = 'file:///' + file.replace(/\\/g, '/');
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>安装 长江雨课堂 · 自动刷课助手</title>
<style>
 body{font:14px/1.7 "Microsoft YaHei",system-ui,sans-serif;max-width:720px;margin:6vh auto;padding:0 24px;color:#1f2329}
 h1{font-size:20px} h2{font-size:15px;margin:0 0 8px}
 .card{background:#f6f8fc;border:1px solid #e3e8f2;border-radius:10px;padding:16px 20px;margin:16px 0}
 .card.hot{background:#fff7ed;border-color:#fed7aa}
 .card.ok{background:#f0fdf4;border-color:#bbf7d0}
 code{background:#eef2f9;padding:2px 6px;border-radius:4px;font-family:Consolas,monospace;font-size:12.5px;word-break:break-all}
 a.btn{display:inline-block;background:#2563eb;color:#fff;text-decoration:none;padding:10px 22px;border-radius:8px;font-weight:600}
 a.btn.g{background:#16a34a}
 ol,ul{padding-left:22px} li{margin:6px 0}
 .tip{color:#6b7280;font-size:12.5px}
 .warn{color:#b45309;font-weight:600}
 kbd{background:#1f2937;color:#fff;border-radius:4px;padding:1px 6px;font-size:12px;font-family:Consolas,monospace}
</style></head><body>
<h1>长江雨课堂 · 自动刷课助手 <span class="tip">v${version}</span></h1>

<div class="card hot">
  <h2>⚠️ 先看这里：脚本装了但没反应？</h2>
  <p>用户脚本<b>只在页面加载时注入</b>。如果你是在课程页已经打开的情况下才装的，
  篡改猴会提示「<b>此脚本还未被执行</b>」——这不是匹配失败，<b>按 F5 刷新页面即可</b>。</p>
  <p>如果刷新后依然没反应，多半是<b>篡改猴里的版本没更新成功</b>（安装页/拖拽有时只在磁盘上换了文件）。
  请在篡改猴管理面板里确认这条脚本的 <code>@version</code> 是否为 <b>${version}</b>，
  以及 <code>@match</code> 是否为 5 条（含 <code>xuetangx.com</code>），并且<b>没有</b> <code>@noframes</code>。</p>
</div>

<div class="card ok">
  <h2>✅ 最稳的验证方式：控制台粘贴版（不需要重装、立刻生效）</h2>
  <p>先用这个确认功能是否正常，能立刻排除安装环节的所有干扰：</p>
  <ol>
    <li>在课程页按 <kbd>F12</kbd> → 切到「<b>控制台 / Console</b>」</li>
    <li>若提示 <code>Warning: Don't paste code...</code>，先在控制台输入 <code>allow pasting</code> 回车</li>
    <li>打开 <code>dist\\console-paste.js</code>，<b>全文复制</b>粘贴进控制台，回车</li>
    <li>右下角出现控制面板即成功；控制台会打印 <code>[刷课助手]</code> 开头的日志</li>
  </ol>
  <p class="tip">缺点：刷新页面后失效，需要重新粘贴。确认没问题后再去修篡改猴安装。</p>
</div>

<div class="card">
  <h2>方式 A · 拖拽安装（推荐）</h2>
  <ol>
    <li>打开 <a href="edge://extensions" target="_blank">edge://extensions</a>，确认篡改猴已启用</li>
    <li>点击篡改猴图标 → 「管理面板 / Dashboard」</li>
    <li>把 <code>${file}</code> 这个文件直接<b>拖进浏览器窗口</b>，弹出安装页后点「安装」或「重新安装」</li>
    <li><b>回到课程页按 F5 刷新</b></li>
  </ol>
</div>

<div class="card">
  <h2>方式 B · 在篡改猴编辑器里整份替换（最不容易出错）</h2>
  <ol>
    <li>篡改猴面板 → 找到「长江雨课堂 · 自动刷课助手」→ 点进去</li>
    <li>全选（<kbd>Ctrl</kbd>+<kbd>A</kbd>）删除，粘贴 <code>${file}</code> 的<b>全部内容</b></li>
    <li><kbd>Ctrl</kbd>+<kbd>S</kbd> 保存</li>
    <li>回到课程页按 <kbd>F5</kbd> 刷新</li>
  </ol>
</div>

<div class="card">
  <h2>方式 C · 一键安装按钮</h2>
  <p><a class="btn" href="${fileUrl}">立即安装到篡改猴</a></p>
  <p class="tip">若按钮无反应，说明浏览器不允许网页跳转到本地文件。
  需要先到 <a href="edge://extensions" target="_blank">edge://extensions</a> → 篡改猴「详细信息」→
  打开「允许访问文件 URL」，再回来点这个按钮。</p>
</div>

<div class="card">
  <h2>怎么确认脚本真的在跑？</h2>
  <ul>
    <li>页面右下角出现<b>蓝色控制面板</b>（标题「长江雨课堂 · 自动刷课」）</li>
    <li>或按 <kbd>F12</kbd>，控制台里能看到 <code>[刷课助手]</code> 开头的日志</li>
    <li>点篡改猴图标：当前页若显示运行中的脚本数为 <b>1</b>，说明已注入</li>
    <li>视频开始以 <b>2.00X</b> 静音播放</li>
  </ul>
  <p class="tip">若还是不行：点面板底部的「<b>复制诊断信息</b>」按钮，把内容发我即可定位。</p>
</div>
</body></html>`;
}

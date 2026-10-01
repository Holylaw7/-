#!/usr/bin/env node
/**
 * 生成「控制台粘贴版」：把用户脚本正文（去掉 UserScript 元数据块）输出成
 * 可直接粘贴到 DevTools 控制台执行的形式，用于篡改猴未生效时的应急启动。
 *
 *   node make-console-build.js
 *
 * 产物：dist/console-paste.js
 *   - 运行时通过 @grant unsafeWindow 的等价物（window 自身）工作
 *   - 与油猴版共用同一份 src/*，行为一致
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = __dirname;
const DIST = path.join(ROOT, 'dist');
const SRC = path.join(ROOT, 'src');
const ORDER = ['01-core.js', '02-guard.js', '03-player.js', '03b-speed-bridge.js', '04-nav.js', '05-ui.js', '06-run.js'];
const OUT = path.join(DIST, 'console-paste.js');

const read = (p) => fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '');
const pkg = JSON.parse(read(path.join(ROOT, 'package.json')));

const parts = ORDER.map((f) => {
  const p = path.join(SRC, f);
  if (!fs.existsSync(p)) throw new Error('缺少源文件: ' + f);
  return `// ------------------------------ src/${f} ------------------------------\n` + read(p).trimEnd();
});

const banner = `/*
 * 长江雨课堂 · 自动刷课助手 —— 控制台粘贴版 v${pkg.version}
 *
 * 用法（篡改猴因任何原因没生效时的应急方案）：
 *   1. 在课程页按 F12 打开开发者工具 → 切到「控制台 / Console」
 *   2. 若提示 "Warning: Don't paste code..."，先输入  allow pasting  回车
 *   3. 把本文件全部内容粘贴进去，回车
 *   4. 右下角出现控制面板即成功
 *
 * 注意：
 *   - 直接粘贴执行时脚本运行在页面主世界，效果与油猴版一致（后台守卫、2 倍速都能生效）
 *   - 但**刷新页面后就会失效**，需要重新粘贴；要长期生效请修好篡改猴安装
 *   - 本文件由 build 自动生成，不要手工修改
 */
`;

const body = [
  banner,
  `(function () {`,
  `  'use strict';`,
  ...parts.map((s) => s.split('\n').map((l) => (l ? '  ' + l : l)).join('\n')),
  `})();`,
  ``,
].join('\n');

try {
  new vm.Script(body, { filename: 'console-paste.js' });
} catch (e) {
  console.error('✗ 语法错误:', e.message);
  process.exit(1);
}

fs.mkdirSync(DIST, { recursive: true });
fs.writeFileSync(OUT, body, 'utf8');
console.log(`✓ 已生成 dist/console-paste.js  (${(fs.statSync(OUT).size / 1024).toFixed(1)} KB, v${pkg.version})`);

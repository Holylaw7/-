#!/usr/bin/env node
/**
 * 自动配置：从浏览器当前打开的雨课堂标签页里读出教室号等参数并保存。
 *   node _tools/config-init.js
 *
 * 结果写入 _tools/local.config.json（已 gitignore，不会提交）。
 */
const path = require('path');
const CONFIG = require('./config');

(async () => {
  console.log('当前配置:');
  console.log(CONFIG.describe());
  console.log('');
  console.log('正在从浏览器探测（调试端口 ' + CONFIG.cdpPort + '）...');

  const found = await CONFIG.detect();
  const patch = {};
  if (found.classroom) patch.classroom = found.classroom;
  if (found.universityId) patch.universityId = found.universityId;
  if (found.origin) patch.origin = found.origin;
  if (found.leaf) patch.leaf = found.leaf;

  if (!patch.classroom) {
    console.log('');
    console.log('没能从浏览器里读到教室号（可能没有雨课堂标签页，或调试端口未开）。');
    CONFIG.require('config-init.js');
    process.exit(1);
  }

  console.log('');
  console.log('探测结果:');
  Object.keys(patch).forEach(function (k) { console.log('   ' + k + ' = ' + patch[k]); });

  const saved = CONFIG.saveLocal(patch);
  CONFIG.saveCache(patch);
  console.log('');
  console.log('已保存到 ' + path.join(__dirname, 'local.config.json') + '（不会提交到 git）');
  console.log('  ' + JSON.stringify(saved));
  console.log('');
  console.log('现在可以直接运行各种工具，例如：');
  console.log('   node _tools/real-verify-all.js');
  console.log('   node _tools/real-e2e-full.js');
  process.exit(0);
})().catch(function (e) { console.error('异常:', e && e.stack || e); process.exit(1); });

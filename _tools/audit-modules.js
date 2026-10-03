#!/usr/bin/env node
/**
 * 模块边界与冲突排查
 *   node _tools/audit-modules.js
 *
 * 检查项：
 *   ① 顶层符号重复定义（跨模块命名冲突）
 *   ② 定义了但从未被引用的符号 / 方法（无用项）
 *   ③ 引用了但不存在的符号（悬空引用）
 *   ④ 各模块之间的调用关系（是否存在不该有的跨层依赖）
 *   ⑤ 构建产物里的模块顺序是否与声明一致
 */
const fs = require('fs');
const path = require('path');
const CONFIG = require('./config');

const SRC = path.join(__dirname, '..', 'src');
const header = fs.readFileSync(path.join(SRC, '00-header.txt'), 'utf8');
const build = fs.readFileSync(path.join(__dirname, '..', 'build.js'), 'utf8');
const ORDER = (build.match(/const ORDER = \[([^\]]+)\]/) || [, ''])[1]
  .split(',').map((s) => s.trim().replace(/['"]/g, '')).filter(Boolean);

console.log('=== 构建顺序（build.js 声明） ===');
ORDER.forEach((f, i) => console.log(`  ${i + 1}. ${f}`));

// 读取各模块源码
const mods = {};
for (const f of ORDER) {
  const p = path.join(SRC, f);
  if (!fs.existsSync(p)) { console.log(`  ✗ 缺失: ${f}`); continue; }
  mods[f] = fs.readFileSync(p, 'utf8');
}
const all = Object.values(mods).join('\n');
const files = Object.keys(mods);

// ---------- ① 顶层符号定义 ----------
const topDefs = {};   // name -> [file...]
for (const f of files) {
  const t = mods[f];
  // const X = / function X( / let X = / var X =
  for (const m of t.matchAll(/^(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/gm)) {
    (topDefs[m[1]] = topDefs[m[1]] || []).push(f);
  }
  for (const m of t.matchAll(/^function\s+([A-Za-z_$][\w$]*)\s*\(/gm)) {
    (topDefs[m[1]] = topDefs[m[1]] || []).push(f);
  }
}
console.log('\n=== ① 顶层符号重复定义（命名冲突） ===');
const dupes = Object.entries(topDefs).filter(([, v]) => v.length > 1);
if (!dupes.length) console.log('  ✓ 无重复');
else dupes.forEach(([n, v]) => console.log(`  ✗ ${n}  定义于 ${v.join(' + ')}  ← 后者会覆盖前者`));

// ---------- ② 对象方法定义与引用 ----------
// 提取每个「大对象」的方法名（缩进 2 空格的 method( 定义）
const objMethods = {};   // objName -> Set(method)
for (const f of files) {
  const t = mods[f];
  const objRe = /^const\s+([A-Za-z_$][\w$]*)\s*=\s*\{/gm;
  let m;
  while ((m = objRe.exec(t))) {
    const objName = m[1];
    const start = m.index;
    // 大括号配平找对象结束
    let depth = 0, i = t.indexOf('{', start), end = -1;
    for (; i < t.length; i++) {
      if (t[i] === '{') depth++;
      else if (t[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    if (end < 0) continue;
    const body = t.slice(start, end);
    const set = new Set();
    for (const mm of body.matchAll(/^  ([A-Za-z_$][\w$]*)\s*[(:]/gm)) set.add(mm[1]);
    for (const mm of body.matchAll(/^  async\s+([A-Za-z_$][\w$]*)\s*\(/gm)) set.add(mm[1]);
    objMethods[objName] = set;
  }
}

console.log('\n=== ② 未被引用的对象方法（疑似无用项） ===');
let unusedTotal = 0;
for (const [obj, methods] of Object.entries(objMethods)) {
  const unused = [];
  for (const meth of methods) {
    // 排除属性式定义与构造钩子
    if (['constructor'].includes(meth)) continue;
    // 引用形式：Obj.meth(  或  this.meth(  或  Obj.meth =
    const re = new RegExp(`(?:\\.${meth}\\s*[(=])|(?:\\b${obj}\\.${meth}\\b)`, 'g');
    const hits = (all.match(re) || []).length;
    // 定义处本身会被 this.meth / obj.meth 匹配到，至少要有 2 次
    if (hits <= 1) unused.push(meth);
  }
  if (unused.length) {
    unusedTotal += unused.length;
    console.log(`  ${obj}: ${unused.join(', ')}`);
  }
}
if (!unusedTotal) console.log('  ✓ 无');

// ---------- ③ 悬空引用 ----------
console.log('\n=== ③ 悬空引用（调用了不存在的对象方法） ===');
const dangling = [];
for (const [obj, methods] of Object.entries(objMethods)) {
  // 找所有 Obj.xxx 调用
  const re = new RegExp(`\\b${obj}\\.([A-Za-z_$][\\w$]*)\\s*\\(`, 'g');
  let m;
  const seen = new Set();
  while ((m = re.exec(all))) {
    const meth = m[1];
    if (seen.has(meth)) continue;
    seen.add(meth);
    if (!methods.has(meth)) dangling.push(`${obj}.${meth}()`);
  }
}
if (!dangling.length) console.log('  ✓ 无');
else [...new Set(dangling)].forEach((d) => console.log(`  ✗ ${d}  ← 被调用但未定义`));

// ---------- ④ 跨模块调用关系 ----------
console.log('\n=== ④ 跨模块调用（谁用了谁） ===');
const OBJS = Object.keys(objMethods);
for (const f of files) {
  const t = mods[f];
  const refs = new Set();
  for (const o of OBJS) {
    if (f.startsWith(o.slice(0, 2))) continue;       // 自己文件内定义的不算
    const re = new RegExp(`\\b${o}\\.`, 'g');
    if (re.test(t)) refs.add(o);
  }
  console.log(`  ${f.padEnd(20)} → ${refs.size ? [...refs].join(', ') : '(仅用 U/LOG)'}`);
}

// ---------- ⑤ 重复定义的注释/说明段 ----------
console.log('\n=== ⑤ 重复的注释块（同一说明写了两遍） ===');
for (const f of files) {
  const t = mods[f];
  const blocks = (t.match(/\/\*\*[\s\S]*?\*\//g) || []);
  const seen = new Map();
  let dup = 0;
  for (const b of blocks) {
    const key = b.replace(/[\s*]+/g, '').slice(0, 60);
    if (seen.has(key)) { dup++; console.log(`  ✗ ${f}: 重复注释 «${b.split('\n')[1]?.trim().slice(0, 50)}»`); }
    seen.set(key, 1);
  }
  if (!dup && f === files[files.length - 1]) console.log('  ✓ 无');
}

// ---------- ⑥ 版本/元数据一致性 ----------
console.log('\n=== ⑥ 元数据一致性 ===');
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
const hVer = (header.match(/@version\s+(\S+)/) || [])[1];
const coreVer = (mods['01-core.js'].match(/version:\s*'([^']+)'/) || [])[1];
const distVer = (fs.readFileSync(path.join(__dirname, '..', 'dist', 'changjiang-yuketang-auto.user.js'), 'utf8')
  .match(/@version\s+(\S+)/) || [])[1];
console.log(`  package.json=${pkg.version}  00-header=${hVer}  01-core=${coreVer}  dist=${distVer}`);
console.log(pkg.version === hVer && hVer === coreVer && coreVer === distVer
  ? '  ✓ 四处一致' : '  ✗ 不一致');

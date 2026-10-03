#!/usr/bin/env node
/**
 * 全量方法引用检查（不限于 this./Obj. 两种形式）
 *   node _tools/audit-deadcode.js
 *
 * 判定规则：某方法名在全部源码中「除定义处外」是否还有任何出现。
 * 定义处形如：  "  name("  / "  name:" / "  async name("
 */
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'src');
const files = fs.readdirSync(SRC).filter((f) => f.endsWith('.js')).sort();
const mods = {};
files.forEach((f) => { mods[f] = fs.readFileSync(path.join(SRC, f), 'utf8'); });
const all = Object.values(mods).join('\n');

function parseObjects() {
  const out = {};
  for (const f of files) {
    const t = mods[f];
    for (const m of t.matchAll(/^const\s+([A-Za-z_$][\w$]*)\s*=\s*\{/gm)) {
      const name = m[1];
      const start = m.index;
      let depth = 0, i = t.indexOf('{', start), end = -1;
      for (; i < t.length; i++) {
        if (t[i] === '{') depth++;
        else if (t[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
      }
      if (end < 0) continue;
      const body = t.slice(start, end);
      const methods = [];
      for (const mm of body.matchAll(/^  (?:async\s+)?([A-Za-z_$][\w$]*)\s*\(/gm)) {
        methods.push({ name: mm[1], defLine: body.slice(0, mm.index).split('\n').length + t.slice(0, start).split('\n').length - 1 });
      }
      out[name] = { methods, file: f };
    }
  }
  return out;
}

const OBJS = parseObjects();

console.log('方法引用全量检查');
console.log('规则：除定义处外，方法名在全部源码中是否还有其他出现\n');

const dead = [];
const summary = [];
for (const [obj, info] of Object.entries(OBJS)) {
  const unusedHere = [];
  for (const meth of info.methods) {
    const name = meth.name;
    // 所有出现
    const re = new RegExp(`\\b${name}\\b`, 'g');
    const total = (all.match(re) || []).length;
    // 定义处的形态（缩进 2 空格 + name + ( 或 :）
    const defRe = new RegExp(`^\\s{2}(?:async\\s+)?${name}\\s*[(:]`, 'gm');
    const defs = (all.match(defRe) || []).length;
    const uses = total - defs;
    if (uses <= 0) { unusedHere.push(name); dead.push(`${obj}.${name}`); }
  }
  summary.push({ obj, total: info.methods.length, unused: unusedHere.length });
  if (unusedHere.length) {
    console.log(`  ${obj}  (${info.file})`);
    unusedHere.forEach((u) => console.log(`      · ${u}`));
  }
}
if (!dead.length) console.log('  ✓ 所有方法都有引用');

console.log('\n汇总表');
console.log('  对象'.padEnd(16) + '方法数  未引用');
console.log('  ' + '-'.repeat(40));
summary.forEach((s) => {
  const flag = s.unused ? `  ✗ ${s.unused}` : '  ✓';
  console.log('  ' + s.obj.padEnd(14) + String(s.total).padStart(4) + flag);
});

console.log('\n=== 结论 ===');
if (!dead.length) {
  console.log('  ✓ 没有未被使用的方法（无死代码）');
} else {
  console.log(`  未引用方法共 ${dead.length} 个：`);
  dead.forEach((d) => console.log(`    · ${d}`));
  console.log('\n  处理建议：');
  console.log('    · 属于「早期方案遗留」→ 直接删除');
  console.log('    · 属于「诊断/外部工具接口」→ 保留但加注释说明用途');
}

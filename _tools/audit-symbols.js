#!/usr/bin/env node
/**
 * 逐项精确认定（不靠正则猜测，直接列出每个符号的全部出现行）
 *   node _tools/audit-symbols.js <符号名...>
 */
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'src');
const files = fs.readdirSync(SRC).filter((f) => f.endsWith('.js')).sort();

const targets = process.argv.slice(2);
if (!targets.length) {
  console.error('用法: node _tools/audit-symbols.js <符号名...>  例如: CFG.itemTimeout Player.enforceRate');
  process.exit(1);
}

console.log('逐项精确认定（列出全部出现位置，人工判断是否为有效引用）\n');

for (const t of targets) {
  const short = t.includes('.') ? t.split('.').pop() : t;
  console.log(`=== ${t}  （按 "${short}" 搜索）===`);
  let n = 0;
  for (const f of files) {
    const lines = fs.readFileSync(path.join(SRC, f), 'utf8').split('\n');
    lines.forEach((l, i) => {
      if (new RegExp(`\\b${short}\\b`).test(l)) {
        n++;
        const isComment = /^\s*(\/\/|\*|\/\*)/.test(l);
        console.log(`  ${isComment ? '注释' : '代码'}  ${f}:${i + 1}  ${l.trim().slice(0, 88)}`);
      }
    });
  }
  if (!n) console.log('  （无任何出现）');
  console.log('');
}

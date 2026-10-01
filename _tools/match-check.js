/**
 * 复刻篡改猴/Chrome 的 @match 匹配算法，验证给定 URL 会被哪些规则命中。
 *   node _tools/match-check.js
 *
 * 规则集与测试 URL 都从 _tools/config.js 取，不写死个人站点/教室号。
 */
const CONFIG = require('./config');

/** 旧版规则集（只有 yuketang 域名，且带 @noframes） */
const RULES_OLD = [
  `*://${new URL(CONFIG.origin).host}/*`,
  '*://*.yuketang.cn/*',
  '*://*.yuketang.com/*',
];

/** 当前规则集（覆盖多域名） */
const RULES_CURRENT = [
  '*://*.yuketang.cn/*',
  '*://*.yuketang.com/*',
  '*://*.xuetangx.com/*',
  '*://*.xuetangx.org/*',
  '*://*.ykt.io/*',
];

/** Chrome match pattern -> RegExp（与浏览器实现一致） */
function matchPatternToRegExp(pattern) {
  if (pattern === '<all_urls>') return /^(https?|wss?|file|ftp|urn):\/\/.*$/;
  const m = /^(\*|http|https|file|ftp|urn):\/\/(\*|(?:\*\.)?[^/*]+|)\/(.*)$/.exec(pattern);
  if (!m) return null;
  const [, scheme, host, path] = m;
  const schemePart = scheme === '*' ? '(https?)' : scheme;
  let hostPart;
  if (host === '*') hostPart = '[^/]+';
  else if (host.startsWith('*.')) hostPart = '[^/]+\\.' + host.slice(2).replace(/\./g, '\\.');
  else hostPart = host.replace(/\./g, '\\.');
  const pathPart = path.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp(`^${schemePart}://${hostPart}/${pathPart}$`);
}

const urls = [
  CONFIG.url.video(CONFIG.leaf || '00000000'),
  CONFIG.url.studentLog(),
  `${CONFIG.origin}/v2/web/index`,
];

function check(name, rules, urls) {
  console.log(`\n===== ${name} =====`);
  const regs = rules.map((r) => [r, matchPatternToRegExp(r)]).filter(([, re]) => re);
  for (const u of urls) {
    const hit = regs.filter(([, re]) => re.test(u)).map(([r]) => r);
    console.log(`${hit.length ? '✓ 命中' : '✗ 未命中'}  ${u}`);
    hit.forEach((h) => console.log(`        ← ${h}`));
  }
}

check('旧版规则集', RULES_OLD, urls);
check('当前规则集', RULES_CURRENT, urls);

// 反向验证：静态资源域名也应被当前规则覆盖
console.log('\n===== 静态资源 / 其它域名 =====');
const others = [
  'https://fe-static-yuketang.yuketang.cn/fe/static/web/1.2.316/js/aiworkspace.js',
  CONFIG.url.video(CONFIG.leaf || '00000000'),
];
for (const u of others) {
  const hitOld = RULES_OLD.filter((r) => matchPatternToRegExp(r).test(u));
  const hitNew = RULES_CURRENT.filter((r) => matchPatternToRegExp(r).test(u));
  console.log(`旧版 ${hitOld.length ? '✓' : '✗'}   当前 ${hitNew.length ? '✓' : '✗'}   ${u}`);
}

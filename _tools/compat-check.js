#!/usr/bin/env node
/**
 * 通用性评估：脚本对「其它课程 / 其它雨课堂部署」的适配程度。
 *   node _tools/compat-check.js
 *
 * 检查三件事：
 *   ① @match 是否覆盖常见雨课堂入口
 *   ② 路由识别是否认得出各种课程页 URL 形态
 *   ③ 关键接口/选择器在不同部署下是否可比对
 */
const fs = require('fs');
const path = require('path');
const CONFIG = require('./config');

/* ---------- ① 复刻篡改猴的 @match 算法 ---------- */
function matchPatternToRegExp(pattern) {
  if (pattern === '<all_urls>') return /^(https?|wss?|file|ftp|urn):\/\/.*$/;
  const m = /^(\*|http|https|file|ftp|urn):\/\/(\*|(?:\*\.)?[^/*]+|)\/(.*)$/.exec(pattern);
  if (!m) return null;
  const [, scheme, host, p] = m;
  const schemePart = scheme === '*' ? '(https?)' : scheme;
  let hostPart;
  if (host === '*') hostPart = '[^/]+';
  else if (host.startsWith('*.')) hostPart = '[^/]+\\.' + host.slice(2).replace(/\./g, '\\.');
  else hostPart = host.replace(/\./g, '\\.');
  const pathPart = p.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp(`^${schemePart}://${hostPart}/${pathPart}$`);
}

const us = fs.readFileSync(path.join(__dirname, '..', 'dist', 'changjiang-yuketang-auto.user.js'), 'utf8');
const matches = [...us.matchAll(/^\/\/ @match\s+(\S+)/gm)].map((m) => m[1]);
const regs = matches.map((r) => [r, matchPatternToRegExp(r)]).filter(([, re]) => re);

/* 常见的雨课堂入口与页面形态 */
const SAMPLES = [
  ['长江雨课堂 · 目录', 'https://changjiang.yuketang.cn/v2/web/studentLog/10000001'],
  ['长江雨课堂 · 播放', 'https://changjiang.yuketang.cn/ai-workspace/lms-graph/10000001/video/90000001?is_chapter=1'],
  ['雨课堂主站 · 目录', 'https://www.yuketang.cn/v2/web/studentLog/10000001'],
  ['雨课堂主站 · 播放', 'https://www.yuketang.cn/ai-workspace/lms-graph/10000001/video/90000001'],
  ['旧版路径 · 学习内容', 'https://changjiang.yuketang.cn/pro/lms/SIGNPLACEHOLDER/10000001/studycontent'],
  ['学堂在线', 'https://www.xuetangx.com/course/xxx/10000001'],
  ['学校自建入口(示例)', 'https://yuketang.example.edu.cn/v2/web/studentLog/10000001'],
];

console.log('=== ① @match 覆盖检查 ===');
console.log('脚本当前规则:');
matches.forEach((m) => console.log('   ' + m));
console.log('');
for (const [label, url] of SAMPLES) {
  const hit = regs.filter(([, re]) => re.test(url)).map(([r]) => r);
  console.log(`  ${hit.length ? '✓ 覆盖' : '✗ 不覆盖'}  ${label.padEnd(22)} ${url.slice(0, 70)}`);
}

/* ---------- ② 路由识别（逐字对齐 src/01-core.js 的 U.route()） ---------- */
console.log('\n=== ② 路由识别（与源码 U.route() 一致） ===');
function routeOf(url) {
  let p, q;
  try { const u = new URL(url); p = u.pathname; q = u.searchParams; } catch (e) { return null; }
  const pick = (...keys) => { for (const k of keys) { const v = q.get(k); if (v) return v; } return ''; };
  const out = {
    isLogPage: false, isPlayPage: false,
    classroomId: pick('classroom_id', 'classroomId', 'cid'),
    leafId: pick('leaf_id', 'leafId', 'video_id', 'videoId'),
  };
  let m = p.match(/^\/ai-workspace\/lms-graph\/([^/]+)\/([^/]+)\/([^/?#]+)/);
  if (m) { out.classroomId = out.classroomId || m[1]; out.leafId = out.leafId || m[3]; out.isPlayPage = true; }
  m = p.match(/^\/v2\/web\/studentLog\/([^/?#]+)/);
  if (m) { out.classroomId = out.classroomId || m[1]; out.isLogPage = true; }
  m = p.match(/^\/(?:pro\/)?lms\/([^/]+)\/studycontent/);
  if (m) { out.classroomId = out.classroomId || m[1]; out.isLogPage = true; }
  if (!out.isPlayPage && !out.isLogPage) {
    if (/\/(video|audio|ppt|pdf|card|studycontent|studentCards?|lesson)\b/i.test(p)) out.isPlayPage = true;
    else if (/studentLog|course\/detail|my_course|study-list/i.test(p)) out.isLogPage = true;
  }
  return out;
}
for (const [label, url] of SAMPLES) {
  const r = routeOf(url);
  const kind = r ? (r.isLogPage ? '目录页' : r.isPlayPage ? '播放页' : '未识别') : 'ERR';
  console.log(`  ${kind.padEnd(6)} 教室=${String(r && r.classroomId || '-').padEnd(10)} 小节=${String(r && r.leafId || '-').padEnd(10)} ${label}`);
}

/* ---------- ③ 关键依赖清单 ---------- */
console.log('\n=== ③ 脚本工作所依赖的站点特征（换部署/换课程时的风险点） ===');
const deps = [
  ['课程列表接口', '/v2/api/web/logs/learn/<教室>（给出 leaf_id）', '若其它部署接口路径不同 → 无法自动选节'],
  ['播放页路径', '/ai-workspace/lms-graph/<教室>/video/<小节>', '新版播放页；旧版 /pro/lms/.../studycontent 只做保护不导航'],
  ['倍速控件', '.xt_video_player_speed 内的 2.00X 选项', '播放器换实现则倍速点不到'],
  ['完成状态', '.rate-detail .text 与 .nav-progress .progress-num', '换布局则完成判定退化到「媒体播完」'],
  ['下一节入口', '播放列表 → data-next-leaf → 下一个知识点按钮', '有多级兜底'],
  ['课程卡片点击', '被站点悬浮校验拦截（已知不可靠）', '仅在接口失败时才会走到，基本无救'],
];
deps.forEach(([k, v, risk]) => {
  console.log(`  · ${k}`);
  console.log(`      依赖: ${v}`);
  console.log(`      风险: ${risk}`);
});

/* ---------- ④ 课程类型支持 ---------- */
console.log('\n=== ④ 支持的课程内容类型 ===');
const types = [
  ['视频 (type 17)', '支持', '自动播放 + 2 倍速 + 自动跳下一节'],
  ['图文 (type 16)', '跳过', '不做停留，直接跳到下一个视频'],
  ['作业/测验 (type 19)', '跳过', '无法自动作答'],
  ['开课通知 (type 9)', '跳过', '非学习内容'],
  ['考试 / 讨论区', '跳过', '需人工完成'],
  ['直播回放', '未验证', '若走同一播放器则可用'],
  ['音频类小节', '部分支持', '脚本按通用媒体元素处理，完成判定可能退化'],
];
types.forEach(([k, v, note]) => console.log(`  ${v.padEnd(6)} ${k.padEnd(20)} ${note}`));

console.log('\n=== 结论 ===');
console.log('  同一套雨课堂（长江雨课堂）下的其它课程：可直接使用（脚本从 URL 取教室号，无需改代码）');
console.log('  同一租户的其它班级/学期：可直接使用');
console.log('  其它学校的雨课堂部署：@match 覆盖没问题，但「课程列表接口」与「播放器控件」需实测；');
console.log('      若接口路径不同，自动选节会退化为「点击卡片」——而卡片点击被站点拦截，可能卡住。');

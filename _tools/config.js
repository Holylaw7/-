#!/usr/bin/env node
/**
 * 通用配置 —— 所有工具共用。
 *
 * 仓库里不含任何个人/课程私有信息。使用者通过下面任一方式提供自己的参数
 * （优先级从高到低）：
 *
 *   1. 命令行参数     node tool.js --classroom 你的教室号
 *   2. 环境变量       set YKT_CLASSROOM=你的教室号
 *   3. 本地配置文件   _tools/local.config.json（已 gitignore，不会提交）
 *   4. 自动探测缓存   由 _tools/config-init.js 从浏览器当前标签页读取
 *
 * 一键自动探测： node _tools/config-init.js
 */
const fs = require('fs');
const path = require('path');

const LOCAL_CONFIG = path.join(__dirname, 'local.config.json');
const STATE_DIR = path.join(__dirname, '..', '.local-state');
const CACHE_FILE = path.join(STATE_DIR, 'detected.json');
const PLACEHOLDER = '00000000';

function argOf(name) {
  const i = process.argv.indexOf('--' + name);
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) return process.argv[i + 1];
  const pref = '--' + name + '=';
  const hit = process.argv.find((a) => a.startsWith(pref));
  return hit ? hit.slice(pref.length) : null;
}
function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return {}; }
}

const local = readJson(LOCAL_CONFIG);
const cached = readJson(CACHE_FILE);

function pick(name, envName, fallback) {
  const v = argOf(name)
    || process.env[envName]
    || (local[name] !== undefined && local[name] !== '' ? String(local[name]) : null)
    || (cached[name] !== undefined && cached[name] !== '' ? String(cached[name]) : null);
  return v === null || v === undefined ? fallback : v;
}

const CONFIG = {
  /**
   * 本项目的 GitHub 仓库（单一来源）。
   *
   * 脚本头部（src/00-header.txt）里的 @namespace / @homepageURL / @supportURL /
   * @updateURL / @downloadURL，以及 README 里的安装链接，都应与这里保持一致。
   * 改仓库名或换账号时，只需替换这些文件里的同一字符串（见 _tools/rename-repo.js），
   * 不必再到各处零散地找。
   */
  repo: String(pick('repo', 'GITHUB_REPO_FULL', 'Holylaw7/changjiang-yuketang-auto')),
  repoBranch: String(pick('repo-branch', 'GITHUB_REPO_BRANCH', 'main')),

  /** 雨课堂站点（长江雨课堂；换成你所在学校的入口即可） */
  origin: String(pick('origin', 'YKT_ORIGIN', 'https://changjiang.yuketang.cn')).replace(/\/+$/, ''),
  /** 教室号：学习日志 URL 里的那串数字 */
  classroom: String(pick('classroom', 'YKT_CLASSROOM', PLACEHOLDER)),
  /** 学校 id（机构代码，URL 里的 uv_id / university_id） */
  universityId: String(pick('university-id', 'YKT_UNIVERSITY_ID', '')),
  /** 平台 id */
  platformId: String(pick('platform-id', 'YKT_PLATFORM_ID', '3')),
  /** 指定测试用小节（可选，不填则用课程里第一个视频小节） */
  leaf: String(pick('leaf', 'YKT_LEAF', '')),
  /** 调试端口 */
  cdpPort: Number(pick('port', 'CDP_PORT', 9222)),
  /** 本地仿真服务器端口 */
  mockPort: Number(pick('mock-port', 'MOCK_PORT', 8099)),
  /** 本地状态目录（自动探测缓存，已 gitignore） */
  stateDir: STATE_DIR,
};

CONFIG.PLACEHOLDER = PLACEHOLDER;
CONFIG.isConfigured = () => !!CONFIG.classroom && CONFIG.classroom !== PLACEHOLDER;

CONFIG.url = {
  studentLog: (classroom) => CONFIG.origin + '/v2/web/studentLog/' + (classroom || CONFIG.classroom),
  video: (leafId, classroom) => CONFIG.origin + '/ai-workspace/lms-graph/' + (classroom || CONFIG.classroom) + '/video/' + leafId + '?is_chapter=1',
  activities: (page, classroom) => CONFIG.origin + '/v2/api/web/logs/learn/' + (classroom || CONFIG.classroom) + '?actype=-1&page=' + (page || 0) + '&offset=20&sort=-1',
  login: () => CONFIG.origin + '/web',
  /** 本仓库在 GitHub 上的地址（页面 / Issues / raw 安装链接） */
  repo: () => 'https://github.com/' + CONFIG.repo,
  issues: () => 'https://github.com/' + CONFIG.repo + '/issues',
  raw: (relPath) => 'https://raw.githubusercontent.com/' + CONFIG.repo + '/'
    + CONFIG.repoBranch + '/' + String(relPath).replace(/^\/+/, ''),
};

CONFIG.mock = {
  /**
   * 本地仿真用的教室号/小节号，**故意是明显的虚构值**，与任何真实课程无关。
   * mock-server.js 与所有仿真测试都从这里取，保证「仿真服务器」与「测试脚本」
   * 永远指向同一个教室 —— 曾经因为两处各写各的（真实教室号 vs 仿真教室号）
   * 而导致整套 e2e 静默失败。
   */
  classroom: String(pick('mock-classroom', 'MOCK_CLASSROOM', '10000001')),
  leafBase: 90000001,
  nodeBase: 70000001,
  origin: () => 'http://127.0.0.1:' + CONFIG.mockPort,
  studentLog: () => 'http://127.0.0.1:' + CONFIG.mockPort + '/v2/web/studentLog/' + CONFIG.mock.classroom,
  video: (leafId) => 'http://127.0.0.1:' + CONFIG.mockPort + '/ai-workspace/lms-graph/' + CONFIG.mock.classroom + '/video/' + leafId + '?is_chapter=1',
};

/** 从任意雨课堂 URL 里解析出教室号 / 小节号 / 学校 id */
CONFIG.parseUrl = function (u) {
  const s = String(u || '');
  const out = { classroom: '', leaf: '', universityId: '', isVideo: false, isStudentLog: false };
  let m = s.match(/\/ai-workspace\/lms-graph\/([^/]+)\/([^/]+)\/([^/?#]+)/);
  if (m) { out.classroom = m[1]; out.leaf = decodeURIComponent(m[3]); out.isVideo = m[2] === 'video'; }
  m = s.match(/\/v2\/web\/studentLog\/([^/?#]+)/);
  if (m) { out.classroom = out.classroom || m[1]; out.isStudentLog = true; }
  m = s.match(/\/pro\/lms\/[^/]+\/(\d+)\//);
  if (m) out.classroom = out.classroom || m[1];
  try {
    const q = new URL(s).searchParams;
    if (!out.classroom) out.classroom = q.get('classroom_id') || q.get('classroomId') || '';
    if (!out.leaf) out.leaf = q.get('leaf_id') || q.get('video_id') || '';
    out.universityId = q.get('university_id') || q.get('uv_id') || '';
  } catch (e) { }
  return out;
};

/** 把探测到的参数写入本地配置（不提交） */
CONFIG.saveLocal = function (patch) {
  const merged = Object.assign({}, local, patch || {});
  fs.writeFileSync(LOCAL_CONFIG, JSON.stringify(merged, null, 2), 'utf8');
  return merged;
};

/** 缓存探测结果（供未显式配置时使用） */
CONFIG.saveCache = function (patch) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    const merged = Object.assign({}, cached, patch || {});
    fs.writeFileSync(CACHE_FILE, JSON.stringify(merged, null, 2), 'utf8');
    return merged;
  } catch (e) { return cached; }
};

CONFIG.describe = function () {
  return [
    'origin      : ' + CONFIG.origin,
    'classroom   : ' + CONFIG.classroom + (CONFIG.isConfigured() ? '' : '   <-- 占位值，需要先配置（node _tools/config-init.js）'),
    'universityId: ' + (CONFIG.universityId || '(未设置)'),
    'leaf        : ' + (CONFIG.leaf || '(自动选择)'),
    'cdpPort     : ' + CONFIG.cdpPort,
    'mockPort    : ' + CONFIG.mockPort,
    '配置文件    : ' + (fs.existsSync(LOCAL_CONFIG) ? LOCAL_CONFIG : '(未创建，可运行 _tools/config-init.js)'),
  ].join('\n');
};

/** 若未配置则打印指引并返回 false（工具入口处调用） */
CONFIG.require = function (toolName) {
  if (CONFIG.isConfigured()) return true;
  console.error([
    '',
    '尚未配置教室号。' + (toolName ? '（' + toolName + '）' : ''),
    '',
    '  任选一种方式：',
    '    1) 自动探测（需先用带调试端口的 Edge 打开课程页）',
    '         node _tools/config-init.js',
    '    2) 命令行传入',
    '         node ' + (toolName || 'tool.js') + ' --classroom 你的教室号',
    '    3) 环境变量',
    '         set YKT_CLASSROOM=你的教室号',
    '    4) 手动创建 _tools/local.config.json',
    '         { "classroom": "你的教室号", "universityId": "你的学校id" }',
    '',
    '  教室号就是「课程学习日志」页 URL 结尾的那串数字：',
    '      <站点>/v2/web/studentLog/<教室号>',
    '',
  ].join('\n'));
  return false;
};

/** 从浏览器当前标签页自动探测（异步） */
CONFIG.detect = async function () {
  const found = { classroom: '', universityId: '', origin: '', leaf: '' };
  try {
    const res = await fetch('http://127.0.0.1:' + CONFIG.cdpPort + '/json/list', { signal: AbortSignal.timeout(4000) });
    const list = await res.json();
    const pages = list.filter(function (t) { return t.type === 'page' && /yuketang/i.test(t.url); });
    for (const p of pages) {
      const parsed = CONFIG.parseUrl(p.url);
      if (parsed.classroom && parsed.classroom !== PLACEHOLDER) {
        found.classroom = parsed.classroom;
        found.leaf = parsed.leaf || found.leaf;
        found.universityId = parsed.universityId || found.universityId;
        found.origin = (String(p.url).match(/^https?:\/\/[^/]+/) || [''])[0];
        break;
      }
    }
    if (!found.classroom && pages.length) {
      const ws = new WebSocket(pages[0].webSocketDebuggerUrl);
      await new Promise(function (r, j) { ws.onopen = r; ws.onerror = function () { j(new Error('ws fail')); }; });
      const expr = '(function(){' +
        'var q=new URLSearchParams(location.search);' +
        'var c=q.get("classroom_id")||q.get("classroomId")||"";' +
        'if(!c){var a=document.querySelector("a[href*=studentLog/],a[href*=lms-graph/]");' +
        'if(a){var m=a.href.match(/studentLog\\/(\\d+)|lms-graph\\/(\\d+)/);if(m)c=m[1]||m[2];}}' +
        'return JSON.stringify({classroom:c,university:q.get("university_id")||q.get("uv_id")||""});})()';
      const r = await new Promise(function (res2) {
        const h = function (ev) {
          const m = JSON.parse(ev.data);
          if (m.id === 1) { ws.removeEventListener('message', h); res2(m.result); }
        };
        ws.addEventListener('message', h);
        ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', returnByValue: true, expression: expr }));
      });
      ws.close();
      try {
        const d = JSON.parse((r && r.result && r.result.value) || '{}');
        found.classroom = found.classroom || d.classroom || '';
        found.universityId = found.universityId || d.university || '';
      } catch (e) { }
    }
  } catch (e) { /* 浏览器不可用，忽略 */ }
  return found;
};


/**
 * 默认站点：已知入口自动映射，未知入口按主机名推导。
 * 这样换学校/换站点时不需要改代码。
 */
CONFIG.resolveOrigin = function (given) {
  const s = String(given || '').trim();
  if (!s) return CONFIG.origin;
  if (/^https?:\/\//i.test(s)) return s.replace(/\/+$/, '');
  const known = {
    changjiang: 'https://changjiang.yuketang.cn',
    yuketang: 'https://www.yuketang.cn',
    xuetangx: 'https://www.xuetangx.com',
  };
  if (known[s]) return known[s];
  return 'https://' + s.replace(/\/+$/, '');
};

/** 让工具支持 --origin changjiang 这类简写，也支持完整 URL */
CONFIG.applyOriginArg = function () {
  const a = argOf('origin');
  if (a) CONFIG.origin = CONFIG.resolveOrigin(a);
  return CONFIG.origin;
};

/**
 * 取一个可用于测试的视频小节 id。
 * 优先用显式配置（--leaf / YKT_LEAF / local.config.json），
 * 否则从浏览器当前标签页读取；再不行才用占位值。
 */
CONFIG.pickLeaf = async function () {
  if (CONFIG.leaf && CONFIG.leaf !== PLACEHOLDER) return CONFIG.leaf;
  try {
    const res = await fetch('http://127.0.0.1:' + CONFIG.cdpPort + '/json/list', { signal: AbortSignal.timeout(4000) });
    const list = await res.json();
    const pages = list.filter(function (t) { return t.type === 'page' && /yuketang/i.test(t.url); });
    for (const p of pages) {
      const parsed = CONFIG.parseUrl(p.url);
      if (parsed.leaf) { CONFIG.leaf = parsed.leaf; return parsed.leaf; }
    }
  } catch (e) { }
  return CONFIG.leaf || PLACEHOLDER;
};

/**
 * 从课程活动接口取「第一个视频小节」的 id（type 17 = 视频）。
 * 需要页面上下文（同源 + 登录态），因此只能从浏览器里发起。
 * 返回 { leaf, title, classroom }
 */
CONFIG.pickFirstVideoLeaf = async function () {
  const classroom = CONFIG.classroom;
  if (!classroom || classroom === PLACEHOLDER) return null;
  try {
    const res = await fetch('http://127.0.0.1:' + CONFIG.cdpPort + '/json/list', { signal: AbortSignal.timeout(4000) });
    const list = await res.json();
    const pages = list.filter(function (t) { return t.type === 'page' && /yuketang/i.test(t.url); });
    if (!pages.length) return null;
    const ws = new WebSocket(pages[0].webSocketDebuggerUrl);
    await new Promise(function (r, j) { ws.onopen = r; ws.onerror = function () { j(new Error('ws fail')); }; });
    const expr = '(async function(){' +
      'var out=[];for(var page=0;page<40;page++){' +
      'var r=await fetch("/v2/api/web/logs/learn/' + classroom + '?actype=-1&page="+page+"&offset=20&sort=-1",{credentials:"include"});' +
      'var j=await r.json();var d=j.data||{};(d.activities||[]).forEach(function(a){' +
      'var c=a.content||{};if(c.leaf_id&&Number(a.type)===17)out.push({leaf:String(c.leaf_id),title:a.title});});' +
      'if(!d.has_more)break;}' +
      'out.sort(function(a,b){return Number(a.leaf)-Number(b.leaf)});' +
      'return JSON.stringify(out.slice(0,5));})()';
    const r = await new Promise(function (res2) {
      const h = function (ev) {
        const m = JSON.parse(ev.data);
        if (m.id === 1) { ws.removeEventListener('message', h); res2(m.result); }
      };
      ws.addEventListener('message', h);
      ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', returnByValue: true, awaitPromise: true, expression: expr }));
    });
    ws.close();
    const arr = JSON.parse((r && r.result && r.result.value) || '[]');
    if (arr.length) { CONFIG.leaf = arr[0].leaf; return arr[0]; }
  } catch (e) { }
  return null;
};

/**
 * 工具入口统一调用：解析参数、必要时从浏览器补全配置。
 * 返回 true 表示可以继续。
 */
CONFIG.bootstrap = async function (toolName, opts) {
  const o = opts || {};
  CONFIG.applyOriginArg();
  if (!CONFIG.require(toolName)) return false;
  // 未指定 origin 时，尽量从浏览器当前页推导
  const res = await CONFIG.detect();
  if (!argOf('origin') && res.origin) CONFIG.origin = CONFIG.resolveOrigin(res.origin);
  if (!argOf('university-id') && !CONFIG.universityId && res.universityId) CONFIG.universityId = res.universityId;
  if (o.needLeaf) {
    if (!CONFIG.leaf) CONFIG.leaf = res.leaf || '';
    if (!CONFIG.leaf) {
      const first = await CONFIG.pickFirstVideoLeaf();
      if (first) CONFIG.leaf = first.leaf;
    }
  }
  return true;
};

/** 需要一个可用小节时调用，拿不到就报错退出 */
CONFIG.requireLeaf = async function (toolName) {
  const leaf = await CONFIG.pickLeaf();
  if (!leaf || leaf === PLACEHOLDER) {
    console.error('未能确定要操作的小节 id。请用 --leaf <小节id> 指定，或先运行 node _tools/config-init.js');
    return null;
  }
  return leaf;
};

module.exports = CONFIG;

if (require.main === module) {
  console.log(CONFIG.describe());
}

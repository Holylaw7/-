#!/usr/bin/env node
/**
 * 长江雨课堂 —— 本地仿真服务器 (mock)
 *
 * 目的：在没有登录态的情况下，复刻长江雨课堂视频播放页的真实 DOM 结构与
 *      「后台暂停 / 切屏降速」的反挂机逻辑，用于端到端验证本用户脚本。
 *
 * 复刻的关键行为（与真实站点一致）：
 *   1. DOM 使用 xt-* 自定义元素播放器  <xt-wrap>/<xt-controls>/<xt-speedbutton>/<xt-speedlist>
 *   2. document.visibilitychange / window.blur 触发 -> 自动 pause
 *   3. 切后台后把 playbackRate 重置成 1
 *   4. 长时间无鼠标移动 -> 弹「好好学习」遮罩弹窗
 *   5. 服务端 /video-log/heartbeat/ 统计进度；上报 hidden 时只按 1 倍速计进度
 *      => 只有真正防住了后台检测，才能在 2 倍速下快速刷完
 *
 * 用法: node mock-server.js [port]
 */
const http = require('http');
const fs = require('fs');
const CONFIG = require('./config');
const path = require('path');
const url = require('url');

const PORT = Number(process.argv[2] || 8099);
const PUBLIC = path.join(__dirname, 'public');

// ------------------------------------------------------------------ 数据集
const CLASSROOM_ID = CONFIG.mock.classroom;   // 仿真用虚构教室号，与真实课程无关
const UNIVERSITY_ID = '1000';       // 虚构学校 id
const PLATFORM_ID = '3';

// 仿真素材的真实时长（由 _tools/make-webm.js 写入）
const CLIP = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(PUBLIC, 'media', 'clip.json'), 'utf8'));
  } catch (e) {
    return { duration: 8 };
  }
})();
const CLIP_DURATION = Number(CLIP.duration) || 8;

function makeLeaves() {
  const items = [
    { leaf_type: 0, name: '1.1 绪论：为什么要学习这门课', kind: 'video', duration: CLIP_DURATION },
    { leaf_type: 0, name: '1.2 基本概念与研究对象', kind: 'video', duration: CLIP_DURATION },
    { leaf_type: 0, name: '1.3 章节测验（应被自动跳过）', kind: 'quiz', duration: 0 },
    { leaf_type: 0, name: '1.4 学科发展简史', kind: 'video', duration: CLIP_DURATION },
    { leaf_type: 0, name: '1.5 小结与延伸阅读', kind: 'video', duration: CLIP_DURATION },
  ];
  return items.map((it, i) => ({
    ...it,
    leaf_id: String(CONFIG.mock.leafBase + i),
    node_id: String(CONFIG.mock.nodeBase + i),
    index: i,
    // 服务端已记录的最大播放秒数（用于断点续播 / 完成判定）
    server_seconds: 0,
    server_done: false,
  }));
}

const STATE = {
  leaves: makeLeaves(),
  // 每个 leaf 的心跳日志
  beats: {},
  // 客户端上一次上报是否处于后台
  hiddenReports: 0,
  visibleReports: 0,
  // 真实墙钟时间与累计播放秒数，用于判定是否真的用了倍速
  startedAt: Date.now(),
  doneAt: null,
};

function leafById(id) {
  return STATE.leaves.find((l) => l.leaf_id === String(id));
}
function nextLeaf(id) {
  const i = STATE.leaves.findIndex((l) => l.leaf_id === String(id));
  if (i < 0) return null;
  for (let j = i + 1; j < STATE.leaves.length; j++) {
    if (STATE.leaves[j].kind === 'video') return STATE.leaves[j];
  }
  return null;
}
function completedCount() {
  return STATE.leaves.filter((l) => l.server_done).length;
}
function percentOf(leaf) {
  if (!leaf || !leaf.duration) return 0;
  if (leaf.server_done) return 100;
  return Math.max(0, Math.min(100, Math.floor((leaf.server_seconds / leaf.duration) * 100)));
}
/** 测试控制面：暴露服务端侧事实，供自动化断言使用 */
function controlState(res) {
  return json(res, {
    classroom_id: CLASSROOM_ID,
    leaves: STATE.leaves.map((l) => ({
      id: l.leaf_id, name: l.name, kind: l.kind,
      done: l.server_done, pct: percentOf(l), seconds: Number(l.server_seconds.toFixed(2)),
    })),
    completed: completedCount(),
    total: STATE.leaves.length,
    videoTotal: STATE.leaves.filter((l) => l.kind === 'video').length,
    hiddenReports: STATE.hiddenReports,
    visibleReports: STATE.visibleReports,
    doneAll: STATE.leaves.filter((l) => l.kind === 'video').every((l) => l.server_done),
    elapsedMs: (STATE.doneAt || Date.now()) - STATE.startedAt,
  });
}

// ------------------------------------------------------------------ 工具
function send(res, code, body, headers = {}) {
  res.writeHead(code, {
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    ...headers,
  });
  res.end(body);
}
function json(res, obj, code = 200) {
  send(res, code, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8' });
}
function readBody(req) {
  return new Promise((resolve) => {
    let d = '';
    req.on('data', (c) => (d += c));
    req.on('end', () => {
      try {
        resolve(d ? JSON.parse(d) : {});
      } catch (_) {
        resolve({ raw: d });
      }
    });
  });
}
function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}

// ------------------------------------------------------------------ 页面模板
// 注意：anti-cheat 以 <script> 同步内联方式注入 head，且在站点脚本之前执行，
//       与真实站点「先注册可见性监听、再挂播放器」的顺序保持一致。
const PAGE_SHELL = (title, assets, body) => `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<link rel="stylesheet" href="/static/app.css">
<script src="/static/anticheat.js"></script>
</head><body data-theme="light">
<div id="app">${body}</div>
${assets.map((a) => `<script src="${a}"></script>`).join('\n')}
</body></html>`;

// 反挂机逻辑已抽到 public/static/anticheat.js，由 PAGE_SHELL 在 head 中以同步脚本注入
// （与真实站点「先注册可见性监听、再挂播放器」的顺序一致）

// ------------------------------------------------------------------ 路由
const server = http.createServer(async (req, res) => {
  const u = url.parse(req.url, true);
  const p = u.pathname;
  const cookies = parseCookies(req);
  const authed = cookies.mock_session === 'ok';

  // ------------------------------------------------ 静态资源
  if (p.startsWith('/static/') || p.startsWith('/media/')) {
    const file = path.join(PUBLIC, p.replace(/^\//, ''));
    if (!file.startsWith(PUBLIC) || !fs.existsSync(file)) return send(res, 404, 'not found');
    const ext = path.extname(file);
    const types = {
      '.js': 'application/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.html': 'text/html; charset=utf-8',
      '.wav': 'audio/wav',
      '.webm': 'video/webm',
      '.mp4': 'video/mp4',
      '.json': 'application/json; charset=utf-8',
    };
    const type = types[ext] || 'application/octet-stream';
    const stat = fs.statSync(file);
    // 支持 Range 请求，媒体元素会用到
    const range = req.headers.range;
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      const start = m && m[1] ? Number(m[1]) : 0;
      const end = m && m[2] ? Number(m[2]) : stat.size - 1;
      res.writeHead(206, {
        'Content-Type': type,
        'Content-Range': `bytes ${start}-${end}/${stat.size}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': end - start + 1,
        'Cache-Control': 'no-store',
      });
      return fs.createReadStream(file, { start, end }).pipe(res);
    }
    return send(res, 200, fs.readFileSync(file), { 'Content-Type': type, 'Accept-Ranges': 'bytes' });
  }

  // ------------------------------------------------ 登录
  if (p === '/web' || p === '/') {
    if (!authed) {
      const next = u.query.next || '/v2/web/index';
      return send(res, 200, PAGE_SHELL('长江雨课堂网页版-登录', ['/static/login.js'], `
        <div class="login-wrap">
          <h2>长江雨课堂（本地仿真）</h2>
          <p>此页面用于验证用户脚本，无需真实账号。</p>
          <button id="btn-login" class="primary">一键登录</button>
        </div>`), { 'Content-Type': 'text/html; charset=utf-8' });
    }
    return send(res, 302, '', { Location: '/v2/web/index' });
  }

  if (p === '/api/mock/login') {
    return send(res, 200, JSON.stringify({ success: true }), {
      'Content-Type': 'application/json',
      'Set-Cookie': 'mock_session=ok; Path=/; Max-Age=86400',
    });
  }

  // 测试控制面：不受登录态限制
  if (p === '/__state') return controlState(res);
  if (p === '/__beats') {
    const id = u.query.leaf_id;
    const beats = id ? (STATE.beats[id] || []) : Object.values(STATE.beats).flat();
    const leaf = id ? leafById(id) : null;
    return json(res, {
      leaf_id: id || null,
      count: beats.length,
      total: leaf ? Number(leaf.server_seconds.toFixed(3)) : null,
      beats: beats.slice(-40),
    });
  }
  if (p === '/__reset') {
    STATE.leaves = makeLeaves();
    STATE.beats = {};
    STATE.hiddenReports = 0;
    STATE.visibleReports = 0;
    STATE.startedAt = Date.now();
    STATE.doneAt = null;
    return json(res, { ok: true });
  }
  if (p === '/__expect') {
    const fails = [];
    const vids = STATE.leaves.filter((l) => l.kind === 'video');
    const undone = vids.filter((l) => !l.server_done);
    if (undone.length) fails.push('存在未完成的视频: ' + undone.map((l) => l.name).join(', '));
    if (STATE.hiddenReports > 0) fails.push('页面曾以「后台」状态上报心跳 ' + STATE.hiddenReports + ' 次');
    const quiz = STATE.leaves.find((l) => l.kind === 'quiz');
    if (quiz && quiz.server_seconds > 0) fails.push('测验页被误播放');
    return json(res, { ok: fails.length === 0, fails });
  }

  if (!authed) {
    if (p.startsWith('/api/')) return json(res, { success: false, op: 'web_redirect', url: '/web?next=' + encodeURIComponent(p) }, 200);
    return send(res, 302, '', { Location: '/web?next=' + encodeURIComponent(u.pathname + (u.search || '')) });
  }

  // ------------------------------------------------ 课程目录页
  if (p === '/v2/web/index' || p === '/v2/web') {
    return send(res, 302, '', { Location: `/v2/web/studentLog/${CLASSROOM_ID}` });
  }

  if (p.startsWith('/v2/web/studentLog/')) {
    const list = STATE.leaves.map((l) => `
      <li class="leaf-item${l.server_done ? ' is-done' : ''}" data-leaf-id="${l.leaf_id}" data-kind="${l.kind}">
        <div class="leaf-item__title">${l.name}</div>
        <div class="leaf-item__status">${l.server_done ? '已完成' : percentOf(l) + '%'}</div>
      </li>`).join('');
    return send(res, 200, PAGE_SHELL('雨课堂', ['/static/log.js'], `
      <div class="logs-page">
        <header class="logs-head">
          <h2>课程学习日志</h2>
          <div class="overall">已完成 ${completedCount()}/${STATE.leaves.length}</div>
        </header>
        <ul class="leaf-list">${list}</ul>
      </div>`), { 'Content-Type': 'text/html; charset=utf-8' });
  }

  // ------------------------------------------------ 课程活动列表接口
  //
  //  真站实测：脚本靠这个接口拿 leaf_id 直接跳 URL（绕开被反自动化校验挡住的
  //  卡片点击）。仿真环境必须同样提供，否则脚本在目录页永远无法进入播放页。
  //
  //  GET /v2/api/web/logs/learn/<教室>?actype=-1&page=N&offset=20&sort=-1
  //  返回 data.activities[].content.leaf_id / title / type, data.has_more
  const mActs = p.match(/^\/v2\/api\/web\/logs\/learn\/([^/?#]+)/);
  if (mActs) {
    const offset = Number(u.query.offset || 20) || 20;
    const page = Number(u.query.page || 0) || 0;
    const from = page * offset;
    const slice = STATE.leaves.slice(from, from + offset);
    const activities = slice.map((l, i) => ({
      classroom_id: Number(CLASSROOM_ID),
      title: l.name,
      // 真站里 content.leaf_id 才是小节 id；type 17 = 视频
      content: { is_open_type: false, sku_id: 0, leaf_id: Number(l.leaf_id), leaf_type_id: null },
      courseware_id: String(2000000 + from + i),
      create_time: 1700000000000 + (from + i) * 1000,
      type: l.kind === 'video' ? 17 : l.kind === 'quiz' ? 19 : 16,
      id: 30000000 + from + i,
    }));
    return json(res, {
      msg: '',
      success: true,
      data: {
        IS_SIMPLE: false,
        prev_id: null,
        activities,
        has_more: from + offset < STATE.leaves.length,
      },
    });
  }

  // ------------------------------------------------ 视频播放页（ai-workspace/lms-graph）
  const mGraph = p.match(/^\/ai-workspace\/lms-graph\/([^/]+)\/([^/]+)\/([^/?#]+)/);
  if (mGraph) {
    const type = mGraph[2];
    const leafId = decodeURIComponent(mGraph[3]);
    const leaf = leafById(leafId);
    if (!leaf) return send(res, 404, 'leaf not found');
    if (type !== 'video') {
      // 测验等其它类型：脚本应当跳过
      return send(res, 200, PAGE_SHELL('学习空间', [], `
        <div class="quiz-page" data-leaf-id="${leafId}">
          <h3>${leaf.name}</h3><p>测验页面：脚本应跳过，不进入。</p>
        </div>`), { 'Content-Type': 'text/html; charset=utf-8' });
    }
    const nl = nextLeaf(leafId);
    const nav = STATE.leaves.map((l) => `
        <li class="nav-item-leaf-box${l.leaf_id === leafId ? ' is-active' : ''}" data-leaf-id="${l.leaf_id}" data-kind="${l.kind}">
          <span class="nav-item-leaf-box__name">${l.name}</span>
          <span class="nav-item-leaf-box__state">${l.server_done ? '已完成' : percentOf(l) + '%'}</span>
        </li>`).join('');
    return send(res, 200, PAGE_SHELL('学习空间', ['/static/player.js'], `
      <div class="lms-graph-layout">
        <main class="main-content">
          <div class="video-box" id="video-box" data-leaf-id="${leafId}"
               data-next-leaf="${nl ? nl.leaf_id : ''}"
               data-classroom-id="${CLASSROOM_ID}" data-duration="${leaf.duration}">
            <div class="title">${leaf.name}</div>
            <div class="progress-wrap"><span class="text">${percentOf(leaf)}%</span></div>
            <xt-wrap>
              <video id="mock-media" src="/media/clip.webm" preload="auto" loop playsinline></video>
              <xt-controls>
                <xt-inner>
                  <xt-playbutton><xt-icon><i class="xt_video_player_play_btn"></i></xt-icon>
                    <span class="play-btn-tip">播放</span></xt-playbutton>
                  <span class="xt_video_player_current_time_display">00:00 / 00:06</span>
                  <xt-volumebutton><xt-icon><i class="xt_video_player_volume_btn"></i></xt-icon></xt-volumebutton>
                  <xt-speedbutton class="xt_video_player_speed">
                    <xt-speedvalue class="xt_video_player_common_value">1.00X</xt-speedvalue>
                    <xt-speedlist class="xt_video_player_common_list_wrap">
                      <xt-button data-speed="0.5" keyt="0.50">0.50X</xt-button>
                      <xt-button data-speed="1" keyt="1.00">1.00X</xt-button>
                      <xt-button data-speed="1.5" keyt="1.50">1.50X</xt-button>
                      <xt-button data-speed="2" keyt="2.00">2.00X</xt-button>
                    </xt-speedlist>
                  </xt-speedbutton>
                </xt-inner>
              </xt-controls>
            </xt-wrap>
          </div>
        </main>
        <aside class="course-nav"><ul class="nav-list">${nav}</ul></aside>
      </div>`), { 'Content-Type': 'text/html; charset=utf-8' });
  }

  // ------------------------------------------------ 心跳接口（进度上报）
  if (p === '/video-log/heartbeat/' && req.method === 'POST') {
    const body = await readBody(req);
    const leafId = String(body.leaf_id || body.leafId || '');
    const leaf = leafById(leafId);
    const isHidden = !!body.is_hidden || body.visibility === 'hidden' || !!body.hidden;
    if (leaf) {
      const key = leafId;
      STATE.beats[key] = STATE.beats[key] || [];
      // 上报的时长（秒）
      const reported = Number(body.played_duration || body.duration || body.play_time || 0);
      // 关键：只有页面自认为「可见」时才按上报倍速计入进度
      const rate = isHidden ? 1 : Number(body.rate || body.playback_rate || 1);
      if (isHidden) STATE.hiddenReports++; else STATE.visibleReports++;
      // 单次心跳的入账上限：必须 >= 心跳间隔 × 最大倍速，否则会永久少算进度
      // （心跳 1.2s × 2x = 2.4s，留出余量取 3s）
      const credited = Math.min(reported, 3) * (isHidden ? 1 : rate);
      leaf.server_seconds = Math.min(leaf.duration, leaf.server_seconds + credited);
      if (leaf.server_seconds >= leaf.duration - 0.05) {
        leaf.server_done = true;
        if (STATE.leaves.every((l) => l.kind !== 'video' || l.server_done)) STATE.doneAt = Date.now();
      }
      STATE.beats[key].push({ t: Date.now(), isHidden, reported, rate, credited, total: leaf.server_seconds });
    }
    // 真实站点的心跳响应会带回该小节的最新进度，播放器的进度条依赖它
    return json(res, {
      success: true,
      errcode: 0,
      data: {
        leaf_id: leafId,
        hidden: isHidden,
        watch_progress: leaf ? percentOf(leaf) : 0,
        is_done: leaf ? leaf.server_done : false,
      },
    });
  }

  // ------------------------------------------------ 进度查询
  if (p === '/video-log/get_video_watch_progress/') {
    const leaf = leafById(u.query.leaf_id || u.query.video_id);
    return json(res, { success: true, errcode: 0, data: { watch_progress: leaf ? percentOf(leaf) : 0 } });
  }

  // ------------------------------------------------ 测试控制面
  if (p === '/__state') return controlState(res);

  return send(res, 404, 'not found: ' + p);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[mock] 长江雨课堂仿真服务已启动: http://127.0.0.1:${PORT}/web`);
  console.log(`[mock] 课程目录: http://127.0.0.1:${PORT}/v2/web/studentLog/${CLASSROOM_ID}`);
  console.log(`[mock] 控制面:   http://127.0.0.1:${PORT}/__state`);
});

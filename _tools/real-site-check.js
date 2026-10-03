#!/usr/bin/env node
/**
 * 真实环境诊断：连接你自己那台已经登录的 Edge，检查脚本到底有没有生效。
 *
 * 前置：Edge 必须带调试端口启动（见 _tools/start-edge-debug.cmd）
 *
 *   node _tools/real-site-check.js                 # 只报告，不改变你页面上的任何东西
 *   node _tools/real-site-check.js --navigate      # 额外打开课程页做一次完整接管测试
 *
 * 这个脚本**不会**替你点击、不会提交任何数据；--navigate 只做一次页面跳转。
 */
const CONFIG = require('./config');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.CDP_PORT || 9222);
const COURSE_URL = process.argv.find((a) => /^https?:\/\//.test(a))
  || CONFIG.origin + `/ai-workspace/lms-graph/${CONFIG.classroom}/video/${LEAF}?is_chapter=1`;
const DO_NAV = process.argv.includes('--navigate');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LEAF = CONFIG.leaf || process.argv[2] || CONFIG.PLACEHOLDER;

class Session {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); }
  static async connect(u) {
    const ws = new WebSocket(u);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws connect failed')); });
    const s = new Session(ws);
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && s.pending.has(m.id)) {
        const { res, rej } = s.pending.get(m.id);
        s.pending.delete(m.id);
        m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
      }
    };
    return s;
  }
  send(method, params = {}, t = 30000) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error('timeout ' + method)); } }, t);
    });
  }
  async eval(expr, awaitPromise = false) {
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise, userGesture: true });
    if (r.exceptionDetails) return { error: r.exceptionDetails.exception?.description || 'eval error' };
    return { value: r.result.value };
  }
}

async function listTargets() {
  const r = await fetch(`http://127.0.0.1:${PORT}/json/list`, { signal: AbortSignal.timeout(5000) });
  return (await r.json()).filter((t) => t.type === 'page');
}

const INSPECT = `(function () {
  var frames = [];
  try {
    for (var i = 0; i < window.frames.length; i++) {
      var f = window.frames[i];
      var info = { index: i, sameOrigin: true, src: null, videoCount: null, note: null };
      try { info.src = f.location.href; } catch (e) { info.sameOrigin = false; info.note = '跨域，无法读取内部'; }
      try { if (info.sameOrigin) info.videoCount = f.document.querySelectorAll('video,audio').length; } catch (e) { }
      frames.push(info);
    }
  } catch (e) { }
  var vids = [].slice.call(document.querySelectorAll('video,audio')).map(function (m, i) {
    var r = m.getBoundingClientRect();
    return {
      i: i, tag: m.tagName, id: m.id || null, cls: (m.className || '').toString().slice(0, 60) || null,
      src: (m.currentSrc || m.src || '').slice(0, 120) || null,
      paused: m.paused, rate: m.playbackRate, muted: m.muted,
      t: +Number(m.currentTime).toFixed(2), dur: (function () { var d = Number(m.duration); return isFinite(d) ? +d.toFixed(2) : String(m.duration); })(),
      rs: m.readyState, err: m.error ? { code: m.error.code, msg: m.error.message } : null,
      w: Math.round(r.width), h: Math.round(r.height), visible: r.width > 1 && r.height > 1,
    };
  });
  var probes = ['xt-speedlist', 'xt-speedbutton', 'xt-wrap', '.progress-wrap', '.progress-wrap .text',
                '.video-box', '.leaf-item', '.nav-item-leaf-box', '.statistics-box', '.logs-list',
                '.el-dialog__wrapper', '[class*=progress]', '[class*=speed]'];
  var found = {};
  probes.forEach(function (s) {
    try { found[s] = document.querySelectorAll(s).length; } catch (e) { found[s] = 'err'; }
  });
  var txt = {};
  ['.progress-wrap .text', '.progress-wrap', '.statistics-box .aside'].forEach(function (s) {
    var el = document.querySelector(s);
    if (el) txt[s] = (el.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 80);
  });
  var tool = null;
  try {
    if (window.__yktTool) {
      var st = window.__yktTool.state;
      tool = {
        version: st.version, running: st.running, phase: st.phase, rate: st.rate, paused: st.paused,
        progress: st.progress, mediaTag: st.mediaTag,
        guard: { active: st.guard.active, blockedEvents: st.guard.blockedEvents, blockedPause: st.guard.blockedPause,
                 selfTest: st.guard.selfTest, seenEvents: st.guard.seenEvents },
      };
    }
  } catch (e) { tool = { error: String(e) }; }
  return JSON.stringify({
    url: location.href, title: document.title, top: window.top === window.self,
    panel: !!document.getElementById('ykt-tool-host'),
    tool: tool,
    mediaCount: vids.length,
    media: vids,
    frames: frames,
    selectors: found,
    texts: txt,
    hidden: document.hidden, vis: document.visibilityState, focus: document.hasFocus(),
    hasRawProbe: !!window.__yktRaw,
  }, null, 2);
})()`;

(async () => {
  let pages;
  try {
    pages = await listTargets();
  } catch (e) {
    console.error(`
✗ 连不上 http://127.0.0.1:${PORT}
  说明 Edge 没有带调试端口启动。

  请任选其一：
    · 双击 <项目根>\\_tools\\start-edge-debug.cmd
    · 或让我执行： node _tools/launch-real-edge.js --kill
`);
    process.exit(1);
  }

  console.log(`✓ 已连接你的 Edge，共 ${pages.length} 个标签页\n`);
  console.log('当前打开的标签页：');
  pages.slice(0, 25).forEach((p, i) => {
    const mark = /yuketang/.test(p.url) ? ' ★' : '';
    console.log(`  [${i}]${mark} ${p.title.slice(0, 40)}`);
    console.log(`       ${p.url.slice(0, 130)}`);
  });

  // 找雨课堂标签页；找不到时，若允许导航就用第一个标签页
  let target = pages.find((p) => /yuketang/i.test(p.url));
  const isCoursePage = target && /lms-graph|studentLog|studycontent|studentCards/.test(target.url);
  let reason = '';

  if (!target) {
    if (DO_NAV) {
      target = pages.find((p) => p.url === 'about:blank') || pages[0];
      reason = '（没有雨课堂标签页，改用现有标签页导航过去）';
    } else {
      console.log('\n没有找到雨课堂标签页。');
      console.log('请先在你的 Edge 里打开课程视频页，然后重新运行本脚本；');
      console.log('或者加 --navigate 参数让我直接打开课程页。');
      process.exit(0);
    }
  } else if (!isCoursePage && !DO_NAV) {
    console.log(`\n找到雨课堂标签页但不是课程页：${target.url}`);
    console.log('请切换到课程视频页后重跑，或加 --navigate。');
    process.exit(0);
  }
  if (reason) console.log(`\n${reason}`);

  const s = await Session.connect(target.webSocketDebuggerUrl);
  await s.send('Runtime.enable');
  await s.send('Page.enable');

  if (DO_NAV) {
    console.log(`\n正在打开课程页：${COURSE_URL}`);
    await s.send('Page.navigate', { url: COURSE_URL });
    console.log('等待页面加载并让脚本注入（8 秒）…');
    await sleep(8000);
  }

  const r = await s.eval(INSPECT);
  if (r.error) {
    console.error('读取页面失败:', r.error);
  } else {
    const d = JSON.parse(r.value);
    console.log('\n' + '='.repeat(78));
    console.log('页面信息');
    console.log('='.repeat(78));
    console.log(`URL        : ${d.url}`);
    console.log(`标题       : ${d.title}`);
    console.log(`可见性     : hidden=${d.hidden} visibilityState=${d.vis} hasFocus=${d.focus}`);
    console.log(`控制面板   : ${d.panel ? '✓ 已出现' : '✗ 未出现'}`);
    console.log(`脚本接口   : ${d.tool ? '✓ __yktTool 存在' : '✗ 不存在（脚本没跑起来）'}`);
    if (d.tool && !d.tool.error) {
      console.log(`   版本=${d.tool.version} running=${d.tool.running} phase=${d.tool.phase} 倍速=${d.tool.rate} 暂停=${d.tool.paused} 进度=${d.tool.progress}%`);
      console.log(`   媒体=${d.tool.mediaTag}`);
      console.log(`   守卫: active=${d.tool.guard.active} 拦截事件=${d.tool.guard.blockedEvents} 拦截pause=${d.tool.guard.blockedPause}`);
      console.log(`   自检: ${JSON.stringify(d.tool.guard.selfTest)}`);
      console.log(`   站点监听: ${JSON.stringify(d.tool.guard.seenEvents)}`);
    }

    console.log('\n' + '='.repeat(78));
    console.log('媒体元素');
    console.log('='.repeat(78));
    if (!d.media.length) {
      console.log('✗ 页面里没有 video/audio 元素');
    }
    d.media.forEach((m) => {
      console.log(`  [${m.i}] <${m.tag}${m.id ? '#' + m.id : ''}> ${m.w}x${m.h} 可见=${m.visible}`);
      console.log(`       paused=${m.paused} rate=${m.rate} muted=${m.muted} t=${m.t}/${m.dur} readyState=${m.rs}`);
      console.log(`       err=${JSON.stringify(m.err)}`);
      console.log(`       src=${m.src}`);
    });

    console.log('\n' + '='.repeat(78));
    console.log('iframe 情况（判断播放器是否被嵌在子框架里）');
    console.log('='.repeat(78));
    if (!d.frames.length) console.log('  顶层文档内没有 iframe');
    d.frames.forEach((f) => {
      console.log(`  [${f.index}] sameOrigin=${f.sameOrigin} 内部video数=${f.videoCount}`);
      console.log(`       src=${f.src || f.note}`);
    });

    console.log('\n' + '='.repeat(78));
    console.log('关键选择器命中数（用于判断前端版本是否变化）');
    console.log('='.repeat(78));
    Object.entries(d.selectors).forEach(([k, v]) => {
      console.log(`  ${String(v).padStart(3)}  ${k}`);
    });
    console.log('  文本: ' + JSON.stringify(d.texts));
    console.log('='.repeat(78));
  }

  s.ws.close();
  process.exit(0);
})().catch((e) => {
  console.error('异常:', e && e.stack || e);
  process.exit(1);
});

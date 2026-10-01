#!/usr/bin/env node
/**
 * 深挖真实雨课堂播放页的 DOM 结构（用于校正脚本里的选择器）。
 *   node _tools/real-dom-dump.js
 */
const fs = require('fs');
const path = require('path');
const PORT = Number(process.env.CDP_PORT || 9222);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const OUT = path.join(__dirname, '..', '_recon', 'real-page');

class Session {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); }
  static async connect(u) {
    const ws = new WebSocket(u);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws fail')); });
    const s = new Session(ws);
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && s.pending.has(m.id)) {
        const { res, rej } = s.pending.get(m.id); s.pending.delete(m.id);
        m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
      }
    };
    return s;
  }
  send(method, params = {}, t = 60000) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error('timeout ' + method)); } }, t);
    });
  }
  async eval(expr, aw = false) {
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: aw, userGesture: true });
    if (r.exceptionDetails) return { error: r.exceptionDetails.exception?.description || 'err' };
    return { value: r.result.value };
  }
}

const PROBE = `(function () {
  function path(el) {
    if (!el || el.nodeType !== 1) return '';
    var p = [];
    while (el && el.nodeType === 1 && p.length < 6) {
      var s = el.tagName.toLowerCase();
      if (el.id) { s += '#' + el.id; p.unshift(s); break; }
      if (el.className && typeof el.className === 'string') {
        var c = el.className.trim().split(/\\s+/).slice(0, 3).join('.');
        if (c) s += '.' + c;
      }
      p.unshift(s);
      el = el.parentElement;
    }
    return p.join(' > ');
  }
  function describe(el) {
    if (!el) return null;
    var r = el.getBoundingClientRect();
    return {
      path: path(el),
      tag: el.tagName.toLowerCase(),
      cls: (typeof el.className === 'string' ? el.className : '') || null,
      id: el.id || null,
      text: (el.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 120) || null,
      html: (el.innerHTML || '').replace(/\\s+/g, ' ').trim().slice(0, 200) || null,
      w: Math.round(r.width), h: Math.round(r.height),
      visible: r.width > 1 && r.height > 1,
    };
  }
  var out = {};

  // 1) 所有 class 含 progress / speed / percent / leaf / stat 的元素
  var byClass = {};
  ['progress', 'speed', 'percent', 'leaf', 'stat', 'finish', 'done', 'complete'].forEach(function (kw) {
    var list = [];
    try {
      document.querySelectorAll('[class*=' + kw + ']').forEach(function (el) {
        if (list.length < 14) list.push(describe(el));
      });
    } catch (e) { }
    byClass[kw] = list;
  });
  out.byClass = byClass;

  // 2) 播放器容器的子结构（去掉 video 内部的噪音）
  var box = document.querySelector('.video-box') || document.querySelector('xt-wrap');
  if (box) {
    out.videoBoxPath = path(box);
    out.videoBoxText = (box.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 300);
    out.videoBoxChildren = [].slice.call(box.children).map(function (c) {
      return { path: path(c), cls: c.className || null, text: (c.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 150) };
    });
    // 页面顶部/标题区
    var head = box.parentElement;
    if (head) {
      out.videoBoxParent = { path: path(head), cls: head.className || null };
      out.siblings = [].slice.call(head.children).slice(0, 12).map(function (c) {
        var r = c.getBoundingClientRect();
        return { path: path(c), text: (c.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 120), w: Math.round(r.width), h: Math.round(r.height) };
      });
    }
  }

  // 3) 侧边目录
  var leaves = document.querySelectorAll('[class*=leaf], [class*=nav]');
  out.leafCandidates = [].slice.call(leaves).slice(0, 20).map(describe);

  // 4) 弹窗
  out.dialogs = [].slice.call(document.querySelectorAll('.el-dialog__wrapper, [class*=dialog]')).slice(0, 8).map(describe);

  // 5) 播放器控件与倍速
  ['xt-wrap', 'xt-controls', 'xt-speedbutton', 'xt-speedlist', 'xt-playbutton', 'xt-volumebutton'].forEach(function (sel) {
    var el = document.querySelector(sel);
    out[sel] = el ? { path: path(el), text: (el.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 80), num: document.querySelectorAll(sel).length } : null;
  });
  var list = document.querySelector('xt-speedlist');
  if (list) out.speedOptions = [].slice.call(list.querySelectorAll('*')).slice(0, 20).map(function (b) {
    return { tag: b.tagName.toLowerCase(), text: (b.innerText || '').trim(), speed: b.getAttribute('data-speed'), keyt: b.getAttribute('keyt') };
  });

  // 6) 只含数字%的可见小元素（进度最可能是它）
  var pct = [];
  document.querySelectorAll('*').forEach(function (el) {
    if (pct.length >= 12) return;
    if (el.children.length) return;
    var t = (el.innerText || '').trim();
    if (/^\\d{1,3}%$/.test(t) || /已完成|未完成|未开始|进行中/.test(t)) {
      var r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) pct.push({ path: path(el), text: t });
    }
  });
  out.percentLike = pct;

  // 7) 页面全文里的进度语句
  var body = (document.body.innerText || '');
  out.progressSentences = (body.match(/[^\\n]{0,30}(完成|进度|已学|已看)[^\\n]{0,30}/g) || []).slice(0, 10);

  return JSON.stringify(out, null, 2);
})()`;

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const pages = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).filter((t) => t.type === 'page');
  const target = pages.find((p) => /lms-graph|studentLog|studycontent/.test(p.url)) || pages[0];
  if (!target) { console.error('没有可用标签页'); process.exit(1); }
  console.log('目标页:', target.url);

  const s = await Session.connect(target.webSocketDebuggerUrl);
  await s.send('Runtime.enable');

  const r = await s.eval(PROBE);
  if (r.error) { console.error('探测失败:', r.error); process.exit(1); }
  fs.writeFileSync(path.join(OUT, 'dom-probe.json'), r.value, 'utf8');

  const d = JSON.parse(r.value);
  console.log('\n===== 播放器容器 =====');
  console.log('video-box 路径:', d.videoBoxPath);
  console.log('video-box 文本:', d.videoBoxText);
  console.log('父节点:', JSON.stringify(d.videoBoxParent));
  console.log('\n同级区块:');
  (d.siblings || []).forEach((x) => console.log(`   ${x.w}x${x.h}  ${x.path}\n        "${x.text}"`));
  console.log('\nvideo-box 子元素:');
  (d.videoBoxChildren || []).forEach((x) => console.log(`   ${x.path}  "${x.text}"`));

  console.log('\n===== 进度相关的 class 命中 =====');
  Object.entries(d.byClass).forEach(([kw, list]) => {
    const vis = list.filter((x) => x.visible);
    console.log(`\n-- 含 "${kw}" 的可见元素 ${vis.length}/${list.length} --`);
    vis.slice(0, 8).forEach((x) => console.log(`   ${x.path}\n        text="${x.text}" html="${(x.html || '').slice(0, 90)}"`));
  });

  console.log('\n===== 形如 "数字%" 或状态文案的叶子元素 =====');
  (d.percentLike || []).forEach((x) => console.log(`   ${x.path}  "${x.text}"`));

  console.log('\n===== 播放器控件 =====');
  ['xt-wrap', 'xt-controls', 'xt-speedbutton', 'xt-speedlist', 'xt-playbutton', 'xt-volumebutton'].forEach((k) => {
    console.log(`   ${k}: ${JSON.stringify(d[k])}`);
  });
  console.log('   倍速选项:', JSON.stringify(d.speedOptions));

  console.log('\n===== 侧边目录候选 =====');
  (d.leafCandidates || []).slice(0, 12).forEach((x) => console.log(`   ${x.path}\n        "${x.text}"`));

  console.log('\n===== 页面里的进度语义句 =====');
  (d.progressSentences || []).forEach((x) => console.log('   ' + x));

  console.log(`\n完整结果已保存: ${path.join(OUT, 'dom-probe.json')}`);
  s.ws.close();
  process.exit(0);
})().catch((e) => { console.error('异常:', e && e.stack || e); process.exit(1); });

#!/usr/bin/env node
/**
 * 遍历真实页面的所有框架（含子 iframe），报告每个框架里脚本与媒体的情况。
 *   node _tools/real-frame-check.js
 */
const PORT = Number(process.env.CDP_PORT || 9222);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  send(method, params = {}, t = 30000) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error('timeout ' + method)); } }, t);
    });
  }
}

const PROBE = `JSON.stringify({
  url: location.href,
  isTop: (function(){ try { return window.top === window.self } catch(e){ return false } })(),
  hasTool: !!window.__yktTool,
  panel: !!document.getElementById('ykt-tool-host'),
  state: window.__yktTool ? {
    running: window.__yktTool.state.running, phase: window.__yktTool.state.phase,
    rate: window.__yktTool.state.rate, paused: window.__yktTool.state.paused,
    t: window.__yktTool.state.currentTime, dur: window.__yktTool.state.duration,
    media: window.__yktTool.state.mediaTag, prog: window.__yktTool.state.progress,
  } : null,
  video: (function(){
    var v = document.querySelector('video');
    return v ? { id: v.id, paused: v.paused, rate: v.playbackRate, muted: v.muted, t: +v.currentTime.toFixed(1), dur: Math.round(v.duration) } : null;
  })(),
  speedText: (function(){ var el=document.querySelector('xt-speedvalue'); return el?(el.innerText||'').trim():null })(),
  rateDetail: (function(){ var el=document.querySelector('.rate-detail .text'); return el?(el.innerText||'').trim():null })(),
})`;

(async () => {
  const pages = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).filter((t) => t.type === 'page');
  const target = pages.find((p) => /yuketang/i.test(p.url)) || pages[0];
  if (!target) { console.error('没有可用标签页'); process.exit(1); }
  console.log('标签页:', target.url, '\n');

  const s = await Session.connect(target.webSocketDebuggerUrl);
  await s.send('Runtime.enable');
  await s.send('Page.enable');

  const tree = await s.send('Page.getFrameTree');

  // 收集所有框架
  const frames = [];
  const walk = (node, depth) => {
    frames.push({ id: node.frame.id, url: node.frame.url, depth });
    (node.childFrames || []).forEach((c) => walk(c, depth + 1));
  };
  walk(tree.frameTree, 0);

  console.log(`共 ${frames.length} 个框架:\n`);

  for (const f of frames) {
    const indent = '  '.repeat(f.depth);
    console.log(`${indent}── 框架 [${f.id.slice(0, 10)}] depth=${f.depth}`);
    console.log(`${indent}   URL: ${f.url.slice(0, 120)}`);
    // 为该框架创建独立执行上下文
    let ctxId = null;
    const created = [];
    const onCtx = (ev) => { };
    try {
      const ctx = await s.send('Page.createIsolatedWorld', { frameId: f.id, worldName: 'ykt-probe', grantUniveralAccess: true });
      ctxId = ctx.executionContextId;
    } catch (e) {
      console.log(`${indent}   ⚠ 无法创建执行上下文: ${e.message}`);
      console.log('');
      continue;
    }
    try {
      const r = await s.send('Runtime.evaluate', { expression: PROBE, contextId: ctxId, returnByValue: true });
      if (r.exceptionDetails) {
        console.log(`${indent}   ⚠ 求值异常: ${(r.exceptionDetails.exception?.description || '').slice(0, 120)}`);
      } else {
        const d = JSON.parse(r.result.value);
        console.log(`${indent}   脚本: ${d.hasTool ? '✓ 已运行' : '✗ 未运行'}   面板: ${d.panel ? '有' : '无'}`);
        if (d.video) {
          console.log(`${indent}   video: rate=${d.video.rate} paused=${d.video.paused} muted=${d.video.muted} t=${d.video.t}/${d.video.dur}`);
        } else {
          console.log(`${indent}   video: 无`);
        }
        console.log(`${indent}   倍速UI文本: ${d.speedText}   本节状态: ${d.rateDetail}`);
        if (d.state) console.log(`${indent}   脚本状态: ${JSON.stringify(d.state)}`);
      }
    } catch (e) {
      console.log(`${indent}   ⚠ ${e.message}`);
    }
    console.log('');
  }

  s.ws.close();
  process.exit(0);
})().catch((e) => { console.error('异常:', e && e.stack || e); process.exit(1); });

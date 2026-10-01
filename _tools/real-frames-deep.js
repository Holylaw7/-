#!/usr/bin/env node
/**
 * 枚举所有框架，检查每个框架里有哪些元素（卡片在 iframe 里时，主文档的点击当然无效）。
 *   node _tools/real-frames-deep.js
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
  studentCards: document.querySelectorAll('section.studentCard').length,
  video: (function(){ var v=document.querySelector('video'); return v?{t:+v.currentTime.toFixed(1), paused:v.paused, rate:v.playbackRate, dur:Math.round(v.duration)}:null })(),
  speedBtn: !!document.querySelector('.xt_video_player_speed, xt-speedbutton'),
  bodyText: (document.body ? (document.body.innerText||'') : '').replace(/\\s+/g,' ').slice(0, 150),
})`;

(async () => {
  const pages = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).filter((t) => t.type === 'page');
  const target = pages.find((p) => /yuketang/i.test(p.url)) || pages[0];
  const s = await Session.connect(target.webSocketDebuggerUrl);
  await s.send('Page.enable'); await s.send('Runtime.enable');

  const tree = await s.send('Page.getFrameTree');
  const frames = [];
  const walk = (n, d) => { frames.push({ id: n.frame.id, url: n.frame.url, depth: d }); (n.childFrames || []).forEach((c) => walk(c, d + 1)); };
  walk(tree.frameTree, 0);

  console.log(`共 ${frames.length} 个框架\n`);
  for (const f of frames) {
    console.log(`── [depth ${f.depth}] ${f.url.slice(0, 110)}`);
    let ctxId = null;
    try {
      const ctx = await s.send('Page.createIsolatedWorld', { frameId: f.id, worldName: 'probe-uuid', grantUniveralAccess: true });
      ctxId = ctx.executionContextId;
    } catch (e) {
      console.log(`   ⚠ 无法创建上下文: ${e.message}\n`);
      continue;
    }
    try {
      const r = await s.send('Runtime.evaluate', { expression: PROBE, contextId: ctxId, returnByValue: true });
      if (r.exceptionDetails) { console.log(`   ⚠ ${(r.exceptionDetails.exception?.description || '').slice(0, 100)}\n`); continue; }
      const d = JSON.parse(r.result.value);
      console.log(`   顶层=${d.isTop}  脚本=${d.hasTool ? '✓' : '✗'}  studentCard=${d.studentCards}  倍速按钮=${d.speedBtn}`);
      console.log(`   video: ${JSON.stringify(d.video)}`);
      console.log(`   文本: ${d.bodyText.slice(0, 110)}`);
    } catch (e) {
      console.log(`   ⚠ ${e.message}`);
    }
    console.log('');
  }
  s.ws.close();
  process.exit(0);
})().catch((e) => { console.error('异常:', e && e.stack || e); process.exit(1); });

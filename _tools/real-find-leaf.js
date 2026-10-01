#!/usr/bin/env node
/**
 * 找到「示例小节A」这一节，并观察脚本在真实站点上处理它的全过程。
 *   node _tools/real-find-leaf.js [关键词]
 */
const CONFIG = require('./config');
const PORT = Number(process.env.CDP_PORT || 9222);
const KEYWORD = process.argv[2] || '示例小节';
const CLASSROOM = CONFIG.classroom;
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
  async eval(expr, aw = false) {
    try {
      const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: aw, userGesture: true });
      if (r.exceptionDetails) return { error: r.exceptionDetails.exception?.description || 'err' };
      return { value: r.result.value };
    } catch (e) { return { error: e.message }; }
  }
}

(async () => {
  const pages = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).filter((t) => t.type === 'page');
  let target = pages.find((p) => /yuketang/i.test(p.url));
  if (!target) target = pages.find((p) => p.url === 'about:blank') || pages[0];
  const s = await Session.connect(target.webSocketDebuggerUrl);
  await s.send('Page.enable'); await s.send('Runtime.enable');
  try { await s.send('Page.bringToFront'); } catch (e) { }

  // 清掉之前测试留下的「关闭自动开始/跳转」，并启用桥
  await s.eval(`(function(){
    try {
      localStorage.removeItem('ykt_tool:autoStart');
      localStorage.removeItem('ykt_tool:autoNext');
      localStorage.setItem('ykt_tool:rate', '2');
    } catch(e){}
    return true;
  })()`);

  console.log('打开课程目录页，查找含「' + KEYWORD + '」的小节…');
  await s.send('Page.navigate', { url: `${CONFIG.origin}/v2/web/studentLog/${CLASSROOM}` });
  await sleep(12000);

  const found = await s.eval(`(function(){
    var out = [];
    var nodes = document.querySelectorAll('*');
    for (var i = 0; i < nodes.length && out.length < 40; i++) {
      var el = nodes[i];
      if (el.children.length) continue;
      var t = (el.innerText || '').trim();
      if (!t || t.length > 60) continue;
      if (t.indexOf(${JSON.stringify(KEYWORD)}) >= 0) {
        // 找到可点击的祖先
        var clickable = el;
        for (var d = 0; d < 6 && clickable.parentElement; d++) {
          clickable = clickable.parentElement;
          var r = clickable.getBoundingClientRect();
          if (r.width > 200 && r.height > 20) break;
        }
        var rect = clickable.getBoundingClientRect();
        out.push({ text: t, x: Math.round(rect.left + rect.width/2), y: Math.round(rect.top + rect.height/2), w: Math.round(rect.width), h: Math.round(rect.height) });
      }
    }
    return JSON.stringify(out);
  })()`);
  let list = [];
  try { list = JSON.parse(found.value || '[]'); } catch (e) { }
  console.log(`匹配到 ${list.length} 处:`);
  list.slice(0, 15).forEach((x) => console.log(`   "${x.text}"  @(${x.x},${x.y}) ${x.w}x${x.h}`));

  const hit = list.find((x) => /上$/.test(x.text)) || list[0];
  if (!hit) { console.log('没找到目标小节'); s.ws.close(); process.exit(0); }

  // 用脚本自身的目录解析能力找到「示例小节…上」这一项并点击（比手算坐标可靠）
  console.log('用脚本的目录解析器定位并点击…');
  const clicked = await s.eval(`(function(){
    if (!window.__yktTool) return 'no tool';
    // 借面板日志确认脚本已就绪；实际点击用脚本内部的 Nav 逻辑不可直接访问，
    // 因此这里直接按 DOM 结构找可点击卡片
    var kw = ${JSON.stringify(KEYWORD)};
    var nodes = document.querySelectorAll('.leaf-item, .leaf_list__wrap .activity__wrap, .content-box, [class*=leaf], [class*=chapter]');
    var hits = [];
    [].slice.call(nodes).forEach(function (n) {
      var t = (n.innerText || '').replace(/\\s+/g, ' ').trim();
      if (t.indexOf(kw) < 0) return;
      var r = n.getBoundingClientRect();
      if (r.width < 100 || r.height < 20) return;
      hits.push({ cls: n.className, text: t.slice(0, 40), x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2), w: Math.round(r.width), h: Math.round(r.height) });
    });
    return JSON.stringify(hits.slice(0, 8));
  })()`);
  let cands = [];
  try { cands = JSON.parse(clicked.value || '[]'); } catch (e) { }
  console.log('候选可点击容器:');
  cands.forEach((x) => console.log(`   .${String(x.cls).split(' ')[0]} "${x.text}" @(${x.x},${x.y}) ${x.w}x${x.h}`));

  const card = cands.find((x) => x.w > 150) || hit;
  console.log(`\n点击 @(${card.x},${card.y})…`);
  await s.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: card.x, y: card.y, buttons: 0 });
  await sleep(200);
  await s.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: card.x, y: card.y, button: 'left', buttons: 1, clickCount: 1 });
  await sleep(90);
  await s.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: card.x, y: card.y, button: 'left', buttons: 0, clickCount: 1 });
  await sleep(9000);

  const PROBE = `JSON.stringify({
    url: location.pathname,
    title: (function(){ var t=document.querySelector('.video-box .title, .lesson-title, .title'); return t?(t.innerText||'').replace(/\\s+/g,' ').trim().slice(0,80):null })(),
    rateDetail: (function(){ var e=document.querySelector('.rate-detail'); return e?(e.innerText||'').replace(/\\s+/g,' ').trim():null })(),
    navProgress: (function(){ var e=document.querySelector('.nav-progress .progress-num'); return e?(e.innerText||'').trim():null })(),
    nextBtn: (function(){ var b=document.querySelector('.nav-footer .nav-next, .nav-next');
      return b?{ text:(b.innerText||'').replace(/\\s+/g,' ').trim(), disabled:b.classList.contains('is-disabled') }:null })(),
    video: (function(){ var v=document.querySelector('video');
      return v?{ t:+v.currentTime.toFixed(1), dur:isFinite(v.duration)?Math.round(v.duration):null, paused:v.paused, rate:v.playbackRate, ended:v.ended }:null })(),
    tool: window.__yktTool ? { running: window.__yktTool.state.running, phase: window.__yktTool.state.phase,
      done: window.__yktTool.state.doneReason, prog: window.__yktTool.state.progress, streak: window.__yktTool.state.sameLeafStreak,
      leaf: window.__yktTool.state.route.leafId } : null,
  })`;

  console.log('\n=== 进入后观察 40 秒 ===');
  const t0 = Date.now();
  let last = '';
  while (Date.now() - t0 < 40000) {
    const d = JSON.parse((await s.eval(PROBE)).value);
    const tag = `${d.url.split('/').pop()} | ${d.rateDetail} | ${d.navProgress} | video=${d.video ? d.video.t + '/' + d.video.dur + ' r' + d.video.rate + (d.video.paused ? ' 暂停' : ' 播放') : '-'} | tool=${d.tool ? d.tool.phase + '/' + d.tool.prog + '%/' + (d.tool.done || '-') : '-'}`;
    if (tag !== last) { console.log(`  [${((Date.now() - t0) / 1000).toFixed(0)}s] ${tag}`); last = tag; }
    await sleep(2000);
  }
  console.log('\n下一个按钮:', (await s.eval(PROBE)).value);
  s.ws.close();
  process.exit(0);
})().catch((e) => { console.error('异常:', e && e.stack || e); process.exit(1); });

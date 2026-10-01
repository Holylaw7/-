#!/usr/bin/env node
/**
 * 聚焦实验：验证「伪造带坐标的 mousemove + click」能否真正点动雨课堂的课程卡片。
 * 依据：油猴中文网指出其点击处理器校验 hasMouse / mouseTarget。
 *
 *   node _tools/test-card-click.js "示例小节A"
 */
const CONFIG = require('./config');
const PORT = Number(process.env.CDP_PORT || 9222);
const CLASSROOM = CONFIG.classroom;
const KEYWORD = process.argv[2] || '示例小节';
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
  async realClick(x, y) {
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons: 0 });
    await sleep(150);
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
    await sleep(90);
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
  }
}

(async () => {
  const pages = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).filter((t) => t.type === 'page');
  let target = pages.find((p) => /yuketang/i.test(p.url));
  if (!target) target = pages.find((p) => p.url === 'about:blank') || pages[0];
  const s = await Session.connect(target.webSocketDebuggerUrl);
  await s.send('Page.enable'); await s.send('Runtime.enable');
  try { await s.send('Page.bringToFront'); } catch (e) { }

  await s.send('Page.navigate', { url: `${CONFIG.origin}/v2/web/studentLog/${CLASSROOM}` });
  await sleep(12000);
  console.log('当前页:', (await s.eval('location.pathname')).value);

  // 定位目标卡片：优先找 class 含 leaf/activity/content 的可点击容器
  const info = await s.eval(`(function () {
    var kw = ${JSON.stringify(KEYWORD)};
    var out = { candidates: [], best: null };
    var all = document.querySelectorAll('*');
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      var t = (el.innerText || '').replace(/\\s+/g, ' ').trim();
      if (t.indexOf(kw) !== 0 && t.indexOf(kw) < 0) continue;
      if (t.length > 80) continue;
      var r = el.getBoundingClientRect();
      if (r.width < 80 || r.height < 16) continue;
      out.candidates.push({ tag: el.tagName, cls: String(el.className || '').slice(0, 60), text: t.slice(0, 30),
        x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2), w: Math.round(r.width), h: Math.round(r.height) });
      if (out.candidates.length > 12) break;
    }
    return JSON.stringify(out);
  })()`);
  const d = JSON.parse(info.value);
  console.log('候选元素:');
  d.candidates.forEach((c, i) => console.log(`   [${i}] <${c.tag} class="${c.cls}"> "${c.text}" ${c.w}x${c.h} @(${c.x},${c.y})`));
  if (!d.candidates.length) { console.log('没找到目标'); s.ws.close(); process.exit(1); }

  const cand = d.candidates[0];

  console.log('\n=== 方案 A：纯合成 click（旧做法，预期无效）===');
  let before = (await s.eval('location.pathname')).value;
  await s.eval(`(function(){
    var el = document.elementFromPoint(${cand.x}, ${cand.y});
    var t = el; for (var i=0;i<4 && t && t.parentElement;i++){ if ((t.innerText||'').indexOf(${JSON.stringify(KEYWORD)})>=0) break; t = t.parentElement; }
    (t||el).dispatchEvent(new MouseEvent('click', {bubbles:true, cancelable:true, view:window}));
    return true;
  })()`);
  await sleep(4000);
  let after = (await s.eval('location.pathname')).value;
  console.log(`   ${before} → ${after}  ${after !== before ? '✓ 生效' : '✗ 无效（符合预期）'}`);

  if (after === before) {
    console.log('\n=== 方案 B：伪造带坐标 mousemove + click（社区方案）===');
    await s.eval(`(function(){
      var kw = ${JSON.stringify(KEYWORD)};
      // 找真正的可点击卡片：从坐标命中的元素向上找到包含关键词的最近容器
      var el = document.elementFromPoint(${cand.x}, ${cand.y});
      var target = el;
      for (var i = 0; i < 6 && target && target.parentElement; i++) {
        if ((target.innerText || '').trim().indexOf(kw) >= 0 && target.getBoundingClientRect().width > 150) break;
        target = target.parentElement;
      }
      target = target || el;
      window.__ckTarget = target;
      var r = target.getBoundingClientRect();
      var x = Math.round(r.left + r.width/2), y = Math.round(r.top + r.height/2);
      function fire(type, cx, cy) {
        var ev = new MouseEvent(type, { bubbles: true, cancelable: true, view: window, button: 0 });
        try { Object.defineProperty(ev, 'clientX', { value: cx, configurable: true }); } catch(e){}
        try { Object.defineProperty(ev, 'clientY', { value: cy, configurable: true }); } catch(e){}
        target.dispatchEvent(ev);
      }
      // 关键：先用超大坐标顶起 hasMouse
      fire('mousemove', 9999, 9999);
      fire('mouseover', 9999, 9999);
      fire('mousemove', x, y);
      fire('mousedown', x, y);
      fire('mouseup', x, y);
      fire('click', x, y);
      return JSON.stringify({ tag: target.tagName, cls: String(target.className||'').slice(0,50), x: x, y: y });
    })()`);
    await sleep(6000);
    after = (await s.eval('location.pathname')).value;
    console.log(`   ${before} → ${after}  ${after !== before ? '✓ 生效！' : '✗ 仍无效'}`);
  }

  if (after === before) {
    console.log('\n=== 方案 C：CDP 真实鼠标移动多次后再点击 ===');
    await s.eval(`(() => { const el = document.elementFromPoint(${cand.x}, ${cand.y}); window.__ckTarget = el; return true; })()`);
    const box = JSON.parse((await s.eval(`(function(){
      var el = window.__ckTarget; if(!el) return null;
      var r = el.getBoundingClientRect();
      return JSON.stringify({ x: Math.round(r.left+r.width/2), y: Math.round(r.top+r.height/2) });
    })()`)).value || 'null');
    if (box) {
      // 多次移动，确保 hasMouse 被真实鼠标事件顶起来
      for (let i = 0; i < 4; i++) {
        await s.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x - 30 + i * 10, y: box.y - 20 + i * 7, buttons: 0 });
        await sleep(120);
      }
      await s.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y, buttons: 0 });
      await sleep(250);
      await s.realClick(box.x, box.y);
      await sleep(6000);
      after = (await s.eval('location.pathname')).value;
      console.log(`   ${before} → ${after}  ${after !== before ? '✓ 生效！' : '✗ 仍无效'}`);
    }
  }

  if (after === before) {
    console.log('\n=== 方案 D：直接调用卡片的 Vue 方法 goLearningSpace（社区推荐）===');
    const call = await s.eval(`(function(){
      var kw = ${JSON.stringify(KEYWORD)};
      var nodes = document.querySelectorAll('section.studentCard');
      for (var i = 0; i < nodes.length; i++) {
        var t = (nodes[i].innerText || '').replace(/\\s+/g, ' ').trim();
        if (t.indexOf(kw) < 0) continue;
        var vm = nodes[i].__vue__;
        if (!vm) return 'card has no __vue__';
        var names = vm.$options && vm.$options.methods ? Object.keys(vm.$options.methods) : [];
        if (typeof vm.goLearningSpace !== 'function') return 'no goLearningSpace; methods=' + names.join(',');
        try {
          vm.goLearningSpace();
          return 'called goLearningSpace()';
        } catch (e) {
          return 'goLearningSpace threw: ' + e.message;
        }
      }
      return 'no matching card';
    })()`);
    console.log('   调用结果:', call.value);
    await sleep(7000);
    after = (await s.eval('location.pathname')).value;
    console.log(`   ${before} → ${after}  ${after !== before ? '✓ 生效！' : '✗ 仍无效'}`);
  }

  if (after === before) {
    console.log('\n=== 方案 E：先 goSummary 再试 / 打印实例更多信息 ===');
    const more = await s.eval(`(function(){
      var nodes = document.querySelectorAll('section.studentCard');
      for (var i = 0; i < nodes.length; i++) {
        var t = (nodes[i].innerText || '').replace(/\\s+/g, ' ').trim();
        if (t.indexOf(${JSON.stringify(KEYWORD)}) < 0) continue;
        var vm = nodes[i].__vue__;
        var out = { props: vm.$options && vm.$options.props ? Object.keys(vm.$options.props) : null };
        try { out.data = {}; var d = vm.$data || {};
          Object.keys(d).forEach(function(k){ var v = d[k];
            if (v === null || typeof v !== 'object') out.data[k] = v; }); } catch(e){}
        try { out.goLearningSpaceSrc = String(vm.goLearningSpace).slice(0, 600); } catch(e){}
        return JSON.stringify(out, null, 2);
      }
      return 'none';
    })()`);
    console.log(more.value);
  }

  console.log('\n最终:', after);
  s.ws.close();
  process.exit(0);
})().catch((e) => { console.error('异常:', e && e.stack || e); process.exit(1); });

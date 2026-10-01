#!/usr/bin/env node
/**
 * 1) 从目录页 DOM 里挖出小节的真实 leaf id（点不动卡片，就绕开它直接用 URL 进入）
 * 2) 进入该视频页，把进度条拖到结尾，测试脚本能否据此判定完成并自动跳转
 *
 *   node _tools/real-seek-test.js "示例小节A"
 */
const CONFIG = require('./config');
const PORT = Number(process.env.CDP_PORT || 9222);
const CLASSROOM = CONFIG.classroom;
const KEYWORD = process.argv[2] || '示例小节';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Session {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.events = []; }
  static async connect(u) {
    const ws = new WebSocket(u);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws fail')); });
    const s = new Session(ws);
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && s.pending.has(m.id)) {
        const { res, rej } = s.pending.get(m.id); s.pending.delete(m.id);
        m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
      } else if (m.method) { s.events.push(m); }
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
  await s.send('Page.enable'); await s.send('Runtime.enable'); await s.send('Network.enable');
  try { await s.send('Page.bringToFront'); } catch (e) { }

  console.log('=== 第 1 步：从目录页挖 leaf id ===');
  await s.send('Page.navigate', { url: `${CONFIG.origin}/v2/web/studentLog/${CLASSROOM}` });
  await sleep(13000);

  const dig = await s.eval(`(function(){
    var kw = ${JSON.stringify(KEYWORD)};
    var out = { found: [], vueNodes: 0, sample: [] };
    var cards = document.querySelectorAll('section.studentCard');
    for (var i = 0; i < cards.length; i++) {
      var card = cards[i];
      var t = (card.innerText || '');
      if (t.indexOf(kw) < 0) continue;
      // 收集卡片上所有 data-* 与 id/class，找 leaf id
      var info = { text: t.replace(/\\s+/g,' ').slice(0, 40), attrs: [], innerAttrs: [] };
      [].slice.call(card.attributes).forEach(function(a){ info.attrs.push(a.name + '=' + a.value); });
      var inner = card.querySelectorAll('*');
      for (var j = 0; j < inner.length && j < 40; j++) {
        var e = inner[j];
        [].slice.call(e.attributes).forEach(function(a){
          if (/leaf|id|data-/i.test(a.name) && a.value && info.innerAttrs.length < 30) {
            info.innerAttrs.push(e.tagName + '.' + String(e.className||'').slice(0,20) + ' ' + a.name + '=' + a.value);
          }
        });
      }
      out.found.push(info);
      if (out.found.length >= 2) break;
    }
    // 也看看页面内联 JSON 里有没有 leaf 列表
    try {
      var scripts = document.querySelectorAll('script:not([src])');
      for (var k = 0; k < scripts.length; k++) {
        var txt = scripts[k].textContent || '';
        if (txt.length > 2000 || txt.indexOf('leaf_id') < 0) continue;
        var m = txt.match(/\\{[^{}]*"leaf_id"[^{}]*\\}/g);
        if (m) out.sample = m.slice(0, 6);
      }
    } catch(e){}
    return JSON.stringify(out);
  })()`);
  const found = JSON.parse(dig.value || '{}');
  console.log('匹配卡片数:', (found.found || []).length);
  (found.found || []).forEach((f) => {
    console.log('  文本:', f.text);
    console.log('    卡片属性:', f.attrs.join(' | '));
    console.log('    子孙属性(前 12):');
    (f.innerAttrs || []).slice(0, 12).forEach((a) => console.log('       ' + a));
  });
  if (found.sample && found.sample.length) console.log('  内联 JSON 样本:', found.sample);

  // 尝试从网络请求里找 leaf 列表接口
  const leafReqs = s.events.filter((e) => e.method === 'Network.requestWillBeSent')
    .map((e) => e.params.request.url)
    .filter((u) => /leaf|lesson|schedule|resource_tree|new_lesson|new_classroom|section/i.test(u));
  console.log('\n可能含 leaf 列表的接口:');
  [...new Set(leafReqs)].slice(0, 12).forEach((u) => console.log('   ' + u.slice(0, 150)));

  console.log('\nleaf id 挖取结果: ' + (found.found && found.found.length ? '见上方属性' : '未找到，需要换方式'));
  s.ws.close();
  process.exit(0);
})().catch((e) => { console.error('异常:', e && e.stack || e); process.exit(1); });

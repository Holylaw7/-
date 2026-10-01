#!/usr/bin/env node
/**
 * 检查调试窗口里篡改猴扩展的真实状态：是否加载、后台是否活着、脚本是否被注入。
 *   node _tools/check-tm-debug.js
 */
const PORT = Number(process.env.CDP_PORT || 9222);
const TM_ID = 'iikmkjmpaadaobahmlepeloendndfphd';
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
  send(method, params = {}, t = 20000) {
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
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  console.log('=== 所有调试目标 ===');
  list.forEach((t) => console.log(`  [${t.type}] ${String(t.title || '').slice(0, 24)}  ${t.url.slice(0, 100)}`));

  // 篡改猴的后台 service worker（MV3）
  const tmTargets = list.filter((t) => /iikmkjmpaadaobahmlepeloendndfphd/.test(t.url));
  console.log('\n篡改猴相关目标:', tmTargets.length ? tmTargets.map((t) => t.type + ' ' + t.url.slice(0, 60)) : '（没有）');

  // 打开扩展页检查加载状态
  const pages = list.filter((t) => t.type === 'page');
  const target = pages.find((p) => p.url === 'about:blank') || pages[0];
  const s = await Session.connect(target.webSocketDebuggerUrl);
  await s.send('Page.enable'); await s.send('Runtime.enable');

  console.log('\n=== 打开 edge://extensions 检查 ===');
  await s.send('Page.navigate', { url: 'edge://extensions/' });
  await sleep(3000);
  // 扩展页是 WebUI，用 DOM 查
  const extInfo = await s.eval(`(function(){
    var out = { found: [], text: '' };
    try {
      var items = document.querySelectorAll('extensions-item, .extension-list-item, [id*=extension]');
      out.count = items.length;
      // 找篡改猴
      var all = document.querySelectorAll('*');
      for (var i = 0; i < all.length && out.found.length < 5; i++) {
        var t = (all[i].innerText || '');
        if (t.indexOf('篡改猴') === 0 && t.length < 200) out.found.push(t.replace(/\\s+/g,' ').slice(0, 150));
      }
    } catch(e) { out.err = String(e); }
    return JSON.stringify(out);
  })()`);
  console.log(extInfo.value || extInfo.error);

  // 直接访问篡改猴的扩展页面，看它自己是否报告脚本列表
  console.log('\n=== 打开篡改猴弹窗页（extension action popup）===');
  await s.send('Page.navigate', { url: `chrome-extension://${TM_ID}/popup.html` });
  await sleep(3500);
  const popup = await s.eval(`JSON.stringify({ url: location.href, title: document.title,
    text: (document.body ? (document.body.innerText||'') : '').replace(/\\s+/g,' ').slice(0, 400) })`);
  console.log(popup.value || popup.error);

  s.ws.close();
  process.exit(0);
})().catch((e) => { console.error('异常:', e && e.stack || e); process.exit(1); });

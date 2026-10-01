#!/usr/bin/env node
/**
 * 抓出「帮助浮层被谁关掉」：监听 class 变化并记录调用栈。
 *   node _tools/debug-help-toggle.js
 */
const CONFIG = require('./config');
const fs = require('fs');
const path = require('path');
const PORT = Number(process.env.CDP_PORT || 9222);
const USERSCRIPT = path.join(__dirname, '..', 'dist', 'changjiang-yuketang-auto.user.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LEAF = CONFIG.leaf || process.argv[2] || CONFIG.PLACEHOLDER;

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
  send(method, params = {}, t = 40000) {
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

(async () => {
  const pages = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).filter((t) => t.type === 'page');
  const target = pages.find((p) => p.url === 'about:blank') || pages[0];
  const s = await Session.connect(target.webSocketDebuggerUrl);
  await s.send('Page.enable');
  await s.send('Runtime.enable');
  await s.send('Page.addScriptToEvaluateOnNewDocument', { source: fs.readFileSync(USERSCRIPT, 'utf8') });
  await s.send('Page.navigate', { url: 'http://127.0.0.1:8099/web' });
  await sleep(1500);
  await s.eval(`document.getElementById('btn-login') && document.getElementById('btn-login').click(), true`);
  await sleep(2500);
  await s.send('Page.navigate', { url: `http://127.0.0.1:8099/ai-workspace/lms-graph/${CONFIG.classroom}/video/${LEAF}?is_chapter=1` });
  await sleep(6000);

  // 安装观察器
  await s.eval(`(function(){
    var h=document.getElementById('ykt-tool-host');
    var el=h.shadowRoot.getElementById('help');
    window.__helpLog = [];
    var origToggle = el.classList.toggle.bind(el.classList);
    // 用 MutationObserver 记录属性变化
    var mo = new MutationObserver(function(muts){
      muts.forEach(function(m){
        if (m.attributeName === 'class') {
          window.__helpLog.push({
            t: Math.round(performance.now()),
            cls: el.className,
            on: el.classList.contains('on'),
            display: getComputedStyle(el).display,
            stack: (new Error('classchange')).stack.split('\\n').slice(1,7).join(' | ')
          });
        }
      });
    });
    mo.observe(el, { attributes: true, attributeFilter: ['class'] });
    window.__helpEl = el;
    return 'observer installed';
  })()`);

  console.log('点击帮助按钮…');
  const r1 = await s.eval(`(function(){
    var h=document.getElementById('ykt-tool-host');
    h.shadowRoot.getElementById('btn-help').click();
    var el=h.shadowRoot.getElementById('help');
    return JSON.stringify({ rightAfterClick: el.classList.contains('on'), cls: el.className });
  })()`);
  console.log('  点击瞬间:', r1.value);

  for (const ms of [100, 400, 1000, 2500]) {
    await sleep(ms === 100 ? 100 : 300);
    const st = await s.eval(`(function(){
      var el=window.__helpEl; if(!el) return 'no el';
      return JSON.stringify({ on: el.classList.contains('on'), cls: el.className, display: getComputedStyle(el).display });
    })()`);
    console.log(`  +${ms}ms:`, st.value);
  }

  const log = await s.eval(`JSON.stringify(window.__helpLog || [])`);
  console.log('\nclass 变化记录:');
  try {
    JSON.parse(log.value).forEach((x) => {
      console.log(`  t=${x.t} cls="${x.cls}" on=${x.on} display=${x.display}`);
      console.log(`     stack: ${x.stack}`);
    });
  } catch (e) { console.log(log.value); }

  s.ws.close();
  process.exit(0);
})().catch((e) => { console.error('异常:', e && e.stack || e); process.exit(1); });

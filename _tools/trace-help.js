#!/usr/bin/env node
/**
 * 追踪 toggleHelp 的调用来源（配合 UI._helpTrace）。
 *   node _tools/trace-help.js
 */
const CONFIG = require('./config');
const fs = require('fs');
const path = require('path');
const PORT = Number(process.env.CDP_PORT || 9222);
const USERSCRIPT = path.join(__dirname, '..', 'dist', 'changjiang-yuketang-auto.user.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LEAF = CONFIG.leaf || process.argv[2] || String(CONFIG.mock.leafBase);

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
  await s.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `try { localStorage.setItem('ykt_tool:autoStart', 'false'); localStorage.setItem('ykt_tool:autoNext', 'false'); } catch(e){}`,
  });
  await s.send('Page.addScriptToEvaluateOnNewDocument', { source: fs.readFileSync(USERSCRIPT, 'utf8') });

  await s.send('Page.navigate', { url: `http://127.0.0.1:8099/ai-workspace/lms-graph/${CONFIG.mock.classroom}/video/${LEAF}?is_chapter=1` });
  await sleep(7000);

  await s.eval(`window.__yktTool && window.__yktTool.start('追踪')`);
  await sleep(1000);

  // 开始追踪
  const setup = await s.eval(`(function(){
    if (!window.__yktTool) return 'no tool';
    // 通过诊断接口拿不到 UI 对象，改为包裹 shadow 里按钮的 click 并记录
    var h=document.getElementById('ykt-tool-host');
    if(!h||!h.shadowRoot) return 'no panel';
    var el=h.shadowRoot.getElementById('help');
    window.__trace = { classChanges: [], clicks: [], navs: [] };
    new MutationObserver(function(muts){
      muts.forEach(function(m){ if(m.attributeName==='class') window.__trace.classChanges.push({t: Math.round(performance.now()), cls: el.className}); });
    }).observe(el, { attributes: true });
    // 监听按钮点击
    var b=h.shadowRoot.getElementById('btn-help');
    b.addEventListener('click', function(){ window.__trace.clicks.push(Math.round(performance.now())); }, true);
    // 监听是否发生页面卸载/可见性变化
    window.addEventListener('beforeunload', function(){ window.__trace.navs.push('beforeunload@'+Math.round(performance.now())) });
    return 'tracing';
  })()`);
  console.log('追踪器:', setup.value);

  console.log('\n点击帮助按钮…');
  await s.eval(`document.getElementById('ykt-tool-host').shadowRoot.getElementById('btn-help').click(), true`);

  for (let i = 1; i <= 6; i++) {
    await sleep(300);
    const st = await s.eval(`(function(){
      var h=document.getElementById('ykt-tool-host');
      if(!h||!h.shadowRoot) return JSON.stringify({gone:true, url: location.href});
      var el=h.shadowRoot.getElementById('help');
      return JSON.stringify({ on: el.classList.contains('on'), w: Math.round(el.getBoundingClientRect().width), url: location.pathname });
    })()`);
    console.log(`  +${i * 300}ms: ${st.value}`);
  }

  const tr = await s.eval(`JSON.stringify(window.__trace || {})`);
  console.log('\n追踪结果:', tr.value);

  s.ws.close();
  process.exit(0);
})().catch((e) => { console.error('异常:', e && e.stack || e); process.exit(1); });

#!/usr/bin/env node
/**
 * 截取控制面板 + 帮助浮层的实际效果图。
 *   node _tools/shot-panel.js
 */
const CONFIG = require('./config');
const fs = require('fs');
const path = require('path');
const PORT = Number(process.env.CDP_PORT || 9222);
const USERSCRIPT = path.join(__dirname, '..', 'dist', 'changjiang-yuketang-auto.user.js');
const OUT = path.join(__dirname, '..', 'screenshots');
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
  fs.mkdirSync(OUT, { recursive: true });
  const pages = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).filter((t) => t.type === 'page');
  const target = pages.find((p) => p.url === 'about:blank') || pages[0];
  const s = await Session.connect(target.webSocketDebuggerUrl);
  await s.send('Page.enable');
  await s.send('Runtime.enable');
  await s.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 2, mobile: false });
  // 关闭自动刷课，避免截图时脚本自动跳转把页面换掉
  await s.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `try { localStorage.setItem('ykt_tool:autoStart', 'false'); localStorage.setItem('ykt_tool:autoNext', 'false'); } catch(e){}`,
  });
  await s.send('Page.addScriptToEvaluateOnNewDocument', { source: fs.readFileSync(USERSCRIPT, 'utf8') });

  await s.send('Page.navigate', { url: 'http://127.0.0.1:8099/web' });
  await sleep(1500);
  await s.eval(`document.getElementById('btn-login') && document.getElementById('btn-login').click(), true`);
  await sleep(2500);
  await s.send('Page.navigate', { url: `http://127.0.0.1:8099/ai-workspace/lms-graph/${CONFIG.classroom}/video/${LEAF}?is_chapter=1` });
  await sleep(6000);
  // 让视频跑起来（手动启动），便于截图展示真实状态
  await s.eval(`window.__yktTool && window.__yktTool.start('截图')`);
  await sleep(3500);

  // 展开日志区（脚本自动运行时已有内容），并点开帮助
  const clicked = await s.eval(`(function(){
    var h=document.getElementById('ykt-tool-host');
    if(!h||!h.shadowRoot) return 'NO_SHADOW';
    var b=h.shadowRoot.getElementById('btn-help');
    if(!b) return 'NO_BTN';
    b.click();
    var el=h.shadowRoot.getElementById('help');
    return el ? ('help on=' + el.classList.contains('on')) : 'NO_HELP_EL';
  })()`);
  console.log('点击帮助按钮:', clicked.value);
  await sleep(1500);
  const state = await s.eval(`(function(){
    var h=document.getElementById('ykt-tool-host');
    var el=h.shadowRoot.getElementById('help');
    var r=el.getBoundingClientRect();
    return JSON.stringify({ on: el.classList.contains('on'), w: Math.round(r.width), h: Math.round(r.height),
      panelBox: JSON.stringify((function(){var p=h.shadowRoot.querySelector('.panel').getBoundingClientRect(); return {x:Math.round(p.left),y:Math.round(p.top),w:Math.round(p.width),h:Math.round(p.height)}})()) });
  })()`);
  console.log('浮层状态:', state.value);

  const r = await s.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const f1 = path.join(OUT, 'panel-help.png');
  fs.writeFileSync(f1, Buffer.from(r.data, 'base64'));
  console.log('已保存:', f1, fs.statSync(f1).size, 'bytes');

  // 再截一张收起帮助、正常播放中的面板
  await s.eval(`document.getElementById('ykt-tool-host').shadowRoot.getElementById('btn-help').click(), true`);
  await sleep(800);
  const r2 = await s.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const f2 = path.join(OUT, 'panel-main.png');
  fs.writeFileSync(f2, Buffer.from(r2.data, 'base64'));
  console.log('已保存:', f2, fs.statSync(f2).size, 'bytes');

  s.ws.close();
  process.exit(0);
})().catch((e) => { console.error('异常:', e && e.stack || e); process.exit(1); });

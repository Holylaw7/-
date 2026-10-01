#!/usr/bin/env node
/**
 * 验证控制面板里的「使用帮助」浮层：点击后是否出现、自检内容是否正确。
 *   node _tools/verify-help-window.js
 */
const CONFIG = require('./config');
const fs = require('fs');
const path = require('path');
const PORT = Number(process.env.CDP_PORT || 9222);
const USERSCRIPT = path.join(__dirname, '..', 'dist', 'changjiang-yuketang-auto.user.js');
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

let pass = 0, fail = 0;
const check = (n, ok, d = '') => { ok ? pass++ : fail++; console.log(`${ok ? '  ✓' : '  ✗'} ${n}${d ? '  — ' + d : ''}`); };

(async () => {
  const pages = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).filter((t) => t.type === 'page');
  const target = pages.find((p) => /yuketang/i.test(p.url)) || pages.find((p) => p.url === 'about:blank') || pages[0];
  if (!target) { console.error('没有可用标签页'); process.exit(1); }

  const s = await Session.connect(target.webSocketDebuggerUrl);
  await s.send('Page.enable');
  await s.send('Runtime.enable');
  await s.send('Page.addScriptToEvaluateOnNewDocument', { source: fs.readFileSync(USERSCRIPT, 'utf8') });

  // 用本地仿真站点验证 UI（无需登录，行为与真站一致）
  console.log('打开仿真课程页并注入最新脚本…');
  await s.send('Page.navigate', { url: 'http://127.0.0.1:8099/web' });
  await sleep(1500);
  await s.eval(`document.getElementById('btn-login') && document.getElementById('btn-login').click(), true`);
  await sleep(2500);
  await s.send('Page.navigate', { url: `http://127.0.0.1:8099/v2/web/studentLog/${CONFIG.classroom}` });
  await sleep(6000);

  const d = JSON.parse((await s.eval(`JSON.stringify({
    url: location.href,
    panel: !!document.getElementById('ykt-tool-host'),
    tool: !!window.__yktTool,
  })`)).value);
  console.log('  当前页面:', d.url.slice(0, 80));
  console.log('  面板:', d.panel, ' __yktTool:', d.tool);
  check('脚本已注入并生成面板', d.panel === true && d.tool === true);

  // 交互验证（注意 host 元素 id 是 ykt-tool-host，必须从 shadowRoot 里取元素）
  const before = JSON.parse((await s.eval(`JSON.stringify({
    hostExists: !!document.getElementById('ykt-tool-host'),
    hasShadow: !!(document.getElementById('ykt-tool-host') || {}).shadowRoot,
    helpOpen: (function(){ var h=document.getElementById('ykt-tool-host'); if(!h||!h.shadowRoot) return 'NO_SHADOW';
      var el=h.shadowRoot.getElementById('help'); return el?el.classList.contains('on'):'NO_HELP_EL' })(),
    hasHelpBtn: (function(){ var h=document.getElementById('ykt-tool-host'); if(!h||!h.shadowRoot) return 'NO_SHADOW';
      return !!h.shadowRoot.getElementById('btn-help') })(),
  })`)).value);
  console.log('  预检:', JSON.stringify(before));
  check('host 元素存在且有 shadowRoot', before.hostExists === true && before.hasShadow === true);
  check('面板里有「使用帮助」按钮', before.hasHelpBtn === true, `hasHelpBtn=${before.hasHelpBtn}`);
  check('帮助浮层默认关闭', before.helpOpen === false, `helpOpen=${before.helpOpen}`);

  if (before.hasHelpBtn !== true || before.helpOpen !== false) {
    console.log('\n✗ 前置条件不满足，后续检查无意义，直接判定失败');
    console.log(`\n❌ 存在失败项  通过 ${pass} / 失败 ${fail + 1}`);
    process.exit(1);
  }

  console.log('\n模拟点击「使用帮助」…');
  await s.eval(`(function(){
    var h=document.getElementById('ykt-tool-host');
    var b=h.shadowRoot.getElementById('btn-help');
    b.click();
    return true;
  })()`);
  await sleep(800);

  const after = JSON.parse((await s.eval(`JSON.stringify((function(){
    var h=document.getElementById('ykt-tool-host');
    var sr=h.shadowRoot;
    var help=sr.getElementById('help');
    var g=function(id){ var e=sr.getElementById(id); return e?e.innerText.trim():null };
    return {
      helpOpen: help?help.classList.contains('on'):null,
      status: g('help-status'),
      detail: g('help-detail'),
      frame: g('help-frame'),
      url1: g('help-url1'),
      url2: g('help-url2'),
      helpHeight: help?Math.round(help.getBoundingClientRect().height):0,
    };
  })())`)).value);

  console.log('  浮层高度:', after.helpHeight);
  console.log('  自检结论:', after.status);
  console.log('  详情:\n' + String(after.detail).split('\n').map((l) => '    ' + l).join('\n'));
  console.log('  运行位置:', after.frame);
  console.log('  地址1:', after.url1);
  console.log('  地址2:', after.url2);

  check('点击后帮助浮层打开', after.helpOpen === true);
  check('浮层有实际高度（可见）', after.helpHeight > 80, `height=${after.helpHeight}`);
  check('自检结论有内容', !!after.status && after.status.length > 2, after.status);
  check('自检详情有内容', !!after.detail && after.detail.length > 10);
  check('给出了扩展设置地址', /edge:\/\/extensions/.test(after.url1 || ''), after.url1);
  check('提示了「允许用户脚本」这一步', /允许用户脚本/.test(after.detail || '') || /允许用户脚本/.test(String(after.status) + String(after.detail)));

  console.log('\n再次点击应收起浮层…');
  await s.eval(`document.getElementById('ykt-tool-host').shadowRoot.getElementById('btn-help').click(), true`);
  await sleep(400);
  const closed = (await s.eval(`(function(){ var h=document.getElementById('ykt-tool-host');
    return h.shadowRoot.getElementById('help').classList.contains('on') })()`)).value;
  check('再次点击可收起', closed === false);

  console.log(`\n${fail === 0 ? '✅ 全部通过' : '❌ 存在失败项'}  通过 ${pass} / 失败 ${fail}`);
  s.ws.close();
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('异常:', e && e.stack || e); process.exit(1); });

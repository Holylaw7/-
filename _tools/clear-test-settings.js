#!/usr/bin/env node
/**
 * 清理调试窗口里的测试残留设置（恢复脚本默认行为）。
 *   node _tools/clear-test-settings.js
 */
const CONFIG = require('./config');

class S {
  constructor(ws) { this.ws = ws; this.id = 0; this.p = new Map(); }
  static async open(u) {
    const ws = new WebSocket(u);
    await new Promise((r, j) => { ws.onopen = r; ws.onerror = () => j(new Error('ws fail')); });
    const s = new S(ws);
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.id && s.p.has(m.id)) { const { r, j } = s.p.get(m.id); s.p.delete(m.id); m.error ? j(new Error(JSON.stringify(m.error))) : r(m.result); }
    };
    return s;
  }
  send(method, params = {}, t = 20000) {
    const id = ++this.id;
    return new Promise((r, j) => {
      this.p.set(id, { r, j });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.p.has(id)) { this.p.delete(id); j(new Error('timeout ' + method)); } }, t);
    });
  }
  async ev(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true });
    if (r.exceptionDetails) return { error: r.exceptionDetails.exception?.description || 'err' };
    return { value: r.result.value };
  }
}

const LS_EXPR = `(function(){
  var keys = ['ykt_tool:mute','ykt_tool:autoStart','ykt_tool:autoNext','ykt_tool:rate',
              'ykt_tool:speedBridge','ykt_tool:fastForward','ykt_tool:background'];
  var before = keys.map(function(k){ return k + '=' + localStorage.getItem(k); });
  keys.forEach(function(k){ try { localStorage.removeItem(k); } catch(e){} });
  try { sessionStorage.removeItem('ykt_tool:stuck'); sessionStorage.removeItem('ykt_tool:auto'); } catch(e){}
  var after = Object.keys(localStorage).filter(function(k){ return k.indexOf('ykt_tool') >= 0; });
  return JSON.stringify({ before: before, afterKeys: after });
})()`;

(async () => {
  const list = await (await fetch(`http://127.0.0.1:${CONFIG.cdpPort}/json/list`)).json();
  const pages = list.filter((t) => t.type === 'page');
  const targets = pages.filter((t) => /yuketang/i.test(t.url));
  console.log(`清理 ${targets.length} 个雨课堂页面里的测试设置…\n`);

  for (const p of targets) {
    const s = await S.open(p.webSocketDebuggerUrl);
    await s.send('Runtime.enable');
    const r = await s.ev(LS_EXPR);
    console.log('▸', p.url.slice(0, 80));
    try {
      const d = JSON.parse(r.value);
      console.log('   清理前:', JSON.stringify(d.before));
      console.log('   清理后剩余:', JSON.stringify(d.afterKeys));
    } catch (e) { console.log('   ', r.value || r.error); }
    s.ws.close();
  }

  console.log('\n完成。刷新页面后脚本将按默认值运行：');
  console.log('  倍速 2x / 自动跳转开 / 后台防暂停开 / 静音关（可按需在面板勾选）');
  process.exit(0);
})().catch((e) => { console.error('异常:', e && e.stack || e); process.exit(1); });

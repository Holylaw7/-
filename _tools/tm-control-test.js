#!/usr/bin/env node
/**
 * 对照实验：用篡改猴里另一个脚本（百度网盘）的匹配页，看篡改猴是否还能正常注入脚本。
 *   node _tools/tm-control-test.js
 */
const CONFIG = require('./config');
const PORT = Number(process.env.CDP_PORT || 9222);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LEAF = CONFIG.leaf || process.argv[2] || CONFIG.PLACEHOLDER;

class Session {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.consoleLogs = []; }
  static async connect(u) {
    const ws = new WebSocket(u);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws fail')); });
    const s = new Session(ws);
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && s.pending.has(m.id)) {
        const { res, rej } = s.pending.get(m.id); s.pending.delete(m.id);
        m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
      } else if (m.method === 'Runtime.consoleAPICalled') {
        s.consoleLogs.push((m.params.args || []).map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 160));
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
  async eval(expr) {
    try {
      const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, userGesture: true });
      if (r.exceptionDetails) return { error: r.exceptionDetails.exception?.description || 'err' };
      return { value: r.result.value };
    } catch (e) { return { error: e.message }; }
  }
}

async function testPage(label, url, markers) {
  console.log(`\n=== ${label} ===`);
  const list = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).filter((t) => t.type === 'page');
  const ctl = await Session.connect(list[0].webSocketDebuggerUrl);
  await ctl.send('Page.enable');
  const nt = await ctl.send('Target.createTarget', { url: 'about:blank' });
  ctl.ws.close();
  await sleep(1200);
  const fresh = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json())
    .filter((t) => t.type === 'page').find((p) => p.id === nt.targetId);
  const s = await Session.connect(fresh.webSocketDebuggerUrl);
  await s.send('Page.enable'); await s.send('Runtime.enable');
  await s.send('Page.navigate', { url });
  await sleep(14000);

  const r = await s.eval(`JSON.stringify((function(){
    var out = { url: location.href, markers: {} };
    ${markers.map((m) => `try { out.markers[${JSON.stringify(m)}] = !!(${m}); } catch(e) { out.markers[${JSON.stringify(m)}] = 'err'; }`).join('\n    ')}
    return out;
  })())`);
  console.log('  ', r.value || r.error);
  s.ws.close();
  return r.value;
}

(async () => {
  // 对照 1：百度网盘首页（篡改猴里有 3 个匹配它的脚本）
  await testPage('对照页：百度网盘', 'https://pan.baidu.com/disk/main', [
    'window.__BAIDU_PAN_HELPER__',
    'document.querySelector("#tt-toolbox, [class*=tt-], [id*=ttHelper]")',
    'Object.keys(window).filter(function(k){return /helper|pan|tt/i.test(k)}).length',
  ]);

  // 对照 2：我们的脚本 —— 雨课堂
  await testPage('目标页：长江雨课堂', CONFIG.origin + `/ai-workspace/lms-graph/${CONFIG.classroom}/video/${LEAF}?is_chapter=1`, [
    'window.__yktTool',
    'document.getElementById("ykt-tool-host")',
    'window.__yktRaw',
  ]);

  process.exit(0);
})().catch((e) => { console.error('异常:', e && e.stack || e); process.exit(1); });

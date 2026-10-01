#!/usr/bin/env node
/**
 * 抓取页面自己请求课程数据时的**真实请求头**，以便复现该接口拿到完整 leaf 列表。
 *   node _tools/capture-api-headers.js
 */
const CONFIG = require('./config');
const PORT = Number(process.env.CDP_PORT || 9222);
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
  const target = pages.find((p) => /yuketang/i.test(p.url)) || pages[0];
  const s = await Session.connect(target.webSocketDebuggerUrl);
  await s.send('Page.enable'); await s.send('Runtime.enable');
  await s.send('Network.enable');
  try { await s.send('Page.bringToFront'); } catch (e) { }

  console.log('重新加载课程页，抓取所有网络请求头…');
  s.events.length = 0;
  await s.send('Page.navigate', { url: CONFIG.origin + `/v2/web/studentLog/${CONFIG.classroom}` });
  await sleep(15000);

  const reqs = s.events.filter((e) => e.method === 'Network.requestWillBeSent');
  console.log(`共捕获 ${reqs.length} 个请求\n`);

  // 找与课程结构相关的接口
  const interesting = reqs.filter((e) => {
    const u = e.params.request.url;
    return /mooc-api|api\/v3|api\/open|course_meta|schedule|leaf|lesson|chapter|resource/i.test(u)
      && !/\.(js|css|png|jpg|svg|woff|gif|ico)(\?|$)/i.test(u);
  });

  const seen = new Set();
  console.log('=== 相关接口及其请求头 ===');
  for (const e of interesting) {
    const u = e.params.request.url.split('?')[0];
    if (seen.has(u)) continue;
    seen.add(u);
    const h = e.params.request.headers || {};
    console.log(`\n▸ ${e.params.request.method} ${e.params.request.url.slice(0, 150)}`);
    const showKeys = ['xtbz', 'XTBZ', 'x-csrftoken', 'X-CSRFToken', 'authorization', 'cookie', 'referer', 'university-id', 'platform-id', 'uv-id'];
    Object.keys(h).forEach((k) => {
      if (showKeys.some((x) => k.toLowerCase() === x.toLowerCase())) {
        const v = String(h[k]);
        console.log(`     ${k}: ${v.length > 110 ? v.slice(0, 110) + '…' : v}`);
      }
    });
    if (seen.size >= 8) break;
  }

  // 再看这些接口的响应结构
  console.log('\n\n=== 关注接口的响应片段 ===');
  const respMap = new Map();
  s.events.filter((e) => e.method === 'Network.responseReceived').forEach((e) => respMap.set(e.params.requestId, e.params.response));

  let shown = 0;
  for (const e of interesting) {
    const r = respMap.get(e.params.requestId);
    if (!r || shown >= 4) continue;
    if (!/json/i.test(r.mimeType || '')) continue;
    shown++;
    console.log(`\n▸ ${r.url.slice(0, 130)}  [${r.status}]`);
    try {
      const body = await s.send('Network.getResponseBody', { requestId: e.params.requestId });
      const txt = body.body || '';
      console.log('   长度:', txt.length);
      console.log('   片段:', txt.slice(0, 300).replace(/\s+/g, ' '));
    } catch (err) {
      console.log('   取响应失败:', err.message);
    }
  }

  s.ws.close();
  process.exit(0);
})().catch((e) => { console.error('异常:', e && e.stack || e); process.exit(1); });

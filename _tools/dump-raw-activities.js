#!/usr/bin/env node
/**
 * 打印活动列表接口的原始 JSON，定位 leaf_id 藏在哪个字段。
 *   node _tools/dump-raw-activities.js
 */
const CONFIG = require('./config');
const PORT = Number(process.env.CDP_PORT || 9222);
const CLASSROOM = CONFIG.classroom;
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
  try { await s.send('Page.bringToFront'); } catch (e) { }

  if (!/yuketang/.test(target.url)) {
    await s.send('Page.navigate', { url: `${CONFIG.origin}/v2/web/studentLog/${CLASSROOM}` });
    await sleep(13000);
  }

  // 找到「示例小节」所在页，并把那条活动原样打印
  const r = await s.eval(`(async function(){
    var found = null, meta = { pages: 0, actsPerPage: [] };
    for (var page = 0; page < 40; page++) {
      var url = '/v2/api/web/logs/learn/${CLASSROOM}?actype=-1&page=' + page + '&offset=20&sort=-1';
      var res = await fetch(url, { credentials: 'include' });
      var j = await res.json();
      var d = j.data || {};
      var acts = d.activities || [];
      meta.pages++;
      meta.actsPerPage.push(acts.length);
      for (var i = 0; i < acts.length; i++) {
        var a = acts[i];
        var t = JSON.stringify(a);
        if (t.indexOf('示例小节') >= 0) { found = { page: page, index: i, act: a, raw: t }; break; }
      }
      if (found) break;
      if (!d.has_more) break;
    }
    if (!found) return JSON.stringify({ err: 'not found', meta: meta });
    return JSON.stringify({ page: found.page, index: found.index, raw: found.raw.slice(0, 2500), keys: Object.keys(found.act) });
  })()`, true);
  const d = JSON.parse(r.value || '{}');
  console.log('分页信息:', JSON.stringify(d.meta || { page: d.page, index: d.index }));
  console.log('顶层字段:', JSON.stringify(d.keys));
  console.log('\n「示例小节A」活动的原始 JSON:');
  console.log(d.raw || d.err);

  // 顺便确认 leaf_id 出现在哪个字段名下
  const scan = await s.eval(`(async function(){
    var res = await fetch('/v2/api/web/logs/learn/${CLASSROOM}?actype=-1&page=0&offset=20&sort=-1', { credentials: 'include' });
    var txt = await res.text();
    var idx = txt.indexOf('leaf_id');
    return JSON.stringify({ found: idx >= 0, context: idx >= 0 ? txt.slice(Math.max(0, idx - 200), idx + 300) : null });
  })()`, true);
  const sc = JSON.parse(scan.value || '{}');
  console.log('\nleaf_id 出现位置:', sc.found ? '有' : '无');
  if (sc.context) console.log('上下文:', sc.context);

  s.ws.close();
  process.exit(0);
})().catch((e) => { console.error('异常:', e && e.stack || e); process.exit(1); });

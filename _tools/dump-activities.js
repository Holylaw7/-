#!/usr/bin/env node
/**
 * 调用课程活动列表接口，输出完整字段结构（小节名 / leaf_id / 完成状态 / 类型）。
 *   node _tools/dump-activities.js
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

  const r = await s.eval(`(async function(){
    var all = [];
    var page = 0;
    var hasMore = true;
    while (hasMore && page < 40) {
      var url = '/v2/api/web/logs/learn/${CLASSROOM}?actype=-1&page=' + page + '&offset=20&sort=-1';
      var res = await fetch(url, { credentials: 'include', headers: { 'Accept': 'application/json' } });
      var j = await res.json();
      var d = j.data || {};
      var acts = d.activities || [];
      acts.forEach(function(a){ all.push(a); });
      hasMore = !!d.has_more && acts.length > 0;
      page++;
    }
    // 取第一条的字段结构
    var sample = all[0] || null;
    var sampleKeys = sample ? Object.keys(sample) : null;
    // 归一化输出
    var list = all.map(function(a){
      return {
        leaf_id: a.leaf_id,
        leaf_type: a.leaf_type,
        name: a.title || a.name || (a.leaf_info && a.leaf_info.title) || '',
        done: a.is_done !== undefined ? a.is_done : (a.schedule !== undefined ? a.schedule : (a.leaf_info ? a.leaf_info.is_done : undefined)),
        raw_done: a.schedule,
        is_done: a.is_done,
        leaf_info: a.leaf_info ? { keys: Object.keys(a.leaf_info).slice(0, 20), title: a.leaf_info.title, leaf_type: a.leaf_info.leaf_type } : null,
      };
    });
    return JSON.stringify({ total: all.length, sampleKeys: sampleKeys, sample: sample, list: list }, null, 1).slice(0, 30000);
  })()`, true);
  const d = JSON.parse(r.value || '{}');
  console.log(`共取到 ${d.total} 条活动\n`);
  console.log('单条字段:', JSON.stringify(d.sampleKeys));
  console.log('\n第一条完整样本:');
  console.log(JSON.stringify(d.sample, null, 2).slice(0, 1200));
  console.log('\n小节列表（前 30 条）:');
  (d.list || []).slice(0, 30).forEach((x) => {
    const nm = x.name || (x.leaf_info && x.leaf_info.title) || '';
    console.log(`  leaf=${String(x.leaf_id).padStart(10)} type=${String(x.leaf_type).padStart(3)} done=${x.done} schedule=${x.raw_done} «${String(nm).slice(0, 34)}»`);
  });

  // 找示例小节
  const ba = (d.list || []).filter((x) => String(x.name || '').includes('示例小节'));
  if (ba.length) {
    console.log('\n★ 匹配「示例小节」的小节:');
    ba.forEach((x) => console.log(`  leaf=${x.leaf_id} type=${x.leaf_type} done=${x.done} «${x.name}»`));
  }

  s.ws.close();
  process.exit(0);
})().catch((e) => { console.error('异常:', e && e.stack || e); process.exit(1); });

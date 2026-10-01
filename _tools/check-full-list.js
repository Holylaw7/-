#!/usr/bin/env node
/**
 * 验证：用课程活动接口能否拿到【完整、有序】的小节列表（含 leaf_id），
 * 以便彻底绕开"点卡片"这一步。
 *
 *   node _tools/check-full-list.js
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
  send(method, params = {}, t = 60000) {
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

const DIG = `(async function(){
  var acts = [];
  var pages = 0;
  var seenLeaf = {};
  for (var page = 0; page < 60; page++) {
    var res = await fetch('/v2/api/web/logs/learn/${CLASSROOM}?actype=-1&page=' + page + '&offset=20&sort=-1', { credentials: 'include' });
    var j = await res.json();
    var d = j.data || {};
    var list = d.activities || [];
    list.forEach(function(a){
      var c = a.content || {};
      if (!c.leaf_id) return;
      if (seenLeaf[c.leaf_id]) return;
      seenLeaf[c.leaf_id] = 1;
      acts.push({
        leaf_id: c.leaf_id,
        title: a.title,
        type: a.type,
        courseware_id: a.courseware_id,
        score_d: c.score_d,
        create_time: a.create_time,
        page: page,
      });
    });
    pages++;
    if (!d.has_more) break;
  }
  // 按创建时间排序（接口是倒序返回的）
  acts.sort(function(a,b){ return (a.create_time||0) - (b.create_time||0); });
  return JSON.stringify({ pages: pages, total: acts.length, list: acts });
})()`;

(async () => {
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

  console.log('打开课程目录页（接口需要同源 + 登录态）…');
  await s.send('Page.navigate', { url: `${CONFIG.origin}/v2/web/studentLog/${CLASSROOM}` });
  await sleep(14000);

  const r = await s.eval(DIG, true);
  const d = JSON.parse(r.value || '{}');
  console.log(`\n分页数=${d.pages}  唯一 leaf 数=${d.total}\n`);

  console.log('=== 前 25 项（按创建时间排序）===');
  (d.list || []).slice(0, 25).forEach((x, i) => {
    console.log(`  ${String(i + 1).padStart(3)}. leaf=${String(x.leaf_id).padStart(10)} type=${String(x.type).padStart(3)} «${String(x.title).slice(0, 36)}»`);
  });

  console.log('\n=== 含「示例小节」的项 ===');
  (d.list || []).filter((x) => /示例小节/.test(String(x.title))).forEach((x, i) => {
    console.log(`  leaf=${x.leaf_id} type=${x.type} «${x.title}»`);
  });

  console.log('\n=== 类型分布 ===');
  const byType = {};
  (d.list || []).forEach((x) => { byType[x.type] = (byType[x.type] || 0) + 1; });
  console.log(' ', JSON.stringify(byType));

  // 保存完整列表供其它工具使用
  const fs = require('fs');
  const path = require('path');
  const out = path.join(__dirname, '..', '_recon', 'leaf-list.json');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(d, null, 2), 'utf8');
  console.log('\n完整列表已保存:', out);

  s.ws.close();
  process.exit(0);
})().catch((e) => { console.error('异常:', e && e.stack || e); process.exit(1); });

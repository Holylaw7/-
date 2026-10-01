#!/usr/bin/env node
/**
 * 直接连扩展的 service worker，读取它实际拿到的权限（判断 userScripts 是否已授权）。
 *   node _tools/worker-perm-check.js
 */
const PORT = Number(process.env.CDP_PORT || 9222);

(async () => {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const w = list.find((t) => t.type === 'worker' || t.type === 'service_worker');
  if (!w) {
    console.log('没有找到 worker/service_worker 目标。');
    console.log('（篡改猴的 MV3 后台可能处于休眠，属正常现象——在扩展页操作一下即可唤醒）');
    return;
  }
  console.log('worker 目标:', w.url ? w.url.slice(0, 100) : '(url 为空，可能是扩展后台)');

  const ws = new WebSocket(w.webSocketDebuggerUrl);
  await new Promise((r) => { ws.onopen = r; });
  let id = 0;
  const pend = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
  };
  const send = (method, params = {}) => new Promise((res) => {
    const i = ++id;
    pend.set(i, res);
    ws.send(JSON.stringify({ id: i, method, params }));
  });

  await send('Runtime.enable');

  const expr = `(async function () {
    var out = {};
    try { var e = await chrome.management.getSelf(); out.self = { name: e.name, version: e.version, enabled: e.enabled }; }
    catch (x) { out.selfErr = String(x); }
    try {
      out.hasUserScriptsApi = !!chrome.userScripts;
      if (chrome.userScripts) {
        var s = await chrome.userScripts.getScripts();
        out.registeredScripts = s.length;
      }
    } catch (x) { out.userScriptsErr = String(x); }
    try { var p = await chrome.permissions.getAll(); out.permissions = p.permissions; out.origins = p.origins; }
    catch (x) { out.permErr = String(x); }
    return JSON.stringify(out, null, 2);
  })()`;

  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  const val = r.result && r.result.result && r.result.result.value;
  console.log('\n结果:');
  console.log(val || JSON.stringify(r, null, 2).slice(0, 1200));
  ws.close();
  process.exit(0);
})().catch((e) => { console.error('异常:', e && e.stack || e); process.exit(1); });

#!/usr/bin/env node
/**
 * 通过 CDP 直接检查篡改猴扩展是否拿到了 userScripts 权限。
 *   node _tools/check-userscripts-permission.js
 */
const PORT = Number(process.env.CDP_PORT || 9222);
const TM_ID = 'iikmkjmpaadaobahmlepeloendndfphd';

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
  send(method, params = {}, t = 20000) {
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

const PROBE = `(async function () {
  var out = {};
  try {
    var e = await chrome.management.getSelf();
    out.self = { name: e.name, version: e.version, enabled: e.enabled, permissions: e.permissions };
  } catch (err) { out.selfErr = String(err); }
  // userScripts 是否真的可用
  try {
    if (chrome.userScripts) {
      var scripts = await chrome.userScripts.getScripts();
      out.userScriptsApi = { available: true, registered: scripts.length };
    } else {
      out.userScriptsApi = { available: false, note: 'chrome.userScripts 未暴露 → 权限未授予' };
    }
  } catch (err) {
    out.userScriptsApi = { available: 'error', err: String(err) };
  }
  try {
    var a = await chrome.permissions.getAll();
    out.grantedPermissions = a.permissions;
    out.grantedOrigins = a.origins;
  } catch (err) { }
  return JSON.stringify(out, null, 2);
})()`;

(async () => {
  let pages;
  try {
    pages = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json());
  } catch (e) {
    console.error(`✗ 连不上调试端口 ${PORT}。请先启动调试窗口。`);
    process.exit(1);
  }

  // 需要是扩展页面才能用 chrome.management
  const extPage = pages.find((p) => p.url.startsWith('chrome-extension://' + TM_ID) || p.url.startsWith('edge-extension://' + TM_ID));
  const anyPage = pages.find((p) => p.type === 'page');

  // 先看扩展有没有 service worker 目标（MV3 的后台）
  const tmSw = pages.find((t) => t.type === 'service_worker' && t.url.includes(TM_ID));
  console.log('篡改猴 service worker:', tmSw ? '运行中 ' + tmSw.url.slice(0, 80) : '未在目标列表中');

  const target = tmSw || extPage || anyPage;
  if (!target) { console.error('没有可用目标'); process.exit(1); }
  console.log('用于探测的目标:', target.type, target.url.slice(0, 90), '\n');

  const s = await Session.connect(target.webSocketDebuggerUrl);
  await s.send('Runtime.enable');
  const r = await s.eval(PROBE, true);
  console.log(r.error ? ('探测失败: ' + r.error) : r.value);

  // 若在普通页面，退而求其次：看 page 能否访问 chrome.userScripts（页面上下文通常没有）
  if (!tmSw) {
    console.log('\n（提示：普通页面上下文拿不到 chrome.management，上面结果可能不完整）');
  }

  s.ws.close();
  process.exit(0);
})().catch((e) => { console.error('异常:', e && e.stack || e); process.exit(1); });

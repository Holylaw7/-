#!/usr/bin/env node
/**
 * 把调试窗口里篡改猴的脚本源码更新为 dist 里的最新版本。
 *   node _tools/tm-update-script.js
 *
 * 原理：篡改猴把用户脚本存在 chrome.storage.local 的
 *       !extdb.@meta#<uuid>（元数据）和 !extdb.@source#<uuid>（源码）里，
 *       直接改写 @source 即可更新（随后需要刷新页面重新注入）。
 */
const fs = require('fs');
const path = require('path');
const PORT = Number(process.env.CDP_PORT || 9222);
const TM_ID = 'iikmkjmpaadaobahmlepeloendndfphd';
const SOURCE = path.join(__dirname, '..', 'dist', 'changjiang-yuketang-auto.user.js');
const SCRIPT_NAME = '长江雨课堂 · 自动刷课助手';

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

(async () => {
  if (!fs.existsSync(SOURCE)) { console.error('缺少 dist 产物，先执行 node build.js'); process.exit(1); }
  const src = fs.readFileSync(SOURCE, 'utf8');
  console.log(`本地最新脚本: ${(src.length / 1024).toFixed(1)} KB`);

  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const sw = list.find((t) => t.type === 'service_worker' && t.url.includes(TM_ID));
  if (!sw) { console.error('篡改猴后台未运行，无法写入'); process.exit(1); }

  const s = await Session.connect(sw.webSocketDebuggerUrl);
  await s.send('Runtime.enable');

  // 找到目标脚本的 uuid
  const find = await s.eval(`(async function(){
    var all = await chrome.storage.local.get(null);
    var found = null;
    Object.keys(all).forEach(function (k) {
      var m = k.match(/^!extdb\\.@meta#(.+)$/);
      if (!m) return;
      var v = all[k];
      var val = (v && v.value) ? v.value : v;
      if (val && val.name === ${JSON.stringify(SCRIPT_NAME)}) found = { uuid: m[1], version: val.version };
    });
    return JSON.stringify(found);
  })()`, true);
  const info = JSON.parse(find.value || 'null');
  if (!info) { console.error('没找到目标脚本'); process.exit(1); }
  console.log(`找到脚本: uuid=${info.uuid} 当前版本=${info.version}`);

  // 备份原源码
  const backupDir = path.join(__dirname, '..', '_backup');
  fs.mkdirSync(backupDir, { recursive: true });
  const oldSrc = await s.eval(`(async function(){
    var all = await chrome.storage.local.get(null);
    var v = all['!extdb.@source#' + ${JSON.stringify(info.uuid)}];
    return String((v && v.value) ? v.value : v || '');
  })()`, true);
  const backupFile = path.join(backupDir, `tm-source-${info.version}-${Date.now()}.js`);
  fs.writeFileSync(backupFile, oldSrc.value || '', 'utf8');
  console.log(`已备份原源码 (${((oldSrc.value || '').length / 1024).toFixed(1)} KB) → ${backupFile}`);

  // 写入新源码
  console.log('写入新源码…');
  const writeRes = await s.eval(`(async function(){
    var key = '!extdb.@source#' + ${JSON.stringify(info.uuid)};
    var all = await chrome.storage.local.get(key);
    var old = all[key];
    var wrap = (old && typeof old === 'object' && 'value' in old) ? { origin: old.origin || 'normal', value: ${JSON.stringify(src)} } : ${JSON.stringify(src)};
    var obj = {}; obj[key] = wrap;
    await chrome.storage.local.set(obj);
    var check = await chrome.storage.local.get(key);
    var v = check[key];
    var len = String((v && v.value) ? v.value : v || '').length;
    return JSON.stringify({ written: true, len: len });
  })()`, true);
  console.log('写入结果:', writeRes.value || writeRes.error);

  // 顺便清掉可能残留的测试用设置
  const clearLs = await s.eval(`(async function(){
    // 篡改猴的 localStorage 与页面共享，这里清不了页面的 localStorage；
    // 但可以把测试期写入的开关从 storage 里标记出来（实际清理在页面侧做）
    return 'ok';
  })()`);

  console.log('\n下一步：刷新雨课堂页面，让新脚本重新注入。');
  s.ws.close();
  process.exit(0);
})().catch((e) => { console.error('异常:', e && e.stack || e); process.exit(1); });

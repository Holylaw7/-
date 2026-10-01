#!/usr/bin/env node
/**
 * 按篡改猴自身的存储格式更新用户脚本（同时更新 @source 与 @meta 的 header/version）。
 * 之前只写 @source 会导致篡改猴内部缓存不一致 → 脚本不再注入。
 *
 *   node _tools/tm-write-script.js                  # 写入 dist 最新版
 *   node _tools/tm-write-script.js --restore <file> # 还原备份
 */
const fs = require('fs');
const path = require('path');
const PORT = Number(process.env.CDP_PORT || 9222);
const TM_ID = 'iikmkjmpaadaobahmlepeloendndfphd';
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
  const restoreIdx = process.argv.indexOf('--restore');
  let srcFile;
  if (restoreIdx >= 0) {
    srcFile = process.argv[restoreIdx + 1];
  } else {
    srcFile = path.join(__dirname, '..', 'dist', 'changjiang-yuketang-auto.user.js');
  }
  if (!srcFile || !fs.existsSync(srcFile)) { console.error('找不到源文件:', srcFile); process.exit(1); }
  const src = fs.readFileSync(srcFile, 'utf8');
  const ver = (src.match(/@version\s+(\S+)/) || [])[1] || '0.0.0';
  const nm = (src.match(/@name\s+(.+)/) || [])[1] || SCRIPT_NAME;
  console.log(`写入 ${path.basename(srcFile)}  (${(src.length / 1024).toFixed(1)} KB, v${ver})`);

  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const sw = list.find((t) => t.type === 'service_worker' && t.url.includes(TM_ID));
  if (!sw) { console.error('篡改猴后台未运行'); process.exit(1); }
  const s = await Session.connect(sw.webSocketDebuggerUrl);
  await s.send('Runtime.enable');

  const r = await s.eval(`(async function(){
    var NAME = ${JSON.stringify(SCRIPT_NAME)};
    var SRC = ${JSON.stringify(src)};
    var VER = ${JSON.stringify(ver)};

    var all = await chrome.storage.local.get(null);
    var uuid = null, metaKey = null, metaWrap = null, meta = null;
    Object.keys(all).forEach(function (k) {
      var m = k.match(/^!extdb\\.@meta#(.+)$/);
      if (!m) return;
      var v = all[k]; var val = (v && v.value) ? v.value : v;
      if (val && val.name === NAME) { uuid = m[1]; metaKey = k; metaWrap = v; meta = val; }
    });
    if (!uuid) return JSON.stringify({ err: 'script not found' });

    // 用脚本头部覆盖 meta.header / meta.version，保持内部一致
    var headerBlock = SRC.slice(0, SRC.indexOf('// ==/UserScript==') + '// ==/UserScript=='.length);
    meta.header = headerBlock;
    meta.version = VER;
    meta.lastModified = Date.now();
    // 依据新头部刷新匹配列表
    var matches = [];
    headerBlock.split('\\n').forEach(function (line) {
      var m = line.match(/^\\/\\/\\s*@match\\s+(\\S+)/);
      if (m) matches.push(m[1]);
    });
    if (matches.length) {
      meta.matches = matches;
      if (!meta.options) meta.options = {};
      meta.options.orig_matches = matches;
    }

    var obj = {};
    obj['!extdb.@source#' + uuid] = (metaWrap && typeof metaWrap === 'object')
      ? Object.assign({}, metaWrap, { value: SRC })
      : { origin: 'normal', value: SRC };
    obj[metaKey] = (metaWrap && typeof metaWrap === 'object')
      ? Object.assign({}, metaWrap, { value: meta })
      : { origin: 'normal', value: meta };

    await chrome.storage.local.set(obj);

    // 回读校验
    var back = await chrome.storage.local.get(['!extdb.@source#' + uuid, metaKey]);
    var sBack = back['!extdb.@source#' + uuid];
    var mBack = back[metaKey];
    var sLen = String((sBack && sBack.value) ? sBack.value : sBack || '').length;
    var mVal = (mBack && mBack.value) ? mBack.value : mBack;
    return JSON.stringify({ ok: true, uuid: uuid, srcLen: sLen, metaVersion: mVal && mVal.version,
      metaMatches: mVal && mVal.matches, headerVer: (mVal && mVal.header || '').match(/@version\\s+(\\S+)/) });
  })()`, true);
  console.log('写入结果:', r.value || r.error);

  s.ws.close();
  process.exit(0);
})().catch((e) => { console.error('异常:', e && e.stack || e); process.exit(1); });

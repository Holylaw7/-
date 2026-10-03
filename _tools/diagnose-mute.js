#!/usr/bin/env node
/**
 * 静音对抗诊断：观察站点是否反复取消静音，以及强制静音能否维持。
 *   node _tools/diagnose-mute.js
 */
const CONFIG = require('./config');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  async json(expr, aw = false) {
    try {
      const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: aw });
      if (r.exceptionDetails) return { __err: r.exceptionDetails.exception?.description || 'err' };
      const v = r.result.value;
      return typeof v === 'string' ? JSON.parse(v) : (v || {});
    } catch (e) { return { __err: e.message }; }
  }
}

(async () => {
  const list = await (await fetch(`http://127.0.0.1:${CONFIG.cdpPort}/json/list`)).json();
  const p = list.find((t) => t.type === 'page' && /yuketang/.test(t.url));
  if (!p) { console.error('没有雨课堂标签页'); process.exit(1); }
  const s = await S.open(p.webSocketDebuggerUrl);
  await s.send('Runtime.enable');

  console.log('=== ① 观察 12 秒内 muted 的变化（不做任何干预）===');
  for (let i = 0; i < 6; i++) {
    const d = await s.json(`(function(){ var v=document.querySelector('video');
      return JSON.stringify({ t: v?+v.currentTime.toFixed(1):null, muted: v?v.muted:null, vol: v?v.volume:null,
        attrMuted: v?v.hasAttribute('muted'):null, defaultMuted: v?v.defaultMuted:null,
        paused: v?v.paused:null, rate: v?v.playbackRate:null,
        mutedPropWritable: (function(){ try { var d=Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype,'muted');
          return d ? {set: !!d.set, get: !!d.get, configurable: d.configurable} : 'none'; } catch(e){ return String(e) } })()
      }); })()`);
    console.log(`  ${i * 2}s: muted=${d.muted} vol=${d.vol} attr=${d.attrMuted} default=${d.defaultMuted} paused=${d.paused} rate=${d.rate} t=${d.t}`);
    if (i === 0) console.log('     muted 属性描述符:', JSON.stringify(d.mutedPropWritable));
    await sleep(2000);
  }

  console.log('\n=== ② 手动强制静音，观察能否维持 10 秒 ===');
  await s.json(`(function(){ var v=document.querySelector('video');
    if(!v) return JSON.stringify({err:'no video'});
    v.muted = true; v.volume = 0; v.defaultMuted = true; v.setAttribute('muted','muted');
    return JSON.stringify({ ok:true, muted:v.muted }); })()`);
  const t0 = Date.now();
  let lostAt = null;
  while (Date.now() - t0 < 10000) {
    const d = await s.json(`(function(){ var v=document.querySelector('video');
      return JSON.stringify({ muted: v?v.muted:null, vol: v?v.volume:null, attr: v?v.hasAttribute('muted'):null }); })()`);
    const el = ((Date.now() - t0) / 1000).toFixed(0);
    if (!d.muted && lostAt === null) { lostAt = el; console.log(`  ${el}s: ✗ 静音被取消（muted=${d.muted} vol=${d.vol} attr=${d.attr}）`); }
    else if (d.muted) console.log(`  ${el}s: ✓ 仍静音（vol=${d.vol} attr=${d.attr}）`);
    await sleep(2000);
  }
  console.log(lostAt ? `\n结论：站点会在约 ${lostAt} 秒内取消静音 → 需要持续强制` : '\n结论：强制静音后未被取消');

  console.log('\n=== ③ 站点的静音控制代码（看它怎么改的）===');
  const w = await s.json(`(function(){
    var v = document.querySelector('video');
    var out = { hasVolumeControl: false, notes: [] };
    try {
      // 找播放器容器上的 Vue 实例，看是否通过 Vue 控制音量
      var root = document.querySelector('.xt_video_player_container, .xtplayer, .video-box, [class*=xt_video_player]');
      var cur = root;
      for (var i=0; cur && i<6; i++) {
        if (cur.__vue__) {
          var pd = cur.__vue__.$data && cur.__vue__.$data.player;
          if (pd && pd.options) {
            out.hasVolumeControl = true;
            out.volumeOption = JSON.stringify(pd.options.volume || null).slice(0, 200);
            out.playerKeys = Object.keys(pd).slice(0, 25);
            break;
          }
        }
        cur = cur.parentElement;
      }
    } catch(e) { out.err = String(e) }
    return JSON.stringify(out); })()`);
  console.log('  ', JSON.stringify(w));

  s.ws.close();
  process.exit(0);
})().catch((e) => { console.error('异常:', e && e.stack || e); process.exit(1); });

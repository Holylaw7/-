#!/usr/bin/env node
/**
 * 用浏览器自己的 MediaRecorder 生成一个真正可解码的测试视频（WebM/VP8）。
 *
 * 背景：headless Edge 对 WAV(PCM/µ-law) 会报 MEDIA_ELEMENT_ERROR: Format error，
 *      为了忠实复现「真实视频播放」，这里让浏览器自己录一段 canvas 视频作为仿真素材。
 *
 * 注意：MediaRecorder 产出的 WebM 通常 duration = Infinity（缺少 Duration 元素），
 *      因此真实时长由本脚本写入 public/media/clip.json，仿真页面据此设定进度。
 *
 *   node _tools/make-webm.js [秒数] [--force]
 *
 * 产物：_tools/public/media/clip.webm + clip.json
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9357;
const MEDIA_DIR = path.join(__dirname, 'public', 'media');
const OUT = path.join(MEDIA_DIR, 'clip.webm');
const META = path.join(MEDIA_DIR, 'clip.json');
const SECONDS = Number(process.argv.find((a) => /^\d+$/.test(a)) || 8);
const FORCE = process.argv.includes('--force');
const MOCK_URL = process.env.MOCK_URL || `http://127.0.0.1:${process.env.MOCK_PORT || 8099}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  if (!FORCE && fs.existsSync(OUT) && fs.existsSync(META)) {
    const meta = JSON.parse(fs.readFileSync(META, 'utf8'));
    console.log(`✓ 已存在 clip.webm (${fs.statSync(OUT).size} bytes, duration=${meta.duration}s)，跳过（--force 可重建）`);
    return;
  }
  fs.mkdirSync(MEDIA_DIR, { recursive: true });

  const browser = spawn(EDGE, [
    '--headless=new', `--remote-debugging-port=${PORT}`,
    '--user-data-dir=' + path.join(os.tmpdir(), 'ykt-webm-' + Date.now()),
    '--no-first-run', '--no-default-browser-check', '--disable-gpu',
    '--autoplay-policy=no-user-gesture-required', '--lang=zh-CN', 'about:blank',
  ], { stdio: 'ignore' });

  let ws;
  try {
    let target = null;
    for (let i = 0; i < 50 && !target; i++) {
      try { target = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((t) => t.type === 'page'); } catch (e) { }
      if (!target) await sleep(400);
    }
    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((r, j) => { ws.onopen = r; ws.onerror = () => j(new Error('ws fail')); });
    let id = 0; const pending = new Map();
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.j(new Error(JSON.stringify(m.error))) : p.r(m.result); }
    };
    const send = (method, params = {}, t = 400000) => new Promise((r, j) => {
      const i = ++id; pending.set(i, { r, j });
      ws.send(JSON.stringify({ id: i, method, params }));
      setTimeout(() => { if (pending.has(i)) { pending.delete(i); j(new Error('timeout ' + method)); } }, t);
    });
    const evalx = async (expr, aw = false) => {
      const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: aw, userGesture: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval error');
      return r.result.value;
    };

    await send('Page.enable');
    await send('Runtime.enable');

    console.log(`[webm] 让 Edge 录制 ${SECONDS}s 的 canvas 视频…`);
    const res = await evalx(`(async function () {
      var W = 640, H = 360, FPS = 12;
      var cv = document.createElement('canvas');
      cv.width = W; cv.height = H;
      var ctx = cv.getContext('2d');
      var stop = false, t0 = performance.now();
      function draw() {
        if (stop) return;
        var t = (performance.now() - t0) / 1000;
        var g = ctx.createLinearGradient(0, 0, W, H);
        g.addColorStop(0, '#1e3a8a'); g.addColorStop(1, '#0f172a');
        ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
        ctx.fillStyle = '#93c5fd'; ctx.font = '600 40px sans-serif';
        ctx.fillText('YKT MOCK', 40, 90);
        ctx.fillStyle = '#e2e8f0'; ctx.font = '30px monospace';
        ctx.fillText(t.toFixed(1) + 's', 40, 160);
        ctx.fillStyle = '#22d3ee';
        ctx.beginPath();
        ctx.arc(140 + Math.sin(t * 2) * 90, 250, 26, 0, Math.PI * 2);
        ctx.fill();
        requestAnimationFrame(draw);
      }
      draw();
      var stream = cv.captureStream(FPS);
      var types = ['video/webm;codecs=vp8', 'video/webm;codecs=vp9', 'video/webm'];
      var mime = types.find(function (m) { return MediaRecorder.isTypeSupported(m); });
      if (!mime) return { error: 'no supported webm recorder mime' };
      var rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 400000 });
      var chunks = [];
      rec.ondataavailable = function (e) { if (e.data && e.data.size) chunks.push(e.data); };
      var done = new Promise(function (r) { rec.onstop = r; });
      var t0rec = performance.now();
      rec.start(200);
      await new Promise(function (r) { setTimeout(r, ${SECONDS * 1000}) });
      var realMs = performance.now() - t0rec;
      stop = true;
      rec.stop();
      await done;
      stream.getTracks().forEach(function (tr) { tr.stop(); });
      var blob = new Blob(chunks, { type: mime });
      var bytes = new Uint8Array(await blob.arrayBuffer());
      var s = '';
      for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
      return { mime: mime, size: bytes.length, realMs: Math.round(realMs), b64: btoa(s) };
    })()`, true);

    if (!res || res.error) throw new Error('录制失败: ' + JSON.stringify(res));
    fs.writeFileSync(OUT, Buffer.from(res.b64, 'base64'));
    // 真实时长以录制墙钟时间为准（MediaRecorder 产物不含 Duration 元素）
    const duration = Math.round((res.realMs / 1000) * 10) / 10;
    fs.writeFileSync(META, JSON.stringify({ duration, mime: res.mime, bytes: res.size, generatedAt: new Date().toISOString() }, null, 2));
    console.log(`[webm] mime=${res.mime}  ${res.size} bytes  实测时长=${duration}s`);
    console.log(`[webm] -> ${path.relative(process.cwd(), OUT)}`);

    // 回读自检（必须走 HTTP：file:// 会被 URL 安全检查拒绝）
    const verify = await evalx(`(async function(){
      var v = document.createElement('video');
      v.muted = true;
      v.src = ${JSON.stringify(MOCK_URL + '/media/clip.webm')} + '?t=' + Date.now();
      var r = await new Promise(function(res){
        v.addEventListener('loadedmetadata', function(){ res('ok size=' + v.videoWidth + 'x' + v.videoHeight + ' duration=' + v.duration) });
        v.addEventListener('error', function(){ res('ERROR code=' + (v.error && v.error.code) + ' ' + (v.error && v.error.message)) });
        setTimeout(function(){ res('timeout') }, 8000);
      });
      try { await v.play(); } catch (e) { return r + ' | play fail: ' + e.name; }
      await new Promise(function(x){ setTimeout(x, 1200) });
      return r + ' | play ok, t=' + v.currentTime.toFixed(2);
    })()`, true);
    console.log('[webm] 解码自检:', verify);
  } catch (e) {
    console.error('[webm] 异常:', e && e.stack || e);
    process.exitCode = 1;
  } finally {
    try { ws && ws.close(); } catch (e) { }
    try { browser.kill(); } catch (e) { }
  }
  process.exit(process.exitCode || 0);
})();

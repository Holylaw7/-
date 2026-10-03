#!/usr/bin/env node
/**
 * 端到端验证：在真实 Edge 浏览器中加载用户脚本，跑完整个仿真课程。
 *
 *   node _tools/e2e.js [--headful] [--keep]
 *
 * 验证点：
 *   1. 目录页 -> 自动进入第一个未完成小节
 *   2. 自动跳过测验小节
 *   3. 视频以 2 倍速播放（真实 playbackRate 采样）
 *   4. 切到后台（真实的新标签页夺焦）后仍继续播放、不掉速、服务端没有收到 hidden 上报
 *   5. 一节播完自动跳转下一节，直到全部完成
 */
const CONFIG = require('./config');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const CDP_PORT = 9333;
const APP = `http://127.0.0.1:${process.env.MOCK_PORT || 8099}`;
const CLASSROOM = CONFIG.mock.classroom;
const CFIG_MUTE = !!CONFIG.mute;   // 仿真教室号，与真实课程无关
const USERSCRIPT = path.join(__dirname, '..', 'dist', 'changjiang-yuketang-auto.user.js');
const SHOTS = path.join(__dirname, '..', 'screenshots');
fs.mkdirSync(SHOTS, { recursive: true });

const HEADFUL = process.argv.includes('--headful');
const KEEP = process.argv.includes('--keep');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ts = () => new Date().toTimeString().slice(0, 8);

let pass = 0, fail = 0;
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  ok ? pass++ : fail++;
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? '  — ' + detail : ''}`);
}

// ---------------------------------------------------------------- CDP 客户端
class Session {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.events = []; this.handlers = new Map(); }
  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws connect failed')); });
    const s = new Session(ws);
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && s.pending.has(msg.id)) {
        const { res, rej } = s.pending.get(msg.id);
        s.pending.delete(msg.id);
        msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
      } else if (msg.method) {
        s.events.push(msg);
        const hs = s.handlers.get(msg.method);
        if (hs) hs.forEach((h) => { try { h(msg.params); } catch (e) { } });
      }
    };
    return s;
  }
  on(method, fn) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(fn);
  }
  send(method, params = {}, timeout = 60000) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error('timeout: ' + method)); } }, timeout);
    });
  }
  async eval(expr, awaitPromise = false) {
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise, userGesture: true });
    if (r.exceptionDetails) return { error: r.exceptionDetails.exception?.description || 'eval error' };
    return { value: r.result.value };
  }
  async shot(name) {
    try {
      const r = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      fs.writeFileSync(path.join(SHOTS, name), Buffer.from(r.data, 'base64'));
      return true;
    } catch (e) { return false; }
  }
}

async function listPages() {
  const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`);
  return (await r.json()).filter((t) => t.type === 'page');
}

async function attachFirstPage() {
  for (let i = 0; i < 50; i++) {
    try {
      const pages = await listPages();
      if (pages.length) return pages[0];
    } catch (e) { }
    await sleep(400);
  }
  throw new Error('无法连接 CDP');
}

async function serverState() {
  const r = await fetch(`${APP}/__state`);
  return r.json();
}

// ---------------------------------------------------------------- 主流程
(async () => {
  if (!fs.existsSync(USERSCRIPT)) {
    console.error('缺少产物，请先执行: node build.js');
    process.exit(1);
  }
  const scriptSrc = fs.readFileSync(USERSCRIPT, 'utf8');
  console.log(`[${ts()}] 用户脚本 ${(scriptSrc.length / 1024).toFixed(1)} KB`);

  // 重置服务端
  await fetch(`${APP}/__reset`).catch(() => { });
  const s0 = await serverState();
  console.log(`[${ts()}] 仿真课程：${s0.total} 个小节，其中视频 ${s0.videoTotal} 个、测验 1 个`);

  const profile = path.join(os.tmpdir(), 'ykt-e2e-' + Date.now());
  const args = [
    HEADFUL ? '--window-size=1200,820' : '--headless=new',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu',
    '--disable-features=Translate,OptimizationHints',
    '--autoplay-policy=no-user-gesture-required',
    '--lang=zh-CN',
    'about:blank',
  ];
  const browser = spawn(EDGE, args, { stdio: 'ignore' });
  console.log(`[${ts()}] 已启动 Edge（${HEADFUL ? '有界面' : 'headless'}），profile=${profile}`);

  let page, main;
  try {
    const target = await attachFirstPage();
    main = await Session.connect(target.webSocketDebuggerUrl);
    await main.send('Page.enable');
    await main.send('Runtime.enable');

    // ---- 在「任何页面脚本之前」注入用户脚本 ----
    await main.send('Page.addScriptToEvaluateOnNewDocument', { source: scriptSrc });

    // 倍速采样器：直接轮询脚本自身的诊断状态（跨导航有效，且测的是真实运行代码）
    const rateSamples = [];
    let sampling = false;
    const startSampling = () => {
      sampling = true;
      (async () => {
        while (sampling) {
          try {
            const v = await main.eval(`window.__yktTool ? JSON.stringify({
              r: window.__yktTool.state.rate, p: window.__yktTool.state.paused,
              t: window.__yktTool.state.currentTime, rs: window.__yktTool.state.readyState,
              leaf: window.__yktTool.state.route.leafId, run: window.__yktTool.state.running,
              mid: window.__yktTool.state.mediaTag,
              fixes: window.__yktTool.state.rateFixCount, ts: Date.now() }) : null`);
            if (v && v.value) rateSamples.push(JSON.parse(v.value));
          } catch (e) { }
          await sleep(300);
        }
      })();
    };
    const stopSampling = () => { sampling = false; };
    /**
     * 判定样本是否处于「有效播放期」。
     * 页面刚导航到新小节的瞬间，媒体尚未起播（currentTime=0/readyState<3），
     * 此时 paused=true、playbackRate=1 属于加载瞬态，不应算作「被暂停/被降速」。
     */
    /**
     * 判定样本是否处于「有效播放期」。
     * 需要排除两类固有瞬态，它们都不是「被站点暂停/降速」：
     *   ① 页面刚导航到新小节，媒体尚未起播（readyState<3 或 currentTime 很小）
     *   ② 新小节的媒体刚起播的头一小段：浏览器默认 playbackRate=1，
     *      脚本的保活循环需要一拍（≤500ms）才能把它设成 2x
     * 判定「新小节起播」用播放位置归零这个明确信号 —— 不能靠 leafId 首次出现，
     * 因为 SPA 会先改 URL、后换页面，旧页面会带着新 leafId 被采样到。
     */
    const PLAYING = (s) => s && s.rs >= 3 && Number(s.t) > 0.4;
    const restartAt = new Set();        // 媒体重启（位置归零）的样本下标
    for (let i = 1; i < rateSamples.length; i++) {
      const prev = rateSamples[i - 1], cur = rateSamples[i];
      if (PLAYING(prev) && PLAYING(cur) && Number(cur.t) < Number(prev.t) - 0.4) restartAt.add(i);
    }
    const STARTUP_GRACE_MS = 1500;
    const isPlaying = (s) => {
      if (!PLAYING(s)) return false;
      const i = rateSamples.indexOf(s);
      // 往前找最近一次「媒体重启」，落在宽限期内的一律算启动瞬态
      for (let j = i; j >= 0 && rateSamples[j].ts >= s.ts - STARTUP_GRACE_MS; j--) {
        if (restartAt.has(j)) return false;
      }
      return true;
    };
    /** 播放中却掉速：这才是真正的「被降速」（瞬态不算） */
    const isSlowed = (s) => isPlaying(s) && Math.abs(Number(s.r) - 2) > 0.01;
    /** 播放中却被暂停：这才是真正的「被暂停」 */
    const isStalled = (s) => isPlaying(s) && s.p === true;

    // ---- 登录（仿真站点：一键登录）----
    console.log(`[${ts()}] 打开仿真站点并登录…`);
    await main.send('Page.navigate', { url: `${APP}/web` });
    await sleep(1500);
    const loginInfo = await main.eval(`document.getElementById('btn-login') ? 'has-button' : 'no-button'`);
    check('仿真站点登录页可用', loginInfo.value === 'has-button', String(loginInfo.value));
    if (loginInfo.value === 'has-button') {
      await main.eval(`document.getElementById('btn-login').click(); true`);
      await sleep(2500);
    }

    // ---- 进入课程目录页，让脚本自动开工 ----
    console.log(`[${ts()}] 进入课程目录页：/v2/web/studentLog/${CLASSROOM}`);
    await main.send('Page.navigate', { url: `${APP}/v2/web/studentLog/${CLASSROOM}` });
    await sleep(3500);

    const boot = await main.eval(`JSON.stringify({
      url: location.pathname,
      panel: !!document.getElementById('ykt-tool-host'),
      bootFlag: sessionStorage.getItem('ykt_tool:boot'),
      hasGuard: typeof HTMLMediaElement !== 'undefined' && !!HTMLMediaElement.prototype.pause.__yktPatched,
      hidden: document.hidden, vis: document.visibilityState, focus: document.hasFocus(),
    })`);
    console.log(`[${ts()}] 脚本装载状态: ${boot.value}`);
    let b = {};
    try { b = JSON.parse(boot.value); } catch (e) { }
    check('用户脚本已注入并生成控制面板', b.panel === true);
    check('后台守卫已生效（document.hidden 恒为 false）', b.hidden === false && b.vis === 'visible', `hidden=${b.hidden} vis=${b.vis}`);
    check('pause() 已被接管', b.hasGuard === true);

    // 等脚本自己点进第一个小节
    console.log(`[${ts()}] 等待脚本自动进入第一个小节…`);
    let entered = false;
    for (let i = 0; i < 40; i++) {
      const u = await main.eval(`location.pathname`);
      if (String(u.value).includes('/lms-graph/')) { entered = true; break; }
      await sleep(500);
    }
    check('自动跳转：目录页 → 播放页', entered, String((await main.eval(`location.pathname`)).value));
    await sleep(3000);

    const playInfo = await main.eval(`JSON.stringify(window.__yktTool ? {
      rate: window.__yktTool.state.rate,
      paused: window.__yktTool.state.paused,
      muted: window.__yktTool.state.muted,
      leaf: window.__yktTool.state.route.leafId,
      mediaTag: window.__yktTool.state.mediaTag,
      readyState: window.__yktTool.state.readyState,
      duration: window.__yktTool.state.duration,
      error: window.__yktTool.state.error,
      progress: window.__yktTool.state.progress,
      playFailCount: window.__yktTool.state.playFailCount,
      guard: window.__yktTool.state.guard,
    } : { noTool: true })`);
    console.log(`[${ts()}] 播放状态: ${playInfo.value}`);
    let p = {};
    try { p = JSON.parse(playInfo.value); } catch (e) { }
    check('脚本已掌握播放器', p.mediaTag !== undefined && p.mediaTag !== null, `media=${p.mediaTag}`);
    check('倍速已锁定为 2x', Math.abs(Number(p.rate) - 2) < 0.01, `playbackRate=${p.rate}`);
    check('视频处于播放状态', p.paused === false, `paused=${p.paused}, readyState=${p.readyState}, playFail=${p.playFailCount}, mediaError=${JSON.stringify(p.error)}`);
    // 静音自 v1.1.2 起默认关闭（避免与站点反复对抗），仅在开启时才校验
    // 静音自 v1.1.2 起默认关闭（避免与站点反复对抗），因此按设置值校验
    check('静音状态符合设置', CFIG_MUTE ? p.muted === true : p.muted === false,
      'CFG.mute=' + CFIG_MUTE + ', muted=' + p.muted);

    await main.shot('01-播放中.png');

    // ---- 后台化验证：新开标签页并真正激活它（Playwright 同款做法） ----
    const bgProbe = `JSON.stringify({
      t: (function(){var m=document.querySelector('video,audio');return m?m.currentTime:null})(),
      paused: (function(){var m=document.querySelector('video,audio');return m?m.paused:null})(),
      rate: (function(){var m=document.querySelector('video,audio');return m?m.playbackRate:null})(),
      route: location.pathname,
      tool: window.__yktTool ? { running: window.__yktTool.state.running, phase: window.__yktTool.state.phase } : null,
      playerLog: (window.__playerLog || []).slice(-4).map(function(x){return x[1]}),
    })`;
    console.log(`[${ts()}] 打开新标签页并激活，把播放页切到后台…`);
    startSampling();
    const bg = await main.send('Target.createTarget', { url: 'about:blank' });
    const bgPages = await listPages();
    const bgPage = bgPages.find((t) => t.id === bg.targetId);
    let bgS = null;
    if (bgPage) {
      bgS = await Session.connect(bgPage.webSocketDebuggerUrl);
      await bgS.send('Runtime.enable');
      await bgS.send('Page.enable');
      await bgS.send('Page.bringToFront');
    }
    await sleep(2500);

    const before = JSON.parse((await main.eval(bgProbe)).value);
    console.log(`[${ts()}] 后台期间(2.5s): ${JSON.stringify(before)}`);
    await sleep(12000);
    const after = JSON.parse((await main.eval(bgProbe)).value);
    console.log(`[${ts()}] 后台期间(14.5s): ${JSON.stringify(after)}`);

    // 采样统计：区分「加载瞬态」与「有效播放期」
    const sampled = rateSamples.filter((x) => x.r !== null && x.r !== undefined);
    const valid = sampled.filter(isPlaying);
    const transient = sampled.length - valid.length;
    const bgSampled = sampled.slice(-22);
    const bgValid = bgSampled.filter(isPlaying);
    const bgSlowed = bgSampled.filter(isSlowed);
    const bgStalled = bgSampled.filter(isStalled);
    const rateSet = [...new Set(valid.map((x) => x.r))];
    console.log(`[${ts()}] 采样 ${sampled.length} 次（排除加载瞬态 ${transient} 次）；`
      + `有效播放期倍速取值=${JSON.stringify(rateSet)}；播放中被暂停=${valid.filter(isStalled).length}；播放中掉速=${valid.filter(isSlowed).length}`);
    console.log(`[${ts()}] 后台阶段样本 ${bgSampled.length} 个（有效播放 ${bgValid.length}），`
      + `倍速取值=${JSON.stringify([...new Set(bgSampled.map((x) => x.r))])}，播放中暂停=${bgStalled.length}，播放中掉速=${bgSlowed.length}`);

    check('已切到后台（聚焦新标签页）且脚本仍在运行', !!bgPage && after.tool && after.tool.running === true,
      `bgTarget=${bg.targetId.slice(0, 8)}, running=${after.tool && after.tool.running}`);
    check('后台期间播放中从未被暂停', bgValid.length > 0 && bgStalled.length === 0,
      `有效播放样本=${bgValid.length}, 暂停=${bgStalled.length}`);
    check('后台期间播放中倍速从未掉到 1x', bgValid.length > 0 && bgSlowed.length === 0,
      `有效播放样本=${bgValid.length}, 掉速=${bgSlowed.length}`);
    check('后台期间视频确实在推进', bgValid.length > 0 && Number(after.t) > 0.5 && after.paused === false,
      `14.5s 时 t=${after.t}, paused=${after.paused}, rate=${after.rate}`);
    const bgLeaves = [...new Set(valid.map((x) => x.leaf).filter(Boolean))];
    check('后台期间经过了多个小节', bgLeaves.length >= 2, `经过小节=${JSON.stringify(bgLeaves)}`);

    // ---- 脚本自带的一键自检（面板上「自检并复制结果」用的就是它） ----
    console.log(`[${ts()}] 运行脚本自带的真实站点自检…`);
    let vd = {};
    try {
      const raw = await main.eval(`(async function(){
        if (!window.__yktTool || !window.__yktTool.verifyResults) return { err: 'no verify api' };
        var r = await window.__yktTool.verifyResults();
        return { pass: r.pass, fail: r.fail, warn: r.warn, lines: r.lines, results: r.results };
      })()`, true);
      // main.eval 返回 { value } 包装；同时兼容直接返回值与错误
      const got = (raw && typeof raw === 'object' && 'value' in raw) ? raw.value : raw;
      if (raw && raw.error) vd = { err: String(raw.error).slice(0, 140) };
      else vd = (got && typeof got === 'object') ? got : { err: 'unexpected: ' + JSON.stringify(got).slice(0, 120) };
    } catch (e) { vd = { err: String(e).slice(0, 140) }; }

    if (vd.lines) vd.lines.forEach((l) => console.log('      ' + l));
    check('脚本自带自检全部通过', typeof vd.fail === 'number' && vd.fail === 0,
      vd.err ? vd.err : `通过 ${vd.pass} / 失败 ${vd.fail} / 提示 ${vd.warn}`);

    // ---- 恢复前台，等全部刷完 ----
    console.log(`[${ts()}] 切回播放页，等待自动刷完整章…`);
    try { await main.send('Page.bringToFront'); } catch (e) { }
    try { bgS && bgS.ws.close(); } catch (e) { }

    // ---- 等全部刷完 ----
    const waitStart = Date.now();
    let st = await serverState();
    let lastLogged = 0;
    while (!st.doneAll && Date.now() - waitStart < 180000) {
      await sleep(2000);
      st = await serverState();
      if (Date.now() - lastLogged > 8000) {
        lastLogged = Date.now();
        const done = st.leaves.filter((l) => l.kind === 'video' && l.done).length;
        const leaf = await main.eval(`(document.querySelector('.video-box')||{}).getAttribute ? (document.querySelector('.video-box').getAttribute('data-leaf-id')||'') : ''`);
        console.log(`[${ts()}]   进度 ${done}/${st.videoTotal}  当前小节=${leaf.value}  hidden上报=${st.hiddenReports}  visible上报=${st.visibleReports}`);
      }
    }
    const elapsed = Date.now() - waitStart;

    // ---- 结果断言 ----
    console.log(`\n[${ts()}] ===== 验证结果 =====`);
    const finals = await serverState();
    for (const l of finals.leaves) {
      console.log(`   ${l.done ? '✓' : '·'} ${l.kind === 'quiz' ? '[跳过]' : '[视频]'} ${l.name}  进度=${l.pct}%`);
    }
    const vids = finals.leaves.filter((l) => l.kind === 'video');
    check('全部视频小节已完成', vids.every((l) => l.done), `${vids.filter((l) => l.done).length}/${vids.length}`);
    check('测验小节未被播放', finals.leaves.find((l) => l.kind === 'quiz').pct === 0);
    check('服务端从未收到「后台」心跳（切屏检测被完全绕开）', finals.hiddenReports === 0, `hidden=${finals.hiddenReports}, visible=${finals.visibleReports}`);
    const expect = await (await fetch(`${APP}/__expect`)).json();
    check('服务端综合断言通过', expect.ok === true, JSON.stringify(expect.fails));

    // 倍速总账：用脚本自身诊断接口的采样（跨导航有效）
    stopSampling();
    const allSampled = rateSamples.filter((x) => x.r !== null && x.r !== undefined);

    // 直接读取脚本记录的「倍速被改动 → 多久改回」事件，这是最有力的证据
    const rs = JSON.parse((await main.eval(`JSON.stringify(
      window.__yktTool ? window.__yktTool.state.rateStats : { events: 0, recovered: 0, maxRecoverMs: 0, recent: [] }
    )`)).value);

    // 统计口径：
    //   · 新媒体元素刚创建、脚本还没赋值前，浏览器默认 playbackRate=1，
    //     这属于固有启动瞬态（脚本一拍内即设为目标倍速），不计为「降速」。
    //   · 元素一旦达到过 2x，之后任何回落都必须被立刻纠正 —— 这才是要证明的性质。
    //   · 另外用脚本自身的 ratechange 记录器佐证「站点是否尝试改过倍速」。
    let seenTarget = false, settleDrops = 0, longestRun = 0, run = 0, startupSamples = 0;
    for (const s of allSampled) {
      if (!(s.rs >= 3) || !(Number(s.t) > 0.4)) continue;
      const isTarget = Math.abs(Number(s.r) - 2) < 0.01;
      if (!seenTarget) {
        if (!isTarget) { startupSamples++; run++; longestRun = Math.max(longestRun, run); continue; }
        seenTarget = true;
        run = 0;
        continue;
      }
      if (isTarget) { run = 0; continue; }
      settleDrops++; run++; longestRun = Math.max(longestRun, run);
    }

    console.log(`[${ts()}] 倍速统计：有效播放采样 ${allSampled.filter((s) => s.rs >= 3 && Number(s.t) > 0.4).length} 次；`
      + `元素起播前默认 1x 的采样 ${startupSamples} 次（固有瞬态）；达标后回落 ${settleDrops} 次；`
      + `最长连续回落 ${longestRun} 个采样点（≈${(longestRun * 0.3).toFixed(1)}s）`);
    console.log(`[${ts()}] 脚本记录的「站点试图改倍速」事件：${rs.events} 次，已纠正 ${rs.recovered} 次，`
      + `最长纠正耗时 ${rs.maxRecoverMs}ms，累计校正 ${rs.fixCount} 次`);
    if (rs.recent && rs.recent.length) console.log(`[${ts()}]   最近事件: ${JSON.stringify(rs.recent)}`);

    check('元素达到 2x 后从未回落（倍速锁定有效）', settleDrops === 0,
      `达标后回落 ${settleDrops} 次，最长连续 ${longestRun} 个采样点`);
    check('站点若试图改倍速也会被立即纠正',
      rs.events === 0 || (rs.recovered === rs.events && rs.maxRecoverMs <= 1000),
      `事件=${rs.events}，已纠正=${rs.recovered}，最长耗时=${rs.maxRecoverMs}ms`);
    check('有效播放期从未被暂停',
      allSampled.filter((x) => x.p === true && x.rs >= 3 && Number(x.t) > 0.4).length === 0,
      `播放中 paused 样本=${allSampled.filter((x) => x.p === true && x.rs >= 3 && Number(x.t) > 0.4).length}`);

    const visits = await main.eval(`localStorage.getItem('mock_visits') || '[]'`);
    let v = [];
    try { v = JSON.parse(visits.value); } catch (e) { }
    check('从未进入测验页', !v.some((x) => x.kind === 'quiz'));

    await main.shot('02-完成.png');

    console.log(`\n[${ts()}] 用时 ${(elapsed / 1000).toFixed(1)}s`);
    console.log(`\n${fail === 0 ? '✅ 全部通过' : '❌ 存在失败项'}  通过 ${pass} / 失败 ${fail}`);
  } catch (e) {
    console.error(`[${ts()}] 测试异常:`, e && e.stack || e);
    fail++;
  } finally {
    if (!KEEP) {
      try { main && main.ws.close(); } catch (e) { }
      try { browser.kill(); } catch (e) { }
    } else {
      console.log('(--keep) 已保留浏览器，端口 ' + CDP_PORT);
    }
  }
  process.exit(fail === 0 ? 0 : 1);
})();

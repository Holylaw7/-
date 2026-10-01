#!/usr/bin/env node
/**
 * 真实浏览器持久注入器：
 *   通过 CDP 的 Target.setAutoAttach + Page.addScriptToEvaluateOnNewDocument，
 *   把用户脚本注入到**每一个新建文档**（含后续动态创建的 iframe），
 *   从而绕过篡改猴，直接在你已登录的真实环境里验证脚本。
 *
 *   node _tools/real-persist-inject.js                 # 对当前雨课堂标签页启用持久注入并刷新
 *   node _tools/real-persist-inject.js --url <URL>     # 指定起始地址
 *   node _tools/real-persist-inject.js --watch 60      # 注入后观察 60 秒
 *
 * 说明：这只影响调试用的镜像浏览器窗口，不会改动你的正式 Edge 配置。
 */
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.CDP_PORT || 9222);
const USERSCRIPT = path.join(__dirname, '..', 'dist', 'changjiang-yuketang-auto.user.js');
const argOf = (name, def) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : def; };
const URL_ARG = argOf('--url', null);
const WATCH = Number(argOf('--watch', 45));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PROBE = `JSON.stringify({
  url: location.href,
  isTop: (function(){ try { return window.top === window.self } catch(e){ return false } })(),
  hasTool: !!window.__yktTool,
  panel: !!document.getElementById('ykt-tool-host'),
  state: window.__yktTool ? {
    running: window.__yktTool.state.running, phase: window.__yktTool.state.phase,
    rate: window.__yktTool.state.rate, paused: window.__yktTool.state.paused, muted: window.__yktTool.state.muted,
    t: window.__yktTool.state.currentTime, dur: window.__yktTool.state.duration,
    media: window.__yktTool.state.mediaTag, prog: window.__yktTool.state.progress,
    done: window.__yktTool.state.doneReason, streak: window.__yktTool.state.sameLeafStreak,
    fixes: window.__yktTool.state.rateStats ? window.__yktTool.state.rateStats.fixCount : 0,
    blockedEvents: window.__yktTool.state.guard.blockedEvents,
    blockedPause: window.__yktTool.state.guard.blockedPause,
    selfTest: window.__yktTool.state.guard.selfTest,
  } : null,
  video: (function(){
    var v = document.querySelector('video');
    return v ? { paused: v.paused, rate: v.playbackRate, muted: v.muted, t: +v.currentTime.toFixed(1), dur: Math.round(v.duration) } : null;
  })(),
  speedText: (function(){ var el=document.querySelector('xt-speedvalue'); return el?(el.innerText||'').trim():null })(),
})`;

class Session {
  constructor(ws, label) { this.ws = ws; this.label = label || ''; this.id = 0; this.pending = new Map(); }
  static async connect(u, label) {
    const ws = new WebSocket(u);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws fail: ' + u)); });
    const s = new Session(ws, label);
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && s.pending.has(m.id)) {
        const { res, rej } = s.pending.get(m.id); s.pending.delete(m.id);
        m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
      }
    };
    return s;
  }
  send(method, params = {}, t = 30000) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error('timeout ' + method)); } }, t);
    });
  }
  async eval(expr) {
    try {
      const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, userGesture: true });
      if (r.exceptionDetails) return { error: r.exceptionDetails.exception?.description || 'err' };
      return { value: r.result.value };
    } catch (e) { return { error: e.message }; }
  }
}

/** 注册新文档注入 + 递归追踪子框架 */
async function armSession(s, src, tag) {
  try {
    await s.send('Page.enable');
    await s.send('Runtime.enable');
    await s.send('Page.addScriptToEvaluateOnNewDocument', { source: src });
    await s.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
    console.log(`  ✓ [${tag}] 已注册新文档注入 + 子框架自动附加`);
  } catch (e) {
    console.log(`  ⚠ [${tag}] 注册失败: ${e.message}`);
  }
}

(async () => {
  if (!fs.existsSync(USERSCRIPT)) { console.error('缺少 dist/changjiang-yuketang-auto.user.js，先 node build.js'); process.exit(1); }
  const src = fs.readFileSync(USERSCRIPT, 'utf8');
  console.log(`用户脚本 ${(src.length / 1024).toFixed(1)} KB（v${JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')).version}）\n`);

  const pages = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).filter((t) => t.type === 'page');
  let target = pages.find((p) => /yuketang/i.test(p.url));
  if (!target) target = pages.find((p) => p.url === 'about:blank') || pages[0];
  if (!target) { console.error('没有可用标签页'); process.exit(1); }
  const url = URL_ARG || target.url;
  console.log(`目标标签页: ${target.url}`);
  console.log(`将加载: ${url}\n`);

  const main = await Session.connect(target.webSocketDebuggerUrl, 'main');
  await armSession(main, src, 'main');

  // 追踪所有新出现的 target / 子框架会话
  const sessions = new Map();          // sessionId -> Session
  main.ws.addEventListener('message', async (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
    if (m.method === 'Target.attachedToTarget') {
      const { sessionId, targetInfo } = m.params;
      try {
        const child = new Session(main.ws, targetInfo.type);
        // 复用同一条 ws，用 sessionId 包装
        const origSend = child.send.bind(child);
        child.send = (method, params = {}, t = 30000) => new Promise((res, rej) => {
          const id = ++main.id;
          main.pending.set(id, { res, rej });
          main.ws.send(JSON.stringify({ id, sessionId, method, params }));
          setTimeout(() => { if (main.pending.has(id)) { main.pending.delete(id); rej(new Error('timeout ' + method)); } }, t);
        });
        child.id = main.id;
        child.pending = main.pending;
        await armSession(child, src, targetInfo.type + ':' + String(targetInfo.url || '').slice(0, 50));
        sessions.set(sessionId, child);
      } catch (e) {
        console.log('  ⚠ 子目标附加失败:', e.message);
      }
    } else if (m.method === 'Target.detachedFromTarget') {
      sessions.delete(m.params.sessionId);
    }
  });

  console.log('重新加载页面…\n');
  // 可选：注入前先关掉脚本的「自动开始」，便于隔离验证单项功能
  if (process.argv.includes('--no-autostart')) {
    try {
      await main.send('Page.addScriptToEvaluateOnNewDocument', {
        source: `try { localStorage.setItem('ykt_tool:autoStart', 'false'); } catch(e){}`,
      });
      console.log('（已设置 autoStart=false，注入后不会自动开始）\n');
    } catch (e) { }
  }
  await main.send('Page.navigate', { url });
  await sleep(9000);

  console.log('观察中…\n');
  // 关闭自动开始时，手动触发一次开始，以便观察倍速接管
  if (process.argv.includes('--no-autostart')) {
    await sleep(500);
    const started = await main.eval(`window.__yktTool ? (window.__yktTool.start('测试'), '已手动 start') : 'no tool'`);
    console.log('手动启动:', started.value, '\n');
  }
  console.log('时刻  框架   running phase 进度   倍速    暂停   播放位置        完成依据 / 小节');
  console.log('-'.repeat(100));
  const t0 = Date.now();
  let lastLine = '';
  while ((Date.now() - t0) / 1000 < WATCH) {
    const r = await main.eval(PROBE);
    if (!r.error && r.value) {
      const d = JSON.parse(r.value);
      const el = ((Date.now() - t0) / 1000).toFixed(0).padStart(3);
      let line;
      if (d.state) {
        line = `${el}s  top    ${String(d.state.running).padEnd(7)} ${String(d.state.phase).padEnd(5)} `
          + `${String(d.state.prog).padStart(3)}%  ${String(d.speedText || d.state.rate).padEnd(7)} `
          + `${String(d.state.paused).padEnd(6)} ${String(d.state.t).padStart(7)}/${String(d.state.dur).padEnd(6)} `
          + `${d.state.done || '-'} leaf=${(d.state.media || '').slice(0, 30)}`;
      } else {
        line = `${el}s  top    ✗ 脚本未运行  ${d.url.slice(0, 60)}`;
      }
      if (line.slice(6) !== lastLine) { console.log(line); lastLine = line.slice(6); }
    }
    await sleep(2000);
  }

  const fin = await main.eval(PROBE);
  if (!fin.error && fin.value) {
    const d = JSON.parse(fin.value);
    console.log('\n最终状态:');
    console.log(JSON.stringify(d, null, 2));
  }
  console.log('\n提示：注入是持久的，之后该窗口里新开的页面/iframe 都会被注入。');
  console.log('      要停止请关闭该 Edge 窗口。');
  process.exit(0);
})().catch((e) => { console.error('异常:', e && e.stack || e); process.exit(1); });

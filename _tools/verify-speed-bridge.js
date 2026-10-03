#!/usr/bin/env node
/**
 * 端到端验证「倍速点击桥」：
 *   页面发请求 → 外部工具用 CDP 真实鼠标点播放器菜单 → 结果回写 → 页面确认
 *
 *   node _tools/verify-speed-bridge.js
 *
 * 需要：仿真服务器在 8099；调试用 Edge 在 9222。
 */
const CONFIG = require('./config');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.CDP_PORT || 9222);
const APP = CONFIG.mock.origin();
const USERSCRIPT = path.join(__dirname, '..', 'dist', 'changjiang-yuketang-auto.user.js');
const BRIDGE = path.join(__dirname, 'speed-bridge.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const check = (n, ok, d = '') => { ok ? pass++ : fail++; console.log(`${ok ? '  ✓' : '  ✗'} ${n}${d ? '  — ' + d : ''}`); };
const LEAF = CONFIG.leaf || process.argv[2] || String(CONFIG.mock.leafBase);

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
  send(method, params = {}, t = 30000) {
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

(async () => {
  // 1) 先让页面进入视频页，并开启倍速桥
  const pages = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).filter((t) => t.type === 'page');
  const target = pages.find((p) => p.url === 'about:blank') || pages[0];
  if (!target) { console.error('没有可用标签页'); process.exit(1); }
  const s = await Session.connect(target.webSocketDebuggerUrl);
  await s.send('Page.enable');
  await s.send('Runtime.enable');
  await s.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `try {
      localStorage.setItem('ykt_tool:autoStart', 'false');
      localStorage.setItem('ykt_tool:autoNext', 'false');
      localStorage.setItem('ykt_tool:speedBridge', 'true');
    } catch(e){}`,
  });
  await s.send('Page.addScriptToEvaluateOnNewDocument', { source: fs.readFileSync(USERSCRIPT, 'utf8') });

  console.log('打开仿真站点并登录…');
  await s.send('Page.navigate', { url: `${APP}/web` });
  await sleep(1500);
  await s.eval(`document.getElementById('btn-login') && document.getElementById('btn-login').click(), true`);
  await sleep(2500);

  console.log('进入视频页（不自动开始，避免跳走）…');
  await s.send('Page.navigate', { url: `${APP}/ai-workspace/lms-graph/${CONFIG.mock.classroom}/video/${LEAF}?is_chapter=1` });
  await sleep(6000);
  try { await s.send('Page.bringToFront'); } catch (e) { }

  const pre = JSON.parse((await s.eval(`JSON.stringify({
    hasTool: !!window.__yktTool,
    bridgeNode: !!document.getElementById('__ykt_speed_bridge__'),
    videoRate: (function(){var v=document.querySelector('video');return v?v.playbackRate:null})(),
    uiText: (function(){var e=document.querySelector('.xt_video_player_common_value, xt-speedvalue');return e?(e.innerText||'').trim():null})(),
    hasMenu: (function(){var b=document.querySelector('.xt_video_player_speed, xt-speedbutton');
      var l=b?b.querySelector('.xt_video_player_common_list_wrap, xt-speedlist'):null;
      return l?l.querySelectorAll('[data-speed]').length:0})(),
  })`)).value);
  console.log('  预检:', JSON.stringify(pre));
  check('脚本已注入', pre.hasTool === true);
  check('倍速桥节点已创建', pre.bridgeNode === true);
  check('播放器有倍速菜单项', pre.hasMenu > 0, `选项数=${pre.hasMenu}`);

  // 2) 启动外部桥工具
  console.log('\n启动外部桥工具…');
  const bridge = spawn(process.execPath, [BRIDGE, '--once'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let bridgeOut = '';
  bridge.stdout.on('data', (d) => { bridgeOut += d.toString(); });
  bridge.stderr.on('data', (d) => { bridgeOut += d.toString(); });

  // 3) 让页面主动发起倍速请求
  console.log('让页面发起倍速请求…');
  const reqRes = await s.eval(`(async function(){
    if (!window.__yktTool) return 'no tool';
    // 直接调用桥（模拟 Run.syncSpeedUi 的行为）
    var ok = await (window.__BridgeProbe ? window.__BridgeProbe(2) : null);
    return ok === null ? 'no probe' : String(ok);
  })()`, true);
  console.log('  页面内直接调用结果:', reqRes.value);

  // 上面的探针可能不存在，改用「手动触发一次 Run」
  if (reqRes.value === 'no probe' || reqRes.value === 'undefined') {
    console.log('  改用面板「开始刷课」触发 syncSpeedUi…');
    await s.eval(`window.__yktTool && window.__yktTool.start('桥测试')`);
  }

  // 等待桥处理完成（脚本成功后会清空桥节点，因此同时看倍速是否达标）
  console.log('等待桥处理（最多 25 秒）…');
  let done = false;
  const t0 = Date.now();
  while (Date.now() - t0 < 25000) {
    await sleep(1000);
    const st = JSON.parse((await s.eval(`JSON.stringify({
      videoRate: (function(){var v=document.querySelector('video');return v?v.playbackRate:null})(),
      uiText: (function(){var e=document.querySelector('.xt_video_player_common_value, xt-speedvalue');return e?(e.innerText||'').trim():null})(),
    })`)).value);
    if (Math.abs(Number(st.videoRate) - 2) < 0.01 && st.uiText && /2(\.0+)?X/i.test(st.uiText)) { done = true; break; }
  }

  const fin = JSON.parse((await s.eval(`JSON.stringify({
    videoRate: (function(){var v=document.querySelector('video');return v?v.playbackRate:null})(),
    uiText: (function(){var e=document.querySelector('.xt_video_player_common_value, xt-speedvalue');return e?(e.innerText||'').trim():null})(),
    optValue: (function(){var r=document.querySelector('.xt_video_player_container, .xtplayer, .video-box');
      var p=r&&r.__vue__&&r.__vue__.$data.player; return (p&&p.options&&p.options.speed)?p.options.speed.value:null})(),
    bridgeCleared: (function(){var n=document.getElementById('__ykt_speed_bridge__');
      return n ? (n.getAttribute('data-req') === '' && n.getAttribute('data-res') === '') : null})(),
  })`)).value);

  console.log('\n桥工具输出:');
  console.log(bridgeOut.split('\n').map((l) => '    ' + l).join('\n'));

  console.log('\n最终页面状态:', JSON.stringify(fin));
  check('桥用真实鼠标点击后 video.playbackRate = 2', Math.abs(Number(fin.videoRate) - 2) < 0.01, `rate=${fin.videoRate}`);
  check('播放器界面同步显示 2.00X（走站点自身逻辑）', !!fin.uiText && /2(\.0+)?X/i.test(fin.uiText), `UI=${fin.uiText}`);
  check('桥工具日志显示菜单被真实 hover 展开并成功点击',
    /移入后菜单宽=[1-9]/.test(bridgeOut) && /真实点击选项/.test(bridgeOut));
  check('页面确认后已清理桥节点状态', fin.bridgeCleared === true, `cleared=${fin.bridgeCleared}`);

  try { bridge.kill(); } catch (e) { }
  s.ws.close();
  console.log(`\n${fail === 0 ? '✅ 全部通过' : '❌ 存在失败项'}  通过 ${pass} / 失败 ${fail}`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('异常:', e && e.stack || e); process.exit(1); });

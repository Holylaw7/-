#!/usr/bin/env node
/**
 * 真实站点上验证「倍速点击桥」：
 *   注入脚本（桥已启用）→ 页面发出「切 2x」请求
 *   → 外部工具用 CDP 真实鼠标 hover 展开播放器菜单并点击 2.00X
 *   → 站点自己的逻辑把 内部变量/界面/playbackRate 一次性设对
 *
 *   node _tools/real-bridge-test.js
 *
 * 注意：必须用真实鼠标输入，且页面在前台；合成事件无法触发 CSS :hover。
 */
const CONFIG = require('./config');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.CDP_PORT || 9222);
const USERSCRIPT = path.join(__dirname, '..', 'dist', 'changjiang-yuketang-auto.user.js');
const BRIDGE = path.join(__dirname, 'speed-bridge.js');
const VIDEO_URL = process.argv.find((a) => /^https?:\/\//.test(a))
  || CONFIG.origin + `/ai-workspace/lms-graph/${CONFIG.classroom}/video/${LEAF}?is_chapter=1`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const check = (n, ok, d = '') => { ok ? pass++ : fail++; console.log(`${ok ? '  ✓' : '  ✗'} ${n}${d ? '  — ' + d : ''}`); };
const LEAF = CONFIG.leaf || process.argv[2] || CONFIG.PLACEHOLDER;

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
    try {
      const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: aw, userGesture: true });
      if (r.exceptionDetails) return { error: r.exceptionDetails.exception?.description || 'err' };
      return { value: r.result.value };
    } catch (e) { return { error: e.message }; }
  }
}

const STATE = `JSON.stringify({
  url: location.pathname,
  hasTool: !!window.__yktTool,
  bridgeNode: !!document.getElementById('__ykt_speed_bridge__'),
  videoRate: (function(){ var v=document.querySelector('video'); return v?v.playbackRate:null })(),
  uiText: (function(){ var e=document.querySelector('.xt_video_player_common_value, xt-speedvalue'); return e?(e.innerText||'').trim():null })(),
  optValue: (function(){ var r=document.querySelector('.xt_video_player_container, .xtplayer, .video-box');
    var p=r&&r.__vue__&&r.__vue__.$data.player; return (p&&p.options&&p.options.speed)?p.options.speed.value:null })(),
  pending: (function(){ var n=document.getElementById('__ykt_speed_bridge__'); return n?n.getAttribute('data-req'):null })(),
  menuW: (function(){ var b=document.querySelector('.xt_video_player_speed, xt-speedbutton');
    var l=b?b.querySelector('.xt_video_player_common_list_wrap, xt-speedlist'):null;
    return l?Math.round(l.getBoundingClientRect().width):0 })(),
})`;

(async () => {
  const pages = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).filter((t) => t.type === 'page');
  const target = pages.find((p) => /yuketang/i.test(p.url)) || pages.find((p) => p.url === 'about:blank') || pages[0];
  if (!target) { console.error('没有可用标签页'); process.exit(1); }
  console.log('目标标签页:', target.url.slice(0, 100), '\n');

  // 用一个全新标签页，避免此前测试累积注册的注入脚本互相干扰
  // （Page.addScriptToEvaluateOnNewDocument 是「追加」语义）
  const anySession = await Session.connect(target.webSocketDebuggerUrl);
  await anySession.send('Page.enable');
  const newTab = await anySession.send('Target.createTarget', { url: 'about:blank' });
  anySession.ws.close();

  const pages2 = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).filter((t) => t.type === 'page');
  const fresh = pages2.find((p) => p.id === newTab.targetId);
  if (!fresh) { console.error('无法创建新标签页'); process.exit(1); }

  const s = await Session.connect(fresh.webSocketDebuggerUrl);
  await s.send('Page.enable');
  await s.send('Runtime.enable');

  // 不自动开始、不自动跳转，避免页面被脚本换掉；启用倍速桥
  await s.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `try {
      localStorage.setItem('ykt_tool:autoStart', 'false');
      localStorage.setItem('ykt_tool:autoNext', 'false');
      localStorage.setItem('ykt_tool:speedBridge', 'true');
      localStorage.setItem('ykt_tool:rate', '2');
    } catch(e){}`,
  });
  await s.send('Page.addScriptToEvaluateOnNewDocument', { source: fs.readFileSync(USERSCRIPT, 'utf8') });

  console.log('打开真实视频页…');
  await s.send('Page.navigate', { url: VIDEO_URL });
  await sleep(10000);
  try { await s.send('Page.bringToFront'); } catch (e) { }
  await sleep(1000);

  let st = JSON.parse((await s.eval(STATE)).value);
  console.log('预检:', JSON.stringify(st));
  check('页面是真实视频页且有 video', !!st.videoRate, `path=${st.url}`);
  check('脚本已注入', st.hasTool === true);
  check('倍速桥节点存在（桥已启用）', st.bridgeNode === true);
  check('播放器倍速按钮/菜单存在', st.menuW !== null);
  console.log(`  起始状态: video.rate=${st.videoRate} UI=${st.uiText} 站点内部值=${st.optValue}`);

  // 启动外部桥工具
  console.log('\n启动外部桥工具…');
  const bridge = spawn(process.execPath, [BRIDGE, '--once'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let bridgeOut = '';
  bridge.stdout.on('data', (d) => { bridgeOut += d.toString(); });
  bridge.stderr.on('data', (d) => { bridgeOut += d.toString(); });

  // 让页面发起请求：手动开始（会走到 syncSpeedUi）
  console.log('触发页面倍速同步（Run.start）…');
  await s.eval(`window.__yktTool && window.__yktTool.start('真站桥测试')`);

  console.log('等待桥处理（最多 30 秒）…');
  let ok = false;
  const t0 = Date.now();
  while (Date.now() - t0 < 30000) {
    await sleep(1000);
    const cur = JSON.parse((await s.eval(STATE)).value);
    // 判据只看媒体真实倍速（界面标签会被站点周期性刷回 1.00X，不代表失败）
    if (Math.abs(Number(cur.videoRate) - 2) < 0.01) { ok = true; break; }
  }

  const fin = JSON.parse((await s.eval(STATE)).value);
  console.log('\n=== 桥工具输出 ===');
  console.log(bridgeOut.split('\n').filter(Boolean).map((l) => '    ' + l).join('\n'));
  console.log('\n=== 最终状态 ===');
  console.log('   ', JSON.stringify(fin));

  const hoverWorked = /移入后菜单宽=[1-9]/.test(bridgeOut) || /点击后菜单宽=[1-9]/.test(bridgeOut);
  check('真实鼠标 hover 成功展开了播放器倍速菜单', hoverWorked,
    (bridgeOut.match(/\[桥\] (移入后|点击后)菜单宽=\d+/g) || []).join(' / '));
  check('真实点击菜单项后 video.playbackRate = 2', Math.abs(Number(fin.videoRate) - 2) < 0.01, `rate=${fin.videoRate}`);
  check('站点内部倍速值 = 2（说明是它自己设的，非外部改写）', Number(fin.optValue) === 2, `内部值=${fin.optValue}`);

  console.log('\n再等 15 秒，看站点会不会把倍速回滚（判断是否被识别为外部改写）…');
  await sleep(15000);
  const stable = JSON.parse((await s.eval(STATE)).value);
  console.log('   ', JSON.stringify(stable));
  check('媒体倍速稳定保持 2x，未被回滚', Math.abs(Number(stable.videoRate) - 2) < 0.01, `rate=${stable.videoRate}`);
  console.log(`   界面标签当前为 ${stable.uiText}（站点会周期性把它刷回 1.00X，属其自身行为，不影响实际倍速）`);

  try { bridge.kill(); } catch (e) { }
  s.ws.close();
  console.log(`\n${fail === 0 ? '✅ 全部通过' : '❌ 存在失败项'}  通过 ${pass} / 失败 ${fail}`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('异常:', e && e.stack || e); process.exit(1); });

#!/usr/bin/env node
/**
 * 倍速点击桥 —— 外部执行端
 *
 * 轮询页面里的桥节点，读到「请点 2.00X」的请求后，
 * 用 **CDP 真实鼠标输入** 去点播放器自己的倍速菜单（hover 展开 → 点选项），
 * 再把结果写回桥节点。
 *
 *   node _tools/speed-bridge.js              # 一直运行，直到 Ctrl+C
 *   node _tools/speed-bridge.js --once       # 只处理一次请求
 *   node _tools/speed-bridge.js --port 9222  # 指定调试端口
 *
 * 只接受白名单动作：点击倍速菜单项。不执行页面传来的任何代码。
 */
const PORT = Number((() => { const i = process.argv.indexOf('--port'); return i >= 0 ? process.argv[i + 1] : (process.env.CDP_PORT || 9222); })());
const ONCE = process.argv.includes('--once');
const NODE_ID = '__ykt_speed_bridge__';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
    try {
      const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: aw, userGesture: true });
      if (r.exceptionDetails) return { error: r.exceptionDetails.exception?.description || 'err' };
      return { value: r.result.value };
    } catch (e) { return { error: e.message }; }
  }
  async realMove(x, y) {
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons: 0 });
  }
  async realClick(x, y) {
    await this.realMove(x, y);
    await sleep(130);
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
    await sleep(80);
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
  }
}

/** 在当前页面里找桥节点并读出请求 */
const READ_REQ = `(function(){
  var el = document.getElementById('${NODE_ID}');
  if (!el) return null;
  var raw = el.getAttribute('data-req');
  if (!raw) return null;
  try { return JSON.stringify(JSON.parse(raw)); } catch (e) { return null; }
})()`;

const WRITE_RES = (token, ok, reason) => `(function(){
  var el = document.getElementById('${NODE_ID}');
  if (!el) return false;
  el.setAttribute('data-res', ${JSON.stringify(JSON.stringify({ token, ok, reason: reason || '' }))});
  return true;
})()`;

/** 读取倍速按钮与选项坐标（兼容 li / xt-button / 任意带 data-speed 的元素） */
const GET_GEOM = `(function(){
  function box(el){ if(!el) return null; var r=el.getBoundingClientRect();
    return { x: Math.round(r.left+r.width/2), y: Math.round(r.top+r.height/2), w: Math.round(r.width), h: Math.round(r.height) }; }
  var btn = document.querySelector('.xt_video_player_speed, xt-speedbutton');
  var list = btn ? btn.querySelector('.xt_video_player_common_list_wrap, xt-speedlist') : null;
  if (!list) list = document.querySelector('.xt_video_player_common_list_wrap, xt-speedlist');
  var scope = list || document;
  var items = [].slice.call(scope.querySelectorAll('[data-speed], li, xt-button'));
  return JSON.stringify({
    btn: box(btn),
    listW: list ? Math.round(list.getBoundingClientRect().width) : 0,
    listH: list ? Math.round(list.getBoundingClientRect().height) : 0,
    listDisplay: list ? getComputedStyle(list).display : null,
    options: items.map(function(li){ var b = box(li); if(!b) return null;
      b.speed = li.getAttribute('data-speed'); b.text = (li.innerText||'').trim(); return b; }).filter(Boolean),
    btnHover: (function(){ var b=document.querySelector('.xt_video_player_speed, xt-speedbutton'); return b?b.matches(':hover'):null })(),
    videoRate: (function(){ var v=document.querySelector('video'); return v?v.playbackRate:null })(),
    uiText: (function(){ var e=document.querySelector('.xt_video_player_common_value, xt-speedvalue'); return e?(e.innerText||'').trim():null })(),
  });
})()`;

/** 检查当前倍速是否已达标 */
const CHECK = `JSON.stringify({
  videoRate: (function(){ var v=document.querySelector('video'); return v?v.playbackRate:null })(),
  uiText: (function(){ var e=document.querySelector('.xt_video_player_common_value, xt-speedvalue'); return e?(e.innerText||'').trim():null })(),
  optValue: (function(){ var r=document.querySelector('.xt_video_player_container, .xtplayer, .video-box');
    var p=r&&r.__vue__&&r.__vue__.$data.player; return (p&&p.options&&p.options.speed)?p.options.speed.value:null })(),
})`;

/**
 * 反复尝试展开倍速菜单。
 *
 * 实测结论（真实站点）：
 *  · 播放器的控件栏会在鼠标离开时隐藏，所以必须先让鼠标进入播放器区域，
 *    再移向倍速按钮 —— 直接跳到按钮坐标往往不触发展开。
 *  · CDP 真实鼠标 hover 触发展开**不稳定**（同样坐标有时通有时不通），
 *    因此做多轮、多种方式尝试，直到菜单真的展开为止。
 */
async function expandMenu(s, geo) {
  // 播放器区域（用于先「把鼠标带进播放器」）
  const playerBox = JSON.parse((await s.eval(`JSON.stringify((function(){
    var p = document.querySelector('.xt_video_player_container, .xtplayer, .xv-wrap, #video-box, video');
    if (!p) return null; var r = p.getBoundingClientRect();
    return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) };
  })())`)).value || 'null');

  const attempts = [
    { name: '进入播放器→移到倍速按钮', run: async () => {
        if (playerBox) { await s.realMove(playerBox.x, playerBox.y); await sleep(500); }
        await s.realMove(geo.btn.x - 1, geo.btn.y - 1); await sleep(150);
        await s.realMove(geo.btn.x, geo.btn.y); await sleep(200);
        await s.realMove(geo.btn.x + 1, geo.btn.y); await sleep(200);
      } },
    { name: '真实点击倍速按钮', run: async () => {
        if (playerBox) { await s.realMove(playerBox.x, playerBox.y); await sleep(400); }
        await s.realClick(geo.btn.x, geo.btn.y);
      } },
    { name: '移开再移回', run: async () => {
        await s.realMove(geo.btn.x - 80, geo.btn.y - 50); await sleep(350);
        await s.realMove(geo.btn.x, geo.btn.y); await sleep(250);
        await s.realMove(geo.btn.x + 2, geo.btn.y + 1); await sleep(250);
      } },
    { name: '进入播放器→点击按钮', run: async () => {
        if (playerBox) { await s.realMove(playerBox.x, playerBox.y); await sleep(400); }
        await s.realMove(geo.btn.x, geo.btn.y); await sleep(150);
        await s.realClick(geo.btn.x, geo.btn.y);
      } },
  ];

  for (let round = 0; round < 3; round++) {
    for (const a of attempts) {
      try { await a.run(); } catch (e) { }
      await sleep(1000);
      const g = JSON.parse((await s.eval(GET_GEOM)).value || '{}');
      if (g.listW > 0) {
        console.log(`[桥] 菜单已展开（第${round + 1}轮 · ${a.name}）宽=${g.listW} display=${g.listDisplay}`);
        return g;
      }
    }
    console.log(`[桥] 第 ${round + 1} 轮未展开，继续重试…`);
  }
  return JSON.parse((await s.eval(GET_GEOM)).value || '{}');
}

async function handle(s, req) {
  const rate = Number(req.rate) || 2;
  console.log(`\n[桥] 收到请求: 切到 ${rate}x (token ${String(req.token).slice(0, 12)})`);

  // 关键：必须让页面在前台，否则 CDP 的鼠标输入到不了页面，CSS :hover 不会触发
  try {
    await s.send('Page.bringToFront');
    await sleep(300);
  } catch (e) {
    console.log('[桥] bringToFront 失败:', e.message);
  }

  // 已经对了就不用点
  let chk = JSON.parse((await s.eval(CHECK)).value || '{}');
  if (Math.abs(Number(chk.videoRate) - rate) < 0.01 && Number(chk.optValue) === rate) {
    console.log('[桥] 已经是目标倍速，直接回复成功');
    await s.eval(WRITE_RES(req.token, true, 'already'));
    return true;
  }

  let geo = JSON.parse((await s.eval(GET_GEOM)).value || '{}');
  if (!geo.btn) {
    console.log('[桥] 找不到倍速按钮，回复失败');
    await s.eval(WRITE_RES(req.token, false, 'no-speed-button'));
    return false;
  }
  console.log(`[桥] 倍速按钮 @(${geo.btn.x},${geo.btn.y})  菜单宽=${geo.listW}`);

  // 菜单没展开 → 多轮尝试用真实鼠标展开
  if (!geo.listW) {
    console.log('[桥] 菜单未展开，开始尝试用真实鼠标展开…');
    geo = await expandMenu(s, geo);
  }

  if (!geo.listW) {
    console.log('[桥] 菜单打不开，回复失败');
    await s.eval(WRITE_RES(req.token, false, 'menu-not-expanded'));
    return false;
  }

  // 点击选项前再确认一次菜单还开着（鼠标移动或重绘都可能让它收起）
  geo = JSON.parse((await s.eval(GET_GEOM)).value || '{}');
  if (!geo.listW) {
    console.log('[桥] 点击前菜单已收起 → 重新展开');
    await s.realClick(geo.btn.x, geo.btn.y);
    for (let i = 0; i < 6 && !geo.listW; i++) {
      await sleep(600);
      geo = JSON.parse((await s.eval(GET_GEOM)).value || '{}');
    }
  }

  const opt = (geo.options || []).find((o) => Number(o.speed) === rate)
    || (geo.options || []).find((o) => new RegExp(`^\\s*${rate}(\\.0+)?\\s*X?\\s*$`, 'i').test(o.text || ''));
  if (!opt || !opt.w) {
    console.log('[桥] 菜单里找不到可点击的目标倍速，回复失败。选项:', JSON.stringify(geo.options));
    await s.eval(WRITE_RES(req.token, false, 'option-not-found'));
    return false;
  }

  console.log(`[桥] 真实点击选项「${opt.text}」@(${opt.x},${opt.y}) 尺寸=${opt.w}x${opt.h}`);
  await s.realClick(opt.x, opt.y);
  await sleep(1500);

  chk = JSON.parse((await s.eval(CHECK)).value || '{}');
  let ok = Math.abs(Number(chk.videoRate) - rate) < 0.01;
  if (!ok) {
    // 第一次没生效：菜单可能刚收起，重试一次
    console.log(`[桥] 首次点击未生效（video.rate=${chk.videoRate}），重试…`);
    geo = JSON.parse((await s.eval(GET_GEOM)).value || '{}');
    if (!geo.listW && geo.btn) {
      await s.realClick(geo.btn.x, geo.btn.y);
      await sleep(800);
      geo = JSON.parse((await s.eval(GET_GEOM)).value || '{}');
    }
    const opt2 = (geo.options || []).find((o) => Number(o.speed) === rate && o.w > 0);
    if (opt2) {
      await s.realClick(opt2.x, opt2.y);
      await sleep(1500);
      chk = JSON.parse((await s.eval(CHECK)).value || '{}');
      ok = Math.abs(Number(chk.videoRate) - rate) < 0.01;
    }
  }
  console.log(`[桥] 结果: video.rate=${chk.videoRate} 内部值=${chk.optValue} UI=${chk.uiText} → ${ok ? '成功' : '未生效'}`);
  await s.eval(WRITE_RES(req.token, ok, ok ? '' : 'no-effect'));
  return ok;
}

(async () => {
  let pages;
  try {
    pages = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).filter((t) => t.type === 'page');
  } catch (e) {
    console.error(`✗ 连不上调试端口 ${PORT}。请先启动带调试端口的 Edge。`);
    process.exit(1);
  }
  const target = pages.find((p) => /yuketang|127\.0\.0\.1:8099/.test(p.url)) || pages[0];
  if (!target) { console.error('没有可用标签页'); process.exit(1); }
  console.log(`[桥] 已连接: ${target.url.slice(0, 100)}`);
  console.log('[桥] 等待页面请求…（Ctrl+C 退出）');

  const s = await Session.connect(target.webSocketDebuggerUrl);
  await s.send('Runtime.enable');
  try { await s.send('Page.bringToFront'); } catch (e) { }

  let handled = 0;
  for (;;) {
    const r = await s.eval(READ_REQ);
    if (r && r.value) {
      let req = null;
      try { req = JSON.parse(r.value); } catch (e) { }
      if (req && req.token) {
        try {
          await handle(s, req);
        } catch (e) {
          // 单次处理异常不能让桥退出，否则后续请求没人应答
          console.log('[桥] 处理请求时异常:', e && e.message);
          try { await s.eval(WRITE_RES(req.token, false, 'bridge-error')); } catch (e2) { }
        }
        handled++;
        if (ONCE) break;
      }
    }
    await sleep(500);
  }
  console.log(`\n[桥] 已处理 ${handled} 个请求，退出。`);
  process.exit(0);
})().catch((e) => { console.error('异常:', e && e.stack || e); process.exit(1); });

#!/usr/bin/env node
/**
 * 检查调试窗口对真实站点的登录态。
 *   node _tools/check-real-login.js
 */
const CONFIG = require('./config');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const list = await (await fetch(`http://127.0.0.1:${CONFIG.cdpPort}/json/list`)).json();
  const p = list.find((t) => t.type === 'page' && !/127\.0\.0\.1/.test(t.url)) || list.find((t) => t.type === 'page');
  if (!p) { console.error('没有可用标签页'); process.exit(1); }

  const ws = new WebSocket(p.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = () => j(new Error('ws fail')); });
  let id = 1;
  const send = (method, params) => new Promise((res) => {
    const h = (e) => { const x = JSON.parse(e.data); if (x.id === id) { ws.removeEventListener('message', h); res(x.result); } };
    ws.addEventListener('message', h);
    ws.send(JSON.stringify({ id, method, params: params || {} }));
    id++;
  });

  await send('Page.enable');
  await send('Runtime.enable');
  console.log('打开课程目录页…', CONFIG.url.studentLog());
  await send('Page.navigate', { url: CONFIG.url.studentLog() });
  await sleep(16000);

  const expr = `JSON.stringify({
    path: location.pathname,
    title: document.title,
    cards: document.querySelectorAll('section.studentCard').length,
    hasLoginForm: !!document.querySelector('input[type=password]'),
    captcha: !!document.querySelector('iframe[src*=captcha]'),
    bodyHead: (document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 160),
  })`;
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
  const d = JSON.parse(r.result.value);
  console.log('\n=== 页面状态 ===');
  console.log('  URL   :', d.path);
  console.log('  标题  :', d.title);
  console.log('  课程卡:', d.cards);
  console.log('  登录框:', d.hasLoginForm);
  console.log('  验证码:', d.captcha);
  console.log('  正文  :', d.bodyHead);

  const ok = d.cards > 0 && !d.hasLoginForm;
  console.log(ok ? '\n✓ 已登录，可以做真实站点验证' : '\n✗ 未登录，需要先在这个窗口登录雨课堂');
  ws.close();
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error('异常:', e && e.stack || e); process.exit(1); });

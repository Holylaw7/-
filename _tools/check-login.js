#!/usr/bin/env node
/**
 * 确认调试窗口是否处于登录态（用于判断能否做真实站点测试）。
 *   node _tools/check-login.js
 */
const CONFIG = require('./config');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const list = (await (await fetch(`http://127.0.0.1:${CONFIG.cdpPort}/json/list`)).json());
  const p = list.find((t) => t.type === 'page');
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
  await sleep(15000);

  const expr = `JSON.stringify({
    path: location.pathname,
    title: document.title,
    cards: document.querySelectorAll('section.studentCard').length,
    hasLoginForm: !!document.querySelector('input[type=password], .login-form, [class*=login-box]'),
    captcha: !!document.querySelector('iframe[src*=captcha]'),
    tool: !!window.__yktTool,
  })`;
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
  console.log('页面状态:', r.result.value);
  ws.close();
  process.exit(0);
})().catch((e) => { console.error('异常:', e && e.stack || e); process.exit(1); });

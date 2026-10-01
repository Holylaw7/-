#!/usr/bin/env node
/**
 * 刷新所有雨课堂标签页，清掉测试残留设置，然后验证最新脚本是否注入成功。
 *   node _tools/refresh-and-verify.js
 */
const PORT = Number(process.env.CDP_PORT || 9222);
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

(async () => {
  const list = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).filter((t) => t.type === 'page');
  const targets = list.filter((p) => /yuketang/i.test(p.url));
  console.log(`找到 ${targets.length} 个雨课堂标签页\n`);

  // 清理设置用一次导航完成
  for (const p of targets) {
    const s = await Session.connect(p.webSocketDebuggerUrl);
    await s.send('Page.enable'); await s.send('Runtime.enable');
    try {
      // 先清掉测试残留，再刷新
      await s.eval(`(function(){
        try {
          localStorage.removeItem('ykt_tool:autoStart');
          localStorage.removeItem('ykt_tool:autoNext');
          localStorage.removeItem('ykt_tool:speedBridge');
          localStorage.setItem('ykt_tool:rate', '2');
          sessionStorage.removeItem('ykt_tool:stuck');
        } catch(e){}
        return true;
      })()`);
      await s.send('Page.reload', { ignoreCache: true });
      console.log(`  已刷新: ${p.url.slice(0, 80)}`);
    } catch (e) {
      console.log(`  刷新失败: ${e.message}`);
    }
    s.ws.close();
    await sleep(600);
  }

  console.log('\n等待脚本注入（12 秒）…');
  await sleep(12000);

  console.log('\n=== 验证注入结果 ===');
  const list2 = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).filter((t) => t.type === 'page');
  for (const p of list2.filter((x) => /yuketang/i.test(x.url)).slice(0, 4)) {
    const s = await Session.connect(p.webSocketDebuggerUrl);
    await s.send('Runtime.enable');
    const r = await s.eval(`JSON.stringify({
      url: location.pathname,
      hasTool: !!window.__yktTool,
      version: window.__yktTool ? window.__yktTool.state.version : null,
      panel: !!document.getElementById('ykt-tool-host'),
      bridge: !!document.getElementById('__ykt_speed_bridge__'),
      running: window.__yktTool ? window.__yktTool.state.running : null,
      phase: window.__yktTool ? window.__yktTool.state.phase : null,
      rate: window.__yktTool ? window.__yktTool.state.rate : null,
      prog: window.__yktTool ? window.__yktTool.state.progress : null,
      cards: document.querySelectorAll('section.studentCard').length,
    })`);
    console.log(`  ▸ ${p.url.slice(0, 76)}`);
    console.log(`     ${r.value}`);
    s.ws.close();
  }

  process.exit(0);
})().catch((e) => { console.error('异常:', e && e.stack || e); process.exit(1); });

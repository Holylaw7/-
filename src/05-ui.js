// ============================================================================
//  模块 5/6：悬浮控制面板（Shadow DOM 隔离，避免被站点样式影响）
// ============================================================================
//  标记启动阶段，用于自检（document-start 早于站点脚本）
try { sessionStorage.setItem('ykt_tool:boot', '1'); } catch (e) { }

const UI = {
  root: null,
  shadow: null,
  els: {},
  logLines: [],
  collapsed: false,
  stats: { page: '', prog: 0 },

  mount() {
    if (this.root || !document.body) return;
    const host = document.createElement('div');
    host.id = 'ykt-tool-host';
    host.style.cssText = 'position:fixed;z-index:2147483000;right:18px;bottom:18px;';
    document.body.appendChild(host);
    const sh = host.attachShadow({ mode: 'open' });
    sh.innerHTML = `
      <style>
        :host { all: initial; }
        .panel {
          width: 306px; font: 12px/1.6 "Microsoft YaHei", system-ui, sans-serif;
          background: #ffffff; color: #1f2329; border-radius: 12px;
          box-shadow: 0 10px 32px rgba(15,23,42,.22); overflow: hidden;
          border: 1px solid #e5e9f2;
        }
        .hd { display:flex; align-items:center; gap:8px; padding:10px 12px;
              background: linear-gradient(135deg,#2563eb,#4f46e5); color:#fff; cursor:move; user-select:none; }
        .hd b { font-size:12.5px; font-weight:600; flex:1; }
        .hd .v { opacity:.75; font-size:10px; font-weight:400; }
        .hd button { all:unset; cursor:pointer; padding:0 6px; border-radius:4px; font-size:13px; }
        .hd button:hover { background:rgba(255,255,255,.22); }
        .bd { padding:10px 12px; display:flex; flex-direction:column; gap:9px; }
        .row { display:flex; align-items:center; gap:6px; }
        .stat { display:flex; gap:6px; }
        .pill { flex:1; background:#f4f6fb; border-radius:7px; padding:5px 8px; text-align:center; }
        .pill i { display:block; font-style:normal; font-size:10px; color:#6b7280; }
        .pill b { font-size:13px; }
        .seg { display:flex; border:1px solid #dbe1ec; border-radius:8px; overflow:hidden; flex:1; }
        .seg button { all:unset; flex:1; text-align:center; padding:5px 0; cursor:pointer; font-size:11.5px; }
        .seg button.on { background:#2563eb; color:#fff; }
        label.chk { display:flex; align-items:center; gap:6px; flex:1; cursor:pointer; font-size:11.5px; }
        input[type=checkbox]{ accent-color:#2563eb; }
        .go { all:unset; display:block; text-align:center; padding:8px; border-radius:8px;
              background:#2563eb; color:#fff; cursor:pointer; font-weight:600; font-size:12.5px; }
        .go.stop { background:#ef4444; }
        .go:hover { filter:brightness(1.08); }
        .log { height:104px; overflow:auto; background:#0f172a; color:#cbd5e1; border-radius:8px;
               padding:6px 8px; font:11px/1.5 ui-monospace,Consolas,monospace; white-space:pre-wrap; word-break:break-all; }
        .log .ok { color:#4ade80; } .log .warn { color:#fbbf24; }
        .mini { all:unset; text-align:center; padding:5px; border-radius:6px; border:1px solid #dbe1ec;
                cursor:pointer; font-size:11px; color:#475569; }
        .mini:hover { background:#f4f6fb; }
        .notice { margin:6px 0 2px; padding:7px 9px; border-radius:7px; font-size:11px; line-height:1.5;
                  background:#fef3c7; border:1px solid #fcd34d; color:#92400e; }
        .help { position:absolute; left:0; right:0; top:0; background:#fff; border-bottom:1px solid #e5e9f2;
                padding:10px 12px 14px; display:none; flex-direction:column; gap:7px; max-height:520px; overflow:auto;
                box-shadow:0 8px 24px rgba(15,23,42,.18); }
        .help.on { display:flex; }
        .help h4 { margin:0; font-size:12.5px; color:#1f2329; }
        .help .st { background:#f4f6fb; border-radius:7px; padding:6px 8px; font-size:11px; }
        .help .st b { color:#16a34a; } .help .st.bad b { color:#dc2626; }
        .help ol { margin:0; padding-left:16px; font-size:11px; color:#374151; }
        .help ol li { margin:3px 0; }
        .help .url { background:#0f172a; color:#7dd3fc; border-radius:6px; padding:4px 7px; font:10.5px/1.4 ui-monospace,Consolas,monospace;
                     word-break:break-all; cursor:pointer; }
        .help .close2 { all:unset; position:absolute; right:8px; top:7px; cursor:pointer; color:#94a3b8; font-size:13px; }
        .help .close2:hover { color:#1f2329; }
        .help .tip2 { font-size:10.5px; color:#94a3b8; }
        .hd2 { font-size:11px; color:#6b7280; display:flex; justify-content:space-between; }
      </style>
      <div class="panel">
        <div class="hd" id="hd">
          <b>长江雨课堂 · 自动刷课</b><span class="v">v${YKT.version}</span>
          <button id="btn-min" title="收起/展开">—</button>
        </div>
        <div class="bd" id="bd" style="position:relative">
          <div class="help" id="help">
            <button class="close2" id="help-close">✕</button>
            <h4>使用帮助 / 自检</h4>
            <div class="st" id="help-status">正在自检…</div>
            <div style="font-size:11px;color:#374151"><b>如果脚本没反应</b>，按顺序检查：</div>
            <ol>
              <li>Edge 地址栏打开下面这个地址</li>
            </ol>
            <div class="url" id="help-url1">edge://extensions/?id=iikmkjmpaadaobahmlepeloendndfphd</div>
            <ol start="2">
              <li>找到「篡改猴」→「详细信息」→ 打开「<b>允许用户脚本</b>」开关
                  <span class="tip2">（Edge 154 起 MV3 必须手动授权，否则篡改猴内所有脚本都不执行）</span></li>
              <li>回到课程页按 <b>F5</b> 刷新</li>
              <li>还不行就打开下面地址，把当前脚本整份替换成最新版</li>
            </ol>
            <div class="url" id="help-url2">edge://extensions/</div>
            <div class="hd2"><span>本页面脚本状态</span><span id="help-frame"></span></div>
            <div class="st" id="help-detail" style="font-size:10.5px;line-height:1.5"></div>
            <div id="help-debug" style="display:none">
              <div style="font-size:11px;color:#374151">检测到本机有可连接的调试用 Edge 窗口：</div>
              <div class="url" id="help-url3" style="margin-top:4px">http://127.0.0.1:9222/json/version</div>
            </div>
            <div class="tip2">提示：浏览器安全限制不允许网页直接跳转到 edge:// 地址，点击上面的地址可复制，再粘贴到地址栏。</div>
          </div>
          <div class="stat">
            <div class="pill"><i>当前页</i><b id="s-page">—</b></div>
            <div class="pill"><i>本节进度</i><b id="s-prog">0%</b></div>
            <div class="pill"><i>倍速</i><b id="s-rate">${CFG.rate}x</b></div>
          </div>
          <div class="row"><span style="width:32px">倍速</span>
            <div class="seg" id="seg-rate"></div>
          </div>
          <div class="row">
            <label class="chk"><input type="checkbox" id="c-bg" ${CFG.background ? 'checked' : ''}>后台防暂停</label>
            <label class="chk"><input type="checkbox" id="c-next" ${CFG.autoNext ? 'checked' : ''}>自动跳转</label>
          </div>
          <div class="row">
            <label class="chk"><input type="checkbox" id="c-mute" ${CFG.mute ? 'checked' : ''}>静音</label>
            <label class="chk"><input type="checkbox" id="c-ff" ${CFG.fastForward ? 'checked' : ''}>快进到结尾</label>
          </div>
          <button class="go" id="btn-go">开始刷课</button>
          <div class="notice" id="notice" hidden></div>
          <div class="hd2"><span>运行日志</span><span id="s-guard">守卫就绪</span></div>
          <div class="log" id="log"></div>
          <div class="row" style="gap:6px">
            <button class="mini" id="btn-diag" style="flex:1">复制诊断信息</button>
            <button class="mini" id="btn-help" style="flex:1">使用帮助</button>
          </div>
        </div>
      </div>`;
    this.root = host;
    this.shadow = sh;
    const q = (id) => sh.getElementById(id);
    this.els = {
      hd: q('hd'), bd: q('bd'), log: q('log'), go: q('btn-go'), min: q('btn-min'),
      page: q('s-page'), prog: q('s-prog'), rate: q('s-rate'), guard: q('s-guard'),
      segRate: q('seg-rate'), cBg: q('c-bg'), cNext: q('c-next'), cMute: q('c-mute'), cFf: q('c-ff'),
    };

    [1, 1.25, 1.5, 2, 3].forEach((r) => {
      const b = document.createElement('button');
      b.textContent = r + 'x';
      b.dataset.rate = String(r);
      if (r === CFG.rate) b.classList.add('on');
      b.addEventListener('click', () => {
        CFG.rate = r;
        STORE.set('rate', r);
        [...this.els.segRate.children].forEach((x) => x.classList.toggle('on', Number(x.dataset.rate) === r));
        this.els.rate.textContent = r + 'x';
        LOG.ok(`目标倍速已设为 ${r}x`);
        // 交给同步逻辑去「真实点击播放器菜单」，此处不直接改 media 属性
        Run._speedBridgeAt = 0;
      });
      this.els.segRate.appendChild(b);
    });

    const bind = (el, key) => el && el.addEventListener('change', () => {
      CFG[key] = el.checked;
      STORE.set(key, el.checked);
      LOG.info(`${key} = ${el.checked}`);
    });
    bind(this.els.cBg, 'background');
    bind(this.els.cNext, 'autoNext');
    bind(this.els.cMute, 'mute');
    bind(this.els.cFf, 'fastForward');

    this.els.go.addEventListener('click', () => Run.toggle());
    this.els.min.addEventListener('click', () => this.toggleCollapse());
    const diagBtn = sh.getElementById('btn-diag');
    if (diagBtn) diagBtn.addEventListener('click', () => this.copyDiag(diagBtn));
    const helpBtn = sh.getElementById('btn-help');
    if (helpBtn) helpBtn.addEventListener('click', () => this.toggleHelp());
    const helpClose = sh.getElementById('help-close');
    if (helpClose) helpClose.addEventListener('click', () => this.toggleHelp(false));
    ['help-url1', 'help-url2', 'help-url3'].forEach((id) => {
      const el = sh.getElementById(id);
      if (!el) return;
      el.addEventListener('click', async () => {
        const txt = el.textContent.trim();
        let ok = false;
        try { await navigator.clipboard.writeText(txt); ok = true; } catch (e) { }
        const old = el.textContent;
        el.textContent = ok ? '已复制：' + txt : txt;
        LOG.info(ok ? `已复制地址：${txt}` : `请手动输入地址：${txt}`);
        setTimeout(() => { el.textContent = old; }, 2000);
      });
    });
    this.makeDraggable(host, this.els.hd);
    this.updateStats();

    window.addEventListener('keydown', (e) => {
      if (!e.altKey) return;
      const k = String(e.key).toLowerCase();
      if (k === 's') { Run.toggle(); e.preventDefault(); }
      else if (k === 'y') { this.toggleCollapse(); e.preventDefault(); }
      else if (['1', '2', '3'].includes(k)) {
        const r = k === '1' ? 1 : k === '2' ? 2 : 3;
        const btn = [...this.els.segRate.children].find((x) => Number(x.dataset.rate) === r);
        if (btn) btn.click();
        e.preventDefault();
      }
    });
  },

  makeDraggable(host, handle) {
    let sx = 0, sy = 0, ox = 0, oy = 0, dragging = false;
    handle.addEventListener('mousedown', (e) => {
      if (e.target.tagName === 'BUTTON') return;
      dragging = true;
      const r = host.getBoundingClientRect();
      sx = e.clientX; sy = e.clientY; ox = r.left; oy = r.top;
      e.preventDefault();
    });
    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const w = host.offsetWidth, h = host.offsetHeight;
      host.style.left = Math.min(Math.max(0, ox + e.clientX - sx), innerWidth - w) + 'px';
      host.style.top = Math.min(Math.max(0, oy + e.clientY - sy), innerHeight - h) + 'px';
      host.style.right = 'auto'; host.style.bottom = 'auto';
    });
    window.addEventListener('mouseup', () => { dragging = false; });
  },

  toggleCollapse() {
    this.collapsed = !this.collapsed;
    if (this.els.bd) this.els.bd.style.display = this.collapsed ? 'none' : 'flex';
  },

  push(line, level) {
    this.logLines.push(line);
    if (this.logLines.length > 120) this.logLines.shift();
    if (!this.els.log) return;
    const div = document.createElement('div');
    if (level) div.className = level;
    div.textContent = line;
    this.els.log.appendChild(div);
    while (this.els.log.childNodes.length > 120) this.els.log.removeChild(this.els.log.firstChild);
    this.els.log.scrollTop = this.els.log.scrollHeight;
  },

  updateStats(patch = {}) {
    Object.assign(this.stats, patch);
    if (!this.els.page) return;
    this.els.page.textContent = this.stats.page || '—';
    this.els.prog.textContent = (this.stats.prog != null ? this.stats.prog : 0) + '%';
    this.els.rate.textContent = CFG.rate + 'x';
    const g = Guard.stats;
    this.els.guard.textContent = (g.blockedEvents || g.blockedPause)
      ? `拦截 事件${g.blockedEvents}/暂停${g.blockedPause}`
      : '守卫就绪';
  },

  setRunning(on) {
    if (!this.els.go) return;
    this.els.go.textContent = on ? '停止刷课' : '开始刷课';
    this.els.go.classList.toggle('stop', on);
  },

  /**
   * 在面板里显示一条显眼提示（例如「浏览器拦住了自动播放，请点一下页面」）。
   * 传空字符串即清除；默认 60 秒后自动隐藏。
   */
  notice(msg, ms = 60000) {
    const el = this.shadow && this.shadow.getElementById('notice');
    if (!el) return;
    if (!msg) { el.hidden = true; el.textContent = ''; return; }
    el.hidden = false;
    el.textContent = msg;
    if (this._noticeTimer) clearTimeout(this._noticeTimer);
    if (ms > 0) this._noticeTimer = setTimeout(() => this.notice(''), ms);
  },

  /** 打开/关闭「使用帮助」浮层，并在打开时做一次自检 */
  toggleHelp(force) {
    const el = this.shadow && this.shadow.getElementById('help');
    if (this._helpTrace) {
      this._helpTrace.push({ t: Math.round(performance.now()), force, hasEl: !!el,
        stack: String(new Error('toggleHelp').stack || '').split('\n').slice(1, 6).join(' | ') });
    }
    if (!el) return;
    const show = force === undefined ? !el.classList.contains('on') : !!force;
    el.classList.toggle('on', show);
    if (show) this.refreshHelp();
  },

  /** 自检当前页面的脚本运行状况，把结论显示在帮助浮层里 */
  refreshHelp() {
    if (!this.shadow) return;
    const set = (id, html, cls) => {
      const el = this.shadow.getElementById(id);
      if (!el) return;
      if (html !== undefined) el.innerHTML = html;
      if (cls !== undefined) el.className = cls;
    };
    const items = [];
    let level = 'ok';

    // ① 脚本能跑起来本身就说明篡改猴已授权（未授权时页面里不会有面板）
    items.push('脚本已注入本页 <b>正常</b> → 篡改猴「允许用户脚本」已授权');

    // ② 顶级文档 / iframe
    const inFrame = U.inIframe();
    set('help-frame', inFrame ? 'iframe 内' : '顶层文档');
    if (inFrame) items.push('当前在 <b>iframe</b> 内运行（只做防暂停/锁倍速，不负责跳转）');

    // ③ 媒体元素
    const mediaCount = document.querySelectorAll('video, audio').length;
    if (mediaCount > 0) {
      const m = Player.get();
      items.push(`找到 ${mediaCount} 个视频元素，播放倍速 <b>${m ? m.playbackRate : '?'}x</b>`);
    } else {
      items.push('本页<b>没有视频元素</b>（目录页/外壳页属正常）');
    }

    // ④ 倍速界面是否同步
    const uiVal = Player.speedUiValue();
    if (uiVal !== null) {
      if (Math.abs(uiVal - CFG.rate) < 0.01) items.push(`播放器倍速显示 <b>${uiVal}x</b>，与目标一致`);
      else { items.push(`播放器倍速显示 ${uiVal}x，与目标 ${CFG.rate}x 不一致（脚本会自动纠正）`); level = 'warn'; }
    }

    // ⑤ 后台守卫
    const g = Guard.stats;
    const st = g.selfTest;
    if (st && st.ok === true) {
      items.push(`后台防暂停 <b>已生效</b>（拦下切屏事件 ${g.blockedEvents} 次、暂停 ${g.blockedPause} 次）`);
    } else if (st && st.ok === false) {
      items.push('<b>后台守卫自检失败</b>：切屏事件仍能送达站点，请反馈诊断信息');
      level = 'bad';
    } else {
      items.push('后台守卫已装载，自检结果稍后显示');
    }

    // ⑥ 真实可见性 vs 伪造值（用于确认守卫在工作）
    let raw = {};
    try { raw = (window.__yktRaw && window.__yktRaw.describe && window.__yktRaw.describe()) || {}; } catch (e) { }
    if (raw.visibilityState !== undefined) {
      items.push(`可见性：真实=${raw.visibilityState} / 站点读到=${raw.fakeVis}`
        + (raw.fakeVis === 'visible' ? ' <b>已被伪造</b>' : ''));
    }

    set('help-status',
      `<b>${level === 'ok' ? '✓ 一切正常' : level === 'warn' ? '⚠ 有需要注意的地方' : '✗ 发现问题'}</b>`,
      'st' + (level === 'ok' ? '' : ' bad'));
    set('help-detail', items.map((x) => '· ' + x).join('<br>'));
    this.updateStats();

    // 探测本机是否有调试用 Edge 窗口（有才显示入口）
    this.probeDebugWindow();
  },

  /** 探测本机是否开着带远程调试端口的 Edge；有则显示入口 */
  probeDebugWindow() {
    if (!this.shadow) return;
    const box = this.shadow.getElementById('help-debug');
    if (!box) return;
    if (this._debugProbed) { box.style.display = this._debugAlive ? 'block' : 'none'; return; }
    this._debugProbed = true;
    const done = (alive) => {
      this._debugAlive = alive;
      const b = this.shadow && this.shadow.getElementById('help-debug');
      if (b) b.style.display = alive ? 'block' : 'none';
    };
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 1200);
      fetch('http://127.0.0.1:9222/json/version', { signal: ctrl.signal })
        .then((r) => { clearTimeout(timer); done(r.ok); })
        .catch(() => { clearTimeout(timer); done(false); });
    } catch (e) { done(false); }
  },

  /** 生成诊断信息，便于把「脚本不生效」类问题一次性反馈 */
  diagText() {
    const r = U.route();
    const m = Player.get();
    const g = Guard.stats;
    let raw = {};
    try { raw = (window.__yktRaw && window.__yktRaw.describe && window.__yktRaw.describe()) || {}; } catch (e) { }
    return [
      `=== ${YKT.name} 诊断 ===`,
      `time       : ${new Date().toLocaleString()}`,
      `version    : ${YKT.version}`,
      `url        : ${location.href}`,
      `frame      : ${U.frameTag()}  (inIframe=${U.inIframe()})`,
      `route      : play=${r.isPlayPage} log=${r.isLogPage} classroom=${r.classroomId || '-'} leaf=${r.leafId || '-'} type=${r.type || '-'}`,
      `media      : ${m ? `${m.tagName}${m.id ? '#' + m.id : ''} paused=${m.paused} rate=${m.playbackRate} dur=${m.duration} t=${m.currentTime} rs=${m.readyState}` : '未找到 video/audio 元素'}`,
      `media count: ${document.querySelectorAll('video, audio').length}`,
      `running    : ${Run.running}  phase=${Run.phase}`,
      `guard      : active=${g.active} blockedEvents=${g.blockedEvents} blockedPause=${g.blockedPause} fakeReads=${g.fakeReads}`,
      `事件拦截自检: ${g.selfTest ? (g.selfTest.ok === true ? '通过（切屏事件无法送达站点监听器）' : g.selfTest.ok === false ? '失败（事件仍可送达）' : '异常: ' + g.selfTest.error) : '未执行'}`
        + (g.selfTest && g.selfTest.ok !== null ? `  原生投递可达=${g.selfTest.rawDelivered} 拦截后可达=${g.selfTest.blockedDelivered}` : ''),
      `站点切屏监听: ${g.seenEvents.length ? [...g.seenEvents].join(', ') : '（未检测到）'}`,
      `守卫备注   : ${g.notes.length ? g.notes.join(' | ') : '（无）'}`,
      `真实可见性 : hidden=${raw.hidden} visibilityState=${raw.visibilityState} hasFocus=${raw.hasFocus}`,
      `伪造后读取 : hidden=${raw.fakeHidden} visibilityState=${raw.fakeVis} hasFocus=${raw.fakeFocus}`,
      `speedUI    : xt-speedlist=${document.querySelectorAll('xt-speedlist').length} xt-speedbutton=${document.querySelectorAll('xt-speedbutton').length}`,
      `cfg        : rate=${CFG.rate} mute=${CFG.mute} background=${CFG.background} autoNext=${CFG.autoNext}`,
      `---- 最近日志 ----`,
      ...this.logLines.slice(-25),
    ].join('\n');
  },

  async copyDiag(btn) {
    const text = this.diagText();
    let ok = false;
    try {
      await navigator.clipboard.writeText(text);
      ok = true;
    } catch (e) {
      // 剪贴板不可用时退化为下载/控制台输出
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.cssText = 'position:fixed;opacity:0';
        document.body.appendChild(ta);
        ta.select();
        ok = document.execCommand('copy');
        ta.remove();
      } catch (e2) { ok = false; }
    }
    LOG.info(ok ? '诊断信息已复制到剪贴板，可直接粘贴反馈' : '剪贴板不可用，诊断信息已输出到浏览器控制台（F12）');
    if (!ok) console.log(text);
    if (btn) {
      const old = btn.textContent;
      btn.textContent = ok ? '✓ 已复制到剪贴板' : '✗ 已输出到控制台（F12）';
      setTimeout(() => { btn.textContent = old; }, 2500);
    }
  },
};

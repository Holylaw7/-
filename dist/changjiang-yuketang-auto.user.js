// ==UserScript==
// @name         长江雨课堂 · 自动刷课助手
// @name:zh-CN   长江雨课堂 · 自动刷课助手
// @namespace    https://github.com/Holylaw7/-
// @version      1.1.3
// @description  长江雨课堂自动刷课：自动跳转下一节、锁定 2 倍速、切换页面/最小化后仍然后台播放（防暂停 / 防降速 / 防挂机弹窗），并自动跳过测验与作业。
// @description:zh-CN 长江雨课堂自动刷课：自动跳转下一节、锁定 2 倍速、切换页面后仍然后台播放。
// @author       Holylaw7
// @license      MIT
// @match        *://*.yuketang.cn/*
// @match        *://*.yuketang.com/*
// @match        *://*.xuetangx.com/*
// @match        *://*.xuetangx.org/*
// @match        *://*.ykt.io/*
// @run-at       document-start
// @grant        unsafeWindow
// @homepageURL  https://github.com/Holylaw7/-
// @supportURL   https://github.com/Holylaw7/-/issues
// @updateURL    https://raw.githubusercontent.com/Holylaw7/-/main/dist/changjiang-yuketang-auto.user.js
// @downloadURL  https://raw.githubusercontent.com/Holylaw7/-/main/dist/changjiang-yuketang-auto.user.js
// ==/UserScript==
(function () {
  'use strict';
  // ------------------------------ src/01-core.js ------------------------------
  // ============================================================================
  //  模块 1/6：配置与通用工具
  // ============================================================================
  const YKT = {
    name: '长江雨课堂 · 自动刷课助手',
    version: '1.1.3',
    debug: true,
  };

  const CFG = {
    /** 目标倍速 */
    rate: 2,
    /** 是否开启后台/切屏防暂停 */
    background: true,
    /** 是否启用「倍速点击桥」：由外部本地工具（_tools/speed-bridge.js）用**真实鼠标**
     *  点击播放器自带菜单来切换倍速，走站点自己的逻辑，不留外部改写的痕迹。
     *  默认关闭；需要时执行一次： localStorage.setItem('ykt_tool:speedBridge','true')
     *  关闭时退回「直接设置媒体倍速」——播放仍是 2 倍速，但播放器界面可能显示 1.00X。 */
    speedBridge: false,
    /** 视频看完后是否自动进入下一节 */
    autoNext: true,
    /** 播放页最长等待时间（毫秒），超时则跳过该节 */
    itemTimeout: 90 * 60 * 1000,
    /** 是否在剩余少量时间时快进到结尾（更快，但部分学校会校验播放时长） */
    fastForward: false,
    /** 快进触发阈值：已播放比例 */
    fastForwardAt: 0.75,
    /** 保活巡检间隔（毫秒）。500ms 足以覆盖 Chrome 后台 1s 定时器节流，同时避免空转吃 CPU */
    tickMs: 500,
    /** 轮询检测间隔（毫秒） */
    pollMs: 1000,
  };

  // 设置项持久化
  const STORE = {
    get(key, fallback) {
      try {
        const raw = localStorage.getItem(`ykt_tool:${key}`);
        return raw === null ? fallback : JSON.parse(raw);
      } catch (e) { return fallback; }
    },
    set(key, value) {
      try { localStorage.setItem(`ykt_tool:${key}`, JSON.stringify(value)); } catch (e) { }
    },
  };

  const LOG = {
    lines: [],
    write(level, msg) {
      const t = new Date().toTimeString().slice(0, 8);
      const line = `[${t}] ${msg}`;
      this.lines.push(line);
      if (this.lines.length > 200) this.lines.shift();
      if (YKT.debug) console.log(`%c[刷课助手]`, 'color:#2563eb', msg);
      if (typeof UI !== 'undefined' && UI.push) UI.push(line, level);
    },
    info(m) { this.write('info', m); },
    ok(m) { this.write('ok', m); },
    warn(m) { this.write('warn', m); },
  };

  // ----------------------------------------------------------------- 通用工具
  const U = {
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),

    /** 是否处于 iframe 内。雨课堂部分教室把播放器放在独立 iframe 里加载 */
    inIframe() {
      try { return window.top !== window.self; } catch (e) { return true; }
    },

    /** 当前帧的简短标识，用于日志与诊断 */
    frameTag() {
      if (!U.inIframe()) return 'top';
      try { return 'iframe[' + location.host + location.pathname.slice(0, 40) + ']'; } catch (e) { return 'iframe[跨域]'; }
    },

    /** 轮询直到条件成立，返回是否成功 */
    async until(fn, { timeout = 20000, interval = 500, label = '' } = {}) {
      const start = Date.now();
      for (;;) {
        let v;
        try { v = fn(); } catch (e) { v = false; }
        if (v) return v;
        if (Date.now() - start > timeout) {
          if (label) LOG.warn(`等待超时：${label}`);
          return false;
        }
        await U.sleep(interval);
      }
    },

    /** 元素是否真实可见 */
    visible(el) {
      if (!el || el.nodeType !== 1) return false;
      const st = getComputedStyle(el);
      if (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity) === 0) return false;
      const r = el.getBoundingClientRect();
      return r.width > 1 && r.height > 1;
    },

    /** 文本归一化 */
    text(el) {
      return String((el && el.innerText) || '').replace(/\s+/g, ' ').trim();
    },

    // ------------------------------------------------------------ 用户激活
    //
    //  浏览器的自动播放策略要求页面有过「真实用户输入」。这个状态浏览器自己就维护着：
    //    navigator.userActivation.hasBeenActive —— 一旦有过真实输入就永久为 true，
    //    合成事件不会让它变 true（规范如此），也无法被脚本伪造。
    //
    //  所以脚本**不需要自己监听鼠标/键盘事件**。早期版本自己写了一套手势追踪，
    //  结果反而出错：antiIdle 为防挂机弹窗定时派发的合成 keydown 被自己当成了用户手势，
    //  导致自动播放被拦时误判「用户已交互」→ 立刻重试 → 又被拒 → 死循环刷屏。
    //
    //  现在只做两件事：读原生状态、等它翻转。
    activation: {
      /** 是否已经有过真实用户输入（浏览器原生判定） */
      has() {
        try {
          const ua = navigator.userActivation;
          return !!(ua && (ua.hasBeenActive || ua.isActive));
        } catch (e) { return false; }
      },

      /** 当前是否正处于「用户刚刚交互过」的短暂窗口内 */
      isActive() {
        try {
          const ua = navigator.userActivation;
          return !!(ua && ua.isActive);
        } catch (e) { return false; }
      },

      /**
       * 等 hasBeenActive 由 false 变为 true（即等到一次**新的**真实输入）。
       * 已是 true 时立即返回，除非传 requireChange=true。
       * 返回 true 表示等到了；false 表示超时。
       */
      waitForChange(timeoutMs, requireChange) {
        if (!requireChange && this.has()) return Promise.resolve(true);
        if (requireChange && !this.has()) return Promise.resolve(true); // 本来就是 false，任何输入都算新的
        const t0 = Date.now();
        return new Promise((resolve) => {
          const tick = () => {
            if (this.isActive() || (requireChange && this.has() === false)) { resolve(true); return; }
            if (Date.now() - t0 >= timeoutMs) { resolve(false); return; }
            setTimeout(tick, 250);
          };
          // 用 isActive() 作为「刚刚输入」的信号：hasBeenActive 一旦为真就不再变化，
          // 无法区分「这次输入」与「很久以前的输入」，而 isActive 只在短暂窗口内为真。
          tick();
        });
      },

      /** 供诊断展示 */
      describe() {
        try {
          const ua = navigator.userActivation;
          return { hasBeenActive: !!ua.hasBeenActive, isActive: !!ua.isActive };
        } catch (e) { return { unavailable: true }; }
      },
    },


    /** 解析路径与查询参数，得到当前教室/小节信息 */
    route() {
      const q = new URLSearchParams(location.search);
      const p = location.pathname;
      const pick = (...keys) => {
        for (const k of keys) { const v = q.get(k); if (v) return v; }
        return '';
      };
      const out = {
        path: p,
        classroomId: pick('classroom_id', 'classroomId', 'cid'),
        nodeId: pick('node_id', 'nodeId'),
        leafId: pick('leaf_id', 'leafId', 'video_id', 'videoId'),
        type: '',
        isLogPage: false,
        isPlayPage: false,
        hasMedia: false,
      };
      let m = p.match(/^\/ai-workspace\/lms-graph\/([^/]+)\/([^/]+)\/([^/?#]+)/);
      if (m) {
        out.classroomId = out.classroomId || m[1];
        out.type = m[2];
        out.leafId = out.leafId || decodeURIComponent(m[3]);
        out.isPlayPage = true;
      }
      m = p.match(/^\/v2\/web\/studentLog\/([^/?#]+)/);
      if (m) {
        out.classroomId = out.classroomId || m[1];
        out.isLogPage = true;
      }
      m = p.match(/^\/(?:pro\/)?lms\/([^/]+)\/studycontent/);
      if (m) {
        out.classroomId = out.classroomId || m[1];
        out.isLogPage = true;
      }
      // 兜底：其它形式的播放页路径（不同教室/版本差异较大）
      if (!out.isPlayPage && !out.isLogPage) {
        if (/\/(video|audio|ppt|pdf|card|studycontent|studentCards?|lesson)\b/i.test(p)) out.isPlayPage = true;
        else if (/studentLog|course\/detail|my_course|study-list/i.test(p)) out.isLogPage = true;
      }
      // 页面里已经出现媒体元素，也认为是可以接管的播放页
      try {
        if (document.querySelector('video, audio')) { out.hasMedia = true; out.isPlayPage = true; }
      } catch (e) { }
      return out;
    },

    /**
     * 跨 realm 安全地构造并派发鼠标事件。
     *
     * 真站实测踩到的坑：在篡改猴沙箱里 `new MouseEvent(type, { view: window })` 会抛
     *   Failed to construct 'MouseEvent': Failed to read the 'view' property from
     *   'UIEventInit': Failed to convert value to 'Window'.
     * 因为沙箱的构造函数不接受**页面 realm** 的 window 对象。
     * 这里逐级降级：页面 realm 构造函数 → 省略 view → 沙箱构造函数。
     */
    fireMouse(target, type, opts = {}) {
      if (!target) return false;
      const W = (typeof unsafeWindow !== 'undefined' && unsafeWindow) || window;
      const base = {
        bubbles: true, cancelable: true,
        clientX: opts.clientX || 0, clientY: opts.clientY || 0,
        button: opts.button === undefined ? 0 : opts.button,
        buttons: opts.buttons === undefined ? 0 : opts.buttons,
      };
      const make = () => {
        try { return new W.MouseEvent(type, { ...base, view: W }); } catch (e) { }
        try { return new W.MouseEvent(type, base); } catch (e) { }
        try { return new MouseEvent(type, { ...base, view: window }); } catch (e) { }
        try { return new MouseEvent(type, base); } catch (e) { }
        return null;
      };
      const ev = make();
      if (!ev) return false;
      // 部分实现会忽略构造参数里的坐标，这里再显式定义一次
      try { Object.defineProperty(ev, 'clientX', { value: base.clientX, configurable: true }); } catch (e) { }
      try { Object.defineProperty(ev, 'clientY', { value: base.clientY, configurable: true }); } catch (e) { }
      try { target.dispatchEvent(ev); return true; } catch (e) { return false; }
    },

    click(el) {
      if (!el) return false;
      try {
        el.scrollIntoView({ block: 'center', behavior: 'instant' });
      } catch (e) { }

      const r = el.getBoundingClientRect();
      const x = Math.round(r.left + Math.min(Math.max(r.width / 2, 2), Math.max(r.width - 2, 2)));
      const y = Math.round(r.top + Math.min(Math.max(r.height / 2, 2), Math.max(r.height - 2, 2)));

      // ① 关键：伪造带真实坐标的 mousemove，顶起站点的 hasMouse 判定
      //    （统一走 U.fireMouse，避免沙箱跨 realm 构造 MouseEvent 抛异常）
      U.fireMouse(el, 'mousemove', { clientX: x - 40, clientY: y - 30 });
      U.fireMouse(el, 'mouseover', { clientX: x - 40, clientY: y - 30 });
      U.fireMouse(el, 'mousemove', { clientX: x, clientY: y });
      U.fireMouse(el, 'mouseenter', { clientX: x, clientY: y });

      // ② 常规鼠标事件序列
      U.fireMouse(el, 'mousedown', { clientX: x, clientY: y, buttons: 1 });
      U.fireMouse(el, 'mouseup', { clientX: x, clientY: y, buttons: 0 });
      U.fireMouse(el, 'click', { clientX: x, clientY: y, buttons: 0 });
      return true;
    },

    /** 判断文本是否表示「已完成」 */
    looksDone(t) {
      if (!t) return false;
      if (/已完成|已学完|已看完|已读|观看完成|学习完成/.test(t)) return true;
      const m = t.match(/(\d{1,3})\s*%/);
      if (m) return Number(m[1]) >= 100;
      const p = t.match(/(\d+)\s*\/\s*(\d+)/);
      if (p && Number(p[2]) > 0) return Number(p[1]) >= Number(p[2]);
      return false;
    },

    /** 从文本中取出百分比 */
    pct(t) {
      const m = String(t || '').match(/(\d{1,3})\s*%/);
      return m ? Number(m[1]) : null;
    },
  };
  // ------------------------------ src/02-guard.js ------------------------------
  // ============================================================================
  //  模块 2/6：后台播放守卫（必须在 document-start 执行，早于站点脚本注册监听）
  //
  //  长江雨课堂判定「你在后台」的手段主要有四类，这里逐一封堵：
  //    ① document.visibilitychange / window.blur / pagehide 事件
  //    ② document.hidden / document.visibilityState / document.hasFocus()
  //    ③ 站点自己调用 media.pause()
  //    ④ 播放器把倍速重置为 1x（ratechange，见 03-player）
  //  并用访问器陷阱拦截站点后续对上述属性的重定义。
  // ============================================================================
  const Guard = {
    active: false,
    stats: { blockedEvents: 0, blockedPause: 0, fakeReads: 0, notes: [] },
    /** 我们自己调用 pause 时的豁免计数 */
    selfPause: 0,
    seenEvents: new Set(),
    /** 脚本内部通道：即便站点事件被吞掉，我们仍能观测真实可见性 */
    internal: new Map(),
    /** 自检结果：{ ok, got, at } —— ok=true 表示确实拦住了事件 */
    selfTest: null,

    /** 注册内部监听（不受事件封堵影响） */
    on(type, fn) {
      if (!this.internal.has(type)) this.internal.set(type, []);
      this.internal.get(type).push(fn);
    },
    deliverInternal(type, event) {
      const l = this.internal.get(type);
      if (!l) return;
      for (const fn of l) { try { fn(event); } catch (e) { } }
    },

    note(m) {
      this.stats.notes.push(m);
      if (this.stats.notes.length > 60) this.stats.notes.shift();
    },
    log(m) { try { LOG.info(m); } catch (e) { } },

    install() {
      if (this.active) return;
      this.active = true;
      const G = this;
      const W = (typeof unsafeWindow !== 'undefined' && unsafeWindow) || window;
      const D = document;

      // 在打补丁之前，抓下「真实」的可见性事实与原生读取器，供诊断显示
      const rawHiddenDesc = Object.getOwnPropertyDescriptor(Document.prototype, 'hidden');
      const rawVisDesc = Object.getOwnPropertyDescriptor(Document.prototype, 'visibilityState');
      const rawHasFocus = document.hasFocus ? document.hasFocus.bind(document) : null;
      W.__yktRaw = {
        describe() {
          let hidden = null, vis = null, focus = null;
          try { hidden = rawHiddenDesc && rawHiddenDesc.get ? rawHiddenDesc.get.call(document) : document.hidden; } catch (e) { }
          try { vis = rawVisDesc && rawVisDesc.get ? rawVisDesc.get.call(document) : document.visibilityState; } catch (e) { }
          try { focus = rawHasFocus ? rawHasFocus() : null; } catch (e) { }
          return { hidden, visibilityState: vis, hasFocus: focus, fakeHidden: document.hidden, fakeVis: document.visibilityState, fakeFocus: document.hasFocus() };
        },
      };

      // ------------------------------------------------- ① 事件封堵
      // 分两层：
      //   第一层 dispatchEvent 拦截 —— 真正的执行点。无论站点在什么时机注册监听
      //   （包括脚本注入之前就已注册的），这些事件都不会派发出去。
      //   第二层 addEventListener 记录 —— 仅用于诊断与统计。
      const BLOCKED = new Set(['visibilitychange', 'webkitvisibilitychange', 'blur', 'pagehide', 'freeze']);

      const wrapDispatch = (target, tag) => {
        const orig = target.dispatchEvent;
        if (typeof orig !== 'function') return;
        target.__yktOrigDispatch = orig;   // 必须在替换之前保存真正的原生实现
        const wrapped = function (event) {
          try {
            const type = event && event.type;
            if (G.active && type && BLOCKED.has(String(type))) {
              // 站点确实注册过这类监听，才算「拦下了一次」
              if (G.seenEvents.has(String(type))) G.stats.blockedEvents++;
              // 输出到脚本自己的内部通道（我们仍需感知真实可见性用于诊断）
              G.deliverInternal(type, event);
              return true; // 吞掉事件：站点监听器一个都不会收到
            }
          } catch (e) { }
          return orig.call(this, event);
        };
        try {
          Object.defineProperty(target, 'dispatchEvent', {
            configurable: true, writable: true, enumerable: false, value: wrapped,
          });
        } catch (e) {
          try { target.dispatchEvent = wrapped; } catch (e2) { G.note('dispatchEvent 补丁失败: ' + e2.message); }
        }
      };
      // 浏览器把事件直接投递给 document/window，因此这两处是必须的
      wrapDispatch(D, 'document');
      wrapDispatch(W, 'window');

      const wrapAdd = (target, tag) => {
        const orig = target.addEventListener;
        if (typeof orig !== 'function') return;
        target.__yktOrigAdd = orig;        // 同样是替换之前的原生实现
        const wrapped = function (type, listener, options) {
          try {
            if (BLOCKED.has(String(type))) {
              G.seenEvents.add(String(type));
              if (G.seenEvents.size <= 6) G.note(`站点注册了切屏监听: ${tag}.${type}（已被 dispatch 层拦截）`);
            }
          } catch (e) { }
          return orig.call(this, type, listener, options);
        };
        wrapped.__yktOrig = orig;
        try { target.addEventListener = wrapped; } catch (e) { }
      };
      wrapAdd(W, 'window');
      wrapAdd(D, 'document');
      // 站点有时挂在 document.body / #app 上
      const wrapLater = () => {
        try { if (document.body) wrapAdd(document.body, 'body'); } catch (e) { }
      };
      if (document.body) wrapLater();
      else D.addEventListener('DOMContentLoaded', wrapLater, { once: true });

      // ------------------------------------------------- ② 属性伪造
      this.nativeDesc = {
        hidden: Object.getOwnPropertyDescriptor(Document.prototype, 'hidden'),
        visibilityState: Object.getOwnPropertyDescriptor(Document.prototype, 'visibilityState'),
        hasFocus: Object.getOwnPropertyDescriptor(Document.prototype, 'hasFocus'),
      };

      const defineFake = (target, prop, value) => {
        try {
          Object.defineProperty(target, prop, {
            configurable: false,
            enumerable: true,
            get() { G.stats.fakeReads++; return value; },
            set() { G.stats.fakeReads++; G.note(`拦截站点写入 ${prop}`); },
          });
          return true;
        } catch (e) {
          G.note(`伪造 ${prop} 失败: ${e.message}`);
          return false;
        }
      };

      defineFake(D, 'hidden', false);
      defineFake(D, 'visibilityState', 'visible');
      defineFake(D, 'webkitHidden', false);
      defineFake(D, 'webkitVisibilityState', 'visible');
      defineFake(W, 'onblur', null);
      defineFake(D, 'onvisibilitychange', null);
      defineFake(W, 'onpagehide', null);

      try {
        Object.defineProperty(D, 'hasFocus', {
          configurable: false, writable: false, enumerable: false,
          value: function hasFocus() { G.stats.fakeReads++; return true; },
        });
      } catch (e) { G.note('hasFocus 补丁失败: ' + e.message); }

      // ------------------------------------------------- ③ pause() 拦截
      const proto = W.HTMLMediaElement && W.HTMLMediaElement.prototype;
      if (proto && typeof proto.pause === 'function') {
        const origPause = proto.pause;
        G.origPause = origPause;
        const patched = function yktPause(...args) {
          try {
            if (CFG.background && G.selfPause === 0 && !this.paused) {
              const dur = Number(this.duration);
              const nearEnd = Number.isFinite(dur) && dur > 1 && dur - this.currentTime <= 0.4;
              if (!this.ended && !nearEnd) {
                G.stats.blockedPause++;
                G.note(`拦截 pause()：${this.tagName || 'media'}`);
                return undefined;
              }
            }
          } catch (e) { }
          return origPause.apply(this, args);
        };
        patched.__yktPatched = true;
        try {
          Object.defineProperty(proto, 'pause', {
            configurable: true, writable: true, enumerable: false, value: patched,
          });
        } catch (e) {
          try { proto.pause = patched; } catch (e2) { G.note('pause 补丁失败: ' + e2.message); }
        }
      }


      this.log('后台播放守卫已装载：事件封堵 + 属性伪造 + pause 拦截');

      // ------------------------------------------------- ④ 自检
      // 目的：证明「切屏类事件确实送不到站点监听器」。
      // 做法：动态把一个测试事件名加入封堵集合（复用的是与 visibilitychange
      //      完全相同的包装代码路径），然后分两次投递：
      //        原生投递 -> 监听器应当收到（证明投递通道正常）
      //        包装投递 -> 监听器不应收到（证明屏障生效）
      setTimeout(() => {
        try {
          const nativeAdd = W.__yktOrigAdd || W.addEventListener;
          const nativeDispatch = W.__yktOrigDispatch || W.dispatchEvent;
          const TEST_EVT = 'ykt-guard-selftest';
          let rawDelivered = false;
          let blockedDelivered = false;
          const probe = (ev) => {
            if (ev && ev.type === TEST_EVT) rawDelivered = true;
            else blockedDelivered = true;
          };
          nativeAdd.call(W, TEST_EVT, probe);
          nativeAdd.call(W, 'visibilitychange', probe);

          // ① 原生投递（绕过包装层）：应当送达
          nativeDispatch.call(W, new Event(TEST_EVT));
          // ② 包装投递：应当被吞掉
          BLOCKED.add(TEST_EVT);
          W.dispatchEvent(new Event(TEST_EVT));
          // ③ 真实事件名走包装层：应当被吞掉
          W.dispatchEvent(new Event('visibilitychange'));

          G.selfTest = {
            rawDelivered,
            blockedDelivered,
            ok: rawDelivered === true && blockedDelivered === false,
            at: Date.now(),
          };
          G.note(G.selfTest.ok
            ? '自检通过：原生投递可送达，经包装层的事件被成功吞掉'
            : `自检异常：原生可达=${rawDelivered} 包装后仍可达=${blockedDelivered}`);
        } catch (e) {
          G.selfTest = { ok: null, error: e.message };
          G.note('自检异常: ' + e.message);
        }
      }, 1200);
    },

    /** 主动暂停媒体（绕过 pause 拦截） */
    pause(media) {
      if (!media) return;
      this.selfPause++;
      try {
        if (this.origPause) this.origPause.call(media);
        else media.pause();
      } catch (e) { } finally { this.selfPause--; }
    },
  };
  // ------------------------------ src/03-player.js ------------------------------
  // ============================================================================
  //  模块 3/6：播放器控制（倍速锁定 / 后台保活 / 完成判定）
  // ============================================================================
  const Player = {
    media: null,
    lastEnforce: 0,
    rateChangeBound: false,
    speedUiTried: 0,

    /** 媒体元素的稳定标识（真站的 id 是「时间戳_哈希」，可以当唯一键用） */
    mediaTagOf(m) {
      if (!m) return '';
      return `${m.tagName}#${m.id || ''}`;
    },

    /** 选取当前正在播放的媒体元素（页面可能有多个 video/audio） */
    pick() {
      const all = [...document.querySelectorAll('video, audio')].filter((m) => m instanceof HTMLMediaElement);
      if (!all.length) return null;
      const score = (m) => {
        let s = 0;
        const r = m.getBoundingClientRect();
        s += Math.min(r.width * r.height, 4e5);
        if (!m.paused && !m.ended) s += 1e6;
        s += Number(m.currentTime || 0);
        if (m.classList.contains('vjs-tech') || m.id === 'mock-media') s += 5e4;
        return s;
      };
      const best = all.sort((a, b) => score(b) - score(a))[0];
      this.media = best;
      return best;
    },

    get() {
      const m = this.media;
      if (m && m.isConnected) return m;
      return this.pick();
    },


    /** 绑定 ratechange：站点一改倍速我们立刻改回来，并记录「被改到什么值、多久恢复」 */
    bindRateGuard(media) {
      if (this.rateChangeBound || !media) return;
      this.rateChangeBound = true;
      const self = this;
      const note = (from, to) => {
        const rec = { at: Date.now(), from, to, mediaTime: media.currentTime, recoveredAt: null };
        self.rateEvents = self.rateEvents || [];
        self.rateEvents.push(rec);
        if (self.rateEvents.length > 200) self.rateEvents.shift();
        self.lastRateEvent = rec;
        return rec;
      };
      media.addEventListener('ratechange', function () {
        try {
          if (Math.abs(this.playbackRate - CFG.rate) > 0.01 && CFG.rate > 1) {
            const from = this.playbackRate;
            this.playbackRate = CFG.rate;
            self.rateFixCount = (self.rateFixCount || 0) + 1;
            if (self.lastRateEvent && self.lastRateEvent.recoveredAt === null) {
              self.lastRateEvent.recoveredAt = Date.now();
            } else {
              note(from, CFG.rate);
              if (self.lastRateEvent) self.lastRateEvent.recoveredAt = Date.now();
            }
          }
        } catch (e) { }
      });
      document.addEventListener('ratechange', function (ev) {
        const t = ev.target;
        if (t && Math.abs(t.playbackRate - CFG.rate) > 0.01 && CFG.rate > 1) {
          try {
            t.playbackRate = CFG.rate;
            self.rateFixCount = (self.rateFixCount || 0) + 1;
            if (self.lastRateEvent && self.lastRateEvent.recoveredAt === null) {
              self.lastRateEvent.recoveredAt = Date.now();
            }
          } catch (e) { }
        }
      }, true);
    },

    /** 掉速统计：用于自证「即便被改也能立刻改回」 */
    rateStats() {
      const evs = this.rateEvents || [];
      const settled = evs.filter((e) => e.recoveredAt !== null);
      const recoverMs = settled.map((e) => e.recoveredAt - e.at);
      return {
        events: evs.length,
        recovered: settled.length,
        fixCount: this.rateFixCount || 0,
        maxRecoverMs: recoverMs.length ? Math.max(...recoverMs) : 0,
        recent: evs.slice(-6).map((e) => ({ from: e.from, to: e.to, ms: e.recoveredAt ? e.recoveredAt - e.at : null })),
      };
    },

    /**
     * 播放器倍速显示同步 —— 真站实测结论（2026-10）：
     *
     *  播放器结构： <xt-speedbutton class="xt_video_player_speed">
     *                 <xt-speedvalue class="xt_video_player_common_value">1.00X</xt-speedvalue>
     *                 <xt-speedlist class="xt_video_player_common_list_wrap" style="display:none">
     *                   <ul class="xt_video_player_common_list">
     *                     <li data-speed="2" keyt="2.00">2.00X</li> …
     *
     *  关键事实：
     *   1. 直接设 video.playbackRate = 2 **确实会 2 倍速播放**（实测位置每 2s 前进 4s），
     *      但界面文字仍是 1.00X —— 因为该文字渲染的是播放器自己的内部变量，不是媒体元素。
     *   2. 内部变量位置：<player 实例>.options.speed.value。改它**不会**让界面更新
     *      （播放器不是响应式渲染这块）。
     *   3. 菜单 <xt-speedlist> 是 hover 才展开的（折叠时 display:none / 宽 0）。
     *      合成 MouseEvent **不会**触发 CSS :hover，因此在脚本里点不开、点不到菜单项
     *      （CDP 真实鼠标输入在自动化环境下也没能稳定展开）。
     *   4. 直接改 <xt-speedvalue> 的文字**不会被播放器覆盖回去**（等待数秒仍保持）。
     *
     * 因此策略是：媒体倍速由站点自己的菜单点击保证（真正的 2 倍速播放），
     * 界面文字由这里同步，避免"显示 1.00X 但其实在 2 倍速"造成的误解。
     */
    speedUi() {
      const btn = document.querySelector('.xt_video_player_speed, xt-speedbutton');
      const value = (btn && btn.querySelector('.xt_video_player_common_value, xt-speedvalue'))
        || document.querySelector('.xt_video_player_common_value, xt-speedvalue');
      const list = (btn && btn.querySelector('.xt_video_player_common_list_wrap, xt-speedlist'))
        || document.querySelector('.xt_video_player_common_list_wrap, xt-speedlist');
      const options = list
        ? [...list.querySelectorAll('li[data-speed], xt-button[data-speed], [data-speed]')]
        : [];
      return { btn, value, list, options };
    },

    /** 播放器界面当前显示的倍速（读不到返回 null） */
    speedUiValue() {
      const ui = this.speedUi();
      const t = U.text(ui && ui.value);
      const m = t.match(/([\d.]+)\s*X/i);
      return m ? Number(m[1]) : null;
    },

    /** 播放器界面是否已显示目标倍速 */
    speedUiMatches() {
      const v = this.speedUiValue();
      return v === null ? null : Math.abs(v - CFG.rate) < 0.01;
    },

    /**
     * 尝试**直接点击播放器自己的倍速菜单项**（不依赖任何外部工具）。
     *
     * 背景（真站实测）：
     *   · 播放器的倍速显示与内部变量只由它自己的菜单处理函数更新；
     *     直接改 video.playbackRate 能真的 2 倍速播放，但界面会一直显示 1.00X。
     *   · 它的菜单默认折叠（display:none），靠 hover 展开；合成 MouseEvent 不触发
     *     CSS :hover，所以需要「临时把菜单显示出来再点」这种迂回做法。
     *
     * 做法：先把折叠的菜单临时设为可见 → 对 2.00X 选项派发完整鼠标事件序列
     *      （带真实坐标，绕开站点的鼠标悬浮校验）→ 立即移除临时样式。
     *      这样走的仍然是站点自己的事件处理，内部变量/界面/媒体三处会一起更新。
     */
    clickNativeSpeedOption() {
      const ui = this.speedUi();
      if (!ui || !ui.list || !ui.options.length) return false;

      const opt = ui.options.find((li) => Number(li.getAttribute('data-speed')) === CFG.rate)
        || ui.options.find((li) => new RegExp(`^\\s*${String(CFG.rate).replace('.', '\\.')}(\\.0+)?\\s*X\\s*$`, 'i').test(U.text(li)));
      if (!opt) return false;

      // 保存并临时强制显示菜单（否则元素尺寸为 0，事件虽然能派发但部分实现会忽略）
      const saved = {
        display: ui.list.style.display,
        visibility: ui.list.style.visibility,
        opacity: ui.list.style.opacity,
        position: ui.list.style.position,
        zIndex: ui.list.style.zIndex,
      };
      const restore = () => {
        Object.keys(saved).forEach((k) => {
          try {
            if (saved[k]) ui.list.style[k] = saved[k];
            else ui.list.style.removeProperty(k.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase()));
          } catch (e) { }
        });
      };

      try {
        ui.list.style.setProperty('display', 'block', 'important');
        ui.list.style.setProperty('visibility', 'visible', 'important');
        ui.list.style.setProperty('opacity', '1', 'important');
        ui.list.style.setProperty('position', 'absolute', 'important');
        ui.list.style.setProperty('z-index', '99999', 'important');

        const r = opt.getBoundingClientRect();
        const x = Math.round(r.left + Math.max(r.width / 2, 1));
        const y = Math.round(r.top + Math.max(r.height / 2, 1));

        // 用跨 realm 安全的方式派发（沙箱里直接 new MouseEvent({view: pageWindow}) 会抛异常）
        const fire = (type, buttons) => U.fireMouse(opt, type, { clientX: x, clientY: y, button: 0, buttons: buttons || 0 });
        fire('mousemove', 0);
        fire('mouseover', 0);
        fire('mouseenter', 0);
        fire('mousedown', 1);
        fire('mouseup', 0);
        fire('click', 0);
        this.speedUiClicks = (this.speedUiClicks || 0) + 1;
        return true;
      } catch (e) {
        LOG.warn('点击播放器倍速菜单失败：' + e.message);
        return false;
      } finally {
        // 立刻恢复，避免影响用户看到真实的播放器样式
        restore();
      }
    },


    /**
     * 后台保活：自动续播（完全不碰音量/静音）。
     *
     * 关于「自动播放被网站拦截」：
     *   浏览器的自动播放策略要求「用户手势」；脚本自 v1.1.3 起不再静音，
     *   所以首次可能被拦：此时标记 autoplayBlocked 并**停止无效重试**，
     *   提示用户点一下页面，记录到手势后自动恢复播放。
     */
    keepAlive(media) {
      if (!media) return;
      try {
        const dur = Number(media.duration);
        const nearEnd = Number.isFinite(dur) && dur > 1 && dur - media.currentTime <= 0.4;
        if (!media.paused || media.ended || nearEnd) {
          // 已经在播 → 若之前被判为拦截，说明其实能播，解除标记
          if (!media.paused) this.autoplayBlocked = false;
          return;
        }
        // 不支持 play() 的媒体对象直接跳过
        if (typeof media.play !== 'function') return;

        // 同一媒体元素上的失败退避：
        //   · 自动播放策略拦截（NotAllowedError）→ 等用户手势，不做无谓重试
        //   · 其它失败（AbortError/媒体被换掉/尚不可播）→ 指数退避重试，有次数上限
        // 这样既不会每 500ms 空转刷屏，也不会因为一次偶发失败就永久放弃。
        const now = Date.now();
        if (this._playRetryUntil && now < this._playRetryUntil) return;
        // 已被判为「自动播放被拦」且浏览器还没有用户激活 → 交给等激活的重试逻辑，不在这里空转
        if (this.autoplayBlocked && !U.activation.has()) return;

        const p = media.play();
        if (p && p.catch) {
          p.then(() => {
            if (this.autoplayBlocked) {
              this.autoplayBlocked = false;
              LOG.ok('自动播放已恢复');
            }
            this.playFailCount = 0;
            this._playRetryUntil = 0;
          }).catch((err) => {
            const name = (err && err.name) || '';
            this.playFailCount = (this.playFailCount || 0) + 1;
            const mediaErr = media.error;

            if (name === 'NotAllowedError') {
              // 自动播放策略拦截 —— 即"被浏览器/网站拦住"，等用户手势
              this.autoplayBlocked = true;
              this.onAutoplayBlocked(media);
              return;
            }

            // 其它失败：指数退避（0.5s → 1s → 2s → 4s，上限 5s）
            const backoff = Math.min(500 * Math.pow(2, Math.min(this.playFailCount - 1, 4)), 5000);
            this._playRetryUntil = Date.now() + backoff;

            if (mediaErr && (mediaErr.code === 3 || mediaErr.code === 4)) {
              if (this.playFailCount === 1 || this.playFailCount % 20 === 0) {
                LOG.warn(`媒体解码失败（code ${mediaErr.code}）：${mediaErr.message || ''}，可能是浏览器不支持该编码`);
              }
              return;
            }
            if (this.playFailCount === 1 || this.playFailCount % 10 === 0) {
              LOG.warn(`播放失败（第 ${this.playFailCount} 次，${Math.round(backoff / 1000 * 10) / 10}s 后重试）：${name} ${(err && err.message) || ''}`);
            }
          });
        }
      } catch (e) { }
    },

    /**
     * 被自动播放策略拦截时的处理：提示一次，并在用户交互后自动恢复。
     *
     * 为什么"过一阵又会恢复"：
     *   浏览器的自动播放策略只认「用户手势」。脚本在 document-start 就监听了
     *   pointerdown / mousedown / keydown / touchstart / **wheel** / click，
     *   所以你哪怕只是滚动一下页面、切回窗口时带了一下滚轮、敲了个键，
     *   都会被记成一次手势 —— 脚本随即重试 play()，于是播放恢复。
     *   也就是说：**恢复不是浏览器自己变宽容了，而是你无意中给了它手势。**
     *
     *   反过来，如果一直没有任何交互，就一直是拦着的（脚本不会空转重试）。
     */
    onAutoplayBlocked(media) {
      this.autoplayBlockCount = (this.autoplayBlockCount || 0) + 1;
      if (this._autoplayWait) return;   // 已有一个等待器挂着，不重复挂、不重复提示

      const active = U.activation.has();
      if (!active && !this._autoplayNotified) {
        this._autoplayNotified = true;
        UI.notice('浏览器拦住了自动播放：请在**视频画面上**点一下。'
          + '（浏览器只认页面内容里的真实点击，点面板上的按钮不算。）点过之后整段课程都不再需要交互。');
      }
      LOG.warn(active
        ? '自动播放被策略拒绝：页面已有用户激活却仍未放行 —— 常见原因：'
          + '① 交互发生在 iframe 内而 play() 在顶层文档；② 浏览器把本站设为「阻止自动播放」。'
        : '自动播放被浏览器的自动播放策略拦截（页面还没有真实用户交互）。');

      this._waitActivationThenRetry(media, active);
    },

    /**
     * 等**用户激活**（或它的变化）后重试 play()；只有真正播起来才解除拦截标记。
     *
     * 判据完全用浏览器原生的 navigator.userActivation，不再自己监听事件：
     *   · hasBeenActive 一旦为 true 就永久为 true，无法区分「这次」与「很久以前」；
     *   · 所以当它本来就已经是 true（说明这次失败不是缺激活造成的）时，
     *     改等 isActive 由 false 变 true —— 那是「刚刚发生了一次真实输入」的信号。
     * 这样既不会立刻重试又失败（死循环刷屏），也不会永远不再尝试。
     */
    _waitActivationThenRetry(media, alreadyActive) {
      this._autoplayWait = true;
      const t0 = Date.now();

      const waitActivation = () => new Promise((resolve) => {
        // 本来没有激活 → 等 hasBeenActive 变 true
        // 本来已有激活 → 等一次「新的」输入（isActive 翻转）
        let armed = false;
        const tick = () => {
          try {
            const ua = navigator.userActivation;
            if (alreadyActive) {
              if (ua && ua.isActive) { resolve(true); return; }
            } else {
              if (ua && (ua.hasBeenActive || ua.isActive)) { resolve(true); return; }
            }
          } catch (e) {
            resolve(true);   // 读不到就不阻塞，直接试一次
            return;
          }
          if (!armed) { armed = true; }   // 至少等一个 tick，避免同刻立即返回
          if (Date.now() - t0 >= 60000) { resolve(false); return; }
          setTimeout(tick, 250);
        };
        setTimeout(tick, 250);
      });

      waitActivation().then((got) => {
        this._autoplayWait = false;
        if (!got) {
          LOG.info('60 秒内没有新的页面交互，暂停自动重试（在视频画面上点一下即可继续）');
          return;
        }
        const m = Player.get() || media;
        if (!m) return;
        LOG.info(`检测到用户交互（等待 ${Math.round((Date.now() - t0) / 1000)} 秒），尝试恢复自动播放…`);
        let pr;
        try { pr = m.play(); } catch (e) { pr = null; }
        if (!pr || !pr.then) return;
        pr.then(() => {
          this.autoplayBlocked = false;
          this._autoplayNotified = false;
          this._autoplayRecoveredAt = Date.now();
          UI.notice('');
          LOG.ok('自动播放已恢复');
        }).catch((e) => {
          const name = (e && e.name) || '';
          // 仍被拦：保持 autoplayBlocked=true（不谎报状态），等下一次交互再试
          this.autoplayBlocked = true;
          LOG.warn(`交互后重试仍失败：${name}。若反复如此，请在浏览器设置里允许本站自动播放。`);
          if (!this._autoplayWait) this._waitActivationThenRetry(m, true);
        });
      });
    },

    /**
     * 合成输入事件，避免站点「长时间无操作」弹窗。
     *
     * 这里派发的是**合成事件**：浏览器不会因此给出用户激活，站点也只当作防挂机信号。
     * 由于脚本判定用户激活完全依赖浏览器原生的 navigator.userActivation
     * （它天然忽略合成事件），所以这些派发不会污染「是否已交互」的判定。
     */
    antiIdle() {
      try {
        U.fireMouse(document, 'mousemove', {
          clientX: Math.round(40 + Math.random() * 60),
          clientY: Math.round(40 + Math.random() * 60),
        });
        const W = (typeof unsafeWindow !== 'undefined' && unsafeWindow) || window;
        const kb = new W.KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Shift', code: 'ShiftLeft' });
        document.dispatchEvent(kb);
      } catch (e) { }
    },

    /** 关闭「还在吗 / 好好学习 / 切屏警告」等遮罩弹窗 */
    dismissPopups() {
      const wraps = document.querySelectorAll('.el-dialog__wrapper, .el-message-box__wrapper, .el-message, .ant-modal-wrap');
      for (const w of wraps) {
        if (!U.visible(w)) continue;
        const t = U.text(w);
        const btns = [...w.querySelectorAll('button, .el-button, [class*=btn]')];
        const hit = (labels) => {
          const b = btns.find((x) => labels.some((l) => U.text(x).includes(l)));
          if (b) { U.click(b); return true; }
          return false;
        };
        if (/继续观看|继续学习|我知道了|知道了|确定|好的/.test(t) && hit(['继续观看', '继续学习', '我知道了', '知道了', '确定', '好的'])) {
          LOG.ok('已关闭挂机提示弹窗');
        } else if (/报告老师|举报/.test(t)) {
          hit(['取消', '关闭']);
          LOG.info('已取消「报告老师」弹窗');
        }
      }
    },

    /** 从 DOM 读取当前小节的学习进度文本
     *  真实页面（2026-10 实测）结构：
     *    · .rate-detail .text           → 「已完成」/ 百分比
     *    · .nav-progress .progress-num  → 「完成度 100%」
     *    · 播放器内 .xt_video_player_current_time_display → 播放时间，不是学习进度
     */
    readProgressText() {
      const sels = [
        '.rate-detail .text',            // 真实站点：本节学习状态
        '.rate-detail',                  // 真实站点
        '.nav-progress .progress-num',   // 真实站点：知识点完成度
        '.progress-wrap .text',          // 旧版 / 仿真环境
        '.progress-wrap',
        '.statistics-box .aside',
        '.leaf-status',
        '.progress-text',
      ];
      for (const s of sels) {
        const el = document.querySelector(s);
        const t = U.text(el);
        if (t) return t;
      }
      // 兜底：从播放器进度条读
      const bar = document.querySelector('.xt_video_player_current_time_display');
      return U.text(bar);
    },

    /** 当前小节进度百分比（0-100），读不到时按播放位置估算 */
    readProgress() {
      if (Api.progressOfCurrentLeaf() >= 100) return 100;
      const text = this.readProgressText();
      if (/已完成|已学完|已看完|完成度\s*100/.test(text)) return 100;
      const pct = U.pct(text);
      if (pct !== null) return pct;
      const m = this.get();
      if (m) {
        const dur = Number(m.duration);
        if (Number.isFinite(dur) && dur > 0) return Math.min(99, Math.round((m.currentTime / dur) * 100));
      }
      return 0;
    },

    /** 完成判定：站点标记 / DOM 文本 / media 结束 / 接口进度，任一成立即可 */
    isDone() {
      const media = this.get();

      // 0) 真实站点在知识点导航里直接标注本节状态（实测：.rate-detail .text = 「已完成」）
      const rateText = U.text(document.querySelector('.rate-detail .text')) || U.text(document.querySelector('.rate-detail'));
      if (/已完成|已学完|已看完|已读/.test(rateText)) return '已完成(站点标记)';
      if (/未完成|未开始|进行中/.test(rateText)) {
        // 站点明确说没完成 → 只信媒体/接口信号，不看其它含糊文案
        if (Api.progressOfCurrentLeaf() >= 100) return '已完成(接口)';
      }

      const text = this.readProgressText();

      // 1) 明确的完成文案
      if (/已完成|已学完|已看完|观看完成|学习完成|已读|完成度\s*100/.test(text)) return '已完成(文案)';

      // 2) 百分比 100%
      const pct = U.pct(text);
      if (pct !== null && pct >= 100) return '已完成(100%)';

      // 3) 接口上报的进度
      if (Api.progressOfCurrentLeaf() >= 100) return '已完成(接口)';

      // 4) 媒体真正播完
      if (media) {
        const dur = Number(media.duration);
        if (media.ended) return '已完成(播放结束)';
        if (Number.isFinite(dur) && dur > 0) {
          if (dur - media.currentTime <= 0.3 && media.currentTime > 0) return '已完成(临近结尾)';
        }
      }
      return false;
    },

  };

  // ============================================================================
  //  模块 3b：接口观测（被动读取站点自己的进度/目录数据，不主动伪造请求）
  // ============================================================================
  const Api = {
    leafProgress: new Map(),   // leaf_id -> 进度百分比
    leafList: null,            // 站点返回的目录结构
    /** 已确认可用的课程活动接口（真站实测） */
    activityPath: '/v2/api/web/logs/learn/',

    hook() {
      const W = (typeof unsafeWindow !== 'undefined' && unsafeWindow) || window;
      const self = this;
      const isInteresting = (u) => typeof u === 'string' && (
        /\/video-log\/(heartbeat|get_video_watch_progress|detail)/.test(u) ||
        /\/video-log\/get_video_watched_record/.test(u) ||
        /\/v2\/api\/web\/logs\/learn\//.test(u) ||
        /\/api\/v3\/lesson|leaf_list|get_leaf|section_leaf|course_chapter|new_classroom/.test(u)
      );

      // ---- fetch ----
      if (typeof W.fetch === 'function' && !W.fetch.__yktPatched) {
        const orig = W.fetch;
        const patched = function (input, init) {
          const url = typeof input === 'string' ? input : (input && input.url) || '';
          const p = orig.apply(this, arguments);
          if (isInteresting(url)) {
            p.then((res) => {
              if (!res || !res.ok) return;
              const ct = res.headers.get('content-type') || '';
              if (!/json|text/.test(ct)) return;
              res.clone().json().then((j) => self.ingest(url, j)).catch(() => { });
            }).catch(() => { });
          }
          return p;
        };
        patched.__yktPatched = true;
        try { W.fetch = patched; } catch (e) { }
      }

      // ---- XMLHttpRequest ----
      if (W.XMLHttpRequest && !W.XMLHttpRequest.__yktPatched) {
        const origOpen = W.XMLHttpRequest.prototype.open;
        const origSend = W.XMLHttpRequest.prototype.send;
        W.XMLHttpRequest.prototype.open = function (method, url) {
          try { this.__yktUrl = url; } catch (e) { }
          return origOpen.apply(this, arguments);
        };
        W.XMLHttpRequest.prototype.send = function () {
          const url = this.__yktUrl;
          if (isInteresting(url)) {
            this.addEventListener('load', function () {
              try {
                const txt = this.responseText;
                if (!txt || txt.length > 3e6) return;
                self.ingest(url, JSON.parse(txt));
              } catch (e) { }
            });
          }
          return origSend.apply(this, arguments);
        };
        W.XMLHttpRequest.__yktPatched = true;
      }
      LOG.info('接口观测已装载（进度/课程活动列表被动读取）');
    },

    /** 从任意可识别的响应中提取有用信息 */
    ingest(url, json) {
      if (!json || typeof json !== 'object') return;
      const data = json.data || json;
      try {
        // 单节进度
        if (/get_video_watch_progress|heartbeat|get_video_watched_record/.test(url)) {
          const leafId = data.leaf_id || data.leafId || data.video_id || (U.route().leafId);
          let pct = data.watch_progress ?? data.progress ?? data.rate ?? null;
          if (pct === null && data.data) pct = data.data.watch_progress;
          if (pct !== null && pct !== undefined && leafId) {
            const v = Number(pct) <= 1 && Number(pct) > 0 ? Number(pct) * 100 : Number(pct);
            this.leafProgress.set(String(leafId), Math.max(0, Math.min(100, v)));
          }
        }

        // ---- 课程活动列表（真站实测：这才是真正给出 leaf_id 的接口）----
        if (/\/v2\/api\/web\/logs\/learn\//.test(url) && Array.isArray(data.activities)) {
          this.absorbActivities(data.activities);
        }

        // 目录结构（兜底：其它版本可能用这些字段名）
        const maybeLeaves = data.section_leaf_list || data.leaf_list
          || (data.course_chapter && data.course_chapter.section_leaf_list);
        if (Array.isArray(maybeLeaves)) {
          this.leafList = maybeLeaves;
          const flat = [];
          const walk = (arr) => arr.forEach((x) => {
            if (!x || typeof x !== 'object') return;
            if (x.leaf_id !== undefined) flat.push(x);
            ['leaf_list', 'section_leaf_list', 'children', 'leaves'].forEach((k) => {
              if (Array.isArray(x[k])) walk(x[k]);
            });
          });
          walk(maybeLeaves);
          if (flat.length) {
            LOG.info(`已从接口获取章节结构，共 ${flat.length} 个小节`);
            Nav.setPlaylistFromApi(flat);
          }
        }
      } catch (e) { }
    },

    /** 吸收活动列表里的 leaf（累积，支持分页） */
    absorbActivities(acts) {
      this.activities = this.activities || new Map();   // leaf_id -> item
      let added = 0;
      for (const a of acts) {
        const c = a && a.content;
        if (!c || c.leaf_id === undefined) continue;
        const id = String(c.leaf_id);
        if (this.activities.has(id)) continue;
        this.activities.set(id, {
          leaf_id: id,
          title: a.title || '',
          type: a.type,
          courseware_id: a.courseware_id,
          score_d: c.score_d,
          is_done: c.is_done !== undefined ? c.is_done : (c.schedule !== undefined ? c.schedule : undefined),
        });
        added++;
      }
      if (added) {
        LOG.info(`已从接口获取 ${added} 个课程项（累计 ${this.activities.size}）`);
      }
    },

    /**
     * 主动拉取完整课程活动列表（分页）。
     * 真站实测：GET /v2/api/web/logs/learn/<教室>?actype=-1&page=N&offset=20&sort=-1
     * 返回字段：data.activities[].content.leaf_id / title / type，data.has_more
     *
     * 这是替代「点击课程卡片」的关键 —— 卡片点了会被站点的鼠标悬浮校验挡掉，
     * 而有了 leaf_id 就能直接构造播放页 URL 跳过去。
     */
    async fetchAllActivities(classroomId, timeoutMs = 25000) {
      const cid = classroomId || U.route().classroomId;
      if (!cid) return null;
      const t0 = Date.now();
      let page = 0;
      let collected = 0;
      for (; page < 60; page++) {
        if (Date.now() - t0 > timeoutMs) {
          LOG.warn('拉取课程列表超时，使用已获取的部分');
          break;
        }
        let j = null;
        try {
          const res = await fetch(`${this.activityPath}${cid}?actype=-1&page=${page}&offset=20&sort=-1`, {
            credentials: 'include',
            headers: { 'Accept': 'application/json' },
          });
          if (!res.ok) { LOG.warn(`课程列表接口返回 ${res.status}`); break; }
          j = await res.json();
        } catch (e) {
          LOG.warn('拉取课程列表失败：' + e.message);
          break;
        }
        const data = (j && j.data) || {};
        const acts = data.activities || [];
        if (!acts.length) break;
        const before = (this.activities && this.activities.size) || 0;
        this.absorbActivities(acts);
        collected += ((this.activities && this.activities.size) || 0) - before;
        if (!data.has_more) break;
      }
      const total = (this.activities && this.activities.size) || 0;
      if (total) {
        const list = [...this.activities.values()].sort((a, b) => Number(a.leaf_id) - Number(b.leaf_id));
        Nav.setPlaylistFromApi(list.map((x) => ({
          leaf_id: x.leaf_id, leaf_type: x.type, title: x.title, is_done: x.is_done,
        })));
        LOG.ok(`课程列表获取完成：共 ${total} 项（${page + 1} 页）`);
      }
      return this.activities;
    },

    progressOfCurrentLeaf() {
      const id = U.route().leafId;
      if (!id) return 0;
      return this.leafProgress.get(String(id)) || 0;
    },
  };
  // ------------------------------ src/03b-speed-bridge.js ------------------------------
  // ============================================================================
  //  模块 3c：倍速点击桥
  //
  //  设计动机（真站实测得出）：
  //    · 直接改 video.playbackRate 虽然真的会 2 倍速播放，但播放器界面仍显示 1.00X，
  //      因为它渲染的是自己的内部变量；而且站点会周期性把它压回 1x。
  //    · 播放器的倍速菜单是 hover 展开的，**合成 MouseEvent 不会触发 CSS :hover**，
  //      所以在页面脚本里点不开、点不到菜单项。
  //    · 唯一「干净」的做法是让浏览器派发真实鼠标输入去点它自己的菜单项 ——
  //      这样站点自己的事件处理函数会把「内部变量 + 界面 + video.playbackRate」一次性设对，
  //      不存在"被外部改写"的痕迹。
  //
  //  因此这里做一个**页面内请求 / 外部执行**的桥：
  //    页面侧：把「请帮我点一下 2.00X」写进一个隐藏 DOM 节点，并轮询结果
  //    外部侧：一个本地小工具（_tools/speed-bridge.js）用 CDP 读指令、
  //            用 Input.dispatchMouseEvent 真实点击、再把结果写回
  //
  //  安全：桥默认关闭，只有本地调试环境需要时才启用；
  //        外部工具只接受白名单动作（点击倍速菜单项），不执行任意代码。
  // ============================================================================
  const SpeedBridge = {
    NODE_ID: '__ykt_speed_bridge__',
    REQ_ATTR: 'data-req',
    RES_ATTR: 'data-res',
    /** 轮询间隔（毫秒） */
    POLL_MS: 700,
    /** 一次请求的最长等待 */
    TIMEOUT_MS: 8000,
    enabled: false,
    done: false,
    tried: 0,
    node: null,
    _timer: null,

    /** 由外部注入或本地调试环境显式启用的开关 */
    enable() {
      if (this.enabled) return;
      this.enabled = true;
      this.install();
      LOG.info('倍速点击桥已启用（外部工具会用真实鼠标点击播放器菜单）');
    },

    install() {
      const mk = () => {
        let el = document.getElementById(this.NODE_ID);
        if (!el) {
          el = document.createElement('div');
          el.id = this.NODE_ID;
          el.style.cssText = 'display:none;position:absolute;width:0;height:0;overflow:hidden';
          el.setAttribute(this.REQ_ATTR, '');
          el.setAttribute(this.RES_ATTR, '');
          (document.body || document.documentElement).appendChild(el);
        }
        this.node = el;
      };
      if (document.body) mk();
      else document.addEventListener('DOMContentLoaded', mk, { once: true });
    },

    nodeRef() {
      if (this.node && this.node.isConnected) return this.node;
      this.node = document.getElementById(this.NODE_ID);
      return this.node;
    },

    get pending() {
      const el = this.nodeRef();
      return !!(el && el.getAttribute(this.REQ_ATTR));
    },

    /**
     * 请求外部用真实鼠标把倍速切到 rate。
     * @returns {Promise<boolean>} 是否成功
     */
    async request(rate) {
      if (!this.enabled) return false;
      const el = this.nodeRef();
      if (!el) return false;

      // 已有未完成的请求 → 不重复发起
      if (this.pending) return false;

      const token = `${Date.now()}-${Math.round(Math.random() * 1e6)}`;
      el.setAttribute(this.REQ_ATTR, JSON.stringify({ token, rate, ts: Date.now() }));
      el.setAttribute(this.RES_ATTR, '');

      const deadline = Date.now() + this.TIMEOUT_MS;
      while (Date.now() < deadline) {
        await U.sleep(this.POLL_MS);
        const node = this.nodeRef();
        if (!node) return false;
        const res = node.getAttribute(this.RES_ATTR);
        if (!res) continue;
        let parsed = null;
        try { parsed = JSON.parse(res); } catch (e) { continue; }
        if (!parsed || parsed.token !== token) continue;
        node.setAttribute(this.REQ_ATTR, '');
        node.setAttribute(this.RES_ATTR, '');
        if (parsed.ok) {
          this.done = true;
          LOG.ok(`已用真实鼠标点击播放器菜单完成倍速切换（${rate}x）`);
        } else {
          LOG.info(`外部点击未成功：${parsed.reason || '未知原因'}`);
        }
        return !!parsed.ok;
      }
      // 超时：清掉请求，避免卡住
      const n2 = this.nodeRef();
      if (n2) n2.setAttribute(this.REQ_ATTR, '');
      LOG.info('倍速点击桥等待超时（外部工具没在运行？）');
      return false;
    },
  };
  // ------------------------------ src/04-nav.js ------------------------------
  // ============================================================================
  //  模块 4/6：导航与自动跳转
  // ============================================================================
  const Nav = {
    playlist: null,   // [{ leaf_id, type, title, done }]
    itemCount: 0,

    // ------------------------------------------------------------ 列表持久化
    loadPlaylist() {
      if (this.playlist && this.playlist.length) return this.playlist;
      try {
        const raw = sessionStorage.getItem('ykt_tool:playlist');
        if (raw) {
          const p = JSON.parse(raw);
          if (Array.isArray(p) && p.length) { this.playlist = p; return p; }
        }
      } catch (e) { }
      return null;
    },
    savePlaylist(list) {
      this.playlist = list;
      try { sessionStorage.setItem('ykt_tool:playlist', JSON.stringify(list)); } catch (e) { }
    },
    /** 课程目录页地址。
     *
     *  原先会先读 localStorage['ykt_tool:visits'] 的历史记录、再回退到构造地址，
     *  但写入方 markVisited() 从未被调用 —— 那个键永远是空的，读取纯属多余。
     *  而构造出的 /v2/web/studentLog/<教室号> 本来就是唯一正确的落点，
     *  所以直接构造，去掉那层无用的历史查询。 */
    lastLogPage() {
      const r = U.route();
      return r.classroomId
        ? `${location.origin}/v2/web/studentLog/${r.classroomId}`
        : `${location.origin}/v2/web/index`;
    },

    // ------------------------------------------------------------ 接口/内联JSON
    /** 从站点内联的 JSON（window 变量或 <script> 内容）中挖出章节结构 */
    setPlaylistFromApi(flat) {
      const list = flat
        .filter((x) => x && x.leaf_id !== undefined)
        .map((x) => ({
          leaf_id: String(x.leaf_id),
          type: Number(x.leaf_type ?? x.type ?? -1),
          title: String(x.title || x.name || x.leaf_title || '').trim(),
          done: !!(x.is_done || x.done || x.finish || x.schedule === 1 || x.is_finish),
        }));
      if (list.length) {
        this.savePlaylist(list);
        LOG.info(`播放列表已建立：${list.length} 个小节`);
      }
    },

    /** 扫描页面内联 JSON，试图找到 leaf_list 结构 */
    scrapeInlineJson() {
      const W = (typeof unsafeWindow !== 'undefined' && unsafeWindow) || window;
      const found = [];
      const tryObj = (o, depth = 0) => {
        if (!o || typeof o !== 'object' || depth > 4) return;
        for (const k of Object.keys(o)) {
          const v = o[k];
          if (Array.isArray(v) && v.length && typeof v[0] === 'object' && v[0] && (v[0].leaf_id !== undefined || v[0].leaf_list)) {
            found.push(...v);
          } else if (v && typeof v === 'object') {
            tryObj(v, depth + 1);
          }
        }
      };
      for (const key of ['__INITIAL_STATE__', '__NUXT__', '__DATA__', 'g_data', 'lessonData', 'courseData', 'yktData']) {
        try { if (W[key]) tryObj(W[key]); } catch (e) { }
      }
      // <script> 内联 JSON
      if (!found.length) {
        for (const s of document.querySelectorAll('script:not([src])')) {
          const t = s.textContent || '';
          if (t.length < 200 || t.length > 2e6) continue;
          if (!/leaf_id/.test(t)) continue;
          const m = t.match(/[{[][\s\S]*[}\]]/);
          if (!m) continue;
          try {
            const parsed = JSON.parse(m[0]);
            const stack = [parsed];
            while (stack.length) {
              const cur = stack.pop();
              if (!cur || typeof cur !== 'object') continue;
              if (Array.isArray(cur)) { cur.forEach((x) => stack.push(x)); continue; }
              if (Array.isArray(cur.leaf_list)) found.push(...cur.leaf_list);
              Object.values(cur).forEach((v) => { if (v && typeof v === 'object') stack.push(v); });
            }
          } catch (e) { }
        }
      }
      const flat = [];
      const walk = (arr) => arr.forEach((x) => {
        if (!x || typeof x !== 'object') return;
        if (x.leaf_id !== undefined) flat.push(x);
        ['leaf_list', 'section_leaf_list', 'children', 'leaves'].forEach((k) => {
          if (Array.isArray(x[k])) walk(x[k]);
        });
      });
      if (found.length) walk(found);
      if (flat.length) this.setPlaylistFromApi(flat);
      return flat.length;
    },

    // ------------------------------------------------------------ 目录页
    /** 解析目录页的学习项列表 */
    parseLogItems() {
      const root = document.querySelector('.logs-list, .viewContainer, .logs-wrap') || document.body;
      let nodes = [...root.querySelectorAll('.content-box')];
      if (!nodes.length) {
        // 兜底：直接找带 h2 标题 + 状态文本的卡片
        nodes = [...root.querySelectorAll('.leaf-list > li, .activity__wrap, .leaf_item, .chapter-item')];
      }
      const items = nodes.map((node, i) => {
        const section = node.querySelector('section') || node;
        const title = U.text(node.querySelector('h2')) || U.text(node) .slice(0, 40) || `第 ${i + 1} 项`;
        const tag = section.querySelector('.tag use')?.getAttribute('xlink:href')
          || section.querySelector('.tag use')?.getAttribute('href') || '';
        const tagText = U.text(section.querySelector('.tag'));
        const statusText = U.text(node.querySelector('.statistics-box .aside'))
          || U.text(node.querySelector('.leaf-item__status'))
          || U.text(node.querySelector('.nav-item-leaf-box__state'))
          || U.text(section.querySelector('.statistics-box'))
          || '';
        // 部分教室用 data-kind / data-type 暴露类型
        const dataKind = (node.getAttribute('data-kind') || node.getAttribute('data-type')
          || section.getAttribute('data-kind') || section.getAttribute('data-type') || '').toLowerCase();
        const typeLabel = `${tag} ${tagText} ${dataKind}`.toLowerCase();
        let kind = 'other';
        if (/shipin|video/.test(typeLabel)) kind = 'video';
        else if (/piliang|batch/.test(typeLabel)) kind = 'batch';
        else if (/kejian|courseware|slide/.test(typeLabel)) kind = 'courseware';
        else if (/kaoshi|zuoye|quiz|exam|homework/.test(typeLabel)) kind = 'exam';
        else if (/ketang|classroom/.test(typeLabel)) kind = 'classroom';
        else if (/tuwen|article|taolun|discuss/.test(typeLabel)) kind = 'article';
        else if (/yinpin|audio/.test(typeLabel)) kind = 'audio';
        const done = U.looksDone(statusText) || U.looksDone(U.text(section.querySelector('.statistics-box')));
        return { index: i, node, section, title, kind, done, statusText, pct: U.pct(statusText) };
      });
      // 类型无法识别时退化为「一切皆可播」
      if (items.length && !items.some((x) => x.kind === 'video')) {
        items.forEach((x) => { if (x.kind === 'other') x.kind = 'unknown'; });
      }
      this.itemCount = items.length;
      return items;
    },

    /** 目录页：找到下一个该刷的项 */
    nextLogItem(items) {
      // 读取「卡住过的小节」黑名单（由 Run 在检测到死循环时写入），避免又把它挑回来
      let stuck = {};
      try { stuck = JSON.parse(sessionStorage.getItem('ykt_tool:stuck') || '{}'); } catch (e) { }
      const isStuck = (it) => {
        const t = stuck[String(it.leafId || '')];
        return t && Date.now() - t < 30 * 60 * 1000;   // 30 分钟内不再选它
      };
      const playable = (x) => x.kind !== 'exam' && x.kind !== 'article';
      const vids = items.filter((x) => x.kind === 'video');
      const pool = vids.length ? vids : items.filter(playable);
      const pending = pool.filter((x) => !x.done && (x.pct === null || x.pct < 100));
      if (!pending.length) return null;
      const fresh = pending.filter((x) => !isStuck(x));
      if (fresh.length) return fresh[0];
      // 全都被拉黑 → 退回第一个未完成的，避免死等
      LOG.warn('所有未完成小节都在「卡住黑名单」里，仍尝试第一个');
      return pending[0];
    },

    /** 目录页：点击某个学习项 */
    clickLogItem(item) {
      const target = item.section || item.node;
      LOG.info(`进入第 ${item.index + 1} 项：${item.title}（${item.kind}，${item.statusText || '未知状态'}）`);
      U.click(target);
      // 雨课堂的卡片点击可能挂在父容器上
      const parent = item.node.querySelector('.content-box') ? item.node : item.node.parentElement;
      if (parent && parent !== target) setTimeout(() => U.click(parent), 60);
    },

    // ------------------------------------------------------------ 播放页
    /** 在播放页的侧边目录里找「当前小节的下一节」
     *  真实站点的知识点列表容器：.learning-space-student-knowledge-nav / .lesson-nav
     */
    nextFromSidebar() {
      const items = [...document.querySelectorAll(
        '.nav-item-leaf-box, .leaf-item, .chapter-leaf-item, .knowledge-item, .lesson-nav-item, [class*=knowledge-item], [class*=nav-item]'
      )];
      if (!items.length) return null;
      const curId = U.route().leafId;
      let idx = items.findIndex((el) => el.classList.contains('is-active')
        || el.classList.contains('active')
        || (curId && el.getAttribute('data-leaf-id') === curId));
      if (idx < 0) {
        const title = U.text(document.querySelector('.video-box .title, .rate-detail, .title'));
        if (title) idx = items.findIndex((el) => U.text(el).includes(title.slice(0, 12)));
      }
      if (idx < 0) return null;
      for (let i = idx + 1; i < items.length; i++) {
        const el = items[i];
        const kind = el.getAttribute('data-kind') || '';
        const t = `${U.text(el)} ${el.getAttribute('data-type') || ''} ${kind}`;
        if (/测验|作业|考试|讨论/.test(t)) { LOG.info(`跳过非视频小节：${U.text(el)}`); continue; }
        return el;
      }
      return null;
    },

    /** 播放页：找「下一节」按钮
     *  真实站点（2026-10 实测）用「下一个知识点」，容器 .nav-footer / .nav-next
     *  注意：到最后一个知识点时该按钮带 .is-disabled 且文字为「暂无」，必须排除
     */
    nextFromButton() {
      // ① 真实站点的知识点导航
      const navNext = document.querySelector('.nav-footer .nav-next, .nav-next');
      if (navNext) {
        const disabled = navNext.classList.contains('is-disabled') || navNext.getAttribute('aria-disabled') === 'true';
        const t = U.text(navNext);
        if (!disabled && !/暂无/.test(t)) return navNext;
      }
      // ② 通用文字匹配（覆盖多种叫法）
      const labels = /^(下一节|下一课|下一讲|下一集|下一个|下一章|下一个知识点|下一个视频|继续学习|继续观看|下一个章节)$/;
      const cands = [...document.querySelectorAll('button, a, div, span, li')]
        .filter((el) => U.visible(el) && el.children.length <= 3)
        .filter((el) => !el.classList.contains('is-disabled'))
        .filter((el) => labels.test(U.text(el)));
      return cands[0] || null;
    },

    /** 播放页：从页面里任意 data-* 属性找下一节提示 */
    nextFromHints() {
      const box = document.querySelector('.video-box, [data-next-leaf], [data-next-leaf-id]');
      if (box) {
        const nid = box.getAttribute('data-next-leaf') || box.getAttribute('data-next-leaf-id');
        if (nid) {
          const r = U.route();
          return `${location.origin}/ai-workspace/lms-graph/${r.classroomId}/${r.type || 'video'}/${nid}`;
        }
      }
      return null;
    },

    /** 从接口/页面拿到的播放列表推算下一节
     *  真站实测：课程活动接口返回 80 个 leaf（type 17=视频、16=图文、19=作业），
     *  leaf_id 数值本身即课程顺序，因此按 leaf_id 排序后取下一个视频即可，
     *  完全不需要点击课程卡片（卡片点击会被站点的鼠标悬浮校验挡掉）。 */
    nextFromPlaylist() {
      const list = this.loadPlaylist();
      if (!list || !list.length) return null;
      const cur = String(U.route().leafId);
      const sorted = [...list].sort((a, b) => Number(a.leaf_id) - Number(b.leaf_id));
      const idx = sorted.findIndex((x) => String(x.leaf_id) === cur);
      if (idx < 0) return null;
      for (let i = idx + 1; i < sorted.length; i++) {
        const it = sorted[i];
        const t = Number(it.type ?? it.leaf_type);
        // 只跳视频类；图文/作业/讨论交给后续逻辑跳过
        if (t !== 17) { LOG.info(`跳过非视频小节（type=${t}）：${String(it.title || '').slice(0, 24)}`); continue; }
        const r = U.route();
        if (!r.classroomId) continue;
        return `${location.origin}/ai-workspace/lms-graph/${r.classroomId}/video/${it.leaf_id}?is_chapter=1`;
      }
      return null;
    },

    /** 统一的「下一节」动作；返回 true 表示确实发起了跳转，false 表示已无下一个节点 */
    async goNext(reason) {
      // ① 首选：用播放列表（接口拿到的 leaf_id）直接跳 URL —— 最可靠，不依赖任何 DOM 点击
      const fromList = this.nextFromPlaylist();
      if (fromList) {
        LOG.ok(`自动跳转下一节（${reason}）→ ${fromList.replace(location.origin, '').slice(0, 70)}`);
        location.href = fromList;
        return true;
      }
      // ② 页面上的提示属性
      const hint = this.nextFromHints();
      if (hint) {
        LOG.ok(`自动跳转下一节（页面提示）→ ${hint.slice(0, 70)}`);
        location.href = hint;
        return true;
      }
      // ③ 站点自己的「下一个知识点」按钮（到最后一个知识点时为 disabled）
      const btn = this.nextFromButton();
      if (btn) {
        LOG.ok(`自动跳转下一节（按钮：${U.text(btn)}）`);
        U.click(btn);
        return true;
      }
      // ④ 侧边目录
      const side = this.nextFromSidebar();
      if (side) {
        LOG.ok(`自动跳转下一节（侧边目录：${U.text(side).slice(0, 30)}）`);
        U.click(side);
        return true;
      }
      LOG.warn('未找到下一节的任何入口（可能是本章最后一个知识点）');
      return false;
    },
  };
  // ------------------------------ src/05-ui.js ------------------------------
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
              <label class="chk"><input type="checkbox" id="c-ff" ${CFG.fastForward ? 'checked' : ''}>快进到结尾</label>
            </div>
            <button class="go" id="btn-go">开始刷课</button>
            <div class="notice" id="notice" hidden></div>
            <div class="hd2"><span>运行日志</span><span id="s-guard">守卫就绪</span></div>
            <div class="log" id="log"></div>
            <div class="row" style="gap:6px">
              <button class="mini" id="btn-verify" style="flex:1">自检并复制结果</button>
              <button class="mini" id="btn-diag" style="flex:1">复制诊断信息</button>
            </div>
            <div class="row" style="gap:6px; margin-top:6px">
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
        segRate: q('seg-rate'), cBg: q('c-bg'), cNext: q('c-next'), cFf: q('c-ff'),
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
      bind(this.els.cFf, 'fastForward');

      this.els.go.addEventListener('click', () => Run.toggle());
      this.els.min.addEventListener('click', () => this.toggleCollapse());
      const diagBtn = sh.getElementById('btn-diag');
      if (diagBtn) diagBtn.addEventListener('click', () => this.copyDiag(diagBtn));
      const verifyBtn = sh.getElementById('btn-verify');
      if (verifyBtn) verifyBtn.addEventListener('click', () => this.runVerify(verifyBtn));
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
        `cfg        : rate=${CFG.rate} background=${CFG.background} autoNext=${CFG.autoNext}`,
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

    /**
     * 一键自检：在真实站点上跑完整验证，把结论写进日志并复制到剪贴板。
     * 这是「不需要外部工具也能验证」的手段 —— 免去开调试端口/装额外程序。
     */
    async runVerify(btn) {
      const old = btn ? btn.textContent : '';
      if (btn) { btn.textContent = '自检中…'; btn.disabled = true; }
      LOG.info('开始自检（约 3 秒）…');
      let text = '';
      try {
        text = await Verify.report();
      } catch (e) {
        text = '自检过程出错：' + (e && e.message);
      }

      // 结论写进面板日志，方便直接看到
      const { fail, pass, warn } = (() => {
        const m = text.match(/通过 (\d+) \/ 失败 (\d+) \/ 提示 (\d+)/);
        return m ? { pass: +m[1], fail: +m[2], warn: +m[3] } : { pass: 0, fail: 0, warn: 0 };
      })();
      text.split('\n').filter((l) => /^[✓✗·]/.test(l)).forEach((l) => {
        if (l.startsWith('✗')) LOG.warn(l);
        else if (l.startsWith('✓')) LOG.ok(l);
        else LOG.info(l);
      });
      LOG[fail === 0 ? 'ok' : 'warn'](`自检完成：通过 ${pass} / 失败 ${fail} / 提示 ${warn}`);

      // 复制到剪贴板
      let copied = false;
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(text);
          copied = true;
        }
      } catch (e) { copied = false; }
      if (!copied) {
        try {
          const ta = document.createElement('textarea');
          ta.value = text;
          ta.style.cssText = 'position:fixed;opacity:0';
          document.body.appendChild(ta);
          ta.select();
          copied = document.execCommand('copy');
          ta.remove();
        } catch (e) { copied = false; }
      }
      if (!copied) console.log(text);
      LOG.info(copied ? '自检结果已复制到剪贴板，直接粘贴反馈即可' : '剪贴板不可用，结果已输出到控制台（F12）');

      if (btn) {
        btn.disabled = false;
        btn.textContent = copied ? (fail === 0 ? '✓ 通过，已复制' : `✗ ${fail} 项失败，已复制`) : '结果见控制台';
        setTimeout(() => { btn.textContent = old; }, 3000);
      }
    },
  };
  // ------------------------------ src/06-run-body.js ------------------------------
  // ============================================================================
  //  模块 6/6：运行控制器（状态机 + 自动跳转 + 后台保活循环）
  // ============================================================================
  const Run = {
    running: false,
    phase: 'idle',
    lastProgressAt: Date.now(),
    lastPos: 0,
    watched: 0,
    doneReason: '',
    startedAt: 0,
    /** 连续进入同一小节的次数，用于防止「本节已完成但找不到下一节」时原地死循环 */
    sameLeafStreak: 0,
    lastLeafVisited: '',

    // ------------------------------------------------------------ 启停
    start(reason = '手动') {
      if (this.running) return;
      this.running = true;
      this.startedAt = Date.now();
      this.lastProgressAt = Date.now();
      this.watched = 0;
      UI.setRunning(true);
      LOG.ok(`▶ 开始刷课（${reason}）`);
      this.loop().catch((e) => LOG.warn('主循环异常：' + (e && e.message)));
      this.keepAliveLoop();
    },

    stop(reason = '手动') {
      if (!this.running) return;
      this.running = false;
      UI.setRunning(false);
      const m = Player.get();
      if (m) Guard.pause(m);
      LOG.info(`⏹ 已停止（${reason}）`);
    },

    toggle() { this.running ? this.stop() : this.start(); },

    // ------------------------------------------------------------ 保活循环
    keepAliveLoop() {
      if (this._kaTimer) return;
      let i = 0;
      this._kaTimer = setInterval(() => {
        if (!this.running) { clearInterval(this._kaTimer); this._kaTimer = null; return; }
        const m = Player.get();
        if (m) {
          // ① 倍速：只通过「真实点击播放器菜单」设置（见 syncSpeedUi 的说明）
          if (i % 2 === 0) this.syncSpeedUi(m);
          // ② 续播（防后台暂停；脚本不碰音量/静音）
          if (CFG.background) Player.keepAlive(m);
          // ③ 统计已观看时长，用于卡死告警（seek 造成的大跳变不计入）
          const pos = Number(m.currentTime || 0);
          const delta = pos - this.lastPos;
          if (!m.paused && delta > 0 && delta < 3) this.watched += delta;
          this.lastPos = pos;
          if (!m.paused) this.lastProgressAt = Date.now();
        }
        // ⑤ 合成输入，防挂机弹窗
        if (++i % 12 === 0) {
          Player.antiIdle();
          Player.dismissPopups();
          try { navigator.mediaSession && (navigator.mediaSession.playbackState = 'playing'); } catch (e) { }
        }
        // ⑥ 面板数据
        if (i % 4 === 0) UI.updateStats({ prog: Player.readProgress() });
      }, CFG.tickMs);
    },

    // ------------------------------------------------------------ 主循环
    async loop() {
      while (this.running) {
        const r = U.route();
        if (r.isPlayPage) await this.runPlayPage(r);
        else if (r.isLogPage) await this.runLogPage(r);
        else {
          UI.updateStats({ page: '未知页' });
          await U.sleep(2000);
          if (!r.classroomId) { this.stop('当前页面不受支持'); return; }
        }
      }
    },

    // ---------------------------------------------------- 目录页流程
    async runLogPage(r) {
      UI.updateStats({ page: '课程目录' });
      this.phase = 'log';

      // 首选：用接口拿完整课程列表（含 leaf_id），这样可以直接跳 URL，
      // 不需要点击课程卡片 —— 真站实测卡片点击会被站点的鼠标悬浮校验挡掉。
      LOG.info('正在通过接口获取课程列表…');
      const acts = await Api.fetchAllActivities(r.classroomId);
      const fromApi = acts && acts.size;

      if (!fromApi) {
        // 接口拿不到才退回 DOM 解析
        LOG.warn('接口未返回课程列表，改用页面解析');
        for (let i = 0; i < 6; i++) {
          const c = document.querySelector('.viewContainer, .logs-list, .logs-wrap');
          if (c) c.scrollTop = c.scrollHeight;
          window.scrollTo(0, document.body.scrollHeight);
          await U.sleep(400);
        }
        Nav.scrapeInlineJson();
      }

      // 读取「卡住黑名单」，避免又选回进不去的小节
      let stuck = {};
      try { stuck = JSON.parse(sessionStorage.getItem('ykt_tool:stuck') || '{}'); } catch (e) { }
      const isStuck = (id) => {
        const t = stuck[String(id)];
        return t && Date.now() - t < 30 * 60 * 1000;
      };

      if (fromApi) {
        // ---- 接口模式：直接构造下一节的 URL ----
        const playlist = Nav.loadPlaylist() || [];
        const done = playlist.filter((x) => x.done || x.done === undefined ? false : true).length;
        LOG.info(`课程列表：共 ${playlist.length} 项`);

        const next = playlist.find((x) => {
          // 视频类（type 17）才自动刷；图文(16)/作业(19)跳过
          if (Number(x.type) !== 17 && Number(x.leaf_type) !== 17) return false;
          if (isStuck(x.leaf_id)) return false;
          // 已完成的不再进入（接口没给完成状态时按顺序走，由播放页自行判定）
          const p = Api.leafProgress.get(String(x.leaf_id));
          if (p !== undefined && p >= 100) return false;
          return true;
        });

        if (!next) {
          LOG.ok('🎉 课程列表中已无可刷的视频小节');
          this.stop('全部完成');
          return;
        }
        const target = `${location.origin}/ai-workspace/lms-graph/${r.classroomId}/video/${next.leaf_id}?is_chapter=1`;
        LOG.ok(`接口模式：直接进入 leaf=${next.leaf_id} 「${String(next.title || '').slice(0, 30)}」`);
        try { sessionStorage.setItem('ykt_tool:auto', '1'); } catch (e) { }
        location.href = target;
        await U.sleep(2500);
        return;
      }

      // ---- DOM 模式（兜底）：点击课程卡片 ----
      const items = Nav.parseLogItems();
      LOG.info(`目录页共解析到 ${items.length} 个学习项`);
      if (!items.length) {
        LOG.warn('未解析到学习项，2 秒后重试');
        await U.sleep(2000);
        return;
      }
      const total = items.length;
      const doneCount = items.filter((x) => x.done).length;
      UI.updateStats({ page: `目录 ${doneCount}/${total}`, prog: Math.round((doneCount / total) * 100) });

      const nextItem = Nav.nextLogItem(items);
      if (!nextItem) {
        LOG.ok('🎉 本章节所有可刷项目均已完成');
        this.stop('全部完成');
        return;
      }
      Nav.clickLogItem(nextItem);
      const entered = await U.until(() => U.route().isPlayPage, { timeout: 12000, interval: 400, label: '进入播放页' });
      if (!entered) {
        LOG.warn('点击课程卡片后页面未跳转（真站已知问题：站点校验鼠标悬浮），'
          + '已记录该小节并换一项；若接口可用则不会走这条路');
        try {
          const st = JSON.parse(sessionStorage.getItem('ykt_tool:stuck') || '{}');
          st[String(nextItem.leafId || nextItem.index)] = Date.now();
          sessionStorage.setItem('ykt_tool:stuck', JSON.stringify(st));
        } catch (e) { }
        await U.sleep(1500);
        return;
      }
      await U.sleep(800);
    },

    // ---------------------------------------------------- 播放页流程
    async runPlayPage(r) {
      this.phase = 'play';
      this.lastProgressAt = Date.now();
      this.watched = 0;
      this.lastPos = 0;

      // 死循环保护：如果连续进入同一个小节，说明「进不去/出不来」，必须跳出。
      // 真站实测过的两种卡死场景：
      //   ① 本节已完成，但「下一个知识点」是 disabled（暂无）→ 点不动
      //   ② 点击目录项后页面没真正切换，脚本又回到同一节
      if (this.lastLeafVisited === String(r.leafId)) {
        this.sameLeafStreak++;
      } else {
        this.lastLeafVisited = String(r.leafId);
        this.sameLeafStreak = 1;
      }
      if (this.sameLeafStreak > 2) {
        LOG.warn(`同一小节（${r.leafId}）已连续进入 ${this.sameLeafStreak} 次，判定卡住 → 返回课程目录换一节`);
        this.sameLeafStreak = 0;
        this.lastLeafVisited = '';
        try { sessionStorage.removeItem('ykt_tool:auto'); } catch (e) { }
        // 记录「不要再选这一节」，避免目录页又把它挑回来
        try {
          const stuck = JSON.parse(sessionStorage.getItem('ykt_tool:stuck') || '{}');
          stuck[String(r.leafId)] = Date.now();
          sessionStorage.setItem('ykt_tool:stuck', JSON.stringify(stuck));
        } catch (e) { }
        location.href = Nav.lastLogPage();
        await U.sleep(3000);
        return;
      }

      // 额外保护：如果同一节停留过久且进度一直不动，也强制换一节
      if (this._stuckWatchLeaf === String(r.leafId) && Date.now() - (this._stuckWatchAt || 0) > 5 * 60 * 1000) {
        LOG.warn(`本节停留超过 5 分钟且无进展，强制跳下一节`);
        this._stuckWatchLeaf = '';
        const moved = await Nav.goNext('超时强制');
        if (moved) { await U.sleep(2000); return; }
      }
      if (this._stuckWatchLeaf !== String(r.leafId)) {
        this._stuckWatchLeaf = String(r.leafId);
        this._stuckWatchAt = Date.now();
      }

      const title = U.text(document.querySelector('.video-box .title, .title')) || r.leafId;
      UI.updateStats({ page: '学习中', prog: Player.readProgress() });

      // 非视频小节（测验/作业）直接跳过，避免把时间浪费在无法自动完成的内容上
      const headText = U.text(document.querySelector('.video-box, .main-content, #app')).slice(0, 400);
      if (/测验|作业|考试|讨论区|主观题/.test(headText) && !document.querySelector('video, audio')) {
        LOG.info('当前小节为测验/作业类，已跳过');
        await Nav.goNext('跳过非视频');
        await U.sleep(1500);
        return;
      }

      LOG.info(`开始学习：${title}`);
      const ok = await U.until(() => Player.pick(), { timeout: 25000, interval: 300, label: '等待媒体元素' });
      if (!ok) {
        LOG.warn('未找到视频元素，尝试返回目录页');
        await U.sleep(1500);
        if (!Player.get()) { location.href = Nav.lastLogPage(); await U.sleep(1500); }
        return;
      }
      const media = Player.get();
      Player.bindRateGuard(media);
      Player.keepAlive(media);
      this.syncSpeedUi(media);

      // ---- 等待本节完成 ----
      const deadline = Date.now() + CFG.itemTimeout;
      let lastReport = 0;
      while (this.running && Date.now() < deadline) {
        const m = Player.get();
        if (m) {
          if (CFG.background) Player.keepAlive(m);
          if (CFG.fastForward) this.maybeFastForward(m);
        }
        const prog = Player.readProgress();
        UI.updateStats({ prog });
        const done = Player.isDone();
        if (done) { this.doneReason = done; break; }
        // 进度长时间不动的告警
        if (Date.now() - this.lastProgressAt > 60000 && Date.now() - lastReport > 60000) {
          lastReport = Date.now();
          const m2 = Player.get();
          LOG.warn(`已 ${Math.round((Date.now() - this.lastProgressAt) / 1000)}s 无播放进展`
            + `（进度 ${prog}%，媒体 ${m2 ? (m2.paused ? '暂停' : '播放中') : '无'}）`);
          if (m2 && m2.paused && CFG.background) Player.keepAlive(m2);
        }
        await U.sleep(CFG.pollMs);
      }

      if (!this.running) return;

      if (Date.now() >= deadline) {
        LOG.warn('本节等待超时，跳过');
      } else {
        LOG.ok(`✅ 本节完成（依据：${this.doneReason}），累计观看约 ${Math.round(this.watched)}s`);
      }

      // ---- 自动跳转下一节 ----
      if (CFG.autoNext) {
        this.phase = 'next';
        try { sessionStorage.setItem('ykt_tool:auto', '1'); } catch (e) { }
        try { sessionStorage.setItem('ykt_tool:lastLeaf', r.leafId); } catch (e) { }
        await U.sleep(800);
        const moved = await Nav.goNext('播放列表');
        if (!moved) {
          LOG.info('本节已无下一个节点，返回课程目录继续下一章');
          try { sessionStorage.removeItem('ykt_tool:auto'); } catch (e) { }
          location.href = Nav.lastLogPage();
        }
        await U.sleep(2000);
      } else {
        LOG.info('自动跳转已关闭，停留当前页');
        this.stop('本节完成');
      }
    },

    /** 剩余不多时跳到最后，加快刷课（可选，默认关闭） */
    maybeFastForward(m) {
      const dur = Number(m.duration);
      if (!Number.isFinite(dur) || dur <= 5) return;
      if (m.currentTime / dur >= CFG.fastForwardAt && dur - m.currentTime > 5) {
        m.currentTime = Math.max(0, dur - 1.5);
        LOG.info('已快进至结尾');
      }
    },

    /** 把播放器倍速切到目标值。
     *
     *  策略（按可靠性排序）：
     *    ① 直接点击播放器自带菜单项 —— 走站点自己的事件处理，内部变量/界面/媒体一起更新，
     *       不依赖任何外部工具，用户装上就能用。
     *    ② 若点了两次仍无效（站点可能改了菜单实现），且外部桥可用，则改用真实鼠标点击
     *       （CDP 输入层，绕过合成事件的一切限制）。
     *    ③ 都不行就如实告知用户，不做"偷偷改值"这种会被站点回滚的兜底。
     *
     *  判据只看 media.playbackRate：播放器界面标签会被站点周期性刷回 1.00X，
     *  那是它自身的显示行为，不代表倍速没生效。 */
    syncSpeedUi(m) {
      if (!m || CFG.rate <= 1) return;
      if (Math.abs(Number(m.playbackRate) - CFG.rate) < 0.01) return;

      const key = `${String(U.route().leafId)}|${Player.mediaTagOf(m)}`;
      if (this._speedUiKey !== key) {
        this._speedUiKey = key;
        this._speedTries = 0;
        this._speedBridgeAt = 0;
        this._speedBridgeBusy = false;
      }
      if ((this._speedTries || 0) >= 2 && Date.now() - (this._speedLastTry || 0) < 5000) return;
      if (Date.now() - (this._speedLastTry || 0) < 1500) return;
      this._speedLastTry = Date.now();
      this._speedTries = (this._speedTries || 0) + 1;

      // ① 自己点菜单
      const clicked = Player.clickNativeSpeedOption();
      if (clicked) {
        if (this._speedTries === 1) LOG.info(`已点击播放器倍速菜单（目标 ${CFG.rate}x），等待生效…`);
        setTimeout(() => {
          const cur = Player.get();
          if (cur && Math.abs(Number(cur.playbackRate) - CFG.rate) < 0.01) {
            LOG.ok(`倍速已通过播放器菜单切到 ${CFG.rate}x`);
            this._speedTries = 0;
          } else if (this._speedTries >= 2) {
            LOG.warn('直接点击播放器菜单未生效');
            this._tryBridgeOrWarn();
          }
        }, 1600);
        return;
      }

      // ② 点不到就交给外部桥
      this._tryBridgeOrWarn();
    },

    /** 菜单点击失败时的后续处理：能用桥就用桥，否则给出明确提示 */
    _tryBridgeOrWarn() {
      if (SpeedBridge.enabled) {
        if (this._speedBridgeBusy) return;
        if (Date.now() - (this._speedBridgeAt || 0) < 10000) return;
        this._speedBridgeAt = Date.now();
        this._speedBridgeBusy = true;
        SpeedBridge.request(CFG.rate).then((ok) => {
          this._speedBridgeBusy = false;
          if (ok) { this._speedTries = 0; LOG.ok('已通过真实鼠标点击完成倍速切换'); }
        });
        return;
      }
      if (!this._warnedNoBridge) {
        this._warnedNoBridge = true;
        LOG.warn('无法设置播放器倍速：菜单点击未生效。可选方案：'
          + '① 等一节播放完、下次进入时重试；'
          + '② 开启倍速点击桥（控制台执行 localStorage.setItem("ykt_tool:speedBridge","true") 后刷新，'
          + '并运行 node _tools\\speed-bridge.js）');
      }
    },
  };

  // ============================================================================
  //  启动
  // ============================================================================
  const Boot = {
    init() {
      // ① 最早：装载守卫（必须早于站点脚本注册监听）
      //    注意：iframe 内的播放器同样需要守卫与倍速，否则后台照样被暂停
      try { Guard.install(); } catch (e) { console.error('[刷课助手] 守卫装载失败', e); }
      // 用户激活状态由浏览器原生维护（navigator.userActivation），无需自己监听事件
      try { Api.hook(); } catch (e) { }

      // ② 恢复用户设置
      ['rate', 'background', 'autoNext', 'fastForward', 'speedBridge'].forEach((k) => {
        const v = STORE.get(k, undefined);
        if (v !== undefined) CFG[k] = v;
      });

      // 倍速点击桥按需启用
      if (CFG.speedBridge) {
        try { SpeedBridge.enable(); } catch (e) { }
      }

      const isTop = !U.inIframe();
      Guard.log(`脚本已在${isTop ? '顶层文档' : 'iframe'}启动：${location.href.slice(0, 120)}`);

      // ③ iframe 内：只做「播放器保护」，不做导航（导航由顶层文档负责），也不挂面板
      if (!isTop) {
        const protect = () => {
          const m = Player.get();
          if (!m) return;
          Player.bindRateGuard(m);
          if (CFG.background) Player.keepAlive(m);
          // iframe 内也走同一套倍速点击桥（真实点击菜单），不做外层改值
          if (SpeedBridge.enabled && Player.speedUiMatches() !== true) {
            if (!this._frameBridgeAt || Date.now() - this._frameBridgeAt > 10000) {
              this._frameBridgeAt = Date.now();
              SpeedBridge.request(CFG.rate).catch(() => { });
            }
          }
        };
        setInterval(() => {
          protect();
          Player.antiIdle();
          Player.dismissPopups();
        }, CFG.tickMs);
        if (document.readyState === 'loading') {
          document.addEventListener('DOMContentLoaded', protect, { once: true });
        } else {
          protect();
        }
        try { window.dispatchEvent(new CustomEvent('ykt-tool:ready', { detail: { version: YKT.version, frame: 'iframe' } })); } catch (e) { }
        return;
      }

      // ④ 顶层文档：DOM 就绪后挂面板 + 自动开始
      const onReady = () => {
        try { UI.mount(); } catch (e) { console.error(e); }
        try { Nav.scrapeInlineJson(); } catch (e) { }
        UI.updateStats({ page: U.route().isPlayPage ? '学习中' : '课程目录' });

        const auto = STORE.get('autoStart', true);
        const cont = (() => { try { return sessionStorage.getItem('ykt_tool:auto') === '1'; } catch (e) { return false; } })();

        // 自动开始的判定必须「允许迟到」：
        //   真站（实测）在 DOMContentLoaded 时还没有 <video>，是之后由 SPA 创建并挂载播放器的。
        //   所以这里不能只看一次，要在短时间内反复确认。
        //   同时要排除真站那种「没有视频的空 iframe」（/pro/lms/.../studycontent 外壳），
        //   否则会在里面空转。
        if (!auto) { LOG.info('自动开始已在设置中关闭，可点面板「开始刷课」手动启动'); return; }
        let chosen = false;
        let waited = 0;
        const decide = () => {
          if (chosen || Run.running) return true;
          const r = U.route();
          const hasMedia = !!document.querySelector('video, audio');
          // 明确是目录页 → 直接开始
          if (r.isLogPage) {
            chosen = true;
            Run.start(cont ? '接力上一节' : '自动启动');
            return true;
          }
          // 出现媒体元素 → 说明播放器已挂载，可以接管
          if (hasMedia) {
            chosen = true;
            Run.start(cont ? '接力上一节' : '检测到视频，自动接管');
            return true;
          }
          // 其余情况（例如没有视频的 iframe 外壳）继续等，直到超时
          return false;
        };

        if (!decide()) {
          const timer = setInterval(() => {
            waited += 1000;
            if (decide() || waited > 30000) {
              clearInterval(timer);
              if (!chosen) {
                LOG.info('30 秒内未发现视频元素，未自动开始；进入视频小节或点面板「开始刷课」即可');
              }
            }
          }, 1000);
          LOG.info('等待播放器挂载（最多 30 秒）…');
        }
      };
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', onReady, { once: true });
      } else {
        onReady();
      }

      // ④ 暴露只读诊断接口，便于排查（也供外部工具观测）
      try {
        Object.defineProperty(window, '__yktTool', {
          configurable: true, enumerable: false,
          value: {
            version: YKT.version,
            /** 一键自检（返回可复制的纯文本报告） */
            verify: () => Verify.report(),
            /** 只跑检查、返回结构化结果 */
            verifyResults: () => Verify.run(),
            config: CFG,
            get state() {
              const m = Player.get();
              const r = U.route();
              return {
                version: YKT.version,
                route: r,
                running: Run.running,
                phase: Run.phase,
                doneReason: Run.doneReason,
                sameLeafStreak: Run.sameLeafStreak,
                rate: m ? m.playbackRate : null,
                paused: m ? m.paused : null,
                ended: m ? m.ended : null,
                muted: m ? m.muted : null,
                readyState: m ? m.readyState : null,
                networkState: m ? m.networkState : null,
                currentTime: m ? m.currentTime : null,
                duration: m ? Number(m.duration) : null,
                mediaTag: m ? m.tagName + (m.id ? '#' + m.id : '') : null,
                error: m && m.error ? { code: m.error.code, message: m.error.message } : null,
                playFailCount: Player.playFailCount || 0,
                autoplayBlocked: !!Player.autoplayBlocked,
                autoplayBlockCount: Player.autoplayBlockCount || 0,
                autoplayRecoveredAt: Player._autoplayRecoveredAt || null,
                userActivation: U.activation.describe(),
                rateFixCount: Player.rateFixCount || 0,
                rateStats: Player.rateStats(),
                progress: Player.readProgress(),
                guard: {
                  active: Guard.active,
                  blockedEvents: Guard.stats.blockedEvents,
                  blockedPause: Guard.stats.blockedPause,
                  fakeReads: Guard.stats.fakeReads,
                  seenEvents: [...Guard.seenEvents],
                  selfTest: Guard.selfTest,
                  notes: Guard.stats.notes.slice(-8),
                },
                boot: { hidden: document.hidden, vis: document.visibilityState, focus: document.hasFocus() },
              };
            },
            start: (why) => Run.start(why || '外部调用'),
            stop: (why) => Run.stop(why || '外部调用'),
            next: () => Nav.goNext('外部调用'),
          },
        });
      } catch (e) { }

      // ⑤ 通知主世界（供外部工具观测）
      try {
        window.dispatchEvent(new CustomEvent('ykt-tool:ready', { detail: { version: YKT.version } }));
      } catch (e) { }
    },
  };
  // ------------------------------ src/07-verify.js ------------------------------
  // ============================================================================
  //  模块 7：自检（在真实站点上一键跑完整验证，结果直接显示 + 可复制）
  // ============================================================================
  //
  //  为什么要有它：真实站点需要登录态，外部工具不一定能连上浏览器
  //  （Edge 在默认配置目录上禁止开启调试端口）。把验证做进脚本本身，
  //  你在面板上点一下就能得到全部结论，也能一键复制发给别人排查。
  //
  const Verify = {
    results: [],

    reset() { this.results = []; },

    add(name, ok, detail) {
      this.results.push({ name, ok: ok === null ? null : !!ok, detail: detail === undefined ? '' : String(detail) });
      return ok;
    },

    /** 跑完整自检，返回 { pass, fail, warn, lines } */
    async run() {
      this.reset();
      const r = U.route();
      const m = Player.get();

      // ---------- 1. 基础环境 ----------
      this.add('脚本已注入（顶层文档）', !U.inIframe(), U.inIframe() ? '当前在 iframe 内，请到顶层页面运行' : location.pathname);
      this.add('页面类型识别', r.isPlayPage || r.isLogPage,
        r.isPlayPage ? `播放页 (leaf=${r.leafId || '?'})` : r.isLogPage ? '课程目录页' : `未识别：${location.pathname}`);
      this.add('教室号识别', !!r.classroomId, r.classroomId || '未识别到教室号');

      // ---------- 2. 播放器接管 ----------
      this.add('已捕获播放器媒体元素', !!m, m ? `${m.tagName}${m.id ? '#' + m.id : ''}` : '未找到 video/audio');

      if (m) {
        const rate = Number(m.playbackRate);
        this.add(`倍速已锁定为 ${CFG.rate}x`, Math.abs(rate - CFG.rate) < 0.01,
          `playbackRate=${rate}`);

        const uiMatches = Player.speedUiMatches();
        const uiVal = Player.speedUiValue();
        this.add('播放器界面倍速与目标一致', uiMatches === true,
          uiVal === null ? '读不到界面倍速（不影响实际播放）' : `界面显示 ${uiVal}X`);

        // 站点内部值（能读到就一并报告，读不到不算失败）
        let optVal = null;
        try {
          const root = document.querySelector('.xt_video_player_container, .xtplayer, .video-box');
          const p = root && root.__vue__ && root.__vue__.$data && root.__vue__.$data.player;
          optVal = p && p.options && p.options.speed ? p.options.speed.value : null;
        } catch (e) { }
        if (optVal !== null) {
          this.add('站点内部倍速值一致', Math.abs(Number(optVal) - CFG.rate) < 0.01, `内部值=${optVal}`);
        } else {
          this.add('站点内部倍速值一致', null, '读不到内部值（正常，不同播放器版本结构不同）');
        }

        this.add('视频正在播放', !m.paused, m.paused ? `paused=true（playFail=${Player.playFailCount || 0}）` : `currentTime=${m.currentTime.toFixed(1)}`);

        // ---------- 3. 自动播放策略 ----------
        const blocked = !!Player.autoplayBlocked;
        this.add('未被自动播放策略拦截', !blocked,
          blocked ? '被拦截：请在本页点一下即可恢复' : `用户激活=${U.activation.has()}`);
        const ua = U.activation.describe();
        this.add('用户激活状态（浏览器原生判定）', null,
          `hasBeenActive=${ua.hasBeenActive} isActive=${ua.isActive}`);

        // ---------- 4. 真实推进（1.5 秒观察） ----------
        const t0 = Number(m.currentTime);
        const paused0 = m.paused;
        await U.sleep(1500);
        const t1 = Number(m.currentTime);
        const advanced = t1 - t0;
        const expect = paused0 ? 0 : 1.5 * CFG.rate;
        this.add('播放进度真实推进（2 倍速生效）', paused0 ? null : advanced > expect * 0.5,
          `1.5 秒内前进 ${advanced.toFixed(2)} 秒（${CFG.rate}x 预期约 ${expect.toFixed(1)} 秒）`);
      }

      // ---------- 5. 完成判定信号 ----------
      const txt = Player.readProgressText ? Player.readProgressText() : null;
      this.add('站点完成标记可读', true, txt || '（当前页面没有该标记）');
      const pct = Player.readProgress();
      this.add('本节进度可读', pct !== null && pct !== undefined, `${pct}%`);

      // ---------- 6. 后台守卫 ----------
      const st = Guard.selfTest || {};
      this.add('后台守卫已装载', !!Guard.active,
        `拦截事件=${Guard.stats.blockedEvents} 拦截pause=${Guard.stats.blockedPause} 伪造读取=${Guard.stats.fakeReads}`);
      this.add('事件拦截自检通过（切屏/失焦无法送达站点）', st.ok === true,
        st.ok === undefined ? '未执行' : `原生投递可达=${st.rawDelivered} 拦截后可达=${st.blockedDelivered}`);
      this.add('站点曾尝试暂停播放器（守卫已拦下）', null,
        `累计拦截 pause() ${Guard.stats.blockedPause} 次、切屏类事件 ${Guard.stats.blockedEvents} 次`);

      // ---------- 7. 导航能力 ----------
      const playlist = Nav.loadPlaylist ? Nav.loadPlaylist() : null;
      const listLen = playlist ? playlist.length : 0;
      this.add('课程列表已通过接口获取', listLen > 0, listLen > 0 ? `共 ${listLen} 项` : '尚未获取（目录页首次运行时会拉取）');
      const nextUrl = Nav.nextFromPlaylist ? Nav.nextFromPlaylist() : null;
      this.add('能算出下一节的地址', listLen === 0 ? null : !!nextUrl,
        nextUrl ? nextUrl.replace(location.origin, '').slice(0, 80) : (listLen ? '已是列表最后一节' : '需先获取列表'));
      this.add('自动跳转已开启', !!CFG.autoNext, CFG.autoNext ? '开启' : '已关闭');

      // ---------- 8. 版本与设置 ----------
      this.add('脚本版本', null, YKT.version + (YKT.updateUrl ? '' : ''));

      const pass = this.results.filter((x) => x.ok === true).length;
      const fail = this.results.filter((x) => x.ok === false).length;
      const warn = this.results.filter((x) => x.ok === null).length;

      const lines = this.results.map((x) => {
        const mark = x.ok === true ? '✓' : x.ok === false ? '✗' : '·';
        return `${mark} ${x.name}${x.detail ? '  — ' + x.detail : ''}`;
      });

      return { pass, fail, warn, lines, results: this.results };
    },

    /** 生成可复制的纯文本报告 */
    async report() {
      const head = [
        '===== 长江雨课堂自动刷课助手 · 真实站点自检 =====',
        `时间   : ${new Date().toLocaleString()}`,
        `版本   : ${YKT.version}`,
        `页面   : ${location.href.slice(0, 150)}`,
        `环境   : ${navigator.userAgent.slice(0, 120)}`,
        '',
      ];
      const { pass, fail, warn, lines } = await this.run();
      const tail = [
        '',
        `结果   : 通过 ${pass} / 失败 ${fail} / 提示 ${warn}`,
        fail === 0 ? '结论   : 全部关键项通过' : '结论   : 存在失败项，见上方 ✗',
        '',
        '--- 详细状态 ---',
        JSON.stringify(window.__yktTool ? window.__yktTool.state : {}, null, 1),
      ];
      return head.concat(lines, tail).join('\n');
    },
  };
  // ------------------------------ src/06-run-boot.js ------------------------------
  Boot.init();
})();

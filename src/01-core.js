// ============================================================================
//  模块 1/6：配置与通用工具
// ============================================================================
const YKT = {
  name: '长江雨课堂 · 自动刷课助手',
  version: '1.1.1',
  debug: true,
};

const CFG = {
  /** 目标倍速 */
  rate: 2,
  /** 是否静音（后台播放必需，浏览器禁止非静音自动播放） */
  mute: true,
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
  /** 目录页最多处理多少节 */
  maxItems: 500,
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

  // ------------------------------------------------------------ 用户手势
  /**
   * 浏览器自动播放策略：没有「用户手势」时，未静音的 play() 会被拒绝
   * （NotAllowedError: play() failed because the user didn't interact with the
   *  document first）。站点本身若也不自己调用 play()，页面就会停在那里。
   *
   * 这里显式追踪用户是否已经交互过：一旦有过，就可以正常自动播放；
   * 没有的话，脚本只发一次自己的提示，等用户点一下就恢复。
   */
  gesture: {
    seen: false,
    _waiters: [],
    _installed: false,

    /** 浏览器记录的激活状态（比我们自己的标记更权威） */
    browserSaysActive() {
      try {
        const ua = navigator.userActivation;
        return !!(ua && (ua.hasBeenActive || ua.isActive));
      } catch (e) { return false; }
    },

    /** 综合判断：我们见过手势，或浏览器说已经激活过 */
    has() {
      return this.seen || this.browserSaysActive();
    },

    mark(source) {
      if (this.seen) return;
      this.seen = true;
      const waiters = this._waiters.slice();
      this._waiters.length = 0;
      waiters.forEach((fn) => { try { fn(); } catch (e) { } });
    },

    /** 等第一次用户手势（已发生过则立即返回） */
    wait(timeoutMs) {
      if (this.has()) return Promise.resolve(true);
      return new Promise((resolve) => {
        let done = false;
        const fire = () => { if (!done) { done = true; resolve(true); } };
        this._waiters.push(fire);
        if (timeoutMs > 0) setTimeout(() => { if (!done) { done = true; resolve(false); } }, timeoutMs);
      });
    },

    /** 在 document-start 装一次监听（capture 阶段，任何点击都算） */
    install() {
      if (this._installed) return;
      this._installed = true;
      const self = this;
      const evs = ['pointerdown', 'mousedown', 'keydown', 'touchstart', 'wheel', 'click'];
      evs.forEach((t) => {
        try {
          window.addEventListener(t, function h() { self.mark(t); }, { capture: true, passive: true, once: false });
        } catch (e) { }
      });
      // 页面加载时若浏览器已认定激活（例如从上一页接力过来），直接标记
      if (this.browserSaysActive()) this.seen = true;
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

  /** 模拟一次真实点击（尽量触发框架的事件系统）
   *
   *  ⚠️ 雨课堂的反自动化校验（实测 + 社区确认）：
   *    它的卡片/按钮点击处理器会先判断「鼠标是否真的悬浮在目标上」：
   *        changeHasMosue: function(hasMouse, target) { this.hasLeftMouse = hasMouse; this.mouseTarget = target }
   *        goDetail: function(e) { var s = e.target;
   *            if ((this.hasMouse || this.hasLeftMouse) && this.mouseTarget == s) { ...跳转... } }
   *    其中 hasMouse 由 mousemove 时鼠标位移的欧氏距离算出，mouseout 时归零。
   *    我们派发的合成 MouseEvent 的 clientX/clientY 默认是 0，
   *    于是 hasMouse 恒为 0（falsy）、mouseTarget 也对不上 → **点击被直接忽略**。
   *
   *  解法（社区方案，这里做了增强）：
   *    先用一个带超大 clientX/clientY 的 mousemove 事件顶起 hasMouse，
   *    并让 mouseTarget 正确指向目标元素，再派发 click。
   */
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

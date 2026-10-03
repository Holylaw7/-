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

  /** 倍速锁定：只在值真的不同才赋值。
   *  注意：给 playbackRate 赋相同值也会触发 ratechange 事件 —— 无条件反复赋值会
   *  刷爆事件、污染统计（真站实测过：6 秒内伪造出 44 次 ratechange）。 */
  enforceRate(media) {
    if (!media || !CFG.rate || CFG.rate === 1) return;
    try {
      if (Math.abs(media.playbackRate - CFG.rate) > 0.01) {
        media.playbackRate = CFG.rate;
      }
      if (Math.abs(Number(media.defaultPlaybackRate) - CFG.rate) > 0.01) {
        media.defaultPlaybackRate = CFG.rate;
      }
    } catch (e) {
      LOG.warn('设置倍速失败：' + e.message);
    }
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
   * 因此策略是：媒体倍速由 enforceRate 保证（真正的 2 倍速播放），
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
   * 让播放器的倍速显示稳定停在目标值。
   *
   * 真站实测：站点会周期性地把倍速显示改回「1.00X」（它同时也会把内部变量压回 1），
   * 只靠定时重新赋值会出现「1.00X ↔ 2.00X」闪烁，日志也会被刷屏。
   *
   * 因此这里直接**劫持显示元素的文字赋值**：站点每次写入都会被改写成目标倍速，
   * 从根上消除闪烁（只作用于这一个元素，不影响页面其它部分）。
   */
  pinSpeedUi() {
    const ui = this.speedUi();
    if (!ui || !ui.value) return false;
    const el = ui.value;
    if (el.__yktPinned && el.__yktPinnedRate === CFG.rate) return true;

    const label = `${CFG.rate}.00X`;
    try {
      // ① 先在原型上拿到原始 setter，避免重复劫持时套娃
      const proto = Object.getPrototypeOf(el);
      const desc = Object.getOwnPropertyDescriptor(proto, 'textContent')
        || Object.getOwnPropertyDescriptor(proto, 'innerText')
        || Object.getOwnPropertyDescriptor(Node.prototype, 'textContent');
      const nativeSet = desc && desc.set;
      if (!nativeSet) return false;

      const encode = (v) => String(v == null ? '' : v);
      const guard = (written) => {
        // 只要站点写入的不是目标倍速，就改写为目标倍速
        if (/\d/.test(written) && !/^\s*2(\.0+)?\s*X\s*$/i.test(written)) {
          Player.speedUiRewrites = (Player.speedUiRewrites || 0) + 1;
          return label;
        }
        return written;
      };

      Object.defineProperty(el, 'textContent', {
        configurable: true, enumerable: false,
        get() { return nativeSet ? this.__yktText ?? '' : ''; },
        set(v) {
          const out = guard(encode(v));
          this.__yktText = out;
          nativeSet.call(this, out);
        },
      });
      // innerText 在部分实现里是独立访问器，一并处理
      const innerDesc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'innerText');
      if (innerDesc && innerDesc.set) {
        Object.defineProperty(el, 'innerText', {
          configurable: true, enumerable: false,
          get() { return this.__yktText ?? ''; },
          set(v) {
            const out = guard(encode(v));
            this.__yktText = out;
            innerDesc.set.call(this, out);
          },
        });
      }
      el.__yktPinned = true;
      el.__yktPinnedRate = CFG.rate;
    } catch (e) {
      LOG.warn('倍速显示劫持失败：' + e.message);
      return false;
    }

    // 立刻写上目标值一次
    try { el.textContent = label; } catch (e) { }
    LOG.ok(`已锁定播放器倍速显示为 ${label}（站点改写会被自动纠正）`);
    return true;
  },

  /**
   * 后台保活：静音 + 自动续播。
   *
   * 关于「自动播放被网站拦截」（真实站点上确实会遇到）：
   *   浏览器的自动播放策略要求「用户手势」或「静音」二者之一。
   *   脚本会静音，但站点的播放器可能在之后又把它取消静音，
   *   或者媒体元素尚未加载到可播放状态，于是 play() 被
   *   NotAllowedError 拒绝。
   *
   *   关键是：被拒绝时**不要每 500ms 硬重试**（既无效又刷屏），
   *   而是标记为「被拦截」，等用户第一次交互后再自动恢复播放。
   */
  keepAlive(media) {
    if (!media) return;
    try {
      this.ensureMuted(media);

      const dur = Number(media.duration);
      const nearEnd = Number.isFinite(dur) && dur > 1 && dur - media.currentTime <= 0.4;
      if (!media.paused || media.ended || nearEnd) {
        // 已经在播 → 若之前被判为拦截，说明其实能播，解除标记
        if (!media.paused) this.autoplayBlocked = false;
        return;
      }
      // 不支持 play() 的媒体对象直接跳过
      if (typeof media.play !== 'function') return;

      // 已知被浏览器拦截且用户还没交互过 → 不再空转重试，只等手势
      if (this.autoplayBlocked && !U.gesture.has()) return;

      const p = media.play();
      if (p && p.catch) {
        p.then(() => {
          if (this.autoplayBlocked) {
            this.autoplayBlocked = false;
            LOG.ok('自动播放已恢复');
          }
          this.playFailCount = 0;
        }).catch((err) => {
          const name = (err && err.name) || '';
          this.playFailCount = (this.playFailCount || 0) + 1;
          const mediaErr = media.error;

          if (name === 'NotAllowedError') {
            // 自动播放策略拦截 —— 这是最常见的"被网站拦截"
            this.autoplayBlocked = true;
            this.onAutoplayBlocked(media);
            return;
          }
          if (mediaErr && (mediaErr.code === 3 || mediaErr.code === 4)) {
            if (this.playFailCount === 1 || this.playFailCount % 20 === 0) {
              LOG.warn(`媒体解码失败（code ${mediaErr.code}）：${mediaErr.message || ''}，可能是浏览器不支持该编码`);
            }
            return;
          }
          if (this.playFailCount === 1 || this.playFailCount % 20 === 0) {
            LOG.warn(`播放失败（第 ${this.playFailCount} 次）：${name} ${(err && err.message) || ''}`);
          }
        });
      }
    } catch (e) { }
  },

  /** 强制媒体静音（静音是自动播放策略放行的条件之一） */
  ensureMuted(media) {
    if (!CFG.mute || !media) return;
    try {
      if (!media.muted) media.muted = true;
      if (media.volume !== 0) media.volume = 0;
      media.defaultMuted = true;
      if (!media.hasAttribute('muted')) media.setAttribute('muted', 'muted');
    } catch (e) { }
  },

  /** 被自动播放策略拦截时的处理：提示一次，并在用户交互后自动恢复 */
  onAutoplayBlocked(media) {
    if (this._autoplayNotified) return;
    this._autoplayNotified = true;
    LOG.warn('自动播放被浏览器的自动播放策略拦截（未静音或缺少用户手势）。');
    UI.notice('浏览器拦住了自动播放：请在本页面任意位置点一下，脚本会自动继续（之后整段课程都不再需要点击）');
    U.gesture.wait(0).then(() => {
      LOG.ok('检测到你的点击，正在恢复自动播放…');
      this.autoplayBlocked = false;
      this._autoplayNotified = false;
      const m = Player.get() || media;
      this.ensureMuted(m);
      try {
        const p = m.play();
        if (p && p.catch) p.catch(() => { });
      } catch (e) { }
    });
  },

  /** 合成输入事件，避免站点「长时间无操作」弹窗 */
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

  /** 剩余可播时长（毫秒），用于超时保护 */
  remainingMs() {
    const media = this.get();
    if (!media) return 10 * 60 * 1000;
    const dur = Number(media.duration);
    if (!Number.isFinite(dur) || dur <= 0) return 10 * 60 * 1000;
    return Math.max((dur - media.currentTime) / Math.max(CFG.rate, 0.1), 1) * 1000;
  },
};

// ============================================================================
//  模块 3b：接口观测（被动读取站点自己的进度/目录数据，不主动伪造请求）
// ============================================================================
const Api = {
  leafProgress: new Map(),   // leaf_id -> 进度百分比
  leafList: null,            // 站点返回的目录结构
  lastLogPageData: null,
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

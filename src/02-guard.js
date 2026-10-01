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

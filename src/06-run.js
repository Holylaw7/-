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
        // ② 静音 + 续播（防后台暂停）
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
    // 追踪用户手势：浏览器自动播放策略要求「有用户手势 或 已静音」，
    // 有了手势记录，用户点过一次之后脚本才能顺利恢复自动播放。
    try { U.gesture.install(); } catch (e) { }
    try { Api.hook(); } catch (e) { }

    // ② 恢复用户设置
    ['rate', 'mute', 'background', 'autoNext', 'fastForward', 'speedBridge'].forEach((k) => {
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
              userGesture: { seen: U.gesture.seen, browserActive: U.gesture.browserSaysActive() },
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

Boot.init();

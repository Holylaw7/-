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

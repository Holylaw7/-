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

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
  /** 记录访问过的页面，用于回退 */
  markVisited(href) {
    try {
      const arr = JSON.parse(localStorage.getItem('ykt_tool:visits') || '[]');
      arr.push({ href, t: Date.now(), leaf: U.route().leafId });
      localStorage.setItem('ykt_tool:visits', JSON.stringify(arr.slice(-80)));
    } catch (e) { }
  },
  lastLogPage() {
    try {
      const arr = JSON.parse(localStorage.getItem('ykt_tool:visits') || '[]');
      const r = U.route();
      for (let i = arr.length - 1; i >= 0; i--) {
        if (arr[i].href && arr[i].href.includes(`/studentLog/${r.classroomId}`)) return arr[i].href;
      }
    } catch (e) { }
    const r = U.route();
    return r.classroomId ? `${location.origin}/v2/web/studentLog/${r.classroomId}` : `${location.origin}/v2/web/index`;
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

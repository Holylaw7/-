/* 播放页：复刻长江雨课堂视频播放器的 DOM 行为 + 进度心跳上报 */
(function () {
  // 诊断记录（供 e2e / 人工排查）
  window.__playerLog = [];
  function plog(m) {
    window.__playerLog.push([Math.round(performance.now()), m]);
    if (window.__playerLog.length > 400) window.__playerLog.shift();
    console.log('[player]', m);
  }
  window.addEventListener('error', function (e) { plog('window error: ' + (e.message || e.type)); });

  var box = document.getElementById('video-box');
  var media = document.getElementById('mock-media');
  var tip = box.querySelector('.play-btn-tip');
  var timeDisp = box.querySelector('.xt_video_player_current_time_display');
  var progressText = document.querySelector('.progress-wrap .text');
  var leafId = box.getAttribute('data-leaf-id');
  var nextLeaf = box.getAttribute('data-next-leaf');
  var classroomId = box.getAttribute('data-classroom-id');
  // 仿真素材的「课程时长」= 服务端认定的总时长；素材本身会循环播放
  var duration = Number(box.getAttribute('data-duration') || 6);
  var rate = 1;
  var finished = false;
  plog('init leafId=' + leafId + ' nextLeaf=' + nextLeaf + ' duration=' + duration);

  function fmt(s) {
    s = Math.max(0, Math.floor(s || 0));
    return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
  }
  function syncTip() { tip.textContent = media.paused ? '播放' : '暂停'; }
  function syncTime() { timeDisp.textContent = fmt(media.currentTime) + ' / ' + fmt(duration); }

  media.addEventListener('play', syncTip);
  media.addEventListener('pause', function () { syncTip(); plog('pause event, paused=' + media.paused + ' t=' + media.currentTime.toFixed(2)); });
  media.addEventListener('timeupdate', syncTime);
  media.addEventListener('seeked', function () { plog('seeked t=' + media.currentTime.toFixed(2)); });
  media.addEventListener('seeking', function () { plog('seeking t=' + media.currentTime.toFixed(2)); });
  media.addEventListener('waiting', function () { plog('waiting rs=' + media.readyState); });

  /* ---- 播放器控件 ---- */
  box.querySelector('xt-playbutton').addEventListener('click', function () {
    media.paused ? media.play() : media.pause();
  });
  box.querySelector('xt-volumebutton').addEventListener('click', function () {
    media.muted = !media.muted;
  });
  var speedBtn = box.querySelector('xt-speedbutton');
  var speedValue = box.querySelector('xt-speedvalue');
  speedBtn.addEventListener('click', function () { speedBtn.classList.toggle('open'); });
  box.querySelectorAll('xt-speedlist xt-button').forEach(function (b) {
    b.addEventListener('click', function (e) {
      e.stopPropagation();
      rate = Number(b.getAttribute('data-speed'));
      media.playbackRate = rate;
      if (speedValue) speedValue.textContent = rate.toFixed(2) + 'X';
      speedBtn.classList.remove('open');
      plog('speed menu click -> ' + rate + 'x');
    });
  });

  /* ---- 2x 以上压回 1x（真实站点对非会员/异常倍速的策略） ---- */
  media.addEventListener('ratechange', function () {
    if (media.playbackRate > 2.05) { media.playbackRate = 1; rate = 1; }
  });

  /* ---- 进度心跳：把「真实播放秒数」上报服务端 ----
     素材会循环，因此按位置增量累计，循环回绕时补上剩余部分。 */
  var lastWall = Date.now();
  var lastPos = media.currentTime;
  var clipLen = 0;
  media.addEventListener('loadedmetadata', function () {
    if (Number.isFinite(media.duration) && media.duration > 0) clipLen = media.duration;
  });

  setInterval(function () {
    var now = Date.now();
    lastWall = now;
    var pos = media.currentTime;
    var delta = pos - lastPos;
    if (delta < -0.3) {
      // 循环回绕：上一段播到素材末尾，新一段从 0 开始
      var len = clipLen || Number(media.duration) || pos;
      delta = Math.max(0, len - lastPos) + pos;
    }
    if (media.paused || media.seeking) delta = 0;
    lastPos = pos;
    if (delta <= 0) return;

    var payload = {
      leaf_id: leafId,
      classroom_id: classroomId,
      played_duration: Math.min(delta, 2),
      rate: media.playbackRate,
      is_hidden: document.visibilityState !== 'visible' || document.hidden || !document.hasFocus(),
      visibility: document.visibilityState,
      ts: now,
    };
    fetch('/video-log/heartbeat/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }).then(function (r) { return r.json(); }).then(function (j) {
      var pct = (j.data && j.data.watch_progress != null) ? j.data.watch_progress : null;
      if (pct != null) progressText.textContent = pct + '%';
      if (pct >= 100 && !finished) {
        finished = true;
        progressText.textContent = '已完成';
        plog('leaf done, nextLeaf=' + nextLeaf);
        if (nextLeaf) {
          setTimeout(function () {
            var url = '/ai-workspace/lms-graph/' + classroomId + '/video/' + nextLeaf + '?is_chapter=1';
            plog('auto advance -> ' + url);
            location.href = url;
          }, 800);
        } else {
          setTimeout(function () {
            plog('last leaf, back to log page');
            location.href = '/v2/web/studentLog/' + classroomId;
          }, 1200);
        }
      }
    }).catch(function (e) { plog('heartbeat failed: ' + (e && e.message)); });
  }, 1200);

  /* ---- 打开页面即尝试自动播放（模拟站点行为） ----
   *
   *  注意：这里刻意设为静音。
   *  真机浏览器里，有声自动播放需要「用户手势」或足够高的媒体参与度，
   *  无头/自动化环境则一律拒绝有声自动播放。
   *  脚本自身完全不管音量（见 CHANGELOG v1.1.3），所以由仿真站点像真站一样
   *  自己声明初始静音状态，才能让脚本逻辑（接管/倍速/跳转）被有效测到。
   *  用户点音量按钮仍可正常取消静音。
   */
  media.muted = true;
  media.volume = 0.3;
  media.play().then(function () { plog('autoplay ok'); }).catch(function (e) { plog('autoplay blocked: ' + (e && e.name)); });
  syncTip();
  syncTime();
})();

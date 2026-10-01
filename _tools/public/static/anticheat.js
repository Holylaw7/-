/* ==== 仿真：长江雨课堂反挂机逻辑（外部脚本，在站点脚本之前执行） ==== */
(function () {
  window.__mock = window.__mock || {};
  window.__mock.events = [];
  var log = function (m) { window.__mock.events.push([Date.now(), m]); console.log('[anti-cheat]', m); };
  window.__mock.log = log;

  var media = function () { return document.querySelector('video,audio'); };

  // 1) 切后台 -> 直接暂停 + 把倍速压回 1
  document.addEventListener('visibilitychange', function () {
    log('visibilitychange -> hidden=' + document.hidden + ' state=' + document.visibilityState);
    if (document.visibilityState === 'hidden' || document.hidden) {
      var m = media();
      if (m) { m.pause(); m.playbackRate = 1; log('paused by visibilitychange, rate->1'); }
    }
  });

  // 2) 失焦 -> 暂停
  window.addEventListener('blur', function () {
    log('window.blur');
    var m = media();
    if (m) { m.pause(); m.playbackRate = 1; log('paused by blur, rate->1'); }
  });

  // 3) 周期巡检：只要判定为不可见 / 无焦点，就压制播放
  setInterval(function () {
    if (document.visibilityState !== 'visible' || document.hidden || !document.hasFocus()) {
      var m = media();
      if (m && !m.paused) { m.pause(); m.playbackRate = 1; log('patrol paused'); }
    }
  }, 1000);

  // 4) 播放器把过高倍速压回 1（真实站点对非会员同样限速）
  document.addEventListener('ratechange', function () {
    var m = media();
    if (m && m.playbackRate > 2.05) { m.playbackRate = 1; log('ratechange clamp'); }
  }, true);

  // 5) 长时间无操作 -> 弹「好好学习」遮罩
  var lastMove = Date.now();
  ['mousemove', 'mousedown', 'keydown', 'wheel', 'touchstart'].forEach(function (e) {
    window.addEventListener(e, function () { lastMove = Date.now(); }, true);
  });
  setInterval(function () {
    if (Date.now() - lastMove > 20000 && !document.querySelector('.el-dialog__wrapper[data-idle]')) {
      log('idle -> show dialog');
      var w = document.createElement('div');
      w.className = 'el-dialog__wrapper';
      w.setAttribute('data-idle', '1');
      w.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:99999;display:flex;align-items:center;justify-content:center';
      w.innerHTML = '<div class="el-dialog" style="background:#fff;padding:24px;border-radius:8px;min-width:320px">' +
        '<div class="el-dialog__title">同学，还在吗？</div>' +
        '<div class="el-dialog__body">长时间未操作，请点击「继续观看」继续学习，否则本段进度不计入。</div>' +
        '<button class="el-button" data-act="report">报告老师</button>' +
        '<button class="el-button el-button--primary" data-act="continue">继续观看</button></div>';
      w.querySelector('[data-act="continue"]').addEventListener('click', function () {
        log('idle dismissed by 继续观看');
        w.remove();
        var m = media();
        if (m) m.play();
      });
      w.querySelector('[data-act="report"]').addEventListener('click', function () { log('reported to teacher (!)'); w.remove(); });
      document.body.appendChild(w);
    }
  }, 2000);
})();

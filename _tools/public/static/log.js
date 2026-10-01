/* 目录页：点击小节进入播放页（记录点击序列供测试断言之用） */
(function () {
  var seq = [];
  document.querySelectorAll('.leaf-item').forEach(function (li) {
    li.addEventListener('click', function () {
      var kind = li.getAttribute('data-kind');
      var id = li.getAttribute('data-leaf-id');
      seq.push({ kind: kind, id: id, t: Date.now(), url: location.href });
      window.__visits = seq;
      try { localStorage.setItem('mock_visits', JSON.stringify(seq)); } catch (e) { }
      console.log('[log-page] visit', kind, id);
      if (kind === 'quiz') return; // 测验：脚本不应点进来
      location.href = `/ai-workspace/lms-graph/${CONFIG.classroom}/video/` + id + '?is_chapter=1';
    });
  });
})();

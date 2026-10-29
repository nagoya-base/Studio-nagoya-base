/* Issue #633 試作ページ専用：静かなFade-up。
   JS無効・初期化失敗時は head の3秒フォールバックで .reveal-ready が外れ、全情報が表示される。 */
(function () {
  window.__pv633Ready = true;
  var root = document.documentElement;
  if (!root.classList.contains('reveal-ready')) return;
  var targets = document.querySelectorAll('.reveal');
  if (!('IntersectionObserver' in window)) {
    root.classList.remove('reveal-ready');
    return;
  }
  var io = new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) {
      if (!entry.isIntersecting) return;
      entry.target.classList.add('is-in');
      io.unobserve(entry.target);
    });
  }, { rootMargin: '0px 0px -8% 0px', threshold: 0.04 });
  targets.forEach(function (el) { io.observe(el); });
})();

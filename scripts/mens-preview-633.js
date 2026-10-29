/* Issue #633 試作ページ専用：静かなFade-up。
   初期化が最後まで成功したときだけ __pv633Ready を立てる。例外時・JS無効時は
   .reveal-ready を外す（head の3秒フォールバックも同じ条件）ので、全情報が表示される。 */
(function () {
  var root = document.documentElement;
  if (!root.classList.contains('reveal-ready')) return;
  try {
    var targets = document.querySelectorAll('.reveal');
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        entry.target.classList.add('is-in');
        io.unobserve(entry.target);
      });
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.04 });
    targets.forEach(function (el) { io.observe(el); });
    window.__pv633Ready = true;
  } catch (e) {
    root.classList.remove('reveal-ready');
  }
})();

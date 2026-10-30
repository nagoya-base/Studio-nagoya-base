/* Issue #653 試作ページ専用：作品紹介（衣装ブロック）の写真・キャプション切替。
   4作品の写真を左の固定枠に重ね、右のキャプションが画面中央の帯に入ったとき、その作品の写真を表示中にする。
   自動再生・スクロールの強制移動・ズームはしない。
   prefers-reduced-motion、IntersectionObserver 非対応、初期化の例外時は .is-active を付けず、
   4作品と各キャプションを通常の静的一覧で表示する。 */
(function () {
  var root = document.querySelector('[data-pv-works]');
  if (!root) return;
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  if (!('IntersectionObserver' in window)) return;
  try {
    var works = root.querySelectorAll('[data-pv-work]');
    if (works.length < 2) return;
    var captions = root.querySelectorAll('[data-pv-work-caption]');
    var current = null;
    function activate(work) {
      if (current === work) return;
      if (current) current.classList.remove('is-current');
      current = work;
      work.classList.add('is-current');
    }
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) activate(entry.target.closest('[data-pv-work]'));
      });
    }, { rootMargin: '-45% 0px -45% 0px' });
    activate(works[0]);
    root.classList.add('is-active');
    Array.prototype.forEach.call(captions, function (el) { io.observe(el); });
  } catch (e) {
    root.classList.remove('is-active');
  }
})();

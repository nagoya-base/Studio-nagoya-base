/* Issue #653 試作ページ専用：作品紹介（衣装ブロック）の写真・キャプション切替。
   4作品の写真を左の固定枠に重ね、右のキャプションが画面中央の帯に入ったとき、その作品の写真を表示中にする。
   帯は viewport の高さからpxで求め（rootMargin の%は仕様上 root の幅基準のため使わない）、resize で更新する。
   キーボード：キャプションを Tab で選ぶと対応する写真に切り替わり、Enter／Space でその写真を拡大できる。
   自動再生・スクロールの強制移動・ズームはしない。
   prefers-reduced-motion、IntersectionObserver 非対応、初期化の例外時は .is-active を付けず、
   4作品と各キャプションを通常の静的一覧で表示する。 */
(function () {
  var root = document.querySelector('[data-pv-works]');
  if (!root) return;
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  if (!('IntersectionObserver' in window)) return;
  var captions = [];
  try {
    var works = root.querySelectorAll('[data-pv-work]');
    if (works.length < 2) return;
    captions = Array.prototype.slice.call(root.querySelectorAll('[data-pv-work-caption]'));
    var current = null;
    var io = null;
    var queued = false;
    function workOf(el) { return el.closest('[data-pv-work]'); }
    function activate(work) {
      if (current === work) return;
      var img = work.querySelector('img');
      var hadFocus = current && current.contains(document.activeElement) && document.activeElement.tagName === 'IMG';
      if (current) current.classList.remove('is-current');
      current = work;
      work.classList.add('is-current');
      if (hadFocus && img && img.focus) img.focus({ preventScroll: true });
    }
    function observe() {
      queued = false;
      if (io && io.disconnect) io.disconnect();
      var m = Math.round((window.innerHeight || 800) * 0.45) + 'px';
      io = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) activate(workOf(entry.target));
        });
      }, { rootMargin: '-' + m + ' 0px -' + m + ' 0px' });
      captions.forEach(function (el) { io.observe(el); });
    }
    function queueObserve() {
      if (queued) return;
      queued = true;
      window.requestAnimationFrame(observe);
    }
    captions.forEach(function (cap) {
      var work = workOf(cap);
      var img = work.querySelector('img');
      cap.setAttribute('tabindex', '0');
      cap.setAttribute('role', 'button');
      cap.setAttribute('aria-label', cap.textContent + '（拡大して見る）');
      cap.addEventListener('focus', function () { activate(work); });
      cap.addEventListener('click', function () { activate(work); });
      cap.addEventListener('keydown', function (e) {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        activate(work);
        if (img) img.click();
      });
    });
    activate(works[0]);
    root.classList.add('is-active');
    observe();
    window.addEventListener('resize', queueObserve);
  } catch (e) {
    root.classList.remove('is-active');
    if (io && io.disconnect) io.disconnect();
    captions.forEach(function (cap) {
      cap.removeAttribute('tabindex');
      cap.removeAttribute('role');
      cap.removeAttribute('aria-label');
    });
  }
})();

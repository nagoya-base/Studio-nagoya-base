/* Issue #653/#660 試作ページ専用：作品紹介（衣装ブロック）の写真・キャプション切替。
   4作品の写真を左の固定枠に重ね、右のキャプションが「固定された写真の縦の中央」より上に来た作品のうち最後のものを表示中にする。
   判定は IntersectionObserver の出入りではなく、scroll／resize のたびに requestAnimationFrame で
   現在位置から再計算する（速いフリックで帯を飛び越えても、その時点の位置に合う作品へ追いつく）。
   画面高の基準は CSS の --pv-vh（100svh）に一本化し、JS は実際に描画された写真とキャプションの位置だけを読む。
   キーボード／クリックで選んだ作品は、ホイール・タッチ・スクロール系キーの操作があるまで位置判定で上書きしない。
   Tab でキャプションを選ぶと対応する写真に切り替わり、Enter／Space でその写真を拡大できる。
   自動再生・スクロールの強制移動・ズームはしない。
   prefers-reduced-motion、初期化の例外時は .is-active を付けず、4作品と各キャプションを通常の静的一覧で表示する。 */
(function () {
  var root = document.querySelector('[data-pv-works]');
  if (!root) return;
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  if (!window.requestAnimationFrame) return;
  var captions = [];
  try {
    var works = root.querySelectorAll('[data-pv-work]');
    if (works.length < 2) return;
    captions = Array.prototype.slice.call(root.querySelectorAll('[data-pv-work-caption]'));
    var current = null;
    var queued = false;
    var manual = false;
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
    function center(el) {
      var r = el.getBoundingClientRect();
      return r.top + r.height / 2;
    }
    /* 固定された写真の縦中央より上にある最後のキャプション＝表示する作品。どれも下なら1作品目 */
    function update() {
      queued = false;
      if (manual) return;
      var photo = works[0].querySelector('.pv-photo');
      if (!photo) return;
      var line = center(photo);
      var idx = 0;
      captions.forEach(function (cap, i) { if (center(cap) <= line) idx = i; });
      activate(workOf(captions[idx]));
    }
    function queueUpdate() {
      if (queued) return;
      queued = true;
      window.requestAnimationFrame(update);
    }
    function release() { if (manual) { manual = false; queueUpdate(); } }
    function select(work) { manual = true; activate(work); }
    captions.forEach(function (cap) {
      var work = workOf(cap);
      var img = work.querySelector('img');
      cap.setAttribute('tabindex', '0');
      cap.setAttribute('role', 'button');
      cap.setAttribute('aria-label', cap.textContent + '（選択。Enter または Space で拡大）');
      cap.addEventListener('focus', function () { select(work); });
      cap.addEventListener('click', function () { select(work); });
      cap.addEventListener('keydown', function (e) {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        select(work);
        if (img) img.click();
      });
    });
    activate(works[0]);
    root.classList.add('is-active');
    update();
    window.addEventListener('scroll', queueUpdate, { passive: true });
    window.addEventListener('resize', queueUpdate);
    window.addEventListener('orientationchange', queueUpdate);
    window.addEventListener('load', queueUpdate);
    /* 利用者のスクロール操作で手動選択を解除し、以後は位置で判定する */
    window.addEventListener('wheel', release, { passive: true });
    window.addEventListener('touchmove', release, { passive: true });
    window.addEventListener('keydown', function (e) {
      if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End'].indexOf(e.key) !== -1) release();
    });
  } catch (e) {
    root.classList.remove('is-active');
    captions.forEach(function (cap) {
      cap.removeAttribute('tabindex');
      cap.removeAttribute('role');
      cap.removeAttribute('aria-label');
    });
  }
})();

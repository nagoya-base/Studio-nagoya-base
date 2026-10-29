/* Issue #639 試作ページ専用：ROPE / WOOD のスクロール連動演出。
   木組みの写真を固定（sticky）し、スクロール位置に合わせて写真の寄り・切り替えと説明を進める。
   PC：画面中央の帯に入った段階を表示中にする。
   スマホ：写真が説明の上に固定されるため、写真の下端より下にある最上段の説明を表示中にする（説明が写真に隠れない）。
   prefers-reduced-motion、IntersectionObserver 非対応、初期化の例外時は .is-active を付けず、
   写真・説明をすべて通常配置で表示する。 */
(function () {
  var root = document.querySelector('[data-pv-scroll]');
  if (!root) return;
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  if (!('IntersectionObserver' in window)) return;
  try {
    var steps = root.querySelectorAll('[data-pv-step]');
    var stage = root.querySelector('.pv-scroll-stage');
    var narrow = window.matchMedia('(max-width: 800px)');
    var current = null;
    var queued = false;
    function activate(step) {
      if (current === step) return;
      if (current) current.classList.remove('is-current');
      current = step;
      step.classList.add('is-current');
      root.setAttribute('data-photo', step.getAttribute('data-photo'));
      root.style.setProperty('--pv-zoom', step.getAttribute('data-zoom'));
      root.style.setProperty('--pv-pos', step.getAttribute('data-pos'));
      root.style.setProperty('--pv-origin', step.getAttribute('data-origin'));
    }
    function pickBelowStage() {
      queued = false;
      if (!narrow.matches) return;
      var line = stage.getBoundingClientRect().bottom - 2;
      var chosen = steps[steps.length - 1];
      for (var i = 0; i < steps.length; i++) {
        if (steps[i].getBoundingClientRect().top >= line) { chosen = steps[i]; break; }
      }
      activate(chosen);
    }
    function queuePick() {
      if (queued || !narrow.matches) return;
      queued = true;
      window.requestAnimationFrame(pickBelowStage);
    }
    var io = new IntersectionObserver(function (entries) {
      if (narrow.matches) return;
      entries.forEach(function (entry) {
        if (entry.isIntersecting) activate(entry.target);
      });
    }, { rootMargin: '-45% 0px -45% 0px' });
    activate(steps[0]);
    root.classList.add('is-active');
    steps.forEach(function (el) { io.observe(el); });
    window.addEventListener('scroll', queuePick, { passive: true });
    window.addEventListener('resize', queuePick);
    pickBelowStage();
  } catch (e) {
    root.classList.remove('is-active');
  }
})();

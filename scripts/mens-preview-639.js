/* Issue #639 試作ページ専用：ROPE / WOOD のスクロール連動演出。
   木組みの写真を固定（sticky）し、スクロール位置に合わせて写真の寄り・切り替えと説明を進める。
   prefers-reduced-motion、IntersectionObserver 非対応、初期化の例外時は .is-active を付けず、
   写真・説明をすべて通常配置で表示する。 */
(function () {
  var root = document.querySelector('[data-pv-scroll]');
  if (!root) return;
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  if (!('IntersectionObserver' in window)) return;
  try {
    var steps = root.querySelectorAll('[data-pv-step]');
    var current = null;
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
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) activate(entry.target);
      });
    }, { rootMargin: '-45% 0px -45% 0px' });
    activate(steps[0]);
    root.classList.add('is-active');
    steps.forEach(function (el) { io.observe(el); });
  } catch (e) {
    root.classList.remove('is-active');
  }
})();

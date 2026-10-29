/* Issue #646 試作ページ専用：同じ撮影場所の照明5パターンの切替UI。
   JS無効時・初期化の例外時は何も加えず、5枚と説明をグリッドでそのまま表示する。
   切替は <button>（タッチ・キーボード操作可）で行い、自動切替・アニメーションは使わない。 */
(function () {
  var root = document.querySelector('[data-pv-compare]');
  if (!root) return;
  var bar = null;
  try {
    var items = root.querySelectorAll('.pv-compare-item');
    if (items.length < 2) return;
    var buttons = [];
    bar = document.createElement('div');
    bar.className = 'pv-compare-tabs';
    bar.setAttribute('role', 'group');
    bar.setAttribute('aria-label', '照明の色を選ぶ');
    var select = function (index) {
      Array.prototype.forEach.call(items, function (item, i) {
        if (i === index) item.classList.add('is-current'); else item.classList.remove('is-current');
      });
      buttons.forEach(function (b, i) { b.setAttribute('aria-pressed', i === index ? 'true' : 'false'); });
    };
    Array.prototype.forEach.call(items, function (item, i) {
      var cap = item.querySelector('[data-pv-compare-label]');
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'pv-compare-tab';
      b.textContent = cap ? cap.getAttribute('data-pv-compare-label') : String(i + 1);
      b.addEventListener('click', function () { select(i); });
      buttons.push(b);
      bar.appendChild(b);
    });
    root.insertBefore(bar, root.firstChild);
    root.classList.add('is-enhanced');
    select(0);
  } catch (e) {
    if (bar && bar.parentNode) bar.parentNode.removeChild(bar);
    root.classList.remove('is-enhanced');
  }
})();

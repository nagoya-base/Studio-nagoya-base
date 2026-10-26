/*
 * SNB MEMBERプレスタート（Issue #498）の表示切替。
 * [data-membership-phase="prestart"] は2026/12/1 00:00 JSTより前だけ、[data-membership-phase="regular"] はそれ以降だけ表示する。
 * ビルド時にも同じ判定をしているが、ビルド後に日付をまたいでも「プレスタート中」表示が残らないようここで再判定する。
 */
(function (root) {
  'use strict';
  var BENEFITS_START_MS = Date.parse('2026-12-01T00:00:00+09:00');

  function phaseAt(nowMs) { return nowMs < BENEFITS_START_MS ? 'prestart' : 'regular'; }

  function apply(doc, nowMs) {
    var phase = phaseAt(nowMs);
    var nodes = doc.querySelectorAll('[data-membership-phase]');
    for (var i = 0; i < nodes.length; i++) {
      nodes[i].hidden = nodes[i].getAttribute('data-membership-phase') !== phase;
    }
  }

  if (root.document) apply(root.document, Date.now());
  if (typeof module !== 'undefined' && module.exports) module.exports = { phaseAt: phaseAt, apply: apply, BENEFITS_START_MS: BENEFITS_START_MS };
})(typeof window !== 'undefined' ? window : this);

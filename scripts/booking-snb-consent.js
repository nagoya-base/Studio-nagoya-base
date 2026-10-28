(function () {
  'use strict';

  var root = document.getElementById('booking-app');
  if (!root) return;

  var brand = root.getAttribute('data-brand');
  if (brand !== 'snb' && brand !== 'mens') return;

  var consentText = document.getElementById('ba-consent-text');
  if (!consentText) return;

  var base = brand === 'mens' ? '../../' : '../';
  consentText.innerHTML =
    '予約成立条件を確認し、<a href="' + base + 'legal/#terms" target="_blank" rel="noopener">利用規約</a>に同意します。' +
    '吊り床・緊縛を利用する場合は、<a href="' + base + '#safety" target="_blank" rel="noopener">安全ルール</a>を確認し、利用者自身で安全管理を行います。';
})();

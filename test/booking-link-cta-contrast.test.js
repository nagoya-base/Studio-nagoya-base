/*
 * Issue #402: Studio Xの `.content-section a { color: var(--accent) }` が
 * リンク型Primary CTA（.ba-btn-primary）の文字色を上書きし、背景と同化する回帰の防止。
 * styles/booking.css が詳細度の高いセレクタで文字色を固定していることを検証する。
 */
'use strict';

var test = require('node:test');
var assert = require('node:assert');
var fs = require('node:fs');
var path = require('node:path');

var css = fs.readFileSync(path.join(__dirname, '..', 'styles', 'booking.css'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '');

function ruleFor(selector) {
  var re = /([^{}]+)\{([^{}]*)\}/g;
  var m;
  while ((m = re.exec(css))) {
    var selectors = m[1].split(',').map(function (s) { return s.trim(); });
    if (selectors.indexOf(selector) !== -1) return m[2];
  }
  return null;
}

test('リンク型Primary CTAの文字色が .content-section a より高い詳細度で固定されている', function () {
  var body = ruleFor('.booking-app a.ba-btn-primary');
  assert.ok(body, '.booking-app a.ba-btn-primary のルールがある');
  assert.match(body, /color:\s*var\(--ba-bg\)/);
});

test('hover / focus / focus-visible / active でも文字色が背景と同化しない', function () {
  ['hover', 'focus', 'focus-visible', 'active'].forEach(function (state) {
    var body = ruleFor('.booking-app a.ba-btn-primary:' + state);
    assert.ok(body, state + ' のルールがある');
    assert.match(body, /color:\s*var\(--ba-bg\)/, state + ' で文字色が --ba-bg');
  });
});

test('背景色は既存のアクセント色のまま（上書きしていない）', function () {
  assert.match(ruleFor('.ba-btn-primary'), /background:\s*var\(--ba-accent\)/);
  assert.doesNotMatch(ruleFor('.booking-app a.ba-btn-primary'), /background/);
});

test('完了画面の2つのCTAは a.ba-btn-primary で描画される', function () {
  ['ja', 'en'].forEach(function (locale) {
    var html = fs.readFileSync(path.join(__dirname, '..', '_includes', 'booking_app_' + locale + '.html'), 'utf8');
    assert.match(html, /<a class="ba-btn ba-btn-primary" id="ba-complete-checkout-link"/);
    assert.match(html, /<a class="ba-btn ba-btn-primary" id="ba-complete-back-link"/);
  });
});

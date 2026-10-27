/*
 * Issue #572: Studio Xから旧運用（シャワー案内・30分1,000円の下見プラン・一般／会員の料金区分表示）を削除する。
 * 表示の整理のみ。Studio Xの料金計算とSNB側の会員制度・料金表示は変えない。
 */
'use strict';

var test = require('node:test');
var assert = require('node:assert');
var fs = require('fs');
var path = require('path');
var vm = require('vm');

function read(rel) { return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8'); }

test('Studio X トップ: シャワー案内・シャワー問い合わせCTAがない', function () {
  var html = read('studio-x/index.html');
  assert.ok(html.indexOf('shower-notice') === -1);
  assert.ok(html.indexOf('シャワー利用をご希望の方へ') === -1);
  assert.ok(html.indexOf('shower_inquiry') === -1);
  assert.ok(!/事前確認が必要なオプション/.test(html));
});

test('Studio X トップ: 下見プラン（30分1,000円・充当・CTA・FAQ）がない', function () {
  var html = read('studio-x/index.html');
  assert.ok(!/下見/.test(html), '下見の文言が残っていない');
  assert.ok(!/まずは見てから決めたい方へ/.test(html));
  assert.ok(!/1,000円分/.test(html));
  assert.ok(!/intent=preview/.test(html));
  assert.ok(!/data-analytics-type="preview"/.test(html));
  assert.ok(html.indexOf('id="price"') > 0, '料金セクション自体は残る');
  assert.match(html, /data-analytics-location="price" data-analytics-destination="booking_app"/, '予約CTAは残る');
});

test('Studio X: 削除したブロック専用のCSSが残っていない', function () {
  var css = read('studio-x/style.css');
  assert.ok(!/shower-notice|price-preview|beginners-preview/.test(css));
});

test('Studio X 予約・相談フォーム: 下見プランの選択肢・固定項目がなく、?intent=previewは無視される', function () {
  var html = read('studio-x/reservation/index.html');
  assert.ok(!/下見/.test(html));
  assert.ok(!/data-intent="preview"/.test(html));
  assert.ok(!/is-preview-only/.test(html));
  var js = read('studio-x/reservation/form.js');
  var m = js.match(/var INTENT_QUERY_MAP = (\{[^}]*\});/);
  assert.ok(m, 'INTENT_QUERY_MAP がある');
  var map = vm.runInNewContext('(' + m[1] + ')');
  assert.strictEqual(map.preview, undefined);
  assert.strictEqual(map.consult, 'consult');
});

test('Studio X 予約画面: 適用料金（一般料金／会員料金）を表示しない。料金計算には影響しない', function () {
  var Logic = require('./helpers/frontend-sandbox').loadFrontendSandbox(['booking-logic.js'], {}).BookingLogic;
  assert.strictEqual(Logic.appliedRateInfo({ brand: 'studio_x', tier: 'GENERAL', plan: '', amount: 3600 }, 'ja'), null);
  assert.strictEqual(Logic.appliedRateInfo({ brand: 'studio_x', tier: 'MEMBER', plan: '', amount: 3600 }, 'ja'), null);
  assert.strictEqual(Logic.appliedRateInfo({ brand: 'studio_x', tier: 'GENERAL', plan: '' }, 'en'), null);
  // SNB / mens の表示は従来どおり
  assert.strictEqual(Logic.appliedRateInfo({ brand: 'snb', tier: 'GENERAL', plan: '' }, 'ja').text, '適用料金：一般料金');
  assert.strictEqual(Logic.appliedRateInfo({ brand: 'mens', tier: 'MEMBER', plan: '' }, 'ja').text, '適用料金：SNB MEMBER 会員料金');
});

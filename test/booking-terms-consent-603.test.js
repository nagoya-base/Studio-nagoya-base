/*
 * Issue #603: 予約フロー（SNB日本語 / mens / SNB英語）の規約等同意・安全ルール同意。
 * テンプレート（Liquid出し分け・リンク先・アンカー）と、booking-app.jsの必須判定を検証する。
 */
'use strict';

var test = require('node:test');
var assert = require('node:assert');
var fs = require('node:fs');
var path = require('node:path');

function read(rel) { return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8'); }

var JA = read('_includes/booking_app_ja.html');
var EN = read('_includes/booking_app_en.html');
var TERMS = read('_includes/booking_terms_consent_ja.html');

test('日本語予約: 規約等同意は共通部品、安全ルール同意はSNB/mensのLiquid分岐の中でのみ生成される', function () {
  var m = JA.match(/\{% if include\.brand == "snb" or include\.brand == "mens" %\}\s*\{% include booking_terms_consent_ja\.html brand=include\.brand safety="true" %\}\s*\{% endif %\}/);
  assert.ok(m, 'SNB/mens限定のinclude');
  /* Studio X向けに出力され得るテンプレート本体（コメント以外）にSNB固有語を直書きしない。 */
  var body = JA.replace(/\{% comment %\}[\s\S]*?\{% endcomment %\}/g, '');
  assert.ok(body.indexOf('ba-confirm-safety') === -1 && body.indexOf('ba-safety-error') === -1);
  assert.ok(TERMS.indexOf('{%- if include.safety == "true" %}') >= 0, '安全ルールはsafety=trueのときだけ');
  var beforeSafety = TERMS.slice(0, TERMS.indexOf('{%- if include.safety'));
  ['緊縛', '吊り', '安全ルール'].forEach(function (w) {
    var noComment = beforeSafety.replace(/\{%- comment -%\}[\s\S]*?\{%- endcomment -%\}/, '');
    assert.ok(noComment.indexOf(w) === -1, '共通部分に「' + w + '」を出さない');
  });
});

test('日本語予約: 同意文言・リンク先（snb=/legal/、mens=/mens/legal/）と必須表示', function () {
  assert.ok(TERMS.indexOf('を確認し、同意します。') >= 0);
  assert.ok(TERMS.indexOf('吊り床・緊縛を利用する場合は、利用者自身で安全管理を行い、') >= 0);
  assert.ok(TERMS.indexOf("{%- assign ba_legal_base = '/legal/' -%}") >= 0);
  assert.ok(TERMS.indexOf("{%- assign ba_legal_base = '/mens/legal/' -%}") >= 0);
  ['#terms', '#cancel', '#privacy', '#safety-rules'].forEach(function (a) {
    assert.ok(TERMS.indexOf("append: '" + a + "'") >= 0, a);
  });
  assert.strictEqual((TERMS.match(/target="_blank" rel="noopener"/g) || []).length, 4);
});

test('英語予約: 同等2チェックと legal/en.html のアンカー、既存の予約成立条件確認を維持', function () {
  assert.ok(EN.indexOf('id="ba-confirm-terms"') >= 0 && EN.indexOf('id="ba-confirm-safety"') >= 0);
  ['#terms', '#cancel', '#privacy', '#safety-rules'].forEach(function (a) {
    assert.ok(EN.indexOf("'/legal/en.html" + a + "'") >= 0, a);
  });
  assert.ok(EN.indexOf('id="ba-confirm-consent"') >= 0);
  assert.ok(JA.indexOf('id="ba-confirm-consent"') >= 0);
});

test('規約: 安全ルール見出しにidがあり、英語は4条・日本語は5条', function () {
  assert.ok(read('_includes/legal_ja.html').indexOf('<h3 id="safety-rules">5. 吊りおよび緊縛に関する安全ルール</h3>') >= 0);
  assert.ok(read('legal/en.html').indexOf('<h3 id="safety-rules">4. Safety Rules for Suspension and Bondage</h3>') >= 0);
});

test('問い合わせフォーム・GAS・予約payloadは変更しない（本Issueの対象外）', function () {
  var reservation = read('_includes/reservation_form_ja.html');
  assert.ok(reservation.indexOf('ba-confirm-terms') === -1 && reservation.indexOf('ba-confirm-safety') === -1);
});

test('booking-app.js: terms/safety要素の存在有無で必須判定を切り替えるロジックを持つ', function () {
  var js = read('scripts/booking-app.js');
  assert.ok(js.indexOf("var termsOk = !els.terms || els.terms.checked;") >= 0);
  assert.ok(js.indexOf("var safetyOk = !els.safety || els.safety.checked;") >= 0);
  assert.ok(js.indexOf("if (!termsOk || !safetyOk) return;") >= 0);
  /* 既存の予約成立条件確認（consent）の判定は先に残っている。 */
  assert.ok(js.indexOf("if (!els.consent.checked) return;") >= 0);
  assert.ok(js.indexOf("termsRequired: '利用規約・キャンセルポリシー・プライバシーポリシーへの同意が必要です。'") >= 0);
  assert.ok(js.indexOf("safetyRequired: '安全ルールへの同意が必要です。'") >= 0);
  assert.ok(js.indexOf("termsRequired: 'Please agree to the Terms of Use, Cancellation Policy, and Privacy Policy.'") >= 0);
  assert.ok(js.indexOf("safetyRequired: 'Please agree to follow the safety rules.'") >= 0);
});

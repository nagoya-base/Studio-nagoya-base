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
  var m = JA.match(/\{% if include\.brand == "snb" or include\.brand == "mens" %\}\s*\{% include booking_terms_consent_ja\.html brand=include\.brand safety="true" %\}\s*\{% elsif include\.brand == "studio_x" %\}/);
  assert.ok(m, 'safety=trueのincludeはSNB/mens限定（Studio Xはelsifで別includeのみ）');
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
  assert.ok(js.indexOf("var consentOk = els.consent.checked;") >= 0);
  assert.ok(js.indexOf("var termsOk = !els.terms || els.terms.checked;") >= 0);
  assert.ok(js.indexOf("var safetyOk = !els.safety || els.safety.checked;") >= 0);
  /* 既存の予約成立条件確認（consent）も同じ判定にまとめて維持。 */
  assert.ok(js.indexOf("if (!consentOk || !termsOk || !safetyOk) return;") >= 0);
  assert.ok(js.indexOf("termsRequired: '利用規約・キャンセルポリシー・プライバシーポリシーへの同意が必要です。'") >= 0);
  assert.ok(js.indexOf("safetyRequired: '安全ルールへの同意が必要です。'") >= 0);
  assert.ok(js.indexOf("termsRequired: 'Please agree to the Terms of Use, Cancellation Policy, and Privacy Policy.'") >= 0);
  assert.ok(js.indexOf("safetyRequired: 'Please agree to follow the safety rules.'") >= 0);
});

/* ── Issue #606: Studio X予約にも同じ共通部品で規約等同意を適用する ── */
test('#606 Studio X: 共通部品をsafetyなしでincludeする（別系統の同意ロジックを持たない）', function () {
  assert.ok(/\{% elsif include\.brand == "studio_x" %\}\s*\{% include booking_terms_consent_ja\.html brand=include\.brand %\}/.test(JA));
  assert.ok(TERMS.indexOf("{%- assign ba_legal_base = '/studio-x/legal/' -%}") >= 0);
  /* Studio X専用の同意IDやテキストをテンプレートに直書きしていない。 */
  assert.strictEqual((JA.match(/id="ba-confirm-terms"/g) || []).length, 0);
  var js = read('scripts/booking-app.js');
  assert.ok(js.indexOf("var termsOk = !els.terms || els.terms.checked;") >= 0);
  assert.ok(!/studio_x[^\n]*termsOk|termsOk[^\n]*studio_x/.test(js), '必須判定にbrand分岐を持たない');
});

test('#606 Studio X: Liquid展開結果にSNB固有の安全同意DOM・文言が出ない', function () {
  /* 部品のLiquidを最小限に評価: safety未指定ではif節の中身は出力されない。 */
  var withoutSafety = TERMS.replace(/\{%- if include\.safety == "true" %\}[\s\S]*?\{%- endif %\}/, '');
  ['緊縛', '吊り床', '安全ルール', 'ba-confirm-safety', 'ba-safety-error', 'safety-rules'].forEach(function (w) {
    var noComment = withoutSafety.replace(/\{%- comment -%\}[\s\S]*?\{%- endcomment -%\}/, '');
    assert.ok(noComment.indexOf(w) === -1, w);
  });
  var studioXBranch = JA.match(/\{% elsif include\.brand == "studio_x" %\}[\s\S]*?\{% endif %\}/)[0];
  assert.ok(studioXBranch.indexOf('safety=') === -1);
  assert.ok(withoutSafety.indexOf('を確認し、同意します。') >= 0);
  ['#terms', '#cancel', '#privacy'].forEach(function (a) {
    assert.ok(withoutSafety.indexOf("append: '" + a + "'") >= 0, a);
  });
  /* 予約成立条件の確認は維持。 */
  assert.ok(JA.indexOf('id="ba-confirm-consent"') >= 0);
});

test('#606 Studio X legal: リンク先アンカーが存在し、studio-x/reservation・規約本文・booking入口は未変更', function () {
  var legal = read('studio-x/legal/index.html');
  ['terms', 'cancel', 'privacy'].forEach(function (id) {
    assert.ok(legal.indexOf('id="' + id + '"') >= 0, id);
  });
  var cp = require('node:child_process');
  var changed = cp.execSync('git diff --name-only origin/main...HEAD; git diff --name-only; git ls-files --others --exclude-standard', { cwd: path.join(__dirname, '..') }).toString();
  assert.ok(changed.indexOf('studio-x/reservation/') === -1);
  assert.ok(changed.indexOf('studio-x/legal/') === -1);
});

test('#606 booking-app.js: 未同意でStudio Xの送信を止める（terms要素があれば必須）', function () {
  var js = read('scripts/booking-app.js');
  assert.ok(js.indexOf("if (!consentOk || !termsOk || !safetyOk) return;") >= 0);
});

/*
 * Issue #598: SNBトップのスマホ表示を再圧縮する（長文の常時表示を要約＋アコーディオンへ）。
 * 情報は削除せず、常時表示を減らす。
 */
'use strict';

var test = require('node:test');
var assert = require('node:assert');
var fs = require('node:fs');
var path = require('node:path');

var ROOT = path.join(__dirname, '..');
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }
function textOf(html) { return html.replace(/<[^>]+>/g, ''); }

var top = read('index.html');
var form = read('_includes/reservation_form_ja.html');

test('#598/#600: 予約セクションは短い3ステップ＋CTAのみ常時表示し、支払い・期限・当日予約・経路別案内は閉じたアコーディオンに保持する', function () {
  var sec = top.slice(top.indexOf('id="calendar"'), top.indexOf('{% include reservation_form_ja.html %}'));
  var m = sec.match(/<details class="note-details">\s*<summary>(予約・支払いの詳細[^<]*)<\/summary>([\s\S]*?)<\/details>/);
  assert.ok(m, '予約・支払いの詳細アコーディオン');
  assert.ok(!/<details[^>]*\sopen/.test(m[0]), '初期は閉じている');
  ['送信だけでは予約確定ではありません', '24時間以内', '現金・PayPay', 'はじめてご利用の方はオンラインクレジットカード決済のみ', '決済ページの有効期限',
    '期限切れ・決済未完了の場合、予約は確定しません', '当日のご予約', '会員登録の有無は当日予約の条件ではありません',
    'はじめてご利用の方：', 'ご利用経験のある方：', '利用目的・安全ルールへのご同意', 'XのDM', 'x.com/nagoyabase2023'].forEach(function (w) {
    assert.ok(m[2].indexOf(w) !== -1, '詳細に保持: ' + w);
  });
  var visible = sec.replace(m[0], '');
  assert.ok(visible.indexOf('calendar-note') === -1 && visible.indexOf('reservation-path-card') === -1, '常時表示の説明ブロックを持たない');
  assert.strictEqual((visible.match(/reservation-steps-num/g) || []).length, 3);
  assert.ok(textOf(visible.slice(visible.indexOf('<ol'), visible.indexOf('</ol>'))).replace(/\s+/g, '').length <= 40, 'ステップは短く');
});

test('#602: 問い合わせフォームは相談受付に徹し、予約用同意チェックを持たない（注意書きは短く残す）', function () {
  ['reservation-terms', 'reservation-safety', 'reservation-carrier-mail', 'reservation-x-dm-confirm', 'reservation-intent'].forEach(function (id) {
    assert.strictEqual(form.indexOf(id), -1, id + ' は存在しない');
  });
  assert.ok(!/type="checkbox"/.test(form) && !/type="radio"/.test(form), '確認チェック・ラジオを持たない');
  assert.ok(!/name="(利用規約同意|安全ルール同意|メール受信設定確認|X DM受信設定確認)"/.test(form));
  assert.ok(!/class="reservation-consents"/.test(form));
  var msg = form.match(/<textarea id="reservation-message"[^>]*>/)[0];
  assert.ok(/\srequired\s/.test(msg) && /field-badge--required">必須</.test(form.slice(form.indexOf('reservation-message-label'), form.indexOf('<textarea id="reservation-message"'))), '相談内容はHTML側で静的に必須');
  assert.ok(/<legend>1\. 連絡先<\/legend>[\s\S]*<legend>2\. ご相談内容<\/legend>[\s\S]*<legend>3\. 送信前の確認<\/legend>/.test(form), 'セクション番号を詰める');
  var xHelp = form.match(/id="reservation-x-account-help"[^>]*>([^<]*)</)[1];
  assert.ok(xHelp.indexOf('DMを受信できる状態にしてください') !== -1, 'X欄のヘルプ文は残す');
  var carrier = form.slice(form.indexOf('reservation-carrier-notice'), form.indexOf('<p class="reservation-privacy">'));
  assert.ok(/<details class="note-details">/.test(carrier) && !/\sopen/.test(carrier), 'キャリアメール注意の詳細は閉じたアコーディオン');
  assert.ok(carrier.indexOf('Gmailからのメールを受信できる設定') !== -1, '詳細の文言を保持');
  assert.strictEqual(form.indexOf('reservation-review-note'), -1, '送信前注意の独立カードは持たない');
  var privacy = form.match(/<p class="reservation-privacy">([\s\S]*?)<\/p>/)[1];
  assert.ok(privacy.indexOf('#privacy') !== -1 && privacy.indexOf('Formspree') !== -1 && privacy.indexOf('送信前に入力内容とメールアドレスをご確認ください') !== -1);
  assert.ok(textOf(privacy).length <= 110, 'プライバシー説明は短く');
  var js = read('scripts/reservation-form.js');
  assert.ok(!/intentRadios|applyIntentMode|getIntent|reservation-terms|reservation-safety|reservation-carrier-mail|x-dm-confirm/.test(js), 'JSに種別・同意依存を残さない');
  assert.ok(!/(利用規約|安全ルール)(への)?同意/.test(textOf(form)), '問い合わせ段階で規約・安全ルール同意を求めない');
});

test('#602: 予約フロー側（#603/#606）の同意UIは問い合わせフォーム整理で変更されていない', function () {
  var inc = read('_includes/booking_terms_consent_ja.html');
  assert.ok(/ba-confirm-terms/.test(inc) && /ba-confirm-safety/.test(inc));
  assert.ok(/ba-confirm-consent/.test(read('_includes/booking_app_ja.html')));
});

test('#598: SNB MEMBERの常時表示は要点のみで、契約条件・割引額は詳細に1回だけ保持する', function () {
  var cta = top.slice(top.indexOf('<div class="snb-member-cta"'), top.indexOf('</details>', top.indexOf('<div class="snb-member-cta"')));
  var visible = cta.slice(0, cta.indexOf('<details'));
  ['月額500円', '3時間以上のご利用で一般料金より安く', '差額が月会費500円相当'].forEach(function (w) { assert.ok(visible.indexOf(w) !== -1, w); });
  assert.ok(textOf(visible).length < 150, '常時表示本文が短い');
  assert.ok(visible.indexOf('1〜2時間') === -1 && visible.indexOf('延長1時間ごとに500円') === -1, '詳細は常時表示しない');
  var details = cta.slice(cta.indexOf('<details'));
  ['3時間で500円、4時間で1,000円、延長1時間ごとに500円', '1〜2時間のご利用では一般料金との差はありません', '自動更新（Stripe）', '平日5,000円／土日祝6,000円'].forEach(function (w) {
    assert.strictEqual(top.split(w).length - 1, 1, w + ' は1回だけ');
    assert.ok(details.indexOf(w) !== -1, '詳細内: ' + w);
  });
});

test('#598: SNB平日6時間パスはトップ料金欄に残っていない（廃止）', function () {
  var pricing = top.slice(top.indexOf('<section id="pricing">'), top.indexOf('</section>', top.indexOf('<section id="pricing">')));
  assert.ok(!/平日6時間パス|¥9,800 \/ 月/.test(pricing));
});

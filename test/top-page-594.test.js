/*
 * Issue #594: トップページを短くする（情報を失わず、重複説明の集約・統合・移転を行う）。
 * 追加要件: 旧「問い合わせフォームから予約」導線の痕跡を削除し、予約は予約ページへ一本化する。
 */
'use strict';

var test = require('node:test');
var assert = require('node:assert');
var fs = require('node:fs');
var path = require('node:path');

var ROOT = path.join(__dirname, '..');
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }
function ids(html) {
  var out = [];
  html.replace(/\sid="([^"]+)"/g, function (_, id) { out.push(id); return ''; });
  return out;
}
function faqIds(html) {
  var out = [];
  html.replace(/data-analytics-faq-id="([^"]+)"/g, function (_, id) { out.push(id); return ''; });
  return out;
}
function textOf(html) { return html.replace(/<[^>]+>/g, ''); }

var top = read('index.html');
var legal = read('legal/index.html');

test('#594: トップは重複セクションを統合し、ヘッダーナビ・既存アンカーの宛先が残っている', function () {
  var present = ids(top).concat(ids(read('_includes/phase2_trust_ja.html')));
  ['calendar', 'first-time', 'safety', 'news', 'features', 'equipment', 'gallery', 'pricing', 'access', 'hours', 'faq', 'legal'].forEach(function (id) {
    assert.ok(present.indexOf(id) !== -1, '#' + id + ' が存在する');
  });
  assert.ok(ids(read('_includes/reservation_form_ja.html')).indexOf('reservation-form') !== -1 && top.indexOf('include reservation_form_ja.html') !== -1, '#reservation-form（相談フォーム）');
  /* 統合・削除したセクション（内容は features / equipment / hero / calendar へ集約） */
  ['show-practice', 'purpose', 'usage-section', 'featured-image', 'cta'].forEach(function (id) {
    assert.ok(present.indexOf(id) === -1, '#' + id + ' は統合済み');
  });
  /* header_ja.html のナビが指すアンカー */
  ['features', 'pricing', 'access', 'faq'].forEach(function (id) {
    assert.ok(present.indexOf(id) !== -1, 'ナビ #' + id);
  });
});

test('#594: 重複していた要点はヒーローの4点に集約され、同じ文言を複数セクションで繰り返さない', function () {
  var heroEnd = top.indexOf('</section>', top.indexOf('class="hero-ad"'));
  var hero = top.slice(top.indexOf('class="hero-ad"'), heroEnd);
  var body = top.slice(top.indexOf('<main'));
  ['完全貸切・1〜4名まで同一料金', '常設の吊り設備と大型ミラー', '自主練・ショー練習・少人数講習に対応', '無人運営・利用前相談も可能'].forEach(function (w) {
    assert.strictEqual(body.split(w).length - 1, 1, w + ' はトップ本文に1回だけ');
    assert.ok(hero.indexOf(w) !== -1, w + ' はヒーロー内');
  });
  assert.strictEqual(top.split('class="phase2-card-grid"').length - 1, 0, '旧「初めての方へ」6カードは持たない');
});

test('#594: 初めての方へ・安全利用は要点を常時表示し、残りは削除せずアコーディオンに保持する', function () {
  var trust = read('_includes/phase2_trust_ja.html');
  var always = trust.slice(trust.indexOf('<ul class="phase2-safety-rules">'), trust.indexOf('</ul>', trust.indexOf('<ul class="phase2-safety-rules">')));
  ['十分な知識・経験を持つ方', '単独での吊りは禁止', '飲酒後の緊縛・吊りは禁止', '性的行為および性的行為を伴う撮影は禁止'].forEach(function (w) {
    assert.ok(always.indexOf(w) !== -1, '常時表示: ' + w);
  });
  var details = trust.slice(trust.indexOf('<details'), trust.indexOf('</details>'));
  ['3名以上', '首吊りや呼吸を阻害する行為は禁止', '体調不良、睡眠不足、負傷、服薬', '設備・縄・金具・接続部を点検', '緊急用はさみ'].forEach(function (w) {
    assert.ok(details.indexOf(w) !== -1, 'アコーディオン保持: ' + w);
  });
  assert.ok(/legal\/' \| relative_url \}\}#terms/.test(trust), '利用規約への導線');
  assert.ok(trust.indexOf('how-to/\' | relative_url }}#flow') !== -1, '使い方への導線');
});

test('#594: FAQ はトップ4問に絞り、外した質問はすべて /legal/#faq-full に同文で保持している', function () {
  var shown = faqIds(top);
  assert.deepStrictEqual(shown, ['first_time', 'bondage_allowed', 'payment_method', 'parking']);
  var legalIds = faqIds(legal);
  var removed = ['snb_member', 'snb_member_billing', 'snb_member_benefits', 'gender', 'alcohol', 'equipment_rental', 'cancellation', 'weather_cancellation'];
  removed.concat(shown).forEach(function (id) { assert.ok(legalIds.indexOf(id) !== -1, id + ' は規約ページのFAQ全件にある'); });
  assert.ok(top.indexOf('#faq-full') !== -1, 'FAQをすべて見る導線');
  /* トップの表示FAQ = JSON-LD（構造化データは表示と一致させる） */
  [top].forEach(function (html) {
    var ld = null;
    html.replace(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g, function (_, body) {
      var parsed = JSON.parse(body);
      if (parsed['@type'] === 'FAQPage') ld = parsed;
      return '';
    });
    ld.mainEntity.forEach(function (e) {
      assert.ok(html.indexOf('<div class="faq-answer">' + e.acceptedAnswer.text + '</div>') !== -1, e.name);
    });
  });
});

test('#594: 設備のトップ掲載を代表項目に絞り、外した詳細は設備一覧（how-to）に保持している', function () {
  var howto = textOf(read('how-to/index.html'));
  ['2350mm', '2450mm', '2000mm', '竹吊り', '1460mm × 800mm', '色温度・色彩を自由に変更可', 'ちゃぶ台', '教卓・黒板', 'スリング・カラビナ・リギングプレート・スイベル', '麻縄', '置き畳'].forEach(function (w) {
    assert.ok(howto.indexOf(w) !== -1, 'how-to に「' + w + '」');
  });
  assert.ok(top.indexOf("how-to/' | relative_url }}#equipment") !== -1, '全設備・備品一覧への導線');
});

test('#594: お知らせはトップに最新3件、全件はお知らせ一覧に保持している', function () {
  assert.ok(/for item in site\.data\.news_ja limit:3/.test(top));
  assert.ok(top.indexOf("'/news/' | relative_url") !== -1, 'お知らせ一覧への導線');
  var page = read('news/index.html');
  assert.ok(/for item in site\.data\.news_ja %\}/.test(page) && !/limit:/.test(page), '一覧は全件');
  assert.ok(read('sitemap.xml').indexOf('/Studio-nagoya-base/news/') !== -1);
});

test('#594: 料金は基本料金を常時表示し、会員・6時間パス・適用条件の詳細は削除せずアコーディオンに保持する', function () {
  var pricing = top.slice(top.indexOf('<section id="pricing">'), top.indexOf('</section>', top.indexOf('<section id="pricing">')));
  var visible = pricing.slice(0, pricing.indexOf('<details'));
  assert.strictEqual(visible.split('<table>').length - 1, 2, '通常・会員の2表は常時表示（6時間パスの表はアコーディオン内）');
  ['3時間以上のご利用で一般料金より安く', '継続・長時間ご利用の方向けの優遇制度'].forEach(function (w) { assert.ok(pricing.indexOf(w) !== -1, w); });
  var details = pricing.split('<details').slice(1).join('<details');
  ['自動更新（Stripe）', '2名ペアパック', '5,000円', '6,000円', 'シャワー', '¥9,800 / 月', '追加利用（1時間ごと）', '講習会・ワークショップ・参加費を徴収する利用は対象外',
    'プラットフォーム経由のご予約には適用されません', '確認コード（6桁）'].forEach(function (w) {
    assert.ok(details.indexOf(w) !== -1, 'アコーディオン内: ' + w);
  });
});

test('#594: 旧「問い合わせフォームから予約」導線の痕跡がトップ・共通フォーム・使い方に残っていない', function () {
  var form = read('_includes/reservation_form_ja.html');
  [top, form, read('_includes/phase2_trust_ja.html'), read('how-to/index.html')].forEach(function (html, i) {
    var t = textOf(html);
    assert.ok(!/日程を決めて予約する/.test(html), i + ': 「日程を決めて予約する」');
    assert.ok(!/data-intent="booking"/.test(html), i + ': booking intent');
    assert.ok(!/(問い合わせ|お問い合わせ|相談)フォームから(の)?(ご)?予約/.test(t), i + ': フォームから予約');
    assert.ok(!/予約フォームで前日まで/.test(t), i + ': 旧「予約フォームで前日まで予約受付」');
    assert.ok(!/前日まで予約受付/.test(t), i + ': 前日まで予約受付');
    assert.ok(!/予約・相談を申し込む|予約を申し込む/.test(t), i + ': フォームを予約窓口とする見出し/ボタン');
  });
  /* 問い合わせフォームは予約窓口ではなく、予約前相談・問い合わせの窓口として維持する */
  assert.ok(form.indexOf('id="reservation-form"') !== -1);
  assert.ok(form.indexOf('このフォームでは予約できません') !== -1);
  var js = read('scripts/reservation-form.js');
  [form, js].forEach(function (src) {
    assert.ok(!/is-booking-only|data-required-if-booking|予約申込日時|reservation-condition|reservation-date|reservation-party-size|reservation-purpose|reservation-duration|reservation-start-time|吊り床利用予定|予約成立条件同意|SUBMIT_LABEL_BOOKING|intent === 'booking'|予約申込/.test(src), 'booking用フィールド/分岐が残っていない');
  });
  assert.ok(form.indexOf('name="送信日時"') !== -1);
  assert.ok(form.indexOf('data-intent="consult"') !== -1);
  assert.ok(/id="reservation-submit"[^>]*>相談内容を送信する</.test(form));
  assert.ok(top.indexOf('利用内容を事前に相談する') !== -1, '予約前相談の導線は維持');
  /* 予約CTAは予約ページへ一本化 */
  var cta = top.match(/href="\{\{ '\/booking\/' \| relative_url \}\}"[^>]*data-analytics-type="booking_app"/g) || [];
  assert.ok(cta.length >= 4, 'ヒーロー・空き状況・料金・末尾の予約CTA');
  assert.ok(top.indexOf('id="floatingBookingBtn"') !== -1);
  assert.ok(/reservation-form\.js/.test(top), '送信処理は変更しない');
});

test('#594: ブランド分離（Studio X / スペースマーケットの導線をトップに混在させない）', function () {
  assert.ok(!/spacemarket/i.test(top));
  assert.ok(!/href="[^"]*studio-x/.test(top), 'トップから Studio X へのリンクを増やさない');
});

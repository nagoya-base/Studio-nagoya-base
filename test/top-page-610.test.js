'use strict';
var test = require('node:test');
var assert = require('node:assert');
var fs = require('fs');
var path = require('path');
var top = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
var pricing = top.slice(top.indexOf('<section id="pricing">'), top.indexOf('</section>', top.indexOf('<section id="pricing">')));

test('#610: トップ料金欄は「受付中」と12/1以降適用を正しい時制で案内し、/membership/へ誘導する', function () {
  var intro = pricing.match(/<p class="phase2-intro"><strong>SNB MEMBER<\/strong>([\s\S]*?)<\/p>/)[1];
  assert.ok(intro.indexOf('受付中') !== -1);
  assert.ok(intro.indexOf('会員料金・会員特典は2026年12月1日以降のご予約・ご利用から適用されます') !== -1);
  assert.ok(intro.indexOf("'/membership/' | relative_url") !== -1);
  assert.ok(pricing.indexOf('始めます') === -1, '「12月1日から始めます」の未来形に戻さない');
});

test('#610: 日付条件（作成日基準／利用日基準）と稼働開始日が正確', function () {
  assert.ok(pricing.indexOf('2026年10月26日から利用中') !== -1);
  assert.ok(pricing.indexOf('2026年12月1日以降に作成したご予約から') !== -1);
  assert.ok(pricing.indexOf('利用日が2026年12月1日以降') !== -1);
});

test('#610: 固定Stripeリンクは削除せず、予約CTAとは別ブロックに分離', function () {
  var link = 'https://buy.stripe.com/cNi3cwb5seVgc2Tgsw9k40a';
  assert.strictEqual(top.split(link).length - 1, 1);
  var cta = pricing.slice(pricing.indexOf('section-cta-sm'), pricing.indexOf('pricing-paid-link'));
  assert.ok(cta.indexOf('日時を選んで予約する') !== -1 && cta.indexOf(link) === -1);
  assert.ok(pricing.slice(pricing.indexOf('pricing-paid-link')).indexOf('予約確定済みの方') !== -1);
});

test('#610: 会員制度の詳細はトップに重複して持たず、/membership/を正本にする', function () {
  assert.ok(pricing.indexOf('snb-member-cta') !== -1);
  ['自動更新', '日割り', '返金', '旧制度', '確認コード', '5,000円', '6,000円', '1,000円'].forEach(function (w) {
    var memberBlock = pricing.slice(pricing.indexOf('snb-member-cta'), pricing.indexOf('pricing-note'));
    assert.strictEqual(memberBlock.indexOf(w), -1, w + ' はトップの会員欄に持たない');
  });
  var m = fs.readFileSync(path.join(__dirname, '..', 'membership/index.html'), 'utf8') + fs.readFileSync(path.join(__dirname, '..', '_includes/membership_terms_ja.html'), 'utf8');
  ['自動更新', '日割り', '返金'].forEach(function (w) { assert.ok(m.indexOf(w) !== -1, w + ' は会員ページ側にある'); });
});

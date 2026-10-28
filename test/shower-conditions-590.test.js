/*
 * Issue #590: 12/1開始のシャワー利用条件（会員限定・1予約1,000円・利用人数は当日のスタジオ利用人数に準ずる・
 * 予約時間内のみ・利用日の1週間前までに申込・運営確認後に利用可否を案内）を、公開Web・規約・内部正本で統一する。
 */
'use strict';

var test = require('node:test');
var assert = require('node:assert');
var fs = require('node:fs');
var path = require('node:path');
var loadBookingSandbox = require('./helpers/gas-sandbox').loadBookingSandbox;

var ROOT = path.join(__dirname, '..');
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }

var SNB_PAGES = ['index.html', 'membership/index.html', 'mens/index.html', 'mens/membership/index.html', 'legal/index.html',
  '_includes/legal_ja.html', '_includes/membership_terms_ja.html', '_includes/membership_benefits_ja.html',
  '_includes/booking_app_ja.html', '_includes/shower_options_ja.html', 'en.html'];


test('#590: SNB / mens の公開文面に旧条件（同一予約2名まで・事前連絡のみ・シャワー利用不可）が残っていない', function () {
  SNB_PAGES.forEach(function (file) {
    var html = read(file);
    assert.ok(!/同一予約で2名まで|利用者2名まで|同じご予約の利用者全員|同じ予約の利用者全員/.test(html), file + ' に人数上限の旧表現がない');
    assert.ok(!/利用希望の場合は事前にご連絡ください/.test(html), file + ' に曖昧な「事前連絡」がない');
    assert.ok(!/No shower available/.test(html), file + ' に英語の旧表現がない');
  });
  assert.ok(!/シャワーはご利用いただけません/.test(read('legal/index.html')), 'legalのFAQがシャワー不可のままではない');
});

test('#590: 規約・会員案内・FAQに新条件（人数・1週間前・運営確認・1予約料金・12/1）が揃っている', function () {
  ['_includes/legal_ja.html', '_includes/membership_benefits_ja.html', '_includes/membership_terms_ja.html', 'membership/index.html', 'legal/index.html'].forEach(function (file) {
    var html = read(file);
    assert.ok(html.indexOf('当日のスタジオ利用人数に準じます') !== -1, file + ' 利用人数');
    assert.ok(html.indexOf('ご利用日の1週間前まで') !== -1, file + ' 申込期限');
    assert.ok(html.indexOf('1,000円') !== -1, file + ' 料金');
    assert.ok(/予約時間内/.test(html), file + ' 予約時間内のみ');
    assert.ok(/12月1日/.test(html), file + ' 提供開始日');
    assert.ok(/利用可否をご案内/.test(html), file + ' 運営確認後に案内');
  });
  assert.ok(read('_includes/legal_ja.html').indexOf('1人あたりの料金ではありません') !== -1, '1人あたりと誤認させない');
});

test('#590: 英語ページはSNBのシャワー条件を案内し、「No shower」を残さない', function () {
  var en = read('en.html');
  assert.ok(/Shower: SNB MEMBER-only option from Dec 1, 2026/.test(en));
  var detail = read('how-to/en.html'); // #600: 条件の詳細はトップではなく詳細ページに保持する
  assert.ok(/per booking \(not per person\)/.test(detail) && /1 week before/.test(detail));
  assert.ok(en.indexOf('how-to/en.html#rules-details') !== -1, 'トップから詳細へ到達できる');
});

test('#590: Studio Xはシャワー対象外のまま', function () {
  assert.ok(read('studio-x/base-plan/index.html').indexOf('<li>シャワーなし</li>') !== -1);
  assert.ok(read('studio-x/index.html').indexOf('シャワー利用は含まれません') !== -1);
  var Options = loadBookingSandbox(['JapaneseHolidays.gs', 'MembershipRules.gs', 'BookingPricing.gs', 'EquipmentCatalog.gs', 'BookingOptions.gs'], {}).BookingOptions;
  assert.strictEqual(Options.isShowerBrand('studio_x'), false);
  assert.strictEqual(Options.isShowerBrand('snb'), true);
  assert.strictEqual(Options.isShowerBrand('mens'), true);
});

test('#590: 予約ロジック: 金額1,000円・提供開始2026-12-01は維持し、カタログに人数上限を持たない', function () {
  var Options = loadBookingSandbox(['JapaneseHolidays.gs', 'MembershipRules.gs', 'BookingPricing.gs', 'EquipmentCatalog.gs', 'BookingOptions.gs'], {}).BookingOptions;
  assert.strictEqual(Options.SHOWER_PRICE_JPY, 1000);
  assert.strictEqual(Options.SHOWER_START_DATE, '2026-12-01');
  assert.strictEqual(Options.isShowerAvailableOnDate('2026-11-30'), false);
  assert.strictEqual(Options.isShowerAvailableOnDate('2026-12-01'), true);
  assert.ok(!/maxUsersPerBooking/.test(read('gas/booking/shared/BookingOptions.gs')), '2名上限の定数が残っていない');
});

test('#590: 内部正本(docs)が新条件に更新されている', function () {
  var doc = read('docs/membership-pricing-2026-12.md');
  assert.ok(doc.indexOf('当日のスタジオ利用人数に準ずる') !== -1);
  assert.ok(doc.indexOf('利用日の1週間前まで') !== -1);
  assert.ok(!/同一予約の利用者2名まで共有可/.test(doc));
});

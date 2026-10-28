/*
 * Issue #611: トップのセクション粒度とCTAを整理する（営業時間→access、X導線→news、legal縮小、CTA重複削減）。
 */
'use strict';

var test = require('node:test');
var assert = require('node:assert');
var fs = require('node:fs');
var path = require('node:path');

function read(rel) { return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8'); }
function section(html, id) {
  var start = html.indexOf('<section id="' + id + '"');
  assert.ok(start !== -1, '#' + id);
  return html.slice(start, html.indexOf('</section>', start));
}
var top = read('index.html');

test('#611: #hours / #x-timeline は独立セクションとして残っていない', function () {
  assert.ok(!/<section[^>]*id="(hours|x-timeline)"/.test(top));
  assert.ok(top.indexOf('class="btn-twitter"') === -1 && top.indexOf('最新情報') === -1);
});

test('#611: 営業時間情報は #access に保持されている（共通ブロックを再利用）', function () {
  var access = section(top, 'access');
  assert.ok(access.indexOf('include hours_block_ja.html') !== -1);
  var block = read('_includes/hours_block_ja.html');
  assert.ok(block.indexOf('8:00 – 23:00') !== -1 && block.indexOf('年中無休') !== -1);
  assert.ok(access.indexOf('上前津駅 徒歩7〜8分') !== -1 && access.indexOf('access_guide.pdf') !== -1, 'アクセス情報は維持');
});

test('#611: X導線は #news 末尾に統合され、お知らせ一覧リンクも残る', function () {
  var news = section(top, 'news');
  assert.ok(/href="https:\/\/twitter\.com\/nagoyabase2023"/.test(news));
  assert.ok(news.indexOf("'/news/' | relative_url") < news.indexOf('twitter.com/nagoyabase2023'), 'Xリンクは末尾側');
  assert.ok(top.indexOf('x.com/nagoyabase2023') !== -1 && top.indexOf('sameAs') !== -1, '既存のXリンクは維持');
});

test('#611: #legal は要点3点＋3リンク＋詳細導線1本に縮小', function () {
  var legal = section(top, 'legal');
  assert.strictEqual((legal.match(/<li>/g) || []).length, 3);
  ['#terms', '#cancel', '#privacy'].forEach(function (a) { assert.ok(legal.indexOf("relative_url }}" + a) !== -1, a); });
  assert.ok(legal.indexOf('#law') === -1 && legal.indexOf('btn-primary') === -1);
  var detail = legal.match(/<a href="\{\{ '\/legal\/' \| relative_url \}\}"[^>]*>([^<]*)</);
  assert.ok(detail && detail[1].indexOf('利用規約・法的事項') !== -1, '詳細導線は1本');
  assert.ok(legal.indexOf('全文は、法的事項ページでご確認') === -1, '自己参照的な説明を持たない');
  assert.ok(legal.length < 1800, '説明量を縮小');
  var page = read('legal/index.html') + read('_includes/legal_ja.html');
  ['id="law"', 'id="terms"', 'id="cancel"', 'id="privacy"'].forEach(function (w) { assert.ok(page.indexOf(w) !== -1, '詳細ページに ' + w); });
});

test('#611: 主要CTAは hero / calendar / pricing / final_cta に残り、近接する重複は減らした', function () {
  ['hero', 'calendar', 'pricing', 'final_cta'].forEach(function (loc) {
    assert.ok(new RegExp('data-analytics-location="' + loc + '"[^>]*data-analytics-type="booking_app"').test(top), loc);
  });
  assert.strictEqual((top.match(/data-analytics-type="booking_app"/g) || []).length, 5, 'hero/calendar/pricing/final＋フローティング');
  assert.strictEqual((top.match(/data-analytics-type="consult"[^>]*data-analytics-location="calendar"/g) || []).length, 0, '直下にフォームがある空き状況の相談CTAは削除');
  assert.ok(top.indexOf('data-analytics-location="hero">利用内容を事前に相談する') !== -1 && top.indexOf('data-analytics-location="final_cta">利用内容を事前に相談する') !== -1);
  var pricing = section(top, 'pricing');
  assert.strictEqual((pricing.match(/class="btn-primary"/g) || []).length, 1, '料金欄の主CTAは予約の1つ');
});

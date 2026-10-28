'use strict';
// Issue #608 第1段階: Studio X利用規約13条の改定予告のみ。
// 13条本文の実変更は告知から14日経過後の第2段階で行う（その際、本テストの「13条本文は現行のまま」を更新する）。
var test = require('node:test');
var assert = require('node:assert');
var fs = require('fs');
var path = require('path');

var ROOT = path.join(__dirname, '..');
function read(p) { return fs.readFileSync(path.join(ROOT, p), 'utf8'); }

var NOTICE_DATE = '2026.10.28';
var EFFECTIVE = '2026-11-12';

function findNotice() {
  var news = read('_data/news_ja.yml');
  var re = /- date: "([^"]+)"\n  type: "([^"]+)"\n  body: "([^"]*)"/g;
  var m;
  while ((m = re.exec(news))) {
    if (m[3].indexOf('第13条') !== -1 && m[3].indexOf('改定') !== -1) return { date: m[1], type: m[2], body: m[3] };
  }
  return null;
}

test('#608: 13条改定予告がお知らせに存在し、概要・告知日・適用予定日を含む', function () {
  var n = findNotice();
  assert.ok(n, '改定予告');
  assert.strictEqual(n.date, NOTICE_DATE);
  assert.strictEqual(n.type, '重要');
  ['Studio X利用規約', '第13条', '2026年11月12日', '2026年10月28日', '予約確認画面', '利用規約・キャンセルポリシー・プライバシーポリシー', '料金・キャンセル条件そのものの変更はありません'].forEach(function (w) {
    assert.ok(n.body.indexOf(w) !== -1, w);
  });
});

test('#608: 適用予定日は告知日から14日以上後', function () {
  var n = findNotice();
  var announced = new Date(n.date.replace(/\./g, '-') + 'T00:00:00Z');
  var effective = new Date(EFFECTIVE + 'T00:00:00Z');
  assert.ok((effective - announced) / 86400000 >= 14);
  assert.ok(n.body.indexOf('2026年11月12日') !== -1);
});

test('#608: お知らせは先頭に追加され、既存のお知らせは維持されている', function () {
  var news = read('_data/news_ja.yml');
  assert.ok(news.indexOf('- date: "2026.10.28"\n  type: "重要"') === news.indexOf('- date'), '先頭');
  assert.ok(news.indexOf('平日6時間パスの提供を終了しました') !== -1);
  assert.ok(news.indexOf('SNB MEMBER') !== -1);
});

test('#608: Studio X利用規約13条本文は現行のまま（第1段階では未変更）', function () {
  var t = read('studio-x/legal/index.html');
  assert.ok(t.indexOf('<h3>13. 予約時の同意</h3><ol><li>予約・撮影相談フォームでの申込みをもって、本規約、キャンセルポリシー、プライバシーポリシーの全内容に同意したものとみなします。</li><li>規約を確認しなかったことにより生じたトラブルについて、当施設は責任を負いません。</li></ol>') !== -1);
  assert.ok(t.indexOf('予約確認画面') === -1);
});

test('#608: #273 rollback資産・予約側同意UIが残っている（範囲の確認はPR説明に委ねる）', function () {
  ['studio-x/reservation/index.html', 'studio-x/reservation/form.js', '_includes/reservation_form_ja.html', '_includes/calendar_embed.html', '_includes/booking_terms_consent_ja.html'].forEach(function (f) {
    assert.ok(fs.existsSync(path.join(ROOT, f)), f);
  });
});

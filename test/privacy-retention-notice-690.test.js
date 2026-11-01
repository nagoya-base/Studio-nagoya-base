'use strict';
// Issue #690 第1段階: プライバシーポリシー改定予告（180日自動消去）のみ。
// ポリシー本文の差替えは効力発生日の第2段階で行う（その際、本テストの「本文は現行のまま」を更新する）。
// 公開（マージ）が遅れた場合は、NOTICE_DATE / EFFECTIVE とお知らせの日付を公開日に合わせる（バックデートしない）。
var test = require('node:test');
var assert = require('node:assert');
var fs = require('fs');
var path = require('path');

var ROOT = path.join(__dirname, '..');
function read(p) { return fs.readFileSync(path.join(ROOT, p), 'utf8'); }

var NOTICE_DATE = '2026.11.01';
var EFFECTIVE = '2026-11-15';

function findNotice() {
  var news = read('_data/news_ja.yml');
  var re = /- date: "([^"]+)"\n  type: "([^"]+)"\n  body: "([^"]*)"/g;
  var m;
  while ((m = re.exec(news))) {
    if (m[3].indexOf('プライバシーポリシー') !== -1 && m[3].indexOf('改定予告') !== -1 && m[3].indexOf('180日') !== -1) return { date: m[1], type: m[2], body: m[3] };
  }
  return null;
}

test('#690: 改定予告がお知らせの先頭にあり、告知日・効力発生日・対象外を含む', function () {
  var n = findNotice();
  assert.ok(n, '改定予告');
  assert.strictEqual(n.date, NOTICE_DATE);
  assert.strictEqual(n.type, '重要');
  var news = read('_data/news_ja.yml');
  assert.strictEqual(news.indexOf('- date: "' + NOTICE_DATE + '"'), news.indexOf('- date'), '先頭');
  ['2026年11月15日', '2026年11月1日', '起算日時', '日次処理', '有効な会員情報', '将来の予約', '紐付けを確認できない記録', '限定記録は別に保持', '版の履歴', 'Stripe', '準備が整い次第', '本文は変更していません'].forEach(function (w) {
    assert.ok(n.body.indexOf(w) !== -1, w);
  });
});

test('#690: 効力発生日は告知日から14日以上後（現行ポリシー11項）', function () {
  var n = findNotice();
  var announced = new Date(n.date.replace(/\./g, '-') + 'T00:00:00Z');
  var effective = new Date(EFFECTIVE + 'T00:00:00Z');
  assert.ok((effective - announced) / 86400000 >= 14);
  assert.ok(read('_includes/legal_ja.html').indexOf('効力発生日の14日前までに本サイト上でお知らせします') !== -1, '現行の14日前告知');
});

test('#690: 誤認させる表現を使わない（全件180日・匿名化・540日・稼働済み）', function () {
  var n = findNotice();
  ['すべての情報', '匿名', '540', '稼働', '開始しました', '消去しました'].forEach(function (w) {
    assert.ok(n.body.indexOf(w) === -1, w);
  });
});

function withoutNotice(html) { return html.replace(/<p class="legal-notice"[\s\S]*?<\/p>/, ''); }

test('#690: ポリシー本文は現行のまま（予告ボックスを除き未変更）', function () {
  var legal = read('_includes/legal_ja.html');
  assert.ok(legal.indexOf('最終改定日：2026年7月28日') !== -1);
  assert.ok(withoutNotice(legal).indexOf('180日') === -1);
  assert.ok(withoutNotice(read('legal/en.html')).indexOf('180 days') === -1);
  assert.ok(withoutNotice(read('studio-x/legal/index.html')).indexOf('180日') === -1);
});

test('#690: 対象の各版（SNB・mens・Studio X・英語）に予告が届く', function () {
  // ポリシーページ（予告本文）
  [['_includes/legal_ja.html', '2026年11月15日', '2026年11月1日'],
   ['studio-x/legal/index.html', '2026年11月15日', '2026年11月1日'],
   ['legal/en.html', 'November 15, 2026', 'November 1, 2026']].forEach(function (c) {
    var t = read(c[0]);
    assert.ok(/id="privacy-notice"/.test(t), c[0] + ' 予告');
    assert.ok(t.indexOf(c[1]) !== -1 && t.indexOf(c[2]) !== -1, c[0] + ' 日付');
  });
  assert.ok(read('legal/en.html').indexOf('180 days') !== -1 && read('legal/en.html').indexOf('Stripe') !== -1, '英語で理解できる予告');
  // 入口（予告へのリンク）
  assert.ok(read('en.html').indexOf('legal/en.html#privacy-notice') !== -1, '英語トップ');
  assert.ok(read('mens/index.html').indexOf('/mens/legal/\' | relative_url }}#privacy-notice') !== -1, 'mensトップ');
  assert.ok(read('studio-x/index.html').indexOf('legal/#privacy-notice') !== -1, 'Studio Xトップ');
  // mens法務ページは共通includeで予告が出る
  assert.ok(read('mens/legal/index.html').indexOf('{% include legal_ja.html %}') !== -1);
});

test('#690: 自動消去は有効化されていない（トリガー・有効化の自動実行がコードに無い）', function () {
  var gs = read('gas/booking/admin/PersonalDataRetention.gs');
  assert.ok(/PERSONAL_DATA_RETENTION_ENABLED/.test(gs));
  assert.ok(!/^\s*(enablePersonalDataRetention|createPersonalDataRetentionTrigger)\(\);/m.test(gs), '自動呼び出しなし');
});

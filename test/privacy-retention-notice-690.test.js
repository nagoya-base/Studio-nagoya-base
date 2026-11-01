'use strict';
// Issue #690 第2段階: プライバシーポリシー本文の差替え（180日自動消去）。
// 改定版は施行前に掲載できる。掲載日と施行日を分け、施行前は従前の取扱いを維持する。
// 原予告は履歴として固定する。延期は訂正告知を別に追加する。
var test = require('node:test');
var assert = require('node:assert');
var fs = require('fs');
var path = require('path');

var ROOT = path.join(__dirname, '..');
function read(p) { return fs.readFileSync(path.join(ROOT, p), 'utf8'); }

/* 原予告（第1段階。2026年11月1日に公開済み）。履歴として残し、書き換えない。延期しても、ここは変えない。 */
var ORIGINAL_NOTICE_DATE = '2026.11.01';
var ORIGINAL_PLANNED = '2026-11-15';
var ORIGINAL_PLANNED_JA = '2026年11月15日';
var PUBLISHED = '2026-11-01';
var PUBLISHED_JA = '2026年11月1日';
/* 効力発生日（掲載日とは別）。当初の予定日と違う場合は、訂正／延期の告知（下記の検査）を別に追加する。 */
var EFFECTIVE = '2026-11-15';
var EFFECTIVE_JA = '2026年11月15日';

function newsItems() {
  var news = read('_data/news_ja.yml');
  var re = /- date: "([^"]+)"\n  type: "([^"]+)"\n  body: "([^"]*)"/g;
  var out = [], m;
  while ((m = re.exec(news))) out.push({ date: m[1], type: m[2], body: m[3] });
  return out;
}
function findNotice() {
  return newsItems().filter(function (n) { return n.body.indexOf('プライバシーポリシー') !== -1 && n.body.indexOf('改定予告') !== -1 && n.body.indexOf('180日') !== -1; })[0] || null;
}
function findPublished() {
  return newsItems().filter(function (n) { return n.body.indexOf('プライバシーポリシー') !== -1 && n.body.indexOf('【改定版掲載】') !== -1 && n.body.indexOf('180日') !== -1; })[0] || null;
}

var PAGES = {
  ja: { file: '_includes/legal_ja.html', words: ['180', '起算', 'Stripe', '自動消去の開始日ではありません', '準備が整い開始条件を満たした後に開始します'], ledger: '日次処理で消去します', excluded: '有効な会員情報、将来の予約', notAnon: '匿名化された情報ではありません' },
  studioX: { file: 'studio-x/legal/index.html', words: ['180', '起算', 'Stripe', '自動消去の開始日ではありません', '準備が整い開始条件を満たした後に開始します'], ledger: '日次処理で消去します', excluded: '有効な会員情報、将来の予約', notAnon: '匿名化された情報ではありません' },
  en: { file: 'legal/en.html', words: ['180 days', 'start date', 'Stripe', 'is not the start date of the automatic erasure', 'after preparations are complete and the conditions for starting it are met'], ledger: 'erased by a daily process', excluded: 'active membership information, future bookings', notAnon: 'not anonymized data' }
};

test('#690: 原予告（第1段階）は、告知日と当初の予定日のまま履歴として残る（延期しても書き換えない）', function () {
  var n = findNotice();
  assert.ok(n, '改定予告');
  assert.strictEqual(n.date, ORIGINAL_NOTICE_DATE);
  assert.ok(n.body.indexOf(ORIGINAL_PLANNED_JA) !== -1, '原予告は当初の予定日を記載したまま');
  assert.ok(n.body.indexOf('告知日：2026年11月1日') !== -1);
});

test('#690: 効力発生日は、原予告の告知日から14日以上後で、当初の予定日より前にならない（現行ポリシー11項）', function () {
  var announced = new Date(ORIGINAL_NOTICE_DATE.replace(/\./g, '-') + 'T00:00:00Z');
  var effective = new Date(EFFECTIVE + 'T00:00:00Z');
  var planned = new Date(ORIGINAL_PLANNED + 'T00:00:00Z');
  assert.ok((effective - announced) / 86400000 >= 14, '告知日の14日後以降');
  assert.ok(effective >= planned, '当初告知した日より早めない');
  assert.ok(read('_includes/legal_ja.html').indexOf('効力発生日の14日前までに本サイト上でお知らせします') !== -1);
});

test('#690: 効力発生日が当初の予定日と違う（延期）場合は、原予告を変えず、訂正／延期の告知が別に追加されている', function () {
  if (EFFECTIVE === ORIGINAL_PLANNED) {
    var none = newsItems().filter(function (n) { return n.body.indexOf('プライバシーポリシー') !== -1 && /【(訂正|延期)/.test(n.body); });
    assert.strictEqual(none.length, 0, '延期していないのに訂正告知がある');
    return;
  }
  var correction = newsItems().filter(function (n) { return n.body.indexOf('プライバシーポリシー') !== -1 && /【(訂正|延期)/.test(n.body); })[0];
  assert.ok(correction, '訂正／延期の告知（【訂正】または【延期】で始まる）');
  assert.ok(correction.body.indexOf(ORIGINAL_PLANNED_JA) !== -1, '当初の予定日を記載');
  assert.ok(correction.body.indexOf(EFFECTIVE_JA) !== -1, '新しい効力発生日を記載');
  assert.ok(correction.body.indexOf('2026年11月1日') !== -1, '原予告の告知日を記載');
  var corrected = new Date(correction.date.replace(/\./g, '-') + 'T00:00:00Z');
  assert.ok((new Date(EFFECTIVE + 'T00:00:00Z') - corrected) / 86400000 >= 14, '訂正告知の14日後以降');
});

test('#690: 改定版掲載のお知らせは掲載日で記録し、施行前の取扱いを明記する', function () {
  var p = findPublished();
  assert.ok(p, '改定のお知らせ');
  assert.strictEqual(p.date, PUBLISHED.replace(/-/g, '.'));
  assert.ok(new Date(PUBLISHED) < new Date(EFFECTIVE), '改定版を施行前に掲載する');
  ['掲載しました', '施行日は' + EFFECTIVE_JA, '11月14日までは従前の規定を適用'].forEach(function (w) { assert.ok(p.body.includes(w), w); });
  assert.strictEqual(p.type, '重要');
  ['2026年11月1日', EFFECTIVE_JA, '180日', '起算日時', '日次処理', '有効な会員情報', '将来の予約', '版の履歴', 'Stripe', '自動消去の開始日ではありません'].forEach(function (w) {
    assert.ok(p.body.indexOf(w) !== -1, w);
  });
  var news = read('_data/news_ja.yml');
  assert.strictEqual(news.indexOf('- date: "' + p.date + '"'), news.indexOf('- date'), '先頭');
});

Object.keys(PAGES).forEach(function (key) {
  var page = PAGES[key];
  test('#690: ポリシー本文（' + key + '）に、台帳の消去・除外・匿名化でないことが書かれ、予告欄と入口リンクは撤去されている', function () {
    var t = read(page.file);
    assert.ok(t.indexOf(page.ledger) !== -1, page.ledger);
    assert.ok(t.indexOf(page.excluded) !== -1, page.excluded);
    assert.ok(t.indexOf(page.notAnon) !== -1, page.notAnon);
    assert.ok(t.indexOf('id="privacy-notice"') === -1, '予告欄の撤去');
    page.words.forEach(function (w) { assert.ok(t.indexOf(w) !== -1, w); });
  });
});

test('#690: 本文は誤認させる表現を使わない（全件180日・匿名化済み・540日・稼働済み）', function () {
  ['_includes/legal_ja.html', 'studio-x/legal/index.html', 'legal/en.html'].forEach(function (f) {
    var t = read(f).replace(/<!--[\s\S]*?-->/g, '');
    var m = /プライバシーポリシー[\s\S]*?(?=特定商取引|Commercial Disclosure|id="commerce")/.exec(t);
    var policy = m ? m[0] : t;
    ['すべての情報が180日', '匿名化済み', '匿名化しました', '540', '稼働', '開始しました', 'anonymized.', 'always erased'].forEach(function (w) {
      assert.ok(policy.indexOf(w) === -1, f + ': ' + w);
    });
  });
});

test('#690: 入口の予告リンク（英語トップ・mensトップ・Studio Xトップ）は撤去されている', function () {
  assert.ok(read('en.html').indexOf('privacy-notice') === -1);
  assert.ok(read('mens/index.html').indexOf('privacy-notice') === -1);
  assert.ok(read('studio-x/index.html').indexOf('privacy-notice') === -1);
});

test('#690: 掲載日と施行日は別に記録される（SNB・mens・Studio X）', function () {
  assert.ok(read('_includes/legal_ja.html').includes('最終改定・掲載日：' + PUBLISHED_JA + '（施行日：' + EFFECTIVE_JA + '）'));
  var sx = read('studio-x/legal/index.html');
  assert.ok(sx.includes('改定版は' + PUBLISHED_JA + 'に掲載しました。施行日は' + EFFECTIVE_JA + 'です'));
});

test('#690: 本文掲載がGASの有効化・トリガー作成を自動実行しない', function () {
  var gs = read('gas/booking/admin/PersonalDataRetention.gs');
  assert.ok(/PERSONAL_DATA_RETENTION_ENABLED/.test(gs));
  assert.ok(!/^\s*(enablePersonalDataRetention|createPersonalDataRetentionTrigger)\(\);/m.test(gs), '自動呼び出しなし');
});

test('#690: 全版で施行日を明示し、施行前は従前の取扱いを適用する', function () {
  ['_includes/legal_ja.html', 'studio-x/legal/index.html'].forEach(function (f) {
    var t = read(f);
    assert.ok(t.includes('id="privacy-effective-notice"'));
    assert.ok(t.includes('この改定版は' + PUBLISHED_JA + 'に掲載しました'));
    assert.ok(t.includes('施行日は' + EFFECTIVE_JA + 'です'));
    assert.ok(t.includes('11月14日までの取扱いには従前の規定を適用します'));
  });
  var en = read('legal/en.html');
  assert.ok(en.includes('id="privacy-effective-notice"'));
  assert.ok(en.includes('Published November 1, 2026; effective November 15, 2026'));
  assert.ok(en.includes('previous provisions continue to apply through November 14'));
  assert.ok(read('mens/legal/index.html').includes('{% include legal_ja.html %}'));
});

test('#690: 別改定の告知と共通CSSを保持する', function () {
  ['_includes/legal_ja.html', 'studio-x/legal/index.html', 'legal/en.html'].forEach(function (f) {
    assert.ok(read(f).includes('terms-update-notice'), f);
  });
  ['styles/common.css', 'studio-x/pages.css'].forEach(function (f) {
    assert.ok(read(f).includes('.legal-notice'), f);
  });
});

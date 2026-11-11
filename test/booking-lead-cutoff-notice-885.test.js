/* Issue #885 第4弾: 新規予約の開始30分前締切を#758の11/19告知へ統合した案内の整合を確認する。 */
'use strict';
var test = require('node:test');
var assert = require('node:assert');
var fs = require('fs');
var path = require('path');
function read(f) { return fs.readFileSync(path.join(__dirname, '..', f), 'utf8'); }

var LEGAL_JA = ['_includes/legal_ja.html', 'studio-x/legal/index.html'];

LEGAL_JA.forEach(function (f) {
  test('#885: ' + f + ' の予約ルール改定告知に新規予約の30分前締切・決済跨ぎ・非遡及・追記日がある', function () {
    var t = read(f);
    var start = t.indexOf('id="booking-rules-notice"');
    var end = t.indexOf('</aside>', start);
    var n = t.slice(start, end);
    ['新規予約の受付締切', '利用開始の30分前まで', '30分前ちょうどは可', '予約操作時のサーバー時刻', '予約は成立のまま', '自動の取消・返金はしません',
      '施行日前に確定した予約を変更・取消しすることはありません', '2026年11月11日に追記', '2026年11月19日 0:00（日本時間）から適用', '11月4日の告知への追記', 'お問い合わせ'].forEach(function (w) {
      assert.ok(n.indexOf(w) !== -1, w);
    });
    // 既存の#758条件は維持
    ['30分の間隔', '60分前', '毎時00分・30分'].forEach(function (w) { assert.ok(n.indexOf(w) !== -1, w); });
  });
});

test('#885: 英語規約にも同じ内容（30分前・ちょうど可・決済跨ぎ・非遡及・追記）がある', function () {
  var t = read('legal/en.html');
  var s = t.indexOf('id="booking-rules-notice"');
  var n = t.slice(s, t.indexOf('</aside>', s));
  ['Booking cutoff for new bookings', 'up to 30 minutes before the start time', 'exactly 30 minutes before is allowed', 'server time',
    'the booking stands', 'no automatic cancellation or refund', 'before the effective date are not changed or cancelled',
    'added on November 11, 2026', 'an addition to the November 4 notice', 'takes effect only at 00:00 JST on November 19, 2026'].forEach(function (w) { assert.ok(n.indexOf(w) !== -1, w); });
});

test('#885: お知らせは既存の11/19告知へ統合し、11/04告知に含まれていなかったことを明記する（新しい別告知は作らない）', function () {
  var t = read('_data/news_ja.yml');
  assert.strictEqual(t.split('新規予約は、利用開始の30分前まで受け付けます').length - 1, 1, '1箇所のみ');
  var entry = t.split('\n- date: ').filter(function (e) { return e.indexOf('予約ルール改定のお知らせ】告知日') !== -1; })[0];
  ['③新規予約は、利用開始の30分前まで', '2026年11月11日に追記。2026年11月19日 0:00（日本時間）から適用し、それまでは従前の条件です', '11月4日の告知時点では含まれていませんでした', '自動の取消・返金はしません', '2026年11月19日 0:00（日本時間）'].forEach(function (w) {
    assert.ok(entry.indexOf(w) !== -1, w);
  });
  var separate = t.split('\n- date: ').filter(function (e) { return /^"2026\.11\.(1[1-9])"/.test(e) && e.indexOf('30分前') !== -1 && e.indexOf('新規予約') !== -1; });
  assert.strictEqual(separate.length, 0, '本締切だけの別告知を作らない（無関係なお知らせは対象外）');
});

test('#885: 予約画面の案内（日英）に30分前締切が追記され、施行前を「施行済み」と見せない', function () {
  var ja = read('_includes/booking_app_ja.html');
  var en = read('_includes/booking_app_en.html');
  /* Issue #896: 予約画面は短い箇条書き。11/19の施行前を「施行済み」と見せないよう「11/19から」を明示し、60分前（#895）は先行表示しない。 */
  assert.ok(ja.indexOf('<li>新規予約は開始30分前まで（11/19から）。</li>') !== -1);
  assert.ok(ja.indexOf('<li>11/19から、予約開始は毎時00分・30分、予約間隔は30分。</li>') !== -1);
  assert.ok(en.indexOf('<li>New bookings up to 30 minutes before the start (from Nov 19).</li>') !== -1);
  assert.ok(en.indexOf('<li>From Nov 19: start times are :00 and :30') !== -1);
  assert.ok(!/新規予約は開始60分前|60 minutes before the start/.test(ja + en), '60分前締切は施行日時の確定（#895）まで現在のルールとして表示しない');
});

['how-to/index.html', 'mens/how-to/index.html'].forEach(function (f) {
  test('#885: ' + f + ' のFAQ（画面とFAQPage JSON-LD）に新規予約の30分前締切がある', function () {
    var t = read(f);
    var phrase = '2026年11月19日0:00（日本時間）以降に行う新規予約は、利用開始の30分前まで受け付けます（30分前ちょうどは可、それ以降は新規予約できません。11月18日までは従前のとおりです）。すでに確定した予約は変更・取消しされません。';
    assert.strictEqual(t.split(phrase).length - 1, 2, '画面とJSON-LDの両方');
    assert.strictEqual(t.split('直前の予約は利用開始の何分前まで可能ですか？').length - 1, 2);
    // JSON-LDが壊れていない
    var blocks = t.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g) || [];
    blocks.forEach(function (b) {
      var body = b.replace(/<script[^>]*>|<\/script>/g, '');
      if (body.indexOf('{%') === -1 && body.indexOf('{{') === -1) JSON.parse(body);
    });
  });
});

test('#885: Studio XのFAQ（当日予約）に30分前締切と施行前の従前表記がある', function () {
  var t = read('studio-x/how-to/index.html');
  assert.ok(t.indexOf('新規予約は、利用開始の30分前まで受け付けます。30分前ちょうどは可で、11月18日までは従前のとおりです') !== -1);
});

test('#885: 既存の#758告知（予約間30分・開始候補・当日延長60分前）の文言は維持されている', function () {
  ['how-to/index.html', 'mens/how-to/index.html', 'studio-x/how-to/index.html'].forEach(function (f) {
    assert.ok(read(f).indexOf('11月18日までは従前のとおりです') !== -1, f);
    assert.ok(read(f).indexOf('終了時刻の60分前を過ぎると、延長できない場合があります') !== -1, f);
  });
});

test('#885: 案内に未来の施行日以外の日付を「施行済み」と誤記しない（11月19日より前の日付での施行表記がない）', function () {
  LEGAL_JA.concat(['_data/news_ja.yml', '_includes/booking_app_ja.html']).forEach(function (f) {
    var t = read(f);
    assert.ok(!/施行済み/.test(t.slice(t.indexOf('予約ルール改定'), t.indexOf('予約ルール改定') + 3000)), f);
  });
});

test('#885: 施行日時ゲートは#758と別設定のまま・既定は未投入（従来ルール）で、運用文書に未投入・戻し方が明記されている', function () {
  var cfg = read('gas/booking/shared/Config.gs');
  assert.ok(cfg.indexOf("'BOOKING_LEAD_2026_EFFECTIVE_AT'") !== -1);
  assert.ok(cfg.indexOf("'BOOKING_RULES_2026_11_EFFECTIVE_AT'") !== -1);
  assert.notStrictEqual(cfg.indexOf("'BOOKING_LEAD_2026_EFFECTIVE_AT'"), cfg.indexOf("'BOOKING_RULES_2026_11_EFFECTIVE_AT'"));
  var doc = read('docs/booking-lead-cutoff-885.md');
  ['2026-11-19T00:00:00+09:00', '値は未投入として扱う', '別設定のまま', '既存告知だけで14日前告知を充足したとは記録しない', '戻し方', '運営の別途承認',
    'ADMIN_NOTIFICATION_EMAIL', 'adminMailTo', 'undelivered'].forEach(function (w) { assert.ok(doc.indexOf(w) !== -1, w); });
});

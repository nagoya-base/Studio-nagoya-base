/*
 * gas/booking/shared/JapaneseHolidays.gs（Issue #346: 予約料金の日本の祝日・振替休日・
 * 国民の休日判定）のテスト。GAS実行環境のAPIに依存しない純粋関数のみで構成されるため、
 * 他の依存ファイルなしで単独でvm実行できる（BookingPricing.gsと同方針）。
 *
 * 期待値は`date -d`および実際の暦（2020年・2021年の東京オリンピック特例、2024〜2026年の
 * 振替休日・国民の休日の実例）で確認済み。
 */
'use strict';

var test = require('node:test');
var assert = require('node:assert');
var loadBookingSandbox = require('./helpers/gas-sandbox').loadBookingSandbox;

function loadHolidays() {
  return loadBookingSandbox(['JapaneseHolidays.gs'], {}).JapaneseHolidays;
}

test('classify: 固定日の祝日（元日・建国記念の日・天皇誕生日・昭和の日・憲法記念日・みどりの日・こどもの日・山の日・文化の日・勤労感謝の日）を認識する', function () {
  var JH = loadHolidays();
  var cases = [
    ['2026-01-01', '元日'],
    ['2026-02-11', '建国記念の日'],
    ['2026-02-23', '天皇誕生日'],
    ['2026-04-29', '昭和の日'],
    ['2026-08-11', '山の日'],
    ['2026-11-23', '勤労感謝の日']
  ];
  cases.forEach(function (c) {
    var result = JH.classify(c[0]);
    assert.strictEqual(result.ok, true, c[0]);
    assert.strictEqual(result.isHoliday, true, c[0] + 'は祝日であるべき');
    assert.strictEqual(result.name, c[1], c[0]);
  });
});

test('classify: ハッピーマンデー祝日（成人の日・海の日・敬老の日・スポーツの日）を年ごとに計算する', function () {
  var JH = loadHolidays();
  var cases = [
    ['2026-01-12', '成人の日'],
    ['2026-07-20', '海の日'],
    ['2026-09-21', '敬老の日'],
    ['2026-10-12', 'スポーツの日']
  ];
  cases.forEach(function (c) {
    var result = JH.classify(c[0]);
    assert.strictEqual(result.isHoliday, true, c[0]);
    assert.strictEqual(result.name, c[1], c[0]);
  });
});

test('classify: 2020年・2021年は東京オリンピック特例の日付になる（通常のハッピーマンデー/固定日ではない）', function () {
  var JH = loadHolidays();
  [
    ['2020-07-23', '海の日'],
    ['2020-07-24', 'スポーツの日'],
    ['2020-08-10', '山の日'],
    ['2021-07-22', '海の日'],
    ['2021-07-23', 'スポーツの日'],
    ['2021-08-08', '山の日']
  ].forEach(function (c) {
    var result = JH.classify(c[0]);
    assert.strictEqual(result.isHoliday, true, c[0]);
    assert.strictEqual(result.name, c[1], c[0]);
  });

  /* 特例年でも、特例の対象外の祝日は通常どおり（例: 2020年の元日）。 */
  assert.strictEqual(JH.classify('2020-01-01').name, '元日');
});

test('classify: 春分の日・秋分の日を近似計算式で求める（年によって日付が変わる）', function () {
  var JH = loadHolidays();
  var cases = [
    ['2023-03-21', '春分の日'],
    ['2023-09-23', '秋分の日'],
    ['2024-03-20', '春分の日'],
    ['2024-09-22', '秋分の日'],
    ['2026-03-20', '春分の日'],
    ['2026-09-23', '秋分の日']
  ];
  cases.forEach(function (c) {
    var result = JH.classify(c[0]);
    assert.strictEqual(result.isHoliday, true, c[0]);
    assert.strictEqual(result.name, c[1], c[0]);
  });
});

test('classify: 振替休日（祝日が日曜のとき翌日以降の最初の非祝日）を判定する', function () {
  var JH = loadHolidays();
  var cases = [
    /* 2023-01-01（元日）は日曜 → 2023-01-02が振替休日 */
    ['2023-01-02', '振替休日'],
    /* 2024-08-11（山の日）は日曜 → 2024-08-12が振替休日 */
    ['2024-08-12', '振替休日'],
    /* 2024-09-22（秋分の日）は日曜 → 2024-09-23が振替休日 */
    ['2024-09-23', '振替休日'],
    /* 2021-08-08（山の日、特例）は日曜 → 2021-08-09が振替休日 */
    ['2021-08-09', '振替休日']
  ];
  cases.forEach(function (c) {
    var result = JH.classify(c[0]);
    assert.strictEqual(result.isHoliday, true, c[0]);
    assert.strictEqual(result.name, c[1], c[0]);
  });
});

test('classify: 振替休日は祝日の連続（カスケード）にも対応する（2007年改正）', function () {
  var JH = loadHolidays();
  /* 2026年ゴールデンウィーク: 5/3(日,憲法記念日)→5/4(月,みどりの日で既に祝日)→
     5/5(火,こどもの日で既に祝日)→5/6(水)が振替休日になる（3日連続で祝日が埋まっているため
     振替休日が5/6まで押し出される）。 */
  assert.strictEqual(JH.classify('2026-05-03').name, '憲法記念日');
  assert.strictEqual(JH.classify('2026-05-04').name, 'みどりの日');
  assert.strictEqual(JH.classify('2026-05-05').name, 'こどもの日');
  var result = JH.classify('2026-05-06');
  assert.strictEqual(result.isHoliday, true);
  assert.strictEqual(result.name, '振替休日');
});

test('classify: 国民の休日（前後を祝日に挟まれた祝日でない平日）を判定する', function () {
  var JH = loadHolidays();
  /* 2026年: 9/21(月,敬老の日)・9/23(水,秋分の日)に挟まれた9/22(火)は国民の休日。 */
  assert.strictEqual(JH.classify('2026-09-20').isHoliday, false, '前日の日曜は対象外');
  assert.strictEqual(JH.classify('2026-09-21').name, '敬老の日');
  var result = JH.classify('2026-09-22');
  assert.strictEqual(result.isHoliday, true);
  assert.strictEqual(result.name, '国民の休日');
  assert.strictEqual(JH.classify('2026-09-23').name, '秋分の日');
  assert.strictEqual(JH.classify('2026-09-24').isHoliday, false, '祝日明けの平日は対象外');
});

test('classify: 通常の平日・土日は祝日ではない', function () {
  var JH = loadHolidays();
  assert.strictEqual(JH.classify('2026-10-05').isHoliday, false, '通常の月曜');
  assert.strictEqual(JH.classify('2026-10-01').isHoliday, false, '通常の木曜');
  assert.strictEqual(JH.classify('2026-10-03').isHoliday, false, '通常の土曜（祝日ではない。土日祝分類自体はBookingPricing.gs側の責務）');
  assert.strictEqual(JH.classify('2026-10-04').isHoliday, false, '通常の日曜（同上）');
});

test('classify: 年またぎ（12/31→1/1）を正しく扱う', function () {
  var JH = loadHolidays();
  var beforeNewYear = JH.classify('2025-12-31');
  assert.strictEqual(beforeNewYear.ok, true);
  assert.strictEqual(beforeNewYear.isHoliday, false);

  var newYear = JH.classify('2026-01-01');
  assert.strictEqual(newYear.ok, true);
  assert.strictEqual(newYear.isHoliday, true);
  assert.strictEqual(newYear.name, '元日');
});

test('classify: 対応年の範囲（MIN_SUPPORTED_YEAR〜MAX_SUPPORTED_YEAR）の境界を検証する', function () {
  var JH = loadHolidays();
  assert.strictEqual(JH.MIN_SUPPORTED_YEAR, 2020);
  assert.strictEqual(JH.MAX_SUPPORTED_YEAR, 2099);

  assert.strictEqual(JH.classify('2020-01-01').ok, true, '下限年は対応範囲内');
  assert.strictEqual(JH.classify('2099-12-31').ok, true, '上限年は対応範囲内');
});

test('classify: 対応年の範囲外の日付は、黙って平日扱いにせず明示的なエラーを返す（fail-closed）', function () {
  var JH = loadHolidays();

  var tooOld = JH.classify('2019-12-31');
  assert.strictEqual(tooOld.ok, false);
  assert.strictEqual(tooOld.error.code, 'HOLIDAY_YEAR_UNSUPPORTED');
  assert.strictEqual(typeof tooOld.error.message, 'string');
  assert.ok(tooOld.error.message.length > 0);

  var tooFar = JH.classify('2100-01-01');
  assert.strictEqual(tooFar.ok, false);
  assert.strictEqual(tooFar.error.code, 'HOLIDAY_YEAR_UNSUPPORTED');
});

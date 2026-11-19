/*
 * Issue #987: Availability.gs の Intl.DateTimeFormat 再利用（遅延生成・同一実行内キャッシュ）のテスト。
 * A. 変更前実装（下のLEGACY_*。変更前コードの写し）との厳密な出力同値＋ゴールデン値
 * B. 再利用の成立・キー独立・容量上限・失敗時に保存しないこと
 * 実予約・決済・メール送信は一切行わない（架空の日時のみ）。
 */
'use strict';

var test = require('node:test');
var assert = require('node:assert');
var loadBookingSandbox = require('./helpers/gas-sandbox').loadBookingSandbox;

/* ---- 変更前（Issue #987以前）の実装の写し。毎回new Intl.DateTimeFormatする ---- */
function legacyIsDateLike(value) {
  return !!value && typeof value.getTime === 'function' && !isNaN(value.getTime());
}
function legacyFormatDate(date, timezone) {
  if (!legacyIsDateLike(date)) return null;
  try {
    var parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit'
    }).formatToParts(date);
    var result = {};
    parts.forEach(function (part) { if (part.type !== 'literal') result[part.type] = part.value; });
    if (!result.year || !result.month || !result.day) return null;
    return result.year + '-' + result.month + '-' + result.day;
  } catch (e) { return null; }
}
function legacyMinutes(date, timezone) {
  if (!legacyIsDateLike(date)) return null;
  try {
    var parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
    }).formatToParts(date);
    var hour = null;
    var minute = null;
    parts.forEach(function (part) {
      if (part.type === 'hour') hour = parseInt(part.value, 10);
      if (part.type === 'minute') minute = parseInt(part.value, 10);
    });
    if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null;
    return hour * 60 + minute;
  } catch (e) { return null; }
}
function legacyTime(date, timezone) {
  if (!legacyIsDateLike(date)) return null;
  try {
    var parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
    }).formatToParts(date);
    var hour = null;
    var minute = null;
    parts.forEach(function (part) {
      if (part.type === 'hour') hour = part.value;
      if (part.type === 'minute') minute = part.value;
    });
    if (hour === null || minute === null) return null;
    return hour + ':' + minute;
  } catch (e) { return null; }
}
function legacyOffset(instantMillis, timezone) {
  try {
    var parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit'
    }).formatToParts(new Date(instantMillis));
    var result = {};
    parts.forEach(function (part) { if (part.type !== 'literal') result[part.type] = part.value; });
    if (!result.year || !result.month || !result.day || !result.hour || !result.minute || !result.second) return null;
    var asUtcMillis = Date.UTC(
      parseInt(result.year, 10), parseInt(result.month, 10) - 1, parseInt(result.day, 10),
      parseInt(result.hour, 10), parseInt(result.minute, 10), parseInt(result.second, 10)
    );
    return asUtcMillis - instantMillis;
  } catch (e) { return null; }
}

/* Intl.DateTimeFormatの生成回数を数えるサンドボックスを作る（本物のFormatterを返す） */
function loadCounting() {
  var counter = { count: 0 };
  function CountingDateTimeFormat(locale, options) {
    counter.count++;
    return new Intl.DateTimeFormat(locale, options);
  }
  var sandbox = loadBookingSandbox(['Availability.gs'], {
    Intl: { DateTimeFormat: CountingDateTimeFormat }
  });
  return { api: sandbox.BookingAvailability, counter: counter };
}

var TIMEZONES = ['Asia/Tokyo', 'UTC', 'America/New_York', 'Asia/Kathmandu', 'Europe/London', 'Australia/Lord_Howe'];
var INSTANTS = [
  '2026-01-01T00:00:00Z', '2025-12-31T14:59:59.999Z', '2025-12-31T15:00:00Z', // 年越し（JST）
  '2028-02-29T14:59:59Z', '2028-02-29T15:00:00Z', // うるう日
  '2026-03-08T06:59:59Z', '2026-03-08T07:00:00Z', // NY DST開始（曖昧/欠落の前後）
  '2026-11-01T05:59:59Z', '2026-11-01T06:00:00Z', // NY DST終了
  '2026-03-31T23:59:59Z', '2026-06-30T15:00:00Z', '2026-12-01T09:00:00.123Z'
].map(function (iso) { return new Date(iso); });

test('A. 4関数の出力が変更前実装と全TZ×全時刻で厳密一致する', function () {
  var api = loadBookingSandbox(['Availability.gs']).BookingAvailability;
  TIMEZONES.forEach(function (tz) {
    INSTANTS.forEach(function (d) {
      var label = tz + ' ' + d.toISOString();
      assert.strictEqual(api.formatDateInTimezone(d, tz), legacyFormatDate(d, tz), 'date ' + label);
      assert.strictEqual(api.getCurrentMinutesInTimezone(d, tz), legacyMinutes(d, tz), 'minutes ' + label);
      assert.strictEqual(api.formatTimeInTimezone(d, tz), legacyTime(d, tz), 'time ' + label);
    });
  });
});

test('A. ゴールデン値（変更前後で同じバグを見逃さない）', function () {
  var api = loadBookingSandbox(['Availability.gs']).BookingAvailability;
  var newYear = new Date('2025-12-31T15:00:00Z');
  assert.strictEqual(api.formatDateInTimezone(newYear, 'Asia/Tokyo'), '2026-01-01');
  assert.strictEqual(api.formatDateInTimezone(newYear, 'UTC'), '2025-12-31');
  assert.strictEqual(api.formatTimeInTimezone(new Date('2026-01-01T00:00:00Z'), 'Asia/Tokyo'), '09:00');
  assert.strictEqual(api.formatTimeInTimezone(new Date('2025-12-31T15:00:00Z'), 'Asia/Tokyo'), '00:00');
  assert.strictEqual(api.formatTimeInTimezone(new Date('2025-12-31T14:59:00Z'), 'Asia/Tokyo'), '23:59');
  assert.strictEqual(api.getCurrentMinutesInTimezone(new Date('2025-12-31T14:59:00Z'), 'Asia/Tokyo'), 1439);
  assert.strictEqual(api.getCurrentMinutesInTimezone(new Date('2025-12-31T15:00:00Z'), 'Asia/Tokyo'), 0);
  assert.strictEqual(api.getCurrentMinutesInTimezone(new Date('2026-06-30T18:15:00Z'), 'Asia/Kathmandu'), 0);
  assert.strictEqual(api.formatTimeInTimezone(new Date('2026-06-30T18:15:00Z'), 'Asia/Kathmandu'), '00:00');
  assert.strictEqual(api.formatDateInTimezone(new Date('2028-02-29T15:00:00Z'), 'Asia/Tokyo'), '2028-03-01');
  assert.strictEqual(api.formatDateInTimezone(new Date('2028-02-29T14:59:59Z'), 'Asia/Tokyo'), '2028-02-29');
  assert.strictEqual(api.zonedDateTimeToUtcMillis('2026-12-01', '09:00', 'Asia/Tokyo'), Date.parse('2026-12-01T00:00:00Z'));
  assert.strictEqual(api.zonedDateTimeToUtcMillis('2026-07-01', '12:00', 'America/New_York'), Date.parse('2026-07-01T16:00:00Z'));
  assert.strictEqual(api.zonedDateTimeToUtcMillis('2026-01-15', '12:00', 'America/New_York'), Date.parse('2026-01-15T17:00:00Z'));
  assert.strictEqual(api.zonedDateTimeToUtcMillis('2026-12-01', '00:00', 'Asia/Kathmandu'), Date.parse('2026-11-30T18:15:00Z'));
});

test('A. zonedDateTimeToUtcMillis（内部のオフセット計算を含む）が変更前の式と厳密一致する（DST曖昧・欠落時刻も旧動作どおり）', function () {
  var api = loadBookingSandbox(['Availability.gs']).BookingAvailability;
  function legacyZoned(dateString, timeString, timezone) {
    var d = dateString.split('-').map(Number);
    var t = timeString.split(':').map(Number);
    var guess = Date.UTC(d[0], d[1] - 1, d[2], t[0], t[1], 0, 0);
    var offset = legacyOffset(guess, timezone);
    if (offset === null) return null;
    return guess - offset;
  }
  ['2026-03-08', '2026-11-01', '2026-03-29', '2026-10-25', '2026-12-31', '2028-02-29', '2027-01-01'].forEach(function (day) {
    ['00:00', '01:30', '02:30', '12:00', '23:59'].forEach(function (time) {
      TIMEZONES.concat(['Not/AZone']).forEach(function (tz) {
        assert.strictEqual(api.zonedDateTimeToUtcMillis(day, time, tz), legacyZoned(day, time, tz), day + ' ' + time + ' ' + tz);
      });
    });
  });
});

test('A. 失敗時の挙動：無効Date・無効TZ・未指定/null/非文字列はnull、正常TZは影響されない', function () {
  var api = loadBookingSandbox(['Availability.gs']).BookingAvailability;
  var d = new Date('2026-12-01T00:00:00Z');
  var bad = ['Not/AZone', '', null, undefined, 123, {}, '__proto__', 'constructor'];
  // 順序: 正常→不正→別の正常→元の正常
  function sequence() {
    var out = [];
    out.push(api.formatDateInTimezone(d, 'Asia/Tokyo'));
    bad.forEach(function (tz) {
      out.push(api.formatDateInTimezone(d, tz), api.formatTimeInTimezone(d, tz), api.getCurrentMinutesInTimezone(d, tz));
    });
    out.push(api.formatDateInTimezone(d, 'America/New_York'));
    out.push(api.formatDateInTimezone(d, 'Asia/Tokyo'));
    return JSON.stringify(out);
  }
  var legacy = [];
  legacy.push(legacyFormatDate(d, 'Asia/Tokyo'));
  bad.forEach(function (tz) {
    legacy.push(legacyFormatDate(d, tz), legacyTime(d, tz), legacyMinutes(d, tz));
  });
  legacy.push(legacyFormatDate(d, 'America/New_York'));
  legacy.push(legacyFormatDate(d, 'Asia/Tokyo'));
  assert.strictEqual(sequence(), JSON.stringify(legacy));
  assert.strictEqual(sequence(), JSON.stringify(legacy), '2周目（キャッシュ済み後）も同一');
  [new Date(NaN), null, undefined, 0, 'x', {}].forEach(function (v) {
    assert.strictEqual(api.formatDateInTimezone(v, 'Asia/Tokyo'), null);
    assert.strictEqual(api.getCurrentMinutesInTimezone(v, 'Asia/Tokyo'), null);
    assert.strictEqual(api.formatTimeInTimezone(v, 'Asia/Tokyo'), null);
  });
  assert.strictEqual(api.zonedDateTimeToUtcMillis('2026-12-01', '09:00', 'Not/AZone'), null);
});

test('A. 別realmのDate（vmサンドボックス内で生成）でも同値', function () {
  var vm = require('node:vm');
  var api = loadBookingSandbox(['Availability.gs']).BookingAvailability;
  var foreign = vm.runInNewContext('new Date("2026-03-08T07:00:00Z")');
  assert.strictEqual(api.formatDateInTimezone(foreign, 'America/New_York'), legacyFormatDate(foreign, 'America/New_York'));
  assert.strictEqual(api.formatTimeInTimezone(foreign, 'America/New_York'), legacyTime(foreign, 'America/New_York'));
});

test('B. 同じTZ・同じ書式なら多数回呼んでも生成は書式ごとに1回（行数に比例しない）', function () {
  var ctx = loadCounting();
  var before = ctx.counter.count;
  assert.strictEqual(before, 0, 'ロード時（IIFE評価時）にFormatterを生成しない（遅延初期化）');
  for (var i = 0; i < 500; i++) {
    var d = new Date(Date.UTC(2026, 11, 1, 0, i));
    ctx.api.formatDateInTimezone(d, 'Asia/Tokyo');
    ctx.api.getCurrentMinutesInTimezone(d, 'Asia/Tokyo');
    ctx.api.formatTimeInTimezone(d, 'Asia/Tokyo');
    ctx.api.zonedDateTimeToUtcMillis('2026-12-01', '09:00', 'Asia/Tokyo');
  }
  // date, time（minutes/formatTimeで共有）, dateTimeSeconds の3種類のみ
  assert.strictEqual(ctx.counter.count, 3);
});

test('B. TZ・書式が違えば別Formatter（キー独立）。交互呼び出しでも結果は正しい', function () {
  var ctx = loadCounting();
  var d = new Date('2025-12-31T15:00:00Z');
  for (var i = 0; i < 20; i++) {
    assert.strictEqual(ctx.api.formatDateInTimezone(d, 'Asia/Tokyo'), '2026-01-01');
    assert.strictEqual(ctx.api.formatDateInTimezone(d, 'UTC'), '2025-12-31');
    assert.strictEqual(ctx.api.formatDateInTimezone(d, 'Bad/Zone'), null);
  }
  // Tokyo+UTCの2回 + 不正TZは毎回試行（保存しない）= 2 + 20
  assert.strictEqual(ctx.counter.count, 2 + 20);
});

test('B. 不正TZのFormatterは保存されず、正常TZの成功キャッシュで隠されない', function () {
  var ctx = loadCounting();
  var d = new Date('2026-12-01T00:00:00Z');
  assert.strictEqual(ctx.api.formatTimeInTimezone(d, 'Not/AZone'), null);
  assert.strictEqual(ctx.api.formatTimeInTimezone(d, 'Asia/Tokyo'), '09:00');
  assert.strictEqual(ctx.api.formatTimeInTimezone(d, 'Not/AZone'), null);
  var after = ctx.counter.count;
  assert.strictEqual(ctx.api.formatTimeInTimezone(d, 'Asia/Tokyo'), '09:00');
  assert.strictEqual(ctx.counter.count, after, '正常TZはヒット');
});

test('B. 未指定・null・空文字・非文字列TZはキャッシュしない（従来どおり毎回コンストラクタへ）', function () {
  var ctx = loadCounting();
  var d = new Date('2026-12-01T00:00:00Z');
  [undefined, null, '', 123].forEach(function (tz) {
    var c0 = ctx.counter.count;
    ctx.api.formatDateInTimezone(d, tz);
    ctx.api.formatDateInTimezone(d, tz);
    assert.strictEqual(ctx.counter.count - c0, 2, String(tz));
  });
});

test('B. 容量上限（12）超過でも常に正しい結果で再生成され、上限を超えて保持しない', function () {
  var ctx = loadCounting();
  var zones = [
    'Asia/Tokyo', 'UTC', 'America/New_York', 'Asia/Kathmandu', 'Europe/London', 'Australia/Lord_Howe',
    'Asia/Seoul', 'Asia/Kolkata', 'Europe/Paris', 'America/Los_Angeles', 'Pacific/Auckland',
    'Africa/Cairo', 'America/Sao_Paulo', 'Asia/Dubai', 'Europe/Berlin', 'Asia/Singapore'
  ];
  var d = new Date('2026-12-01T00:00:00Z');
  for (var round = 0; round < 3; round++) {
    zones.forEach(function (tz) {
      assert.strictEqual(ctx.api.formatTimeInTimezone(d, tz), legacyTime(d, tz), tz);
      assert.strictEqual(ctx.api.formatDateInTimezone(d, tz), legacyFormatDate(d, tz), tz);
    });
  }
  // 16TZ×2書式=32キー > 上限12なので、3周しても再生成され続ける（無制限に溜めない）= 毎周32回
  assert.ok(ctx.counter.count >= 32 * 3 - 12 * 2, '上限超過時は再生成される: ' + ctx.counter.count);
});

test('B. TZ名が__proto__等でもprototype汚染・衝突を起こさない', function () {
  var ctx = loadCounting();
  var d = new Date('2026-12-01T00:00:00Z');
  assert.strictEqual(ctx.api.formatDateInTimezone(d, '__proto__'), null);
  assert.strictEqual(ctx.api.formatDateInTimezone(d, 'constructor'), null);
  assert.strictEqual(ctx.api.formatDateInTimezone(d, 'Asia/Tokyo'), '2026-12-01');
  assert.strictEqual(({}).polluted, undefined);
});

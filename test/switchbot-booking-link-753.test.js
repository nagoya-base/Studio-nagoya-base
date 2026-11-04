/*
 * Issue #753（PR-A）: 予約システム → SwitchBot鍵連携の接続（フラグOFF）のテスト。
 * 実API・実機・GASデプロイには接続しない。コアは SwitchBotAccessCore のフェイク world で駆動する。
 *
 * 重点: ①予約変更後の旧キー削除 ②前日12:00以降の発行 ③当日予約の即時処理 ④旧予約との重複防止。
 */
'use strict';

var test = require('node:test');
var assert = require('node:assert');
var crypto = require('node:crypto');
var loadBookingSandbox = require('./helpers/gas-sandbox').loadBookingSandbox;
var stubs = require('./helpers/gas-stubs');
var C = require('../gas/switchbot-access/SwitchBotAccessCore.gs');
var S = C.STATE;

var SPREADSHEET_ID = 'ss1';
var FILES = ['Config.gs', 'Availability.gs', 'Booking.gs', 'AccessKeySnapshot.gs', 'SpreadsheetRepository.gs'];

function jst(date, time) { return new Date(date + 'T' + time + '+09:00'); }

function load(sheetsByName, extraGlobals) {
  var spreadsheetsById = {};
  spreadsheetsById[SPREADSHEET_ID] = sheetsByName || {};
  var logged = [];
  var globals = Object.assign({
    PropertiesService: stubs.createPropertiesServiceStub({ SPREADSHEET_ID: SPREADSHEET_ID }),
    SpreadsheetApp: stubs.createSpreadsheetAppStub(spreadsheetsById),
    console: { error: function (m) { logged.push(String(m)); } }
  }, extraGlobals || {});
  var sandbox = loadBookingSandbox(FILES, globals);
  sandbox._logged = logged;
  return sandbox;
}

function record(over) {
  return Object.assign({
    bookingId: 'SNB-20301111-AAAAAAAA',
    createdAt: jst('2030-01-05', '10:00'),
    date: '2030-01-11',
    startAt: jst('2030-01-11', '10:00'),
    endAt: jst('2030-01-11', '12:00'),
    brand: 'snb', name: '山田太郎', email: 'taro@example.com', phone: '090-0000-0000',
    people: '2名', purpose: '練習', paymentMethod: 'オンラインクレジットカード',
    status: 'CONFIRMED', calendarEventId: 'ev1', source: 'test', note: '',
    paymentStatus: 'paid', paymentConfirmedAt: jst('2030-01-05', '10:05'), confirmedAt: jst('2030-01-05', '10:05')
  }, over || {});
}

// ---------------------------------------------------------------- スキーマ

test('スキーマ: revision は Bookings の末尾列（途中挿入なし・重複なし）', function () {
  var h = loadBookingSandbox(['BookingsSchema.gs'], {}).BookingsSchema.HEADERS;
  assert.strictEqual(h[h.length - 1], 'revision');
  assert.strictEqual(h.filter(function (x) { return x === 'revision'; }).length, 1);
  assert.strictEqual(h[h.length - 2], 'supportBackdrop', '既存の末尾列は移動しない');
});

// ---------------------------------------------------------------- JST変換

test('JST変換: Date/ISO文字列とも UTC演算でJSTの日付・時刻へ。日付跨ぎ・年跨ぎ・24:00終了', function () {
  var S_ = load().AccessKeySnapshot;
  assert.deepStrictEqual(JSON.parse(JSON.stringify(S_.toJst(new Date('2026-11-04T15:30:00Z')))), { date: '2026-11-05', time: '00:30', aligned: true });
  assert.strictEqual(S_.toJst(new Date('2026-12-31T14:59:00Z')).date, '2026-12-31');
  assert.strictEqual(S_.toJst(new Date('2026-12-31T14:59:00Z')).time, '23:59');
  var ny = S_.toJst(new Date('2026-12-31T15:00:00Z'));
  assert.strictEqual(ny.date + ' ' + ny.time, '2027-01-01 00:00');
  assert.strictEqual(S_.toJst('2030-01-11T10:00:00+09:00').time, '10:00', 'ISO文字列でも同じ（二重変換しない）');
  assert.strictEqual(S_.toJst(jst('2030-01-11', '10:00')).time, '10:00');
  assert.strictEqual(S_.toJst('not a date'), null);
  assert.strictEqual(S_.toJst(null), null);
});

test('スナップショット: 日付跨ぎの予約は endDate を別に持ち、24:00終了は翌日00:00', function () {
  var S_ = load().AccessKeySnapshot;
  var sn = S_.build(record({ startAt: jst('2030-01-11', '22:00'), endAt: jst('2030-01-12', '00:00') }), { facility: 'main' });
  assert.deepStrictEqual([sn.date, sn.startTime, sn.endDate, sn.endTime], ['2030-01-11', '22:00', '2030-01-12', '00:00']);
  assert.deepStrictEqual(Array.from(sn.blockers), []);
});

test('スナップショット: 分未満(秒)の日時は丸めず止める。開始>=終了も止める', function () {
  var S_ = load().AccessKeySnapshot;
  assert.ok(Array.from(S_.build(record({ endAt: new Date(jst('2030-01-11', '12:00').getTime() + 30000) })).blockers).indexOf('TIME_NOT_MINUTE_ALIGNED') !== -1);
  assert.ok(Array.from(S_.build(record({ startAt: jst('2030-01-11', '12:00'), endAt: jst('2030-01-11', '10:00') })).blockers).indexOf('TIME_INVALID') !== -1);
  assert.ok(Array.from(S_.build(record({ startAt: '' })).blockers).indexOf('TIME_INVALID') !== -1);
});

// ---------------------------------------------------------------- スナップショット

test('スナップショット: 個人情報を含まない・空revisionは0・支払根拠を正規化', function () {
  var S_ = load().AccessKeySnapshot;
  var sn = S_.build(record(), { facility: 'main' });
  assert.strictEqual(sn.revision, 0);
  assert.strictEqual(sn.paymentStatus, 'STRIPE_PAID');
  var text = JSON.stringify(sn);
  ['山田', 'taro@', '090-', '練習'].forEach(function (pii) { assert.strictEqual(text.indexOf(pii), -1, pii); });
  assert.deepStrictEqual(Object.keys(sn).sort(), ['blockers', 'bookingId', 'brand', 'date', 'digest', 'endDate', 'endTime', 'facility', 'paymentStatus', 'revision', 'room', 'startTime', 'status'].sort());
});

test('支払根拠: Stripeは実入金(paid+確認時刻)のみ。現金/PayPayは管理者確定の台帳根拠が無ければ安全停止', function () {
  var S_ = load().AccessKeySnapshot;
  function b(over) { return Array.from(S_.build(record(over)).blockers); }
  assert.deepStrictEqual(b({}), []);
  assert.ok(b({ paymentStatus: 'checkout_pending' }).indexOf('PAYMENT_UNVERIFIED') !== -1, 'Stripe未入金');
  assert.ok(b({ paymentConfirmedAt: '' }).indexOf('PAYMENT_UNVERIFIED') !== -1, '入金確認時刻なし');
  assert.deepStrictEqual(b({ paymentMethod: '現金', paymentStatus: 'not_started', paymentConfirmedAt: '' }), [], '現金: confirmedAtあり=管理者確定');
  assert.strictEqual(S_.build(record({ paymentMethod: 'PayPay', paymentStatus: 'not_started', paymentConfirmedAt: '' })).paymentStatus, 'ADMIN_APPROVED');
  assert.ok(b({ paymentMethod: '現金', paymentStatus: 'not_started', paymentConfirmedAt: '', confirmedAt: '' }).indexOf('PAYMENT_UNVERIFIED') !== -1, '現金: 承認根拠なし');
});

test('復活(expiredAtが残る)した現金/PayPayは復活だけでは承認扱いにしない。Stripeは実入金なら従来どおり', function () {
  var S_ = load().AccessKeySnapshot;
  var revived = { paymentMethod: '現金', paymentStatus: 'not_started', paymentConfirmedAt: '', expiredAt: jst('2030-01-06', '10:00') };
  assert.ok(Array.from(S_.build(record(revived)).blockers).indexOf('PAYMENT_UNVERIFIED') !== -1);
  assert.strictEqual(S_.build(record(revived)).paymentStatus, 'UNVERIFIED');
  assert.deepStrictEqual(Array.from(S_.build(record({ expiredAt: jst('2030-01-06', '10:00') })).blockers), [], 'Stripe: 実入金確認があれば復活後も対象');
});

test('延長の未決済/要復旧/ブランド/revision異常はblockerになる', function () {
  var S_ = load().AccessKeySnapshot;
  function b(over) { return Array.from(S_.build(record(over)).blockers); }
  assert.ok(b({ feeSettlementState: 'PENDING_CHARGE' }).indexOf('EXTENSION_CHARGE_PENDING') !== -1);
  assert.ok(b({ feeSettlementState: 'PENDING_DECISION' }).indexOf('EXTENSION_CHARGE_PENDING') !== -1);
  assert.deepStrictEqual(b({ feeSettlementState: 'PENDING_REFUND' }), [], '短縮の返金待ちは鍵を止めない');
  assert.ok(b({ feeRecoveryRequiredAt: jst('2030-01-06', '10:00') }).indexOf('RECOVERY_REQUIRED') !== -1);
  assert.ok(b({ paymentRecoveryRequiredAt: jst('2030-01-06', '10:00') }).indexOf('RECOVERY_REQUIRED') !== -1);
  assert.ok(b({ brand: '' }).indexOf('BRAND_UNKNOWN') !== -1, '空brandをSNB扱いにしない');
  assert.deepStrictEqual(b({ brand: 'mens' }), [], '他ブランドは対象外(コアで発行せず旧キー回収)');
  assert.ok(b({ revision: 'abc' }).indexOf('REVISION_INVALID') !== -1);
  assert.ok(b({ revision: -1 }).indexOf('REVISION_INVALID') !== -1);
  assert.strictEqual(S_.build(record({ revision: 7 })).revision, 7);
});

test('鍵に関係する変更の判定: 人数・メール送信済み・同値再書込み・PENDING中の更新では増やさない', function () {
  var S_ = load().AccessKeySnapshot;
  var base = record();
  assert.strictEqual(S_.isKeyRelevantChange(base, Object.assign({}, base, { people: '5名' })), false);
  assert.strictEqual(S_.isKeyRelevantChange(base, Object.assign({}, base, { reminderSentAt: new Date() })), false);
  assert.strictEqual(S_.isKeyRelevantChange(base, Object.assign({}, base, { startAt: jst('2030-01-11', '10:00') })), false, '別オブジェクトの同時刻');
  assert.strictEqual(S_.isKeyRelevantChange(base, Object.assign({}, base, { endAt: jst('2030-01-11', '13:00') })), true);
  assert.strictEqual(S_.isKeyRelevantChange(base, Object.assign({}, base, { status: 'CANCELLED' })), true);
  var pending = record({ status: 'PENDING' });
  assert.strictEqual(S_.isKeyRelevantChange(pending, Object.assign({}, pending, { endAt: jst('2030-01-11', '13:00'), paymentStatus: 'checkout_pending' })), false);
  assert.strictEqual(S_.isKeyRelevantChange(pending, Object.assign({}, pending, { status: 'CONFIRMED' })), true, '確定');
});

// ---------------------------------------------------------------- revision (SpreadsheetRepository)

function repoWith(rec) {
  var sandbox = load();
  sandbox.SpreadsheetRepository.appendBooking(rec || record({ status: 'PENDING', paymentStatus: 'not_started', paymentConfirmedAt: '', confirmedAt: '' }));
  var id = (rec || record()).bookingId;
  return {
    sandbox: sandbox, id: id, repo: sandbox.SpreadsheetRepository,
    rev: function () { return sandbox.SpreadsheetRepository.findRowByBookingId(id).record.revision; },
    row: function () { return sandbox.SpreadsheetRepository.findRowByBookingId(id).record; }
  };
}

test('revision: 確定で増え、同じ更新の再実行・人数のみの変更では増えない', function () {
  var t = repoWith();
  assert.strictEqual(t.rev() === '' || t.rev() === undefined || t.rev() === 0, true, '新規行はrevision未設定=0');
  t.repo.updateBookingFields(t.id, { people: '3名' });
  t.repo.updateBookingFields(t.id, { endAt: jst('2030-01-11', '13:00') });
  assert.ok(!t.rev(), 'PENDING中の更新では増えない');
  t.repo.updateBookingFields(t.id, { status: 'CONFIRMED', confirmedAt: jst('2030-01-05', '10:05') });
  assert.strictEqual(t.rev(), 1);
  t.repo.updateBookingFields(t.id, { status: 'CONFIRMED', confirmedAt: jst('2030-01-05', '10:05') });
  assert.strictEqual(t.rev(), 1, '同値の再実行/再配信では増えない');
  t.repo.updateBookingFields(t.id, { people: '4名', reminderSentAt: new Date() });
  assert.strictEqual(t.rev(), 1, '人数/メール送信済みでは増えない');
});

test('revision: 日時変更・延長・短縮・連続変更・元に戻す変更は単調増加（戻しも新revision）', function () {
  var t = repoWith(record());
  var orig = [jst('2030-01-11', '10:00'), jst('2030-01-11', '12:00')];
  t.repo.updateBookingScheduleAtomic(t.id, '2030-01-11', orig[0], jst('2030-01-11', '14:00'));
  assert.strictEqual(t.rev(), 1, '延長');
  t.repo.updateBookingScheduleAtomic(t.id, '2030-01-11', jst('2030-01-11', '09:00'), jst('2030-01-11', '14:00'));
  assert.strictEqual(t.rev(), 2, '開始繰上げ');
  t.repo.updateBookingScheduleAtomic(t.id, '2030-01-12', jst('2030-01-12', '09:00'), jst('2030-01-12', '14:00'));
  assert.strictEqual(t.rev(), 3, '日付変更');
  t.repo.updateBookingScheduleAtomic(t.id, '2030-01-11', orig[0], orig[1]);
  assert.strictEqual(t.rev(), 4, '元の日時へ戻しても新revision（A→B→AでAのrevisionを再利用しない）');
  t.repo.updateBookingScheduleAtomic(t.id, '2030-01-11', jst('2030-01-11', '10:00'), jst('2030-01-11', '12:00'));
  assert.strictEqual(t.rev(), 4, '同一日時の再書込みは増えない');
});

test('revision: 取消・失効・復活・支払状態・延長の追加料金待ち・要復旧フラグで増える', function () {
  var t = repoWith(record());
  t.repo.updateBookingCancellationStateAtomic(t.id, { status: 'CANCELLED', cancelledAt: new Date(), updatedAt: new Date() });
  assert.strictEqual(t.rev(), 1, '取消');
  var t2 = repoWith(record({ status: 'EXPIRED' }));
  t2.repo.updateBookingFields(t2.id, { status: 'CONFIRMED', confirmedAt: new Date() });
  assert.strictEqual(t2.rev(), 1, 'EXPIRED→CONFIRMED(復活)');
  var t3 = repoWith(record());
  t3.repo.updateBookingRescheduleFeeAtomic(t3.id, { feeSettlementState: 'PENDING_CHARGE' });
  assert.strictEqual(t3.rev(), 1, '追加料金待ち');
  t3.repo.updateBookingFields(t3.id, { feeRecoveryRequiredAt: new Date(), feeRecoveryReason: 'x' });
  assert.strictEqual(t3.rev(), 2, '要復旧');
  t3.repo.updateBookingFields(t3.id, { paymentStatus: 'refund_pending' });
  assert.strictEqual(t3.rev(), 3, '返金待ちへ');
});

test('revision: 空欄は0、数値文字列は加算、不正値は予約処理を失敗させず固定コードだけログ', function () {
  var t = repoWith(record());
  t.repo.updateBookingFields(t.id, { endAt: jst('2030-01-11', '13:00') });
  assert.strictEqual(t.rev(), 1);
  var cellOf = function (sandbox) { return sandbox.SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName('Bookings'); };
  var sheet = cellOf(t.sandbox);
  var col = t.repo.HEADERS.indexOf('revision');
  sheet._rows[1][col] = '5';
  t.repo.updateBookingFields(t.id, { endAt: jst('2030-01-11', '14:00') });
  assert.strictEqual(t.rev(), 6);
  sheet._rows[1][col] = 'abc';
  t.repo.updateBookingFields(t.id, { endAt: jst('2030-01-11', '15:00') });
  assert.strictEqual(t.rev(), 'abc', '不正値は上書きしない');
  assert.strictEqual(t.row().endAt.getTime(), jst('2030-01-11', '15:00').getTime(), '予約の更新自体は成功');
  assert.deepStrictEqual(t.sandbox._logged, ['ACCESS_KEY_REVISION_BUMP_FAILED: REVISION_INVALID']);
});

test('revision: 未migration(列なし)・列がグリッド外・書込み失敗でも予約更新は成功し巻き戻さない', function () {
  /* 旧ヘッダー(revision列なし)のシート。 */
  var sandbox = load();
  var H = sandbox.SpreadsheetRepository.HEADERS;
  var spreadsheetsById = {}; spreadsheetsById[SPREADSHEET_ID] = {};
  var sheet = stubs.createSpreadsheetAppStub(spreadsheetsById).openById(SPREADSHEET_ID).insertSheet('Bookings');
  sheet.appendRow(H.slice(0, -1));
  var sb = loadBookingSandbox(FILES, {
    PropertiesService: stubs.createPropertiesServiceStub({ SPREADSHEET_ID: SPREADSHEET_ID }),
    SpreadsheetApp: stubs.createSpreadsheetAppStub({ [SPREADSHEET_ID]: { Bookings: sheet } }),
    console: { error: function (m) { sb._logged.push(m); } }
  });
  sb._logged = [];
  var old = H.slice(0, -1).map(function (h) { var r = record(); return r[h] === undefined ? '' : r[h]; });
  sheet.appendRow(old);
  sb.SpreadsheetRepository.updateBookingFields('SNB-20301111-AAAAAAAA', { status: 'CANCELLED' });
  assert.strictEqual(sb.SpreadsheetRepository.findRowByBookingId('SNB-20301111-AAAAAAAA').record.status, 'CANCELLED');
  assert.strictEqual(sheet._rows[1].length, H.length - 1, 'revisionセルを書かない');
  assert.deepStrictEqual(sb._logged, ['ACCESS_KEY_REVISION_BUMP_FAILED: REVISION_COLUMN_MISSING']);

  /* 実GASでグリッド外へのgetRangeは例外になる。 */
  var realGetRange = sheet.getRange;
  sheet.getRange = function (row, col) { if (col > H.length - 1) throw new Error('out of grid'); return realGetRange.apply(sheet, arguments); };
  sb.SpreadsheetRepository.updateBookingFields('SNB-20301111-AAAAAAAA', { status: 'CONFIRMED' });
  assert.strictEqual(sb.SpreadsheetRepository.findRowByBookingId('SNB-20301111-AAAAAAAA').record.status, 'CONFIRMED');

  /* revisionセルの書込みだけ失敗。 */
  var t = repoWith(record());
  var sh = t.sandbox.SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName('Bookings');
  var rc = t.repo.HEADERS.indexOf('revision') + 1;
  var orig = sh.getRange;
  sh.getRange = function (row, col, nr, nc) {
    var r = orig.apply(sh, arguments);
    if (row > 1 && col === rc) { var sv = r.setValue; r.setValue = function () { throw new Error('quota'); }; }
    return r;
  };
  t.repo.updateBookingFields(t.id, { status: 'CANCELLED' });
  assert.strictEqual(t.row().status, 'CANCELLED', 'revision書込み失敗でも取消は残る');
  assert.deepStrictEqual(t.sandbox._logged, ['ACCESS_KEY_REVISION_BUMP_FAILED: REVISION_WRITE_FAILED']);
});

test('既存行(旧スキーマ)のsnapshot: revision空欄でもfailせず0で読める', function () {
  var sandbox = load();
  sandbox.SpreadsheetRepository.appendBooking(record());
  var found = sandbox.SpreadsheetRepository.findRowByBookingId('SNB-20301111-AAAAAAAA');
  var sn = sandbox.AccessKeySnapshot.build(found.record);
  assert.strictEqual(sn.revision, 0);
});

// ---------------------------------------------------------------- 発行開始・照合条件

test('発行開始: 前日12:00JST。11:59:59は前、12:00:00から。月・年・うるう日跨ぎ', function () {
  var S_ = load().AccessKeySnapshot;
  function open(date, iso) { return S_.issueWindow({ date: date }, Date.parse(iso)).open; }
  assert.strictEqual(open('2030-01-11', '2030-01-10T11:59:59+09:00'), false);
  assert.strictEqual(open('2030-01-11', '2030-01-10T12:00:00+09:00'), true);
  assert.strictEqual(open('2030-01-01', '2029-12-31T11:59:59+09:00'), false, '年跨ぎ');
  assert.strictEqual(open('2030-01-01', '2029-12-31T12:00:00+09:00'), true);
  assert.strictEqual(open('2030-03-01', '2030-02-28T12:00:00+09:00'), true, '平年の月跨ぎ');
  assert.strictEqual(open('2032-03-01', '2032-02-28T12:00:00+09:00'), false, 'うるう年は前日=2/29');
  assert.strictEqual(open('2032-03-01', '2032-02-29T12:00:00+09:00'), true);
  assert.strictEqual(S_.issueWindow({ date: 'bad' }, 0).open, false);
});

test('照合条件は独立: revision不変でも12:00到達で処理・未完了状態があれば処理・何もなければ処理しない', function () {
  var S_ = load().AccessKeySnapshot;
  var sn = S_.build(record({ revision: 3 }), { facility: 'main' });
  var before = Date.parse('2030-01-10T11:59:59+09:00');
  var after = Date.parse('2030-01-10T12:00:00+09:00');
  assert.deepStrictEqual(Array.from(S_.triggers(sn, { revision: 3, issueWindowHandled: false, openKeyRecord: false }, before)), []);
  assert.deepStrictEqual(Array.from(S_.triggers(sn, { revision: 3, issueWindowHandled: false, openKeyRecord: false }, after)), ['ISSUE_WINDOW_REACHED']);
  assert.deepStrictEqual(Array.from(S_.triggers(sn, { revision: 3, issueWindowHandled: true, openKeyRecord: false }, after)), []);
  assert.deepStrictEqual(Array.from(S_.triggers(sn, { revision: 2, issueWindowHandled: true, openKeyRecord: false }, before)), ['REVISION_CHANGED']);
  assert.deepStrictEqual(Array.from(S_.triggers(sn, { revision: null }, before)), ['REVISION_CHANGED'], '初回取り込み');
  assert.deepStrictEqual(Array.from(S_.triggers(sn, { revision: 3, issueWindowHandled: true, openKeyRecord: true }, before)), ['OPEN_KEY_RECORD']);
});

// ---------------------------------------------------------------- コア結線（フェイクSwitchBot）

var DEV = 'AAAAAAAAAAAA01FD';
var DEV_HOME = 'BBBBBBBBBBBB37DD';

function coreConfig(over) {
  return Object.assign({
    enabled: true, commercialUseApproved: true,
    eligiblePaymentStatuses: ['STRIPE_PAID', 'ADMIN_APPROVED'], eligibleBrands: ['snb'],
    graceBeforeSec: 900, graceAfterSec: 900,
    keypads: [{ brand: 'snb', facility: 'main', deviceId: DEV }],
    maxReads: 3, webhookWaitSec: 90
  }, over || {});
}

function world(nowIso) {
  var w = { now: Date.parse(nowIso) / 1000, store: {}, secrets: {}, notes: [], calls: [], seq: 100, keys: {}, deleteMode: 'ok' };
  w.keys[DEV] = []; w.keys[DEV_HOME] = [];
  w.deps = function () {
    return {
      store: {
        get: function (k) { return w.store[k] === undefined ? null : w.store[k]; },
        set: function (k, v) { w.store[k] = v; },
        del: function (k) { delete w.store[k]; },
        keys: function () { return Object.keys(w.store); }
      },
      secrets: {
        get: function (k) { return w.secrets[k] === undefined ? null : w.secrets[k]; },
        set: function (k, v) { w.secrets[k] = v; },
        del: function (k) { delete w.secrets[k]; }
      },
      lock: function (keys, fn) { return fn(); },
      api: {
        listDevices: function () {
          w.calls.push('list');
          return { ok: true, devices: Object.keys(w.keys).map(function (id) {
            return { deviceId: id, deviceType: 'Keypad', keyList: w.keys[id].map(function (k) { return Object.assign({}, k); }) };
          }) };
        },
        createKey: function (p) {
          w.calls.push('create:' + p.deviceId);
          w.keys[p.deviceId].push({ id: String(++w.seq), name: p.name, type: 'timeLimit', startTime: String(p.startTime), endTime: String(p.endTime) });
          return { httpCode: 200, parsed: { statusCode: 100, body: {} } };
        },
        deleteKey: function (dev, id) {
          w.calls.push('delete:' + id);
          if (w.deleteMode !== 'noApply') w.keys[dev] = w.keys[dev].filter(function (k) { return k.id !== id; });
          return { httpCode: 200, parsed: { statusCode: 100, body: {} } };
        }
      },
      notifyAdmin: function (e) { w.notes.push(e); },
      deliverCode: function () {},
      sha256Hex: function (s) { return crypto.createHash('sha256').update(s).digest('hex'); },
      randomInt: function (n) { return crypto.randomInt(n); },
      nowSec: function () { return w.now; }
    };
  };
  w.engine = function (cfg) { return C.createEngine(w.deps(), cfg || coreConfig()); };
  w.mutations = function () { return w.calls.filter(function (c) { return c.indexOf('create:') === 0 || c.indexOf('delete:') === 0; }); };
  w.records = function () {
    return Object.keys(w.store).filter(function (k) { return k.indexOf('OP_') === 0; }).map(function (k) { return JSON.parse(w.store[k]); });
  };
  w.at = function (iso) { w.now = Date.parse(iso) / 1000; };
  return w;
}

/** 台帳レコード → スナップショット → 処理方針 → コア sync。FREEZEならsyncを呼ばず管理者通知相当を返す。 */
function drive(sandbox, w, engine, rec) {
  var sn = sandbox.AccessKeySnapshot.build(rec, { facility: 'main' });
  var plan = sandbox.AccessKeySnapshot.toCoreInput(sn, w.now * 1000);
  if (plan.action === 'FREEZE') return { frozen: Array.from(plan.reasons) };
  return { result: engine.sync(plan.booking), plan: plan };
}

test('①②前日12:00前は発行せず、同revisionのまま12:00:00で初めて1件だけ発行(revision不変でも時刻到達で処理)', function () {
  var sandbox = load();
  var w = world('2030-01-10T11:59:59+09:00');
  var e = w.engine();
  var rec = record({ revision: 1 });
  var r1 = drive(sandbox, w, e, rec);
  assert.deepStrictEqual(Array.from(r1.plan.reasons), ['BEFORE_ISSUE_WINDOW']);
  assert.deepStrictEqual(w.mutations(), [], '11:59:59は発行しない');
  w.at('2030-01-10T12:00:00+09:00');
  drive(sandbox, w, e, rec);
  assert.strictEqual(w.mutations().length, 1);
  assert.deepStrictEqual(w.mutations(), ['create:' + DEV]);
  assert.strictEqual(w.records()[0].revision, 1);
  assert.strictEqual(w.records()[0].state, S.ISSUED_CONFIRMED);
  drive(sandbox, w, e, rec); drive(sandbox, w, w.engine(), rec);
  assert.strictEqual(w.mutations().length, 1, '再照合・別インスタンスでも重複しない');
});

test('③当日予約: 確定した最初の照合で即時発行(前日12:00を過ぎている)。利用中(開始後・終了前)の確定も同様', function () {
  var sandbox = load();
  var w = world('2030-01-11T09:00:00+09:00');
  var e = w.engine();
  drive(sandbox, w, e, record({ revision: 1 }));
  assert.strictEqual(w.mutations().length, 1);
  assert.strictEqual(w.keys[DEV].length, 1);
  var w2 = world('2030-01-11T10:30:00+09:00');
  drive(sandbox, w2, w2.engine(), record({ bookingId: 'SNB-X', revision: 1 }));
  assert.strictEqual(w2.mutations().length, 1, '開始後でも終了(+15分)前なら発行');
  var w3 = world('2030-01-11T12:15:00+09:00');
  drive(sandbox, w3, w3.engine(), record({ bookingId: 'SNB-Y', revision: 1 }));
  assert.deepStrictEqual(w3.mutations(), [], '終了+15分以降は発行しない');
});

test('①予約変更(別日): 旧キーを削除確認してから、新しい日の12:00以降に新キー。常に有効キーは高々1件', function () {
  var sandbox = load();
  var w = world('2030-01-10T13:00:00+09:00');
  var e = w.engine();
  drive(sandbox, w, e, record({ revision: 1 }));
  var oldName = w.keys[DEV][0].name;
  assert.strictEqual(w.keys[DEV].length, 1);
  var moved = record({ revision: 2, date: '2030-01-18', startAt: jst('2030-01-18', '10:00'), endAt: jst('2030-01-18', '12:00') });
  drive(sandbox, w, e, moved);
  assert.strictEqual(w.keys[DEV].length, 0, '旧キーは削除済み');
  assert.deepStrictEqual(w.mutations(), ['create:' + DEV, 'delete:101'], '新日付の発行開始前なので新キーは作らない');
  assert.strictEqual(w.records()[0].state, S.DELETED_CONFIRMED);
  w.at('2030-01-17T12:00:00+09:00');
  drive(sandbox, w, e, moved);
  assert.strictEqual(w.keys[DEV].length, 1);
  assert.notStrictEqual(w.keys[DEV][0].name, oldName);
  assert.strictEqual(w.mutations().length, 3);
  var recs = w.records();
  assert.deepStrictEqual(recs.map(function (r) { return r.revision; }), [1, 2]);
});

test('①予約変更(当日延長・開始繰上げ): 旧キー削除→新期間キー。失敗中も併存させない', function () {
  var sandbox = load();
  var w = world('2030-01-11T08:00:00+09:00');
  var e = w.engine();
  drive(sandbox, w, e, record({ revision: 1 }));
  drive(sandbox, w, e, record({ revision: 2, endAt: jst('2030-01-11', '14:00') }));
  assert.strictEqual(w.keys[DEV].length, 1);
  assert.strictEqual(w.records()[1].endSec, C.jstToEpochSec('2030-01-11', '14:00') + 900);
  drive(sandbox, w, e, record({ revision: 3, startAt: jst('2030-01-11', '09:00'), endAt: jst('2030-01-11', '14:00') }));
  assert.strictEqual(w.keys[DEV].length, 1);
  assert.strictEqual(w.records()[2].startSec, C.jstToEpochSec('2030-01-11', '09:00') - 900);
  assert.strictEqual(w.mutations().filter(function (m) { return m.indexOf('delete') === 0; }).length, 2);
});

test('①削除が反映されない(UNKNOWN)間は新キーを作らず再送もしない。管理者通知', function () {
  var sandbox = load();
  var w = world('2030-01-11T08:00:00+09:00');
  var e = w.engine();
  drive(sandbox, w, e, record({ revision: 1 }));
  w.deleteMode = 'noApply';
  drive(sandbox, w, e, record({ revision: 2, endAt: jst('2030-01-11', '14:00') }));
  for (var i = 0; i < 5; i++) { w.at('2030-01-11T08:0' + (i + 1) + ':00+09:00'); drive(sandbox, w, e, record({ revision: 2, endAt: jst('2030-01-11', '14:00') })); }
  var creates = w.mutations().filter(function (m) { return m.indexOf('create') === 0; });
  var deletes = w.mutations().filter(function (m) { return m.indexOf('delete') === 0; });
  assert.strictEqual(creates.length, 1, '新キーを発行しない');
  assert.strictEqual(deletes.length, 1, 'deleteKeyを自動再送しない');
  assert.ok(w.notes.length >= 1);
  assert.ok(w.records().some(function (r) { return r.state === S.UNKNOWN; }));
});

test('延長の追加料金待ち・支払不明・要復旧は鍵操作を凍結し、既存キーを残す(削除も発行もしない)', function () {
  var sandbox = load();
  var w = world('2030-01-11T08:00:00+09:00');
  var e = w.engine();
  drive(sandbox, w, e, record({ revision: 1 }));
  var before = w.mutations().length;
  var f1 = drive(sandbox, w, e, record({ revision: 2, endAt: jst('2030-01-11', '14:00'), feeSettlementState: 'PENDING_CHARGE' }));
  assert.deepStrictEqual(f1.frozen, ['EXTENSION_CHARGE_PENDING']);
  var f2 = drive(sandbox, w, e, record({ revision: 3, paymentStatus: 'checkout_pending' }));
  assert.deepStrictEqual(f2.frozen, ['PAYMENT_UNVERIFIED']);
  var f3 = drive(sandbox, w, e, record({ revision: 4, feeRecoveryRequiredAt: new Date() }));
  assert.deepStrictEqual(f3.frozen, ['RECOVERY_REQUIRED']);
  assert.strictEqual(w.mutations().length, before, '鍵APIを呼ばない');
  assert.strictEqual(w.keys[DEV].length, 1, '旧キーは残る');
  /* 精算が済んだ最新revisionで初めて入れ替わる。 */
  drive(sandbox, w, e, record({ revision: 5, endAt: jst('2030-01-11', '14:00'), feeSettlementState: 'SETTLED' }));
  assert.strictEqual(w.keys[DEV].length, 1);
  assert.strictEqual(w.records()[1].endSec, C.jstToEpochSec('2030-01-11', '14:00') + 900);
});

test('①取消: 旧キー削除。取消は凍結要因(支払不明等)があっても削除へ進む。遅れて届く古い確定は発行しない', function () {
  var sandbox = load();
  var w = world('2030-01-11T08:00:00+09:00');
  var e = w.engine();
  drive(sandbox, w, e, record({ revision: 1 }));
  drive(sandbox, w, e, record({ revision: 2, status: 'CANCELLED', paymentStatus: 'refund_pending', feeRecoveryRequiredAt: new Date() }));
  assert.strictEqual(w.keys[DEV].length, 0);
  var n = w.mutations().length;
  var late = drive(sandbox, w, e, record({ revision: 1 }));
  assert.ok(late.result.skipped === 'STALE_REVISION' || late.result.skipped === 'AFTER_CANCEL');
  assert.strictEqual(w.mutations().length, n);
  var late2 = drive(sandbox, w, e, record({ revision: 2 }));
  assert.strictEqual(w.mutations().length, n, '同revisionの確定再配信でも復活しない');
  assert.ok(late2.result.skipped);
});

test('①SNB対象外化: 延長待ち/要復旧が残っていても旧キー削除へ進む(凍結しない)。brand空は凍結', function () {
  var sandbox = load();
  var w = world('2030-01-11T08:00:00+09:00');
  var e = w.engine();
  drive(sandbox, w, e, record({ revision: 1 }));
  var r = drive(sandbox, w, e, record({ revision: 2, brand: 'mens', feeSettlementState: 'PENDING_CHARGE', feeRecoveryRequiredAt: new Date() }));
  assert.ok(!r.frozen);
  assert.strictEqual(w.keys[DEV].length, 0);
  var w2 = world('2030-01-11T08:00:00+09:00');
  drive(sandbox, w2, w2.engine(), record({ revision: 1 }));
  var f = drive(sandbox, w2, w2.engine(), record({ revision: 2, brand: '' }));
  assert.deepStrictEqual(f.frozen, ['BRAND_UNKNOWN']);
  assert.strictEqual(w2.keys[DEV].length, 1);
});

test('①SNB対象外化(他ブランドへ変更): 旧キーを削除し、新規発行しない', function () {
  var sandbox = load();
  var w = world('2030-01-11T08:00:00+09:00');
  var e = w.engine();
  drive(sandbox, w, e, record({ revision: 1 }));
  drive(sandbox, w, e, record({ revision: 2, brand: 'studio_x' }));
  assert.strictEqual(w.keys[DEV].length, 0);
  assert.strictEqual(w.mutations().filter(function (m) { return m.indexOf('create') === 0; }).length, 1);
});

test('④旧改訂の再配信・順不同・復活の重複: 古いrevisionは無視し、同じ対象に2件目を作らない', function () {
  var sandbox = load();
  var w = world('2030-01-11T08:00:00+09:00');
  var e = w.engine();
  drive(sandbox, w, e, record({ revision: 1 }));
  drive(sandbox, w, e, record({ revision: 2, endAt: jst('2030-01-11', '14:00') }));
  var n = w.mutations().length;
  var stale = drive(sandbox, w, e, record({ revision: 1 }));
  assert.strictEqual(stale.result.skipped, 'STALE_REVISION');
  drive(sandbox, w, e, record({ revision: 2, endAt: jst('2030-01-11', '14:00') }));
  drive(sandbox, w, w.engine(), record({ revision: 2, endAt: jst('2030-01-11', '14:00') }));
  assert.strictEqual(w.mutations().length, n);
  assert.strictEqual(w.keys[DEV].length, 1);
});

test('④別予約は別キー。同じ時間帯でも予約IDごとに独立し、取消した予約のキーだけが消える', function () {
  var sandbox = load();
  var w = world('2030-01-11T08:00:00+09:00');
  var e = w.engine();
  drive(sandbox, w, e, record({ bookingId: 'SNB-A', revision: 1 }));
  drive(sandbox, w, e, record({ bookingId: 'SNB-B', revision: 1, startAt: jst('2030-01-11', '12:30'), endAt: jst('2030-01-11', '14:00') }));
  assert.strictEqual(w.keys[DEV].length, 2);
  drive(sandbox, w, e, record({ bookingId: 'SNB-A', revision: 2, status: 'CANCELLED' }));
  assert.strictEqual(w.keys[DEV].length, 1);
  assert.strictEqual(w.records().filter(function (r) { return r.bookingId === 'SNB-B' && r.state === S.ISSUED_CONFIRMED; }).length, 1);
});

test('37DD(自宅検証機)は対応表に無ければ送信せず停止。台帳側は施設名しか渡さない', function () {
  var sandbox = load();
  var w = world('2030-01-11T08:00:00+09:00');
  var cfg = coreConfig({ keypads: [{ brand: 'snb', facility: 'home', deviceId: DEV_HOME }] });
  drive(sandbox, w, w.engine(cfg), record({ revision: 1 }));
  assert.deepStrictEqual(w.mutations(), [], 'facility=main に対応するKeypad無し→送信ゼロ');
  assert.strictEqual(w.keys[DEV_HOME].length, 0);
});

test('フラグOFF: スナップショットを渡しても鍵APIを呼ばず状態も書かない(新コードの配送ゼロ)', function () {
  var sandbox = load();
  var w = world('2030-01-11T08:00:00+09:00');
  var e = w.engine(coreConfig({ enabled: false }));
  var r = drive(sandbox, w, e, record({ revision: 1 }));
  assert.strictEqual(r.result.skipped, 'FLAG_OFF');
  assert.deepStrictEqual(w.calls, []);
  assert.deepStrictEqual(Object.keys(w.store), []);
});

test('スナップショットの時刻がコアの期間計算に一致(JST境界・猶予込み)', function () {
  var sandbox = load();
  var sn = sandbox.AccessKeySnapshot.build(record({ revision: 1, startAt: jst('2030-01-11', '00:00'), endAt: jst('2030-01-11', '01:00') }), { facility: 'main' });
  var core = sandbox.AccessKeySnapshot.toCoreInput(sn, Date.parse('2030-01-10T12:00:00+09:00'));
  var el = C.evaluateEligibility(core.booking, coreConfig(), Date.parse('2030-01-10T12:00:00+09:00') / 1000);
  assert.strictEqual(el.eligible, true);
  assert.strictEqual(el.startSec, Date.UTC(2030, 0, 10, 15, 0, 0) / 1000 - 900, 'JST 1/11 00:00 = UTC 1/10 15:00');
  assert.strictEqual(el.endSec, Date.UTC(2030, 0, 10, 16, 0, 0) / 1000 + 900);
});

// ---------------------------------------------------------------- 前日リマインドの一行

var MAIL_FILES = ['Availability.gs', 'Booking.gs', 'BookingMailTemplates.gs'];
var MAIL_CONFIG = { timezone: 'Asia/Tokyo', contactEmail: 'contact@example.com' };
var GUIDE = { address: '名古屋市', entryMethod: 'キーボックス', keyboxNumber: '1234', unlockCode: '5678' };
var LINE = '入室用の暗証番号は、別のメールでお送りします。';

test('前日リマインド: フラグOFF/未指定は本文が従来と完全に同一。SNB+ONの場合のみ一行追加', function () {
  var T = loadBookingSandbox(MAIL_FILES, {}).BookingMailTemplates;
  var rec = record({ brand: 'snb' });
  var base = T.buildReminderMail(rec, MAIL_CONFIG, GUIDE, { now: jst('2030-01-10', '18:00') });
  assert.strictEqual(base.body.indexOf(LINE), -1);
  var off = T.buildReminderMail(rec, MAIL_CONFIG, GUIDE, { now: jst('2030-01-10', '18:00'), separateCodeNotice: false });
  assert.strictEqual(off.body, base.body);
  assert.strictEqual(T.buildReminderMail(rec, MAIL_CONFIG, GUIDE, { now: jst('2030-01-10', '18:00'), separateCodeNotice: 'true' }).body, base.body, 'trueの真偽値以外は無効');
  var on = T.buildReminderMail(rec, MAIL_CONFIG, GUIDE, { now: jst('2030-01-10', '18:00'), separateCodeNotice: true });
  assert.strictEqual(on.body.split('\n').filter(function (l) { return l === LINE; }).length, 1);
  assert.strictEqual(on.body.replace(LINE + '\n', ''), base.body, '一行以外は不変');
  ['studio_x', 'mens', ''].forEach(function (brand) {
    var m = T.buildReminderMail(record({ brand: brand }), MAIL_CONFIG, GUIDE, { now: jst('2030-01-10', '18:00'), separateCodeNotice: true });
    assert.strictEqual(m.body.indexOf(LINE), -1, 'SNB以外には出さない: ' + brand);
  });
});

test('設定: ACCESS_KEY_NOTICE_ENABLED は文字列trueのときだけ有効(既定OFF)', function () {
  function cfg(v) {
    var p = { SPREADSHEET_ID: SPREADSHEET_ID }; if (v !== undefined) p.ACCESS_KEY_NOTICE_ENABLED = v;
    return loadBookingSandbox(['Config.gs'], { PropertiesService: stubs.createPropertiesServiceStub(p) }).BookingConfig;
  }
  assert.strictEqual(cfg(undefined).isAccessKeyNoticeEnabled(), false);
  assert.strictEqual(cfg('false').isAccessKeyNoticeEnabled(), false);
  assert.strictEqual(cfg('1').isAccessKeyNoticeEnabled(), false);
  assert.strictEqual(cfg('true').isAccessKeyNoticeEnabled(), true);
});

test('既存予約系は鍵モジュールを参照しない(鍵APIの呼び出し点が予約GASに無い)', function () {
  var fs = require('fs'); var path = require('path');
  var dir = path.join(__dirname, '..', 'gas', 'booking');
  var offenders = [];
  ['shared', 'admin', 'public', 'webhook'].forEach(function (d) {
    fs.readdirSync(path.join(dir, d)).filter(function (f) { return /\.gs$/.test(f); }).forEach(function (f) {
      var src = fs.readFileSync(path.join(dir, d, f), 'utf8');
      if (/SwitchBotAccessCore|api\.switch-bot\.com|createKey|deleteKey/.test(src.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, ''))) offenders.push(f);
    });
  });
  assert.deepStrictEqual(offenders, []);
});

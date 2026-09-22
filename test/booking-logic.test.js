/*
 * scripts/booking-logic.js（共通予約UI・Issue #269のDOM非依存ロジック）のテスト。
 * DOM配線（scripts/booking-app.js）自体はブラウザでの動作確認に委ねる
 * （README「テストの実行」参照）。
 */
'use strict';

var test = require('node:test');
var assert = require('node:assert');
var loadFrontendSandbox = require('./helpers/frontend-sandbox').loadFrontendSandbox;

function loadLogic() {
  var sandbox = loadFrontendSandbox(['booking-logic.js'], {});
  return sandbox.BookingLogic;
}

test('getBrandMeta: snb/mens/studio_xそれぞれのdisplayName・sourceを返す', function () {
  var Logic = loadLogic();
  /* vmサンドボックス（別realm）で生成されたオブジェクトのため、非strict deepEqualで比較する。 */
  assert.deepEqual(Logic.getBrandMeta('snb'), { brand: 'snb', displayName: 'Studio Nagoya Base', source: 'snb-booking-app' });
  assert.deepEqual(Logic.getBrandMeta('mens'), { brand: 'mens', displayName: 'SNB mens', source: 'mens-booking-app' });
  assert.deepEqual(Logic.getBrandMeta('studio_x'), { brand: 'studio_x', displayName: 'Studio X', source: 'studio-x-booking-app' });
});

test('getBrandMeta: 未知のbrandはnullを返す（フロントも防御的に停止できるようにする）', function () {
  var Logic = loadLogic();
  assert.strictEqual(Logic.getBrandMeta('ataru'), null);
  assert.strictEqual(Logic.getBrandMeta(''), null);
  assert.strictEqual(Logic.getBrandMeta(undefined), null);
});

test('messageForErrorCode: createBooking/getAvailabilityのerror.code一覧をすべて日本語メッセージへ変換できる', function () {
  var Logic = loadLogic();
  var codes = [
    'INVALID_BRAND', 'INVALID_CONFIG', 'INVALID_DATE', 'INVALID_DURATION', 'DURATION_TOO_SHORT',
    'INVALID_START_TIME', 'START_TIME_NOT_ALIGNED', 'SLOT_CONFLICT', 'INVALID_NAME', 'INVALID_EMAIL',
    'INVALID_PHONE', 'INVALID_PEOPLE', 'INVALID_PURPOSE', 'INVALID_PAYMENT_METHOD', 'INVALID_NOTE',
    'INVALID_SOURCE', 'INVALID_CUSTOMER_TYPE', 'SAME_DAY_NOT_ALLOWED_FOR_FIRST_TIME',
    'SAME_DAY_START_TIME_PASSED',
    'RATE_LIMITED', 'LOCK_TIMEOUT', 'BOOKING_SAVE_FAILED', 'INVALID_JSON', 'INTERNAL_ERROR'
  ];
  codes.forEach(function (code) {
    var message = Logic.messageForErrorCode(code);
    assert.strictEqual(typeof message, 'string', code);
    assert.ok(message.length > 0, code);
  });
});

test('messageForErrorCode: 未知のcodeでも空にならない汎用メッセージを返す（成否不明画面を作らない）', function () {
  var Logic = loadLogic();
  assert.ok(Logic.messageForErrorCode('SOMETHING_NEW_FROM_SERVER').length > 0);
  assert.ok(Logic.messageForErrorCode(undefined).length > 0);
});

test('recoveryActionForErrorCode: SLOT_CONFLICT系は時間の選び直し、入力系はdetails修正、それ以外は再試行に振り分ける', function () {
  var Logic = loadLogic();
  assert.strictEqual(Logic.recoveryActionForErrorCode('SLOT_CONFLICT'), 'reselect-time');
  assert.strictEqual(Logic.recoveryActionForErrorCode('START_TIME_NOT_ALIGNED'), 'reselect-time');
  assert.strictEqual(Logic.recoveryActionForErrorCode('SAME_DAY_START_TIME_PASSED'), 'reselect-time', '当日の過去開始時刻はStep2へ戻し空き時間を再取得する（Issue #270レビュー対応）');
  assert.strictEqual(Logic.recoveryActionForErrorCode('INVALID_EMAIL'), 'edit-details');
  assert.strictEqual(Logic.recoveryActionForErrorCode('INVALID_PAYMENT_METHOD'), 'edit-details');
  assert.strictEqual(Logic.recoveryActionForErrorCode('RATE_LIMITED'), 'retry');
  assert.strictEqual(Logic.recoveryActionForErrorCode('LOCK_TIMEOUT'), 'retry');
  assert.strictEqual(Logic.recoveryActionForErrorCode('INTERNAL_ERROR'), 'retry');
});

test('recoveryActionForErrorCode: 当日+初回利用・利用区分未指定は日付・利用区分の選び直しに振り分ける（Issue #270。空き時間の再取得だけでは解決しないためreselect-timeとは区別する）', function () {
  var Logic = loadLogic();
  assert.strictEqual(Logic.recoveryActionForErrorCode('SAME_DAY_NOT_ALLOWED_FOR_FIRST_TIME'), 'reselect-date');
  assert.strictEqual(Logic.recoveryActionForErrorCode('INVALID_CUSTOMER_TYPE'), 'reselect-date');
});

test('isAllowedCustomerType/customerTypeLabel: first_time/returningのみ許可し、表示文言を返す（Issue #270）', function () {
  var Logic = loadLogic();
  assert.strictEqual(Logic.isAllowedCustomerType('first_time'), true);
  assert.strictEqual(Logic.isAllowedCustomerType('returning'), true);
  assert.strictEqual(Logic.isAllowedCustomerType(''), false);
  assert.strictEqual(Logic.isAllowedCustomerType('member'), false);
  assert.strictEqual(Logic.isAllowedCustomerType(undefined), false);

  assert.strictEqual(Logic.customerTypeLabel('first_time'), '初回利用');
  assert.strictEqual(Logic.customerTypeLabel('returning'), '利用経験あり');
  assert.strictEqual(Logic.customerTypeLabel('unknown'), '');
});

test('isSameDayFirstTimeBlocked: 当日+初回利用の組み合わせのみtrue（Issue #270最終仕様）', function () {
  var Logic = loadLogic();
  var today = '2026-10-01';
  assert.strictEqual(Logic.isSameDayFirstTimeBlocked('2026-10-01', 'first_time', today), true);
  assert.strictEqual(Logic.isSameDayFirstTimeBlocked('2026-10-01', 'returning', today), false, '当日+利用経験ありは通常フロー');
  assert.strictEqual(Logic.isSameDayFirstTimeBlocked('2026-10-02', 'first_time', today), false, '翌日+初回利用は通常フロー');
  assert.strictEqual(Logic.isSameDayFirstTimeBlocked('2026-10-02', 'returning', today), false, '翌日+利用経験ありは通常フロー');
});

test('durationHoursToMinutes: 正の整数時間だけを分へ変換し、それ以外はnull', function () {
  var Logic = loadLogic();
  assert.strictEqual(Logic.durationHoursToMinutes('2'), 120);
  assert.strictEqual(Logic.durationHoursToMinutes('8'), 480);
  assert.strictEqual(Logic.durationHoursToMinutes(''), null);
  assert.strictEqual(Logic.durationHoursToMinutes('abc'), null);
  assert.strictEqual(Logic.durationHoursToMinutes('0'), null);
  assert.strictEqual(Logic.durationHoursToMinutes('-1'), null);
  assert.strictEqual(Logic.durationHoursToMinutes('2.5'), null);
});

test('durationHoursToMinutes: 8時間を超える長時間利用もUI側で上限を設けず変換できる（#269レビュー対応：長時間利用をフロントだけで塞がない）', function () {
  var Logic = loadLogic();
  assert.strictEqual(Logic.durationHoursToMinutes('9'), 540);
  assert.strictEqual(Logic.durationHoursToMinutes('12'), 720);
  assert.strictEqual(Logic.durationHoursToMinutes('15'), 900);
  assert.strictEqual(Logic.durationHoursToMinutes('24'), 1440);
  /* 営業時間内に収まるかどうかの最終判定はcreateBooking/getAvailability側（INVALID_START_TIME等）が行う */
});

test('computeEndTime: 開始時刻＋利用時間（分）を表示用に加算する', function () {
  var Logic = loadLogic();
  assert.strictEqual(Logic.computeEndTime('10:00', 120), '12:00');
  assert.strictEqual(Logic.computeEndTime('21:00', 120), '23:00');
  assert.strictEqual(Logic.computeEndTime('invalid', 120), '');
});

test('validateDetailsForm: 必須項目の未入力・不正形式をそれぞれ検出する', function () {
  var Logic = loadLogic();
  var valid = {
    name: '山田太郎', email: 'taro@example.com', phone: '090-1234-5678',
    people: '2名', purpose: 'ポートレート撮影', paymentMethod: '現金', note: ''
  };
  assert.deepEqual(Logic.validateDetailsForm(valid), {});

  assert.ok(Logic.validateDetailsForm(Object.assign({}, valid, { name: '' })).name);
  assert.ok(Logic.validateDetailsForm(Object.assign({}, valid, { email: '' })).email);
  assert.ok(Logic.validateDetailsForm(Object.assign({}, valid, { email: 'not-an-email' })).email);
  assert.ok(Logic.validateDetailsForm(Object.assign({}, valid, { phone: 'abc-defg' })).phone);
  assert.strictEqual(Logic.validateDetailsForm(Object.assign({}, valid, { phone: '' })).phone, undefined, '電話番号は任意項目');
  assert.ok(Logic.validateDetailsForm(Object.assign({}, valid, { people: '' })).people);
  assert.ok(Logic.validateDetailsForm(Object.assign({}, valid, { purpose: '' })).purpose);
  assert.ok(Logic.validateDetailsForm(Object.assign({}, valid, { paymentMethod: '' })).paymentMethod);
  assert.ok(Logic.validateDetailsForm(Object.assign({}, valid, { note: 'a'.repeat(1001) })).note);
});

test('validateDetailsForm: 利用目的が「その他」の場合は詳細入力が必須', function () {
  var Logic = loadLogic();
  var base = {
    name: '山田太郎', email: 'taro@example.com', people: '2名',
    purpose: 'その他', paymentMethod: '現金'
  };
  assert.ok(Logic.validateDetailsForm(Object.assign({}, base, { purposeOther: '' })).purposeOther);
  assert.deepEqual(Logic.validateDetailsForm(Object.assign({}, base, { purposeOther: 'ヘアメイク撮影' })), {});
});

test('buildPurposeValue: 「その他」選択時は詳細を連結し、それ以外はそのまま返す', function () {
  var Logic = loadLogic();
  assert.strictEqual(Logic.buildPurposeValue('ポートレート撮影', ''), 'ポートレート撮影');
  assert.strictEqual(Logic.buildPurposeValue('その他', 'ヘアメイク撮影'), 'その他：ヘアメイク撮影');
});

test('buildCreateBookingPayload: createBookingへ渡すペイロードを組み立て、sourceはbrandから自動設定する', function () {
  var Logic = loadLogic();
  var payload = Logic.buildCreateBookingPayload({
    brand: 'mens',
    customerType: 'returning',
    date: '2026-10-01',
    startTime: '10:00',
    durationMinutes: 120,
    name: ' 山田太郎 ',
    email: ' taro@example.com ',
    phone: '',
    people: '2名',
    purpose: 'その他',
    purposeOther: 'ヘアメイク撮影',
    paymentMethod: '現金',
    note: ''
  });

  /* vmサンドボックス（別realm）で生成されたオブジェクトのため、非strict deepEqualで比較する
     （test/booking-calendar-repository.test.jsと同じ方針）。 */
  assert.deepEqual(payload, {
    brand: 'mens',
    customerType: 'returning',
    date: '2026-10-01',
    startTime: '10:00',
    durationMinutes: 120,
    name: '山田太郎',
    email: 'taro@example.com',
    phone: '',
    people: '2名',
    purpose: 'その他：ヘアメイク撮影',
    paymentMethod: '現金',
    note: '',
    source: 'mens-booking-app'
  });
});

test('buildCreateBookingPayload: 未知のbrandでもsourceは"unknown"になり例外を投げない（防御的フォールバック）', function () {
  var Logic = loadLogic();
  var payload = Logic.buildCreateBookingPayload({ brand: 'ataru', name: 'x', email: 'x@example.com', people: '1名', purpose: 'その他', paymentMethod: '現金' });
  assert.strictEqual(payload.source, 'unknown');
});

/* ── English locale対応（Issue #297） ── */

test('normalizeLocale: 未指定・未知のlocaleはjaへfallbackし、enはenのまま返す', function () {
  var Logic = loadLogic();
  assert.strictEqual(Logic.normalizeLocale(undefined), 'ja');
  assert.strictEqual(Logic.normalizeLocale(''), 'ja');
  assert.strictEqual(Logic.normalizeLocale('fr'), 'ja');
  assert.strictEqual(Logic.normalizeLocale('en'), 'en');
  assert.strictEqual(Logic.normalizeLocale('ja'), 'ja');
});

test('messageForErrorCode: locale="en"は英語、locale未指定は既存どおり日本語を返す（後方互換）', function () {
  var Logic = loadLogic();
  assert.strictEqual(Logic.messageForErrorCode('SAME_DAY_NOT_ALLOWED_FOR_FIRST_TIME'), '初回利用の方は当日のご予約を受け付けていません。翌日以降の日付を選択してください。');
  assert.strictEqual(
    Logic.messageForErrorCode('SAME_DAY_NOT_ALLOWED_FOR_FIRST_TIME', 'en'),
    'First-time guests cannot book for the same day. Please choose a date from tomorrow onward.'
  );
  /* 未知のlocaleはjaへfallback */
  assert.strictEqual(Logic.messageForErrorCode('BOOKING_SAVE_FAILED', 'fr'), '予約の保存に失敗しました。しばらくしてから再度お試しください。');
  /* 未知のcodeでも空文字にならない（locale別の汎用メッセージ） */
  assert.ok(Logic.messageForErrorCode('SOMETHING_NEW', 'en').length > 0);
  assert.notStrictEqual(Logic.messageForErrorCode('SOMETHING_NEW', 'en'), Logic.messageForErrorCode('SOMETHING_NEW', 'ja'));
});

test('customerTypeLabel: locale="en"は英語ラベル、locale未指定は日本語ラベル（内部valueはfirst_time/returningのまま不変）', function () {
  var Logic = loadLogic();
  assert.strictEqual(Logic.customerTypeLabel('first_time'), '初回利用');
  assert.strictEqual(Logic.customerTypeLabel('returning'), '利用経験あり');
  assert.strictEqual(Logic.customerTypeLabel('first_time', 'en'), 'First-time guest');
  assert.strictEqual(Logic.customerTypeLabel('returning', 'en'), 'Returning guest');
  /* 内部value自体はlocaleに関わらずfirst_time/returningの2つだけ */
  assert.deepEqual(Logic.ALLOWED_CUSTOMER_TYPES, ['first_time', 'returning']);
});

test('validateDetailsForm: locale="en"は英語のフィールドエラー、locale未指定は既存どおり日本語（後方互換・判定結果は同一）', function () {
  var Logic = loadLogic();
  var invalid = { name: '', email: 'not-an-email', people: '', purpose: '', paymentMethod: '' };

  var jaErrors = Logic.validateDetailsForm(invalid);
  var enErrors = Logic.validateDetailsForm(invalid, 'en');

  /* エラーになるフィールド集合はlocaleに関わらず同一（判定ロジックは分岐しない） */
  assert.deepEqual(Object.keys(jaErrors).sort(), Object.keys(enErrors).sort());

  assert.strictEqual(jaErrors.name, 'お名前を入力してください。');
  assert.strictEqual(enErrors.name, 'Please enter your name.');
  assert.strictEqual(jaErrors.email, 'メールアドレスの形式が正しくありません。');
  assert.strictEqual(enErrors.email, 'Please enter a valid email address.');
});

test('validateDetailsForm: purpose="その他"の判定はlocaleに関わらず日本語固定値で行う（Issue #297: purpose内部value無変更）', function () {
  var Logic = loadLogic();
  var base = { name: 'John Smith', email: 'john@example.com', people: '2名', purpose: 'その他', paymentMethod: '現金' };
  var enErrors = Logic.validateDetailsForm(Object.assign({}, base, { purposeOther: '' }), 'en');
  assert.strictEqual(enErrors.purposeOther, 'Please describe the purpose of your visit.');
  assert.deepEqual(Logic.validateDetailsForm(Object.assign({}, base, { purposeOther: 'Cosplay shoot' }), 'en'), {});
});

test('networkErrorMessage/apiNotConfiguredMessage: locale="en"は英語、未指定は既存定数（ja）と一致', function () {
  var Logic = loadLogic();
  assert.strictEqual(Logic.networkErrorMessage(), Logic.NETWORK_ERROR_MESSAGE);
  assert.strictEqual(Logic.apiNotConfiguredMessage(), Logic.API_NOT_CONFIGURED_MESSAGE);
  assert.strictEqual(Logic.networkErrorMessage('en'), 'Please check your connection and try again in a moment.');
  assert.strictEqual(Logic.apiNotConfiguredMessage('en'), 'Online booking is currently being prepared. Please try again later.');
});

test('buildCreateBookingPayload: localeに関わらずpayloadのkey/valueは変わらない（brandはsnbのまま）', function () {
  var Logic = loadLogic();
  var payload = Logic.buildCreateBookingPayload({
    brand: 'snb',
    customerType: 'first_time',
    date: '2026-10-05',
    startTime: '10:00',
    durationMinutes: 120,
    name: 'John Smith',
    email: 'john@example.com',
    phone: '',
    people: '2名',
    purpose: 'ポートレート撮影',
    paymentMethod: 'PayPay',
    note: ''
  });
  assert.deepEqual(payload, {
    brand: 'snb',
    customerType: 'first_time',
    date: '2026-10-05',
    startTime: '10:00',
    durationMinutes: 120,
    name: 'John Smith',
    email: 'john@example.com',
    phone: '',
    people: '2名',
    purpose: 'ポートレート撮影',
    paymentMethod: 'PayPay',
    note: '',
    source: 'snb-booking-app'
  });
});

test('isSameDayFirstTimeBlocked: English UIでも当日+初回利用の判定結果は日本語版と同一（localeを取らない業務ロジック）', function () {
  var Logic = loadLogic();
  var today = '2026-10-05';
  assert.strictEqual(Logic.isSameDayFirstTimeBlocked('2026-10-05', 'first_time', today), true);
  assert.strictEqual(Logic.isSameDayFirstTimeBlocked('2026-10-05', 'returning', today), false);
});

test('todayInJapan: 日本時間での「今日」をYYYY-MM-DD形式で返す（日付入力の下限と、isSameDayFirstTimeBlockedへ渡す当日判定の基準の両方に使う。Issue #270）', function () {
  var Logic = loadLogic();
  /* 2026-09-19 12:00 UTC は JST 2026-09-19 21:00 → 今日は2026-09-19 */
  var result = Logic.todayInJapan(new Date('2026-09-19T12:00:00Z'));
  assert.strictEqual(result, '2026-09-19');

  /* 2026-09-19 20:00 UTC は JST 2026-09-20 05:00 → 今日は2026-09-20（日付が変わる） */
  var result2 = Logic.todayInJapan(new Date('2026-09-19T20:00:00Z'));
  assert.strictEqual(result2, '2026-09-20');
});

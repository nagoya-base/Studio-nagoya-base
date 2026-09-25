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
    'SAME_DAY_START_TIME_PASSED', 'CARD_PAYMENT_TOO_CLOSE_TO_START',
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
  assert.strictEqual(Logic.recoveryActionForErrorCode('CARD_PAYMENT_TOO_CLOSE_TO_START'), 'edit-details', 'カード96時間未満は支払方法変更/日程変更で解消するためedit-detailsへ誘導する（Issue #334）');
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

test('isDurationAtLeastUiMinimum: 120分未満をNG、120分以上をOKとするUI側UX guard（Issue #301）', function () {
  var Logic = loadLogic();
  assert.strictEqual(Logic.isDurationAtLeastUiMinimum(60), false);
  assert.strictEqual(Logic.isDurationAtLeastUiMinimum(120), true);
  assert.strictEqual(Logic.isDurationAtLeastUiMinimum(180), true);
  assert.strictEqual(Logic.isDurationAtLeastUiMinimum(1440), true);
  assert.strictEqual(Logic.isDurationAtLeastUiMinimum(null), false);
});

test('isDurationAtLeastUiMinimum: durationHoursToMinutesの変換責務とは独立している（1時間の変換自体は60分のまま）', function () {
  var Logic = loadLogic();
  assert.strictEqual(Logic.durationHoursToMinutes('1'), 60);
  assert.strictEqual(Logic.durationHoursToMinutes('2'), 120);
  assert.strictEqual(Logic.isDurationAtLeastUiMinimum(Logic.durationHoursToMinutes('1')), false);
  assert.strictEqual(Logic.isDurationAtLeastUiMinimum(Logic.durationHoursToMinutes('2')), true);
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
    source: 'mens-booking-app',
    isMember: false
  });
});

test('buildCreateBookingPayload: isMemberはtrue以外すべてfalseへ正規化する（fail-closed）', function () {
  var Logic = loadLogic();
  [true, false, undefined, null, '', 'true', 1].forEach(function (rawIsMember) {
    var payload = Logic.buildCreateBookingPayload({
      brand: 'snb', name: 'x', email: 'x@example.com', people: '1名', purpose: 'その他', paymentMethod: '現金',
      isMember: rawIsMember
    });
    assert.strictEqual(payload.isMember, rawIsMember === true, JSON.stringify(rawIsMember) + ' の正規化結果が不正');
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

test('messageForErrorCode: CARD_PAYMENT_TOO_CLOSE_TO_START（Issue #334の新エラーコード）はja/enとも汎用メッセージにフォールバックせず専用文言を返す', function () {
  var Logic = loadLogic();
  var ja = Logic.messageForErrorCode('CARD_PAYMENT_TOO_CLOSE_TO_START');
  var en = Logic.messageForErrorCode('CARD_PAYMENT_TOO_CLOSE_TO_START', 'en');
  assert.match(ja, /96時間/);
  assert.match(ja, /現金・PayPay/);
  assert.match(en, /96 hours/);
  assert.match(en, /cash or PayPay/);
  /* 汎用メッセージ（未知のcode用）へフォールバックしていないことを確認する */
  assert.notStrictEqual(ja, Logic.messageForErrorCode('SOMETHING_UNKNOWN'));
  assert.notStrictEqual(en, Logic.messageForErrorCode('SOMETHING_UNKNOWN', 'en'));
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
    source: 'snb-booking-app',
    isMember: false
  });
});

test('isSameDayFirstTimeBlocked: English UIでも当日+初回利用の判定結果は日本語版と同一（localeを取らない業務ロジック）', function () {
  var Logic = loadLogic();
  var today = '2026-10-05';
  assert.strictEqual(Logic.isSameDayFirstTimeBlocked('2026-10-05', 'first_time', today), true);
  assert.strictEqual(Logic.isSameDayFirstTimeBlocked('2026-10-05', 'returning', today), false);
});

/* ── 確認画面表示専用ラベル（Issue #297 PR #300再レビュー対応） ──
   people/purpose/paymentMethodの内部value・保存値は変更しない。ここは確認画面へ
   表示する文字列だけをlocaleで切り替える表示専用関数のテスト。 */

test('peopleLabel: locale="en"は英語ラベル、locale未指定・ja/未知の内部valueは元のvalueをそのまま返す（内部value不変）', function () {
  var Logic = loadLogic();
  assert.strictEqual(Logic.peopleLabel('2名', 'en'), '2 guests');
  assert.strictEqual(Logic.peopleLabel('1名', 'en'), '1 guest');
  assert.strictEqual(Logic.peopleLabel('5名以上・要相談', 'en'), '5 or more (please contact us)');
  /* locale未指定は既存どおり内部valueをそのまま表示（後方互換） */
  assert.strictEqual(Logic.peopleLabel('2名'), '2名');
  assert.strictEqual(Logic.peopleLabel('2名', 'ja'), '2名');
  /* 未知のvalueでも例外を投げず、そのまま返す */
  assert.strictEqual(Logic.peopleLabel('10名', 'en'), '10名');
});

test('purposeLabel: locale="en"は英語ラベル、"その他"は自由記述と結合して"Other: "を使う（保存値のbuildPurposeValueとは別処理）', function () {
  var Logic = loadLogic();
  assert.strictEqual(Logic.purposeLabel('ポートレート撮影', '', 'en'), 'Portrait photography');
  assert.strictEqual(Logic.purposeLabel('その他', 'Cosplay shoot', 'en'), 'Other: Cosplay shoot');
  /* locale未指定・jaは既存どおり日本語表示（後方互換） */
  assert.strictEqual(Logic.purposeLabel('ポートレート撮影', ''), 'ポートレート撮影');
  assert.strictEqual(Logic.purposeLabel('その他', 'コスプレ撮影', 'ja'), 'その他：コスプレ撮影');
  /* buildPurposeValue()自体（保存値の仕様）は変更されていないことを併せて確認 */
  assert.strictEqual(Logic.buildPurposeValue('その他', 'Cosplay shoot'), 'その他：Cosplay shoot');
});

test('paymentMethodLabel: locale="en"は英語ラベル、locale未指定・jaは内部valueをそのまま返す（内部value不変）', function () {
  var Logic = loadLogic();
  assert.strictEqual(Logic.paymentMethodLabel('現金', 'en'), 'Cash');
  assert.strictEqual(Logic.paymentMethodLabel('PayPay', 'en'), 'PayPay');
  assert.strictEqual(Logic.paymentMethodLabel('オンラインクレジットカード', 'en'), 'Online credit card');
  assert.strictEqual(Logic.paymentMethodLabel('未定', 'en'), 'Undecided');
  assert.strictEqual(Logic.paymentMethodLabel('現金'), '現金');
  assert.strictEqual(Logic.paymentMethodLabel('現金', 'ja'), '現金');
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

/* ── 月間空き状況カレンダー（Issue #318） ── */

test('isBookableDayStatus: AVAILABLE_HIGH/AVAILABLE/LIMITEDのみtrue、FULL/OUT_OF_RANGEはfalse', function () {
  var Logic = loadLogic();
  assert.strictEqual(Logic.isBookableDayStatus('AVAILABLE_HIGH'), true);
  assert.strictEqual(Logic.isBookableDayStatus('AVAILABLE'), true);
  assert.strictEqual(Logic.isBookableDayStatus('LIMITED'), true);
  assert.strictEqual(Logic.isBookableDayStatus('FULL'), false);
  assert.strictEqual(Logic.isBookableDayStatus('OUT_OF_RANGE'), false);
  assert.strictEqual(Logic.isBookableDayStatus('SOMETHING_UNKNOWN'), false);
});

test('dayStatusSymbol: 5値それぞれに対応する記号を返す（◎/○/△/×/－）', function () {
  var Logic = loadLogic();
  assert.strictEqual(Logic.dayStatusSymbol('AVAILABLE_HIGH'), '◎');
  assert.strictEqual(Logic.dayStatusSymbol('AVAILABLE'), '○');
  assert.strictEqual(Logic.dayStatusSymbol('LIMITED'), '△');
  assert.strictEqual(Logic.dayStatusSymbol('FULL'), '×');
  assert.strictEqual(Logic.dayStatusSymbol('OUT_OF_RANGE'), '－');
});

test('dayStatusLabel: 記号だけに依存しない文言をja/enそれぞれ返す', function () {
  var Logic = loadLogic();
  assert.strictEqual(Logic.dayStatusLabel('AVAILABLE_HIGH', 'ja'), '空き時間が十分あります');
  assert.strictEqual(Logic.dayStatusLabel('FULL', 'en'), 'Fully booked');
  /* locale未指定はja */
  assert.strictEqual(Logic.dayStatusLabel('LIMITED'), '残り枠が少ないです');
});

test('isCalendarDaySelectable: FULL/OUT_OF_RANGEは選択不可、それ以外は選択可能', function () {
  var Logic = loadLogic();
  assert.strictEqual(Logic.isCalendarDaySelectable('2026-10-05', 'AVAILABLE_HIGH', 'returning', '2026-10-01'), true);
  assert.strictEqual(Logic.isCalendarDaySelectable('2026-10-05', 'LIMITED', 'returning', '2026-10-01'), true);
  assert.strictEqual(Logic.isCalendarDaySelectable('2026-10-05', 'FULL', 'returning', '2026-10-01'), false);
  assert.strictEqual(Logic.isCalendarDaySelectable('2026-10-05', 'OUT_OF_RANGE', 'returning', '2026-10-01'), false);
});

test('isCalendarDaySelectable: 初回利用＋当日は、GAS側のstatusが予約可でも選択不可になる（getAvailability自体はcustomerTypeを見ないため、フロント側ガードの再現）', function () {
  var Logic = loadLogic();
  var today = '2026-10-01';
  assert.strictEqual(Logic.isCalendarDaySelectable(today, 'AVAILABLE_HIGH', 'first_time', today), false, '今日＋初回利用は選択不可');
  assert.strictEqual(Logic.isCalendarDaySelectable(today, 'AVAILABLE_HIGH', 'returning', today), true, '今日＋利用経験ありは選択可能');
  assert.strictEqual(Logic.isCalendarDaySelectable('2026-10-02', 'AVAILABLE_HIGH', 'first_time', today), true, '翌日＋初回利用は選択可能');
});

test('dayAriaLabel: 記号ではなく日付＋状態の文言をaria-label用に返す（ja/en）', function () {
  var Logic = loadLogic();
  assert.strictEqual(Logic.dayAriaLabel('2026-10-05', 'AVAILABLE', 'returning', '2026-10-01', 'ja'), '10月5日　空きあります');
  assert.strictEqual(Logic.dayAriaLabel('2026-10-05', 'AVAILABLE', 'returning', '2026-10-01', 'en'), 'October 5　Available');
});

test('dayAriaLabel: 今日＋初回利用は、通常のstatusラベルではなくSAME_DAY_NOT_ALLOWED_FOR_FIRST_TIMEの案内文になる', function () {
  var Logic = loadLogic();
  var today = '2026-10-01';
  var label = Logic.dayAriaLabel(today, 'AVAILABLE_HIGH', 'first_time', today, 'ja');
  assert.ok(label.indexOf('初回利用の方は当日のご予約を受け付けていません') !== -1, label);
});

test('monthLabel: ja "2026年10月" / en "October 2026"', function () {
  var Logic = loadLogic();
  assert.strictEqual(Logic.monthLabel(2026, 10, 'ja'), '2026年10月');
  assert.strictEqual(Logic.monthLabel(2026, 10, 'en'), 'October 2026');
  assert.strictEqual(Logic.monthLabel(2027, 1, 'en'), 'January 2027');
});

test('formatCalendarDayLabel: ja "10月5日" / en "October 5"', function () {
  var Logic = loadLogic();
  assert.strictEqual(Logic.formatCalendarDayLabel('2026-10-05', 'ja'), '10月5日');
  assert.strictEqual(Logic.formatCalendarDayLabel('2026-10-05', 'en'), 'October 5');
});

test('buildMonthMatrix: 7列×週の2次元配列を返し、月初の曜日位置が正しい（2026年10月は木曜始まり）', function () {
  var Logic = loadLogic();
  var weeks = Logic.buildMonthMatrix(2026, 10);
  weeks.forEach(function (week) { assert.strictEqual(week.length, 7, '各週は7列であること'); });

  /* 2026-10-01は木曜日（index 4）なので、最初の週は日〜水が空白セル */
  assert.strictEqual(weeks[0][0], null);
  assert.strictEqual(weeks[0][3], null);
  assert.deepEqual(weeks[0][4], { day: 1, dateValue: '2026-10-01' });
  assert.deepEqual(weeks[0][6], { day: 3, dateValue: '2026-10-03' });

  /* 31日ぶんすべてのセルが1回ずつ現れる */
  var allDays = [];
  weeks.forEach(function (week) {
    week.forEach(function (cell) { if (cell) allDays.push(cell.day); });
  });
  assert.deepStrictEqual(allDays, Array.from({ length: 31 }, function (_, i) { return i + 1; }));
});

test('buildMonthMatrix: 月初が日曜の月は先頭セルから空白なしで始まる（2026年11月は日曜始まり）', function () {
  var Logic = loadLogic();
  var weeks = Logic.buildMonthMatrix(2026, 11);
  assert.deepEqual(weeks[0][0], { day: 1, dateValue: '2026-11-01' });
});

test('buildMonthMatrix: 28/29/30/31日の月それぞれで正しい日数のセルになる', function () {
  var Logic = loadLogic();
  function countDays(year, month) {
    var count = 0;
    Logic.buildMonthMatrix(year, month).forEach(function (week) {
      week.forEach(function (cell) { if (cell) count += 1; });
    });
    return count;
  }
  assert.strictEqual(countDays(2026, 2), 28, '2026年2月（平年）');
  assert.strictEqual(countDays(2028, 2), 29, '2028年2月（閏年）');
  assert.strictEqual(countDays(2026, 4), 30, '2026年4月');
  assert.strictEqual(countDays(2026, 1), 31, '2026年1月');
});

test('buildMonthMatrix: 4〜6週の範囲に収まる（月初の曜日と日数の組み合わせにより、日曜始まり28日の月だけ例外的に4週になる）', function () {
  var Logic = loadLogic();
  for (var month = 1; month <= 12; month++) {
    var weekCount = Logic.buildMonthMatrix(2026, month).length;
    assert.ok(weekCount >= 4 && weekCount <= 6, month + '月は' + weekCount + '週（4〜6週の範囲外）');
  }
});

test('shiftMonth: 通常の月内移動', function () {
  var Logic = loadLogic();
  assert.deepEqual(Logic.shiftMonth(2026, 5, 1), { year: 2026, month: 6 });
  assert.deepEqual(Logic.shiftMonth(2026, 5, -1), { year: 2026, month: 4 });
});

test('shiftMonth: 年跨ぎ（12月→1月、1月→12月）を正しく処理する', function () {
  var Logic = loadLogic();
  assert.deepEqual(Logic.shiftMonth(2026, 12, 1), { year: 2027, month: 1 });
  assert.deepEqual(Logic.shiftMonth(2026, 1, -1), { year: 2025, month: 12 });
});

test('yearMonthFromDateValue: YYYY-MM-DDから{year, month}を取り出す', function () {
  var Logic = loadLogic();
  assert.deepEqual(Logic.yearMonthFromDateValue('2026-10-05'), { year: 2026, month: 10 });
  assert.deepEqual(Logic.yearMonthFromDateValue('2027-01-31'), { year: 2027, month: 1 });
});

test('weekdayColumnClass: 日曜は赤系・土曜は青系・平日は通常色のクラス名を返す', function () {
  var Logic = loadLogic();
  assert.strictEqual(Logic.weekdayColumnClass(0), 'ba-cal-sun');
  assert.strictEqual(Logic.weekdayColumnClass(6), 'ba-cal-sat');
  for (var i = 1; i <= 5; i++) {
    assert.strictEqual(Logic.weekdayColumnClass(i), 'ba-cal-weekday');
  }
});

/* ── 希望時間帯フィルタ（Issue #324） ── */

test('normalizeTimeBand: all/morning/daytime/eveningはそのまま、それ以外・未指定はallへフォールバックする', function () {
  var Logic = loadLogic();
  assert.strictEqual(Logic.normalizeTimeBand('all'), 'all');
  assert.strictEqual(Logic.normalizeTimeBand('morning'), 'morning');
  assert.strictEqual(Logic.normalizeTimeBand('daytime'), 'daytime');
  assert.strictEqual(Logic.normalizeTimeBand('evening'), 'evening');
  [undefined, null, '', 'bogus', 'MORNING', 'Morning'].forEach(function (value) {
    assert.strictEqual(Logic.normalizeTimeBand(value), 'all', 'normalizeTimeBand(' + JSON.stringify(value) + ')はallになるべき');
  });
});

test('timeBandLabel: 日本語「指定なし/午前/昼/夜」、英語「Any time/Morning/Afternoon/Evening」を返す（Issue #324本文レビュー追記5）', function () {
  var Logic = loadLogic();
  assert.strictEqual(Logic.timeBandLabel('all', 'ja'), '指定なし');
  assert.strictEqual(Logic.timeBandLabel('morning', 'ja'), '午前');
  assert.strictEqual(Logic.timeBandLabel('daytime', 'ja'), '昼');
  assert.strictEqual(Logic.timeBandLabel('evening', 'ja'), '夜');
  assert.strictEqual(Logic.timeBandLabel('all', 'en'), 'Any time');
  assert.strictEqual(Logic.timeBandLabel('morning', 'en'), 'Morning');
  assert.strictEqual(Logic.timeBandLabel('daytime', 'en'), 'Afternoon');
  assert.strictEqual(Logic.timeBandLabel('evening', 'en'), 'Evening');
  assert.strictEqual(Logic.timeBandLabel('bogus', 'ja'), '指定なし', '不正値はja/en問わずallのラベルになる');
});

test('filterStartTimesByTimeBand: allは絞り込みなし（後方互換）で、元配列と同じ内容の新しい配列を返す', function () {
  var Logic = loadLogic();
  var times = ['08:00', '12:00', '18:00'];
  var result = Logic.filterStartTimesByTimeBand(times, 'all');
  assert.deepStrictEqual(result, times);
  assert.notStrictEqual(result, times, '呼び出し元の配列を書き換えず、新しい配列を返すべき');
});

test('filterStartTimesByTimeBand: 境界値（11:45は午前・12:00は昼・17:45は昼・18:00は夜）をGAS側と同じ規則で判定する', function () {
  var Logic = loadLogic();
  var times = ['07:45', '08:00', '11:45', '12:00', '17:45', '18:00', '22:45'];
  assert.deepStrictEqual(Logic.filterStartTimesByTimeBand(times, 'morning'), ['08:00', '11:45']);
  assert.deepStrictEqual(Logic.filterStartTimesByTimeBand(times, 'daytime'), ['12:00', '17:45']);
  assert.deepStrictEqual(Logic.filterStartTimesByTimeBand(times, 'evening'), ['18:00', '22:45']);
});

test('filterStartTimesByTimeBand: 対象時間帯の候補が1件も無い場合は空配列を返す', function () {
  var Logic = loadLogic();
  assert.deepStrictEqual(Logic.filterStartTimesByTimeBand(['08:00', '09:00'], 'evening'), []);
});

test('filterStartTimesByTimeBand: timeBand未指定・不正値はallとして扱う（絞り込みなし）', function () {
  var Logic = loadLogic();
  var times = ['08:00', '13:00', '20:00'];
  assert.deepStrictEqual(Logic.filterStartTimesByTimeBand(times, undefined), times);
  assert.deepStrictEqual(Logic.filterStartTimesByTimeBand(times, 'bogus'), times);
});

test('filterStartTimesByTimeBand: times未指定はエラーにせず空配列を返す', function () {
  var Logic = loadLogic();
  var result = Logic.filterStartTimesByTimeBand(undefined, 'morning');
  assert.ok(Array.isArray(result));
  assert.strictEqual(result.length, 0);
});

/* ── カード決済の96時間受付条件・支払期限表示（Issue #334 PR-B） ── */

test('isCardPaymentMethodValue: 内部value「オンラインクレジットカード」のみtrue', function () {
  var Logic = loadLogic();
  assert.strictEqual(Logic.isCardPaymentMethodValue('オンラインクレジットカード'), true);
  assert.strictEqual(Logic.isCardPaymentMethodValue('現金'), false);
  assert.strictEqual(Logic.isCardPaymentMethodValue('PayPay'), false);
  assert.strictEqual(Logic.isCardPaymentMethodValue('未定'), false);
  assert.strictEqual(Logic.isCardPaymentMethodValue(''), false);
  assert.strictEqual(Logic.isCardPaymentMethodValue(undefined), false);
});

test('isCardPaymentEligible: 利用開始まで96時間ちょうどは選択できる（境界を含む。gas/booking/shared/Booking.gsのCARD_MIN_HOURS_BEFORE_START=96と同じ境界）', function () {
  var Logic = loadLogic();
  var now = new Date('2026-10-01T10:00:00+09:00');
  assert.strictEqual(Logic.isCardPaymentEligible('2026-10-05', '10:00', now), true);
});

test('isCardPaymentEligible: 96時間に1分でも満たない場合は選択できない', function () {
  var Logic = loadLogic();
  var now = new Date('2026-10-01T10:00:00+09:00');
  assert.strictEqual(Logic.isCardPaymentEligible('2026-10-05', '09:59', now), false);
});

/*
 * PRレビュー対応: 以前の実装は現在時刻を分単位（秒を切り捨て）で丸めてから
 * 「暦日差×1440分 + 分」で比較していたため、実際の残り時間より最大59秒長く見積もる
 * バイアスがあり、96時間未満の申込を誤って選択可能と判定しうる不具合があった。
 * 固定時刻を使い、96時間ちょうど／1秒前（96時間01秒前＝許可）／1秒後（95時間59分59秒前＝
 * 不許可）の境界をミリ秒精度で検証する（gas/booking/shared/Booking.gsの
 * `minutesUntilStart < CARD_MIN_HOURS_BEFORE_START * 60`とちょうど96時間が一致する
 * よう、`>=`で許可する境界を秒単位で崩さないことを保証する）。
 */
test('isCardPaymentEligible: 96時間の境界を秒単位で判定する（96時間ちょうど／1秒前／1秒後）', function () {
  var Logic = loadLogic();
  var startAt = new Date('2026-10-05T10:00:00+09:00').getTime();
  var exactly96hBefore = new Date(startAt - 96 * 3600000);
  var oneSecondBeforeThat = new Date(exactly96hBefore.getTime() - 1000); /* 96時間01秒前 */
  var oneSecondAfterThat = new Date(exactly96hBefore.getTime() + 1000); /* 95時間59分59秒前 */

  assert.strictEqual(
    Logic.isCardPaymentEligible('2026-10-05', '10:00', exactly96hBefore),
    true,
    '96時間ちょうどは許可（境界を含む）'
  );
  assert.strictEqual(
    Logic.isCardPaymentEligible('2026-10-05', '10:00', oneSecondBeforeThat),
    true,
    '96時間01秒前（96時間を1秒超えて余裕がある）は許可'
  );
  assert.strictEqual(
    Logic.isCardPaymentEligible('2026-10-05', '10:00', oneSecondAfterThat),
    false,
    '95時間59分59秒前（96時間に1秒足りない）は不許可'
  );
});

test('isCardPaymentEligible: 分の境目をまたぐ1秒でも、秒単位で正しく判定する（分単位への丸めによる誤判定がないことの確認）', function () {
  var Logic = loadLogic();
  /* now=10:00:59（分としては10:00扱いされていた旧実装だと、本来95時間59分1秒しか
     余裕が無いのに96時間ちょうど余裕があるかのように誤って許可されうるケース）。 */
  var now = new Date('2026-10-01T10:00:59+09:00');
  assert.strictEqual(
    Logic.isCardPaymentEligible('2026-10-05', '10:00', now),
    false,
    '96時間まで59秒足りないため不許可であるべき（分単位への丸めで許可されてはいけない）'
  );
});

test('isCardPaymentEligible: 96時間を十分に超えていれば選択できる', function () {
  var Logic = loadLogic();
  var now = new Date('2026-10-01T10:00:00+09:00');
  assert.strictEqual(Logic.isCardPaymentEligible('2026-10-10', '10:00', now), true);
});

test('isCardPaymentEligible: 利用開始が過去・現在時刻より前でも例外を投げず、96時間未満としてfalseを返す（fail-closed）', function () {
  var Logic = loadLogic();
  var now = new Date('2026-10-05T10:00:00+09:00');
  assert.strictEqual(Logic.isCardPaymentEligible('2026-10-01', '10:00', now), false);
});

test('isCardPaymentEligible: 日付・開始時刻がまだ未確定（空文字）の間は選択肢を塞がずtrueを返す', function () {
  var Logic = loadLogic();
  var now = new Date('2026-10-01T10:00:00+09:00');
  assert.strictEqual(Logic.isCardPaymentEligible('', '', now), true);
  assert.strictEqual(Logic.isCardPaymentEligible('2026-10-05', '', now), true);
  assert.strictEqual(Logic.isCardPaymentEligible('', '10:00', now), true);
});

test('cardPaymentDueDisplay: 「今から72時間後」をAsia/Tokyo基準の日付（曜日つき）・時刻で返す', function () {
  var Logic = loadLogic();
  var now = new Date('2026-10-01T10:00:00+09:00'); /* 木曜 */
  assert.strictEqual(Logic.cardPaymentDueDisplay(now), '2026-10-04（日） 10:00');
});

test('cardPaymentDueDisplay: 72時間後に日付だけでなく曜日も正しく繰り上がる', function () {
  var Logic = loadLogic();
  var now = new Date('2026-10-29T23:30:00+09:00'); /* 木曜 */
  assert.strictEqual(Logic.cardPaymentDueDisplay(now), '2026-11-01（日） 23:30');
});

test('cardPaymentIneligibleNotice: Issue #334本文どおりの案内文をja/enで返す', function () {
  var Logic = loadLogic();
  assert.strictEqual(
    Logic.cardPaymentIneligibleNotice('ja'),
    'カード事前決済は利用開始の4日前までのお申し込みです。直前のご予約は現金・PayPay（現地決済）をお選びください。'
  );
  assert.match(Logic.cardPaymentIneligibleNotice('en'), /4 days/);
});

test('cardPaymentNoticeLines: 決済リンクの送信予定（24時間以内）・支払期限（72時間後の実際の日時）・自動失効・再申し込み方法・決済済みの場合の連絡先をすべて含む', function () {
  var Logic = loadLogic();
  var due = '2026-10-04（日） 10:00';
  var lines = Logic.cardPaymentNoticeLines(due, 'ja');
  var body = lines.join('\n');
  assert.match(body, /24時間以内にメールでお送りします/);
  assert.match(body, /72時間後（2026-10-04（日） 10:00）/);
  assert.match(body, /自動的に失効/);
  assert.match(body, /改めて予約フォームからお申し込み/);
  assert.match(body, /二重決済をせず、運営までご連絡/);
});

test('cardPaymentNoticeLines: options.omitPendingNoteを指定すると「仮受付です」の行を省く（仮受付メールとの重複整理用）', function () {
  var Logic = loadLogic();
  var withNote = Logic.cardPaymentNoticeLines('2026-10-04（日） 10:00', 'ja').join('\n');
  var withoutNote = Logic.cardPaymentNoticeLines('2026-10-04（日） 10:00', 'ja', { omitPendingNote: true }).join('\n');
  assert.match(withNote, /仮受付です/);
  assert.doesNotMatch(withoutNote, /仮受付です/);
});

test('cardPaymentNoticeLines: locale="en"では英語の案内文を返す', function () {
  var Logic = loadLogic();
  var lines = Logic.cardPaymentNoticeLines('2026-10-04 10:00', 'en');
  var body = lines.join('\n');
  assert.match(body, /24 hours/);
  assert.match(body, /72 hours/);
  assert.match(body, /expire automatically/);
});

test('CARD_MIN_HOURS_BEFORE_START/CARD_TTL_HOURS/CARD_PAYMENT_METHOD_VALUE: gas/booking/shared/Booking.gsの値と一致する定数を公開する', function () {
  var Logic = loadLogic();
  assert.strictEqual(Logic.CARD_MIN_HOURS_BEFORE_START, 96);
  assert.strictEqual(Logic.CARD_TTL_HOURS, 72);
  assert.strictEqual(Logic.CARD_PAYMENT_METHOD_VALUE, 'オンラインクレジットカード');
});

/* ── 利用料金表示（Issue #342） ── */

test('brandShowsMemberOption: snbのみtrue。mens/studio_x/未知のbrandはfalse', function () {
  var Logic = loadLogic();
  assert.strictEqual(Logic.brandShowsMemberOption('snb'), true);
  assert.strictEqual(Logic.brandShowsMemberOption('mens'), false);
  assert.strictEqual(Logic.brandShowsMemberOption('studio_x'), false);
  assert.strictEqual(Logic.brandShowsMemberOption('ataru'), false);
  assert.strictEqual(Logic.brandShowsMemberOption(undefined), false);
});

test('formatJpyAmount: 数値を"¥"+3桁区切りへ整形する。数値化できない値は空文字を返す', function () {
  var Logic = loadLogic();
  assert.strictEqual(Logic.formatJpyAmount(4000), '¥4,000');
  assert.strictEqual(Logic.formatJpyAmount(10000), '¥10,000');
  assert.strictEqual(Logic.formatJpyAmount('4000'), '¥4,000');
  assert.strictEqual(Logic.formatJpyAmount(0), '¥0');
  assert.strictEqual(Logic.formatJpyAmount(undefined), '');
  assert.strictEqual(Logic.formatJpyAmount(null), '');
  assert.strictEqual(Logic.formatJpyAmount('abc'), '');
  assert.strictEqual(Logic.formatJpyAmount(NaN), '');
});

test('priceComputingLabel/priceUnavailableLabel: locale="en"は英語、未指定は日本語を返す', function () {
  var Logic = loadLogic();
  assert.strictEqual(Logic.priceComputingLabel(), '料金を計算しています…');
  assert.strictEqual(Logic.priceComputingLabel('en'), 'Calculating price…');
  assert.notStrictEqual(Logic.priceUnavailableLabel(), Logic.priceUnavailableLabel('en'));
  assert.ok(Logic.priceUnavailableLabel().length > 0);
  assert.ok(Logic.priceUnavailableLabel('en').length > 0);
});

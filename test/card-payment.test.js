/*
 * gas/booking/shared/CardPayment.gs（Issue #341 PR-A。Stripeカード決済の状態設計・
 * サーバー側の料金検証・冪等性キー発行に関する純粋ロジック）のテスト。
 * Booking.gs（Booking.getEffectivePriceAmount）に依存するため、Availability.gs/Booking.gsと
 * 合わせてvmへ読み込む（booking-model.test.jsと同じ依存順）。
 *
 * 実際のStripe API呼び出し（UrlFetchApp）はこのファイルの対象外（PR-B/PR-C）。
 */
'use strict';

var test = require('node:test');
var assert = require('node:assert');
var loadBookingSandbox = require('./helpers/gas-sandbox').loadBookingSandbox;

function loadCardPayment() {
  var sandbox = loadBookingSandbox(['Availability.gs', 'Booking.gs', 'CardPayment.gs'], {});
  return sandbox.CardPayment;
}

function priceRecord(overrides) {
  return Object.assign(
    {
      priceAmount: 8000,
      priceOverrideAmount: '',
      priceOverrideAt: ''
    },
    overrides || {}
  );
}

test('CardPayment: CHECKOUT_HOLD_MINUTES/STRIPE_SESSION_EXPIRY_BUFFER_MINUTESが公開されている（Issue #341）', function () {
  var CardPayment = loadCardPayment();
  assert.strictEqual(CardPayment.CHECKOUT_HOLD_MINUTES, 30, 'Issue #341本文の目安どおり30分');
  assert.strictEqual(CardPayment.STRIPE_SESSION_EXPIRY_BUFFER_MINUTES, 5, 'Stripeのexpires_at最小30分制約に対する安全マージン');
});

test('computeCheckoutHoldExpiryMillis: 作成時刻からCHECKOUT_HOLD_MINUTES(30分)後を返す', function () {
  var CardPayment = loadCardPayment();
  var createdAt = new Date('2026-10-01T10:00:00+09:00').getTime();
  var expiry = CardPayment.computeCheckoutHoldExpiryMillis(createdAt);
  assert.strictEqual(expiry, createdAt + 30 * 60000);
});

/*
 * computeStripeSessionExpiresAtSeconds: Stripe Checkout Session（mode=payment）の
 * expires_atは「Session作成時刻から30分後〜24時間後」の範囲でしか指定できない
 * （CardPayment.gsファイル冒頭コメント参照）。CHECKOUT_HOLD_MINUTESちょうどではなく
 * バッファを載せた値を返すことで、Session発行処理自体の遅延で30分未満になる事故を防ぐ。
 */
test('computeStripeSessionExpiresAtSeconds: Session作成時刻からCHECKOUT_HOLD_MINUTES+STRIPE_SESSION_EXPIRY_BUFFER_MINUTES(35分)後をUnix秒で返す', function () {
  var CardPayment = loadCardPayment();
  var creationAt = new Date('2026-10-01T10:00:00+09:00').getTime();
  var expiresAtSeconds = CardPayment.computeStripeSessionExpiresAtSeconds(creationAt);
  assert.strictEqual(expiresAtSeconds, Math.floor((creationAt + 35 * 60000) / 1000));
});

test('computeStripeSessionExpiresAtSeconds: 常にSession作成時刻から30分（Stripeの最小許容値）を上回る', function () {
  var CardPayment = loadCardPayment();
  var creationAt = Date.now();
  var expiresAtSeconds = CardPayment.computeStripeSessionExpiresAtSeconds(creationAt);
  var minimumAllowedSeconds = Math.floor(creationAt / 1000) + 30 * 60;
  assert.ok(expiresAtSeconds > minimumAllowedSeconds, 'expires_atはSession作成時刻+30分より後でなければならない');
});

test('computeExpectedPaymentAmount: priceAmountをそのままamountJpy(JPY)として返す', function () {
  var CardPayment = loadCardPayment();
  var result = CardPayment.computeExpectedPaymentAmount(priceRecord({ priceAmount: 8000 }));
  assert.strictEqual(result.valid, true);
  assert.strictEqual(result.amountJpy, 8000);
  assert.strictEqual(result.currency, 'JPY');
});

test('computeExpectedPaymentAmount: priceOverrideAtが設定されていればpriceOverrideAmountを優先する（Booking.getEffectivePriceAmountに委譲）', function () {
  var CardPayment = loadCardPayment();
  var result = CardPayment.computeExpectedPaymentAmount(priceRecord({
    priceAmount: 8000, priceOverrideAmount: 7000, priceOverrideAt: new Date('2026-09-20T00:00:00+09:00')
  }));
  assert.strictEqual(result.valid, true);
  assert.strictEqual(result.amountJpy, 7000);
});

test('computeExpectedPaymentAmount: priceAmountが空（未計算）の予約はfail-closedにvalid:falseを返す', function () {
  var CardPayment = loadCardPayment();
  var result = CardPayment.computeExpectedPaymentAmount(priceRecord({ priceAmount: '' }));
  assert.strictEqual(result.valid, false);
  assert.strictEqual(result.error.code, 'PRICE_NOT_AVAILABLE');
});

test('computeExpectedPaymentAmount: 0円・負数・非整数の金額はfail-closedにvalid:falseを返す', function () {
  var CardPayment = loadCardPayment();
  [0, -1000, 1000.5].forEach(function (amount) {
    var result = CardPayment.computeExpectedPaymentAmount(priceRecord({ priceAmount: amount }));
    assert.strictEqual(result.valid, false, JSON.stringify(amount) + ' は不正な金額として拒否されるべき');
    assert.strictEqual(result.error.code, 'PRICE_NOT_AVAILABLE');
  });
});

test('verifyPaymentAmount: サーバー計算額・通貨と一致すればvalid:trueを返す', function () {
  var CardPayment = loadCardPayment();
  var result = CardPayment.verifyPaymentAmount(priceRecord({ priceAmount: 8000 }), 8000, 'JPY');
  assert.strictEqual(result.valid, true);
  assert.strictEqual(result.amountJpy, 8000);
});

test('verifyPaymentAmount: 金額が1円でも異なればAMOUNT_MISMATCHで拒否する（クライアント改ざん対策。Issue #341受入条件）', function () {
  var CardPayment = loadCardPayment();
  var result = CardPayment.verifyPaymentAmount(priceRecord({ priceAmount: 8000 }), 7999, 'JPY');
  assert.strictEqual(result.valid, false);
  assert.strictEqual(result.error.code, 'AMOUNT_MISMATCH');
});

test('verifyPaymentAmount: 通貨がJPY以外はCURRENCY_MISMATCHで拒否する', function () {
  var CardPayment = loadCardPayment();
  var result = CardPayment.verifyPaymentAmount(priceRecord({ priceAmount: 8000 }), 8000, 'USD');
  assert.strictEqual(result.valid, false);
  assert.strictEqual(result.error.code, 'CURRENCY_MISMATCH');
});

test('verifyPaymentAmount: サーバー計算額自体が無い場合はPRICE_NOT_AVAILABLEをそのまま返す', function () {
  var CardPayment = loadCardPayment();
  var result = CardPayment.verifyPaymentAmount(priceRecord({ priceAmount: '' }), 8000, 'JPY');
  assert.strictEqual(result.valid, false);
  assert.strictEqual(result.error.code, 'PRICE_NOT_AVAILABLE');
});

/*
 * verifyPaymentAgainstSnapshot（Issue #341 PR-Aレビュー対応・項目3）: Webhook検証（PR-C）は
 * その時点の「現在の」確定金額（priceAmount/priceOverrideAmount）ではなく、Checkout
 * Session発行時点でstripeAmount/stripeCurrencyへ保存したスナップショットと突き合わせる。
 * こうすることで、Session発行後・Webhook到達前に管理者が料金を修正しても、既に完了した
 * 決済の検証結果には影響しない（正常な決済が誤ってAMOUNT_MISMATCHになる事故を防ぐ）。
 */
function snapshotRecord(overrides) {
  return Object.assign(
    { priceAmount: 8000, priceOverrideAmount: '', priceOverrideAt: '', stripeAmount: 8000, stripeCurrency: 'JPY' },
    overrides || {}
  );
}

test('verifyPaymentAgainstSnapshot: stripeAmount/stripeCurrencyのスナップショットと一致すればvalid:trueを返す', function () {
  var CardPayment = loadCardPayment();
  var result = CardPayment.verifyPaymentAgainstSnapshot(snapshotRecord(), 8000, 'JPY');
  assert.strictEqual(result.valid, true);
  assert.strictEqual(result.amountJpy, 8000);
});

test('verifyPaymentAgainstSnapshot: Session発行後に料金が修正されても、スナップショット（Session発行時点の金額）との一致だけを見るため正常な決済は不一致にならない', function () {
  var CardPayment = loadCardPayment();
  // priceAmountは9000へ変わっているが、stripeAmount（Session発行時点のスナップショット）は8000のまま。
  var record = snapshotRecord({ priceAmount: 9000, stripeAmount: 8000 });
  var result = CardPayment.verifyPaymentAgainstSnapshot(record, 8000, 'JPY');
  assert.strictEqual(result.valid, true, 'Session発行後の料金修正で、既に完了した決済の検証結果が変わってはならない');
});

test('verifyPaymentAgainstSnapshot: 参考として、同じ入力をverifyPaymentAmount（現在の確定金額と照合）に通すと誤ってAMOUNT_MISMATCHになることを確認する（だからこそPR-CはverifyPaymentAgainstSnapshotを使う）', function () {
  var CardPayment = loadCardPayment();
  var record = snapshotRecord({ priceAmount: 9000, stripeAmount: 8000 });
  var result = CardPayment.verifyPaymentAmount(record, 8000, 'JPY');
  assert.strictEqual(result.valid, false);
  assert.strictEqual(result.error.code, 'AMOUNT_MISMATCH');
});

test('verifyPaymentAgainstSnapshot: 金額・通貨がスナップショットと異なればそれぞれAMOUNT_MISMATCH/CURRENCY_MISMATCHで拒否する', function () {
  var CardPayment = loadCardPayment();
  var amountResult = CardPayment.verifyPaymentAgainstSnapshot(snapshotRecord(), 7999, 'JPY');
  assert.strictEqual(amountResult.valid, false);
  assert.strictEqual(amountResult.error.code, 'AMOUNT_MISMATCH');

  var currencyResult = CardPayment.verifyPaymentAgainstSnapshot(snapshotRecord(), 8000, 'USD');
  assert.strictEqual(currencyResult.valid, false);
  assert.strictEqual(currencyResult.error.code, 'CURRENCY_MISMATCH');
});

test('verifyPaymentAgainstSnapshot: スナップショット未記録（Checkout Session未発行）の予約はSNAPSHOT_NOT_AVAILABLEで拒否する', function () {
  var CardPayment = loadCardPayment();
  [
    snapshotRecord({ stripeAmount: '' }),
    snapshotRecord({ stripeCurrency: '' }),
    {}
  ].forEach(function (record) {
    var result = CardPayment.verifyPaymentAgainstSnapshot(record, 8000, 'JPY');
    assert.strictEqual(result.valid, false, JSON.stringify(record) + ' はスナップショット未記録として拒否されるべき');
    assert.strictEqual(result.error.code, 'SNAPSHOT_NOT_AVAILABLE');
  });
});

/*
 * generatePaymentAttemptId: bookingIdと同じくuuidの一部を混ぜる方式
 * （Booking.generateBookingIdと同方針）。Checkout Session発行時の冪等キーや
 * Webhook metadataとの照合に使う想定（PR-B/PR-C）。
 */
test('generatePaymentAttemptId: PAY-<bookingId>-<uuid先頭12桁を大文字化・ハイフン除去>の形式を返す', function () {
  var CardPayment = loadCardPayment();
  var id = CardPayment.generatePaymentAttemptId('SX-20261001-3F2A9B1C', 'ab12cd34-ef56-7890-ab12-cd34ef567890');
  assert.strictEqual(id, 'PAY-SX-20261001-3F2A9B1C-AB12CD34EF56');
});

test('generatePaymentAttemptId: 異なるuuidを渡せば異なる決済試行IDになる（再試行のたびに新しいIDを発行する想定）', function () {
  var CardPayment = loadCardPayment();
  var first = CardPayment.generatePaymentAttemptId('SX-20261001-3F2A9B1C', 'aaaaaaaa-0000-0000-0000-000000000000');
  var second = CardPayment.generatePaymentAttemptId('SX-20261001-3F2A9B1C', 'bbbbbbbb-0000-0000-0000-000000000000');
  assert.notStrictEqual(first, second);
});

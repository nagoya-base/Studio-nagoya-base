/*
 * BookingRepository.applyPaymentStateUpdate のテスト（Issue #341 PR-Aレビュー対応）。
 *
 * 実際のStripe API・Webhookは呼ばない（PR-B/PR-Cの責務）。ここではLockServiceによる
 * 排他制御・更新順序（決済付随情報17列→paymentStatus単独の順）・部分失敗時のRecovery
 * 記録・要復旧ゲート・冪等な再実行（既に目的の状態ならalreadyApplied:trueで成功扱い）・
 * 未知のpaymentStatus値の検知で処理を停止する挙動を、モックのLockService/SpreadsheetApp
 * を使って検証する。
 */
'use strict';

var test = require('node:test');
var assert = require('node:assert');
var loadBookingSandbox = require('./helpers/gas-sandbox').loadBookingSandbox;
var stubs = require('./helpers/gas-stubs');

var FILES = [
  'Config.gs',
  'CalendarRepository.gs',
  'Availability.gs',
  'Booking.gs',
  'SpreadsheetRepository.gs',
  'RecoveryRepository.gs',
  'BookingRepository.gs'
];

var SPREADSHEET_ID = 'ss1';

function setup(options) {
  var opts = options || {};
  var spreadsheetsById = {};
  spreadsheetsById[SPREADSHEET_ID] = opts.sheetsByName || {};
  var properties = Object.assign({ SPREADSHEET_ID: SPREADSHEET_ID }, opts.properties || {});

  var globals = {
    PropertiesService: stubs.createPropertiesServiceStub(properties),
    LockService: opts.lockService || stubs.createLockServiceStub(),
    SpreadsheetApp: stubs.createSpreadsheetAppStub(spreadsheetsById),
    Logger: stubs.createLoggerStub()
  };

  var sandbox = loadBookingSandbox(FILES, globals);
  return { sandbox: sandbox, globals: globals };
}

function sampleRecord(overrides) {
  return Object.assign(
    {
      bookingId: 'SX-20261001-AAAAAAAA',
      createdAt: new Date('2026-09-30T10:00:00+09:00'),
      date: '2026-10-01',
      startAt: new Date('2026-10-01T10:00:00+09:00'),
      endAt: new Date('2026-10-01T12:00:00+09:00'),
      brand: 'studio_x',
      name: '山田太郎',
      email: 'taro@example.com',
      phone: '090-0000-0000',
      people: '2名',
      purpose: '緊縛の自主練習',
      paymentMethod: 'オンラインクレジットカード',
      status: 'PENDING',
      calendarEventId: 'event-1',
      source: 'test',
      note: '',
      paymentStatus: 'not_started'
    },
    overrides || {}
  );
}

function createBookingRow(ctx, overrides) {
  ctx.sandbox.SpreadsheetRepository.appendBooking(sampleRecord(overrides));
  return 'SX-20261001-AAAAAAAA';
}

test('applyPaymentStateUpdate: NOT_STARTED→CHECKOUT_PENDINGへ、決済付随情報→paymentStatusの順で1回ずつ書き込む', function () {
  var ctx = setup();
  var bookingId = createBookingRow(ctx);

  var result = ctx.sandbox.BookingRepository.applyPaymentStateUpdate(bookingId, 'checkout_pending', {
    paymentAttemptId: 'PAY-1', stripeCheckoutSessionId: 'cs_1', paymentHoldExpiresAt: new Date('2026-10-01T09:30:00+09:00')
  });

  assert.strictEqual(result.success, true);
  assert.strictEqual(result.alreadyApplied, undefined);

  var found = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(bookingId);
  assert.strictEqual(found.record.paymentStatus, 'checkout_pending');
  assert.strictEqual(found.record.paymentAttemptId, 'PAY-1');
  assert.strictEqual(found.record.stripeCheckoutSessionId, 'cs_1');

  var sheet = ctx.globals.SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName('Bookings');
  var calls = sheet._setValuesCalls;
  assert.strictEqual(calls.length, 2, '決済付随情報の一括書き込みとpaymentStatus単独書き込みの2回だけ');
  assert.strictEqual(calls[0].numCols, 17, '1回目は決済付随情報17列の一括書き込み（PR #354レビュー対応・3回目でpaymentAttemptResolvedAtを追加）');
  assert.strictEqual(
    calls[0].col, ctx.sandbox.SpreadsheetRepository.HEADERS.indexOf('paymentAttemptId') + 1,
    '1回目はpaymentAttemptIdから始まる'
  );
  assert.strictEqual(calls[1].numCols, 1, '2回目はpaymentStatus単独の書き込み');
  assert.strictEqual(
    calls[1].col, ctx.sandbox.SpreadsheetRepository.HEADERS.indexOf('paymentStatus') + 1,
    '2回目はpaymentStatus列だけを書く'
  );
});

test('applyPaymentStateUpdate: fieldsを渡さない遷移（例: FAILED→CHECKOUT_PENDINGの再試行）はpaymentStatusのみ1回書き込む', function () {
  var ctx = setup();
  // FAILEDは必須証跡なし（REQUIRED_EVIDENCE_FOR_STATUS_）のため、fields省略でも
  // PAYMENT_EVIDENCE_MISSINGにならない遷移として checkout_pending→failed を使う
  // （Session期限切れ等、PaymentIntentが発行される前に失敗する経路もあるため）。
  var bookingId = createBookingRow(ctx, {
    paymentStatus: 'checkout_pending', paymentAttemptId: 'PAY-1', stripeCheckoutSessionId: 'cs_1'
  });

  var result = ctx.sandbox.BookingRepository.applyPaymentStateUpdate(bookingId, 'failed');
  assert.strictEqual(result.success, true);

  var sheet = ctx.globals.SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName('Bookings');
  assert.strictEqual(sheet._setValuesCalls.length, 1, 'fields省略時は決済付随情報の書き込みをスキップする');

  var found = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(bookingId);
  assert.strictEqual(found.record.paymentStatus, 'failed');
});

test('applyPaymentStateUpdate: FAILED→CHECKOUT_PENDINGの再試行は、新しい決済試行ID・Session idをfieldsで主張する必要がある（証跡なしのCHECKOUT_PENDINGは許可しない）', function () {
  var ctx = setup();
  var bookingId = createBookingRow(ctx, { paymentStatus: 'failed' });

  var withoutEvidence = ctx.sandbox.BookingRepository.applyPaymentStateUpdate(bookingId, 'checkout_pending');
  assert.strictEqual(withoutEvidence.success, false);
  assert.strictEqual(withoutEvidence.error.code, 'PAYMENT_EVIDENCE_MISSING');

  var withEvidence = ctx.sandbox.BookingRepository.applyPaymentStateUpdate(bookingId, 'checkout_pending', {
    paymentAttemptId: 'PAY-2', stripeCheckoutSessionId: 'cs_2'
  });
  assert.strictEqual(withEvidence.success, true);
  var found = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(bookingId);
  assert.strictEqual(found.record.paymentStatus, 'checkout_pending');
  assert.strictEqual(found.record.paymentAttemptId, 'PAY-2', '再試行では新しい決済試行IDに更新される');
});

/*
 * 3回目レビュー対応・項目1: 「既に目的の状態」であっても、その状態に必須の証跡が
 * 台帳に一つも記録されていなければalreadyApplied:trueにしない。識別子を何も主張しない
 * 再実行（＝2回目対応時点ではpaymentIdentityMatches_を素通りしてしまっていた経路）が
 * 抜け穴にならないことを検証する。
 */
test('applyPaymentStateUpdate: paidでPaymentIntent ID等の必須証跡が台帳に記録されていない場合、識別子を主張しない再実行であってもPAYMENT_EVIDENCE_MISSINGで拒否する（同一状態への再実行での証跡検証の回避を防ぐ）', function () {
  var ctx = setup();
  var bookingId = createBookingRow(ctx, {
    paymentStatus: 'paid', paymentAttemptId: 'PAY-1', stripeCheckoutSessionId: 'cs_1'
    // stripePaymentIntentId・lastStripeEventIdは意図的に未設定（証跡が欠けたまま'paid'になっている異常な台帳を模す）。
  });

  var result = ctx.sandbox.BookingRepository.applyPaymentStateUpdate(bookingId, 'paid');
  assert.strictEqual(result.success, false);
  assert.strictEqual(result.error.code, 'PAYMENT_EVIDENCE_MISSING');
  assert.notStrictEqual(result.alreadyApplied, true, '証跡が無いまま「既に目的の状態」を成功扱いにしてはならない');

  var found = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(bookingId);
  assert.ok(found.record.paymentRecoveryRequiredAt, '台帳側の記録そのものが不整合（証跡なしでpaidに到達）なため恒久ゲートを立てる');
  assert.strictEqual(found.record.paymentRecoveryReason.indexOf('paid') !== -1 || found.record.paymentRecoveryReason.length > 0, true);

  var recovery = ctx.sandbox.RecoveryRepository.listAll();
  assert.strictEqual(recovery.length, 1);
  assert.strictEqual(recovery[0].failureType, 'PAYMENT_EVIDENCE_MISSING');

  // 要復旧ゲートが立っているため、後から正しい証跡を渡しても自動では復旧しない（管理者の確認が必要）。
  var retryWithEvidence = ctx.sandbox.BookingRepository.applyPaymentStateUpdate(bookingId, 'paid', {
    stripePaymentIntentId: 'pi_1', lastStripeEventId: 'evt_1'
  });
  assert.strictEqual(retryWithEvidence.success, false);
  assert.strictEqual(retryWithEvidence.error.code, 'PAYMENT_RECOVERY_REQUIRED');
});

/*
 * 4回目レビュー対応: 「既に目的の状態」の経路は台帳を一切書き込まないため、
 * この経路の証跡検証は台帳に**現に保存されている値だけ**で行わなければならない。
 * 3回目対応時点の実装は、この経路でもfindMissingPaymentEvidence_（fieldsを台帳より
 * 優先してマージする、新規遷移用の関数）を誤って使っていたため、台帳自体は
 * lastStripeEventIdを欠いたまま（証跡不備）でも、今回の呼び出しがfieldsに正しい
 * lastStripeEventIdを渡しさえすれば検証を通過し、alreadyApplied:trueに到達できて
 * しまっていた（＝台帳の不整合を検知できないまま隠してしまう）。この抜け穴を検証する。
 */
test('applyPaymentStateUpdate: paidの台帳でlastStripeEventIdが欠落している場合、再実行時のfieldsに正しいlastStripeEventIdを渡してもalreadyApplied:trueにならない（台帳の証跡欠落を今回の入力で覆い隠さない）', function () {
  var ctx = setup();
  var bookingId = createBookingRow(ctx, {
    paymentStatus: 'paid', paymentAttemptId: 'PAY-1', stripeCheckoutSessionId: 'cs_1',
    stripePaymentIntentId: 'pi_1'
    // lastStripeEventIdのみ意図的に未設定。stripePaymentIntentIdは記録済みという、
    // 一部の証跡だけが欠けた状態を模す。
  });

  // 再実行時のfieldsには正しいlastStripeEventIdを渡すが、台帳自体には保存されていない。
  var result = ctx.sandbox.BookingRepository.applyPaymentStateUpdate(bookingId, 'paid', {
    stripePaymentIntentId: 'pi_1', lastStripeEventId: 'evt_1'
  });
  assert.strictEqual(result.success, false);
  assert.strictEqual(result.error.code, 'PAYMENT_EVIDENCE_MISSING');
  assert.notStrictEqual(result.alreadyApplied, true, '今回のfieldsに正しい値を渡しても、台帳自体の証跡欠落をalreadyApplied:trueで覆い隠してはならない');

  var found = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(bookingId);
  assert.strictEqual(found.record.lastStripeEventId, '', 'この経路はBookingsへ一切書き込まない（fieldsのlastStripeEventIdが台帳へ漏れて反映されていないこと）');
  assert.ok(found.record.paymentRecoveryRequiredAt, '台帳側の証跡欠落として恒久ゲートを立てる');

  var recovery = ctx.sandbox.RecoveryRepository.listAll();
  assert.strictEqual(recovery.length, 1);
  assert.strictEqual(recovery[0].failureType, 'PAYMENT_EVIDENCE_MISSING');
});

/*
 * 再実行時の整合性検証（Issue #341 PR-Aレビュー対応・項目1）: 既に目的の状態へ到達済みの
 * 場合は書き込みを一切行わずalreadyApplied:trueで成功を返す。Stripe Webhookの重複配信・
 * 呼び出し元の重複リトライを安全に吸収する。
 */
test('applyPaymentStateUpdate: 既にtoPaymentStatusと同じ場合でも証跡・識別子が確認できて初めてalreadyApplied:trueで冪等に成功する（資金移動を伴う状態）', function () {
  var ctx = setup();
  var bookingId = createBookingRow(ctx, {
    paymentStatus: 'paid', paymentAttemptId: 'PAY-1', stripeCheckoutSessionId: 'cs_1',
    stripePaymentIntentId: 'pi_1', lastStripeEventId: 'evt_1'
  });

  var result = ctx.sandbox.BookingRepository.applyPaymentStateUpdate(bookingId, 'paid', {
    stripePaymentIntentId: 'pi_1', lastStripeEventId: 'evt_1'
  });
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.alreadyApplied, true);

  var sheet = ctx.globals.SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName('Bookings');
  assert.strictEqual(sheet._setValuesCalls.length, 0, '既に目的の状態で証跡・識別子とも確認できたので一切書き込まない');
});

/*
 * 2回目レビュー対応・項目1: alreadyAppliedの判定条件の厳格化。
 * 決済状態の一致だけでなく、呼び出し元が主張する決済試行ID・Stripe識別子
 * （IDENTITY_FIELDS_）が台帳の記録と一致することまで確認する。
 */
test('applyPaymentStateUpdate: 同じ決済試行ID（paymentAttemptId/stripeCheckoutSessionId/stripePaymentIntentId/lastStripeEventId）による重複処理は冪等に成功する', function () {
  var ctx = setup();
  var bookingId = createBookingRow(ctx, {
    paymentStatus: 'paid', paymentAttemptId: 'PAY-1', stripeCheckoutSessionId: 'cs_1',
    stripePaymentIntentId: 'pi_1', lastStripeEventId: 'evt_1'
  });

  // Webhookの重複配信を模し、同一の決済試行IDを主張して同じ'paid'への遷移を再送する。
  var result = ctx.sandbox.BookingRepository.applyPaymentStateUpdate(bookingId, 'paid', {
    paymentAttemptId: 'PAY-1', stripeCheckoutSessionId: 'cs_1', stripePaymentIntentId: 'pi_1', lastStripeEventId: 'evt_1'
  });
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.alreadyApplied, true);

  var sheet = ctx.globals.SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName('Bookings');
  assert.strictEqual(sheet._setValuesCalls.length, 0, '同一の決済試行と確認できたので何も書き込まない');
});

test('applyPaymentStateUpdate: 異なる決済試行ID（paymentAttemptId）を主張する呼び出しは、決済状態が同じでも処理済みとして扱わずPAYMENT_IDENTITY_MISMATCHで停止する', function () {
  var ctx = setup();
  var bookingId = createBookingRow(ctx, {
    paymentStatus: 'paid', paymentAttemptId: 'PAY-1', stripeCheckoutSessionId: 'cs_1',
    stripePaymentIntentId: 'pi_1', lastStripeEventId: 'evt_1'
  });

  // 別の決済試行（例えば別のCheckout Session由来のWebhook）が、同じ'paid'を主張してきたケース。
  var result = ctx.sandbox.BookingRepository.applyPaymentStateUpdate(bookingId, 'paid', {
    paymentAttemptId: 'PAY-2', stripeCheckoutSessionId: 'cs_2', stripePaymentIntentId: 'pi_2', lastStripeEventId: 'evt_2'
  });
  assert.strictEqual(result.success, false);
  assert.strictEqual(result.error.code, 'PAYMENT_IDENTITY_MISMATCH');
  assert.notStrictEqual(result.alreadyApplied, true, '別の決済試行を完了済みとして扱ってはならない');

  var found = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(bookingId);
  assert.strictEqual(found.record.paymentAttemptId, 'PAY-1', '台帳の記録を上書きしない');
  assert.ok(found.record.paymentRecoveryRequiredAt, '別の決済試行の可能性があるため要復旧フラグを立てる（二重決済等の疑いを人が確認するまで自動処理を止める）');

  var recovery = ctx.sandbox.RecoveryRepository.listAll();
  assert.strictEqual(recovery.length, 1);
  assert.strictEqual(recovery[0].failureType, 'PAYMENT_IDENTITY_MISMATCH');
});

/*
 * 2回目レビュー対応・項目3（要復旧となった予約への自動処理再実行禁止）:
 * PAYMENT_IDENTITY_MISMATCHで要復旧になった予約は、その後どんな（本来なら正当な）
 * 呼び出しが来てもPAYMENT_RECOVERY_REQUIREDで即座に拒否され、台帳へは一切書き込まれない。
 */
test('applyPaymentStateUpdate: PAYMENT_IDENTITY_MISMATCHで要復旧になった予約は、以後の正当な呼び出しも含めて自動処理が再実行されない', function () {
  var ctx = setup();
  var bookingId = createBookingRow(ctx, {
    paymentStatus: 'paid', paymentAttemptId: 'PAY-1', stripeCheckoutSessionId: 'cs_1',
    stripePaymentIntentId: 'pi_1', lastStripeEventId: 'evt_1'
  });

  ctx.sandbox.BookingRepository.applyPaymentStateUpdate(bookingId, 'paid', {
    paymentAttemptId: 'PAY-2', stripeCheckoutSessionId: 'cs_2', stripePaymentIntentId: 'pi_2', lastStripeEventId: 'evt_2'
  });

  // 要復旧後、たとえ正しい（PAY-1の）識別子を主張する呼び出しであっても再実行されない。
  var retry = ctx.sandbox.BookingRepository.applyPaymentStateUpdate(bookingId, 'refund_pending', {
    stripeRefundId: 're_1'
  });
  assert.strictEqual(retry.success, false);
  assert.strictEqual(retry.error.code, 'PAYMENT_RECOVERY_REQUIRED');

  var sheet = ctx.globals.SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName('Bookings');
  var setValuesCallsAfterMismatch = sheet._setValuesCalls.length;
  ctx.sandbox.BookingRepository.applyPaymentStateUpdate(bookingId, 'paid', {
    paymentAttemptId: 'PAY-1', stripeCheckoutSessionId: 'cs_1', stripePaymentIntentId: 'pi_1', lastStripeEventId: 'evt_1'
  });
  assert.strictEqual(
    sheet._setValuesCalls.length, setValuesCallsAfterMismatch,
    '要復旧ゲートが立っている間はいかなる呼び出しも台帳へ書き込まない'
  );
});

/*
 * 3回目レビュー対応・項目3: refundedについても、返金識別子（stripeRefundId）の
 * 欠落・一致・不一致をpaidと同じ3パターンで検証する。
 */
test('applyPaymentStateUpdate: refundedでも返金識別子（stripeRefundId）が台帳に記録されていなければ、識別子なしの再実行はPAYMENT_EVIDENCE_MISSINGで拒否する', function () {
  var ctx = setup();
  var bookingId = createBookingRow(ctx, {
    paymentStatus: 'refunded', paymentAttemptId: 'PAY-1', stripeCheckoutSessionId: 'cs_1',
    stripePaymentIntentId: 'pi_1', lastStripeEventId: 'evt_1'
    // stripeRefundIdは意図的に未設定。
  });

  var result = ctx.sandbox.BookingRepository.applyPaymentStateUpdate(bookingId, 'refunded');
  assert.strictEqual(result.success, false);
  assert.strictEqual(result.error.code, 'PAYMENT_EVIDENCE_MISSING');

  var found = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(bookingId);
  assert.ok(found.record.paymentRecoveryRequiredAt, '返金識別子が無いままrefundedに到達している台帳側の不整合として恒久ゲートを立てる');
});

test('applyPaymentStateUpdate: refundedで同じstripeRefundIdを主張する再実行は冪等に成功する', function () {
  var ctx = setup();
  var bookingId = createBookingRow(ctx, {
    paymentStatus: 'refunded', paymentAttemptId: 'PAY-1', stripeCheckoutSessionId: 'cs_1',
    stripePaymentIntentId: 'pi_1', lastStripeEventId: 'evt_1', stripeRefundId: 're_1'
  });

  var result = ctx.sandbox.BookingRepository.applyPaymentStateUpdate(bookingId, 'refunded', { stripeRefundId: 're_1' });
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.alreadyApplied, true);

  var sheet = ctx.globals.SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName('Bookings');
  assert.strictEqual(sheet._setValuesCalls.length, 0);
});

test('applyPaymentStateUpdate: refundedで異なるstripeRefundIdを主張する呼び出しはPAYMENT_IDENTITY_MISMATCHで拒否する（別の返金処理を完了済みとして扱わない）', function () {
  var ctx = setup();
  var bookingId = createBookingRow(ctx, {
    paymentStatus: 'refunded', paymentAttemptId: 'PAY-1', stripeCheckoutSessionId: 'cs_1',
    stripePaymentIntentId: 'pi_1', lastStripeEventId: 'evt_1', stripeRefundId: 're_1'
  });

  var result = ctx.sandbox.BookingRepository.applyPaymentStateUpdate(bookingId, 'refunded', { stripeRefundId: 're_2' });
  assert.strictEqual(result.success, false);
  assert.strictEqual(result.error.code, 'PAYMENT_IDENTITY_MISMATCH');

  var found = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(bookingId);
  assert.strictEqual(found.record.stripeRefundId, 're_1', '台帳の記録を上書きしない');
  assert.ok(found.record.paymentRecoveryRequiredAt);
});

test('applyPaymentStateUpdate: refundedへの再確認で返金識別子を一つも主張しない呼び出しはPAYMENT_IDENTITY_UNCONFIRMEDで停止する', function () {
  var ctx = setup();
  var bookingId = createBookingRow(ctx, {
    paymentStatus: 'refunded', paymentAttemptId: 'PAY-1', stripeCheckoutSessionId: 'cs_1',
    stripePaymentIntentId: 'pi_1', lastStripeEventId: 'evt_1', stripeRefundId: 're_1'
  });

  var result = ctx.sandbox.BookingRepository.applyPaymentStateUpdate(bookingId, 'refunded');
  assert.strictEqual(result.success, false);
  assert.strictEqual(result.error.code, 'PAYMENT_IDENTITY_UNCONFIRMED');

  var found = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(bookingId);
  assert.strictEqual(found.record.paymentRecoveryRequiredAt, '', '同一性の未確認は台帳側の不整合ではないため恒久ゲートは立てない');
});

/*
 * 3回目レビュー対応・項目2: 資金移動を伴う状態（paid/refund_pending/refunded）は、
 * 識別子を一つも主張しない呼び出しを無条件に同一処理とみなしてはならない。
 * checkout_pending/failedのような非資金移動の状態では、識別子を主張しない呼び出しは
 * 従来どおり状態の一致のみでalreadyApplied:trueになる（対比のため両方を検証する）。
 */
test('applyPaymentStateUpdate: paidへの再確認で決済識別子を一つも主張しない呼び出しはPAYMENT_IDENTITY_UNCONFIRMEDで停止する（証跡自体は台帳に揃っていても、同一処理かどうかは確認できないため）', function () {
  var ctx = setup();
  var bookingId = createBookingRow(ctx, {
    paymentStatus: 'paid', paymentAttemptId: 'PAY-1', stripeCheckoutSessionId: 'cs_1',
    stripePaymentIntentId: 'pi_1', lastStripeEventId: 'evt_1'
  });

  var result = ctx.sandbox.BookingRepository.applyPaymentStateUpdate(bookingId, 'paid', { paymentConfirmedAt: new Date() });
  assert.strictEqual(result.success, false);
  assert.strictEqual(result.error.code, 'PAYMENT_IDENTITY_UNCONFIRMED');
  assert.notStrictEqual(result.alreadyApplied, true);

  var found = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(bookingId);
  assert.strictEqual(found.record.paymentConfirmedAt, '', '台帳は一切変更しない');
  assert.strictEqual(found.record.paymentRecoveryRequiredAt, '', '同一性を確認できなかっただけで台帳側の不整合ではないため恒久ゲートは立てない');

  var recovery = ctx.sandbox.RecoveryRepository.listAll();
  assert.strictEqual(recovery.length, 1);
  assert.strictEqual(recovery[0].failureType, 'PAYMENT_IDENTITY_UNCONFIRMED');

  // 正しい識別子を添えれば、恒久ゲートが立っていないため即座に成功する。
  var retryWithIdentity = ctx.sandbox.BookingRepository.applyPaymentStateUpdate(bookingId, 'paid', {
    stripePaymentIntentId: 'pi_1', lastStripeEventId: 'evt_1'
  });
  assert.strictEqual(retryWithIdentity.success, true);
  assert.strictEqual(retryWithIdentity.alreadyApplied, true);
});

test('applyPaymentStateUpdate: checkout_pending/failedのような非資金移動の状態では、識別子を主張しない呼び出しは従来どおり状態の一致のみでalreadyApplied:trueになる', function () {
  var ctx = setup();
  var bookingId = createBookingRow(ctx, { paymentStatus: 'failed', paymentAttemptId: 'PAY-1' });

  var result = ctx.sandbox.BookingRepository.applyPaymentStateUpdate(bookingId, 'failed');
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.alreadyApplied, true);
});

/*
 * Issue #341 PR-Cレビュー対応・1回目: expirePendingBookings（Booking Admin）とWebhook処理
 * （Booking Webhook。別プロジェクト・別LockService）が競合し、失効判定が先に
 * paymentStatus:failedへ進めた直後に、実際には決済が成立していたとWebhookで判明する
 * 場合がある。この場合でも入金の事実（paymentStatus:paid）を記録できることを検証する
 * （Booking.gsのPAYMENT_STATUS_TRANSITIONS_[FAILED]にPAIDを追加）。この関数はpaymentStatus
 * 列のみを更新し、予約のstatus（EXPIRED等）には一切影響しない。
 */
test('applyPaymentStateUpdate: 失効によりFAILEDへ進んだ後でも、正しい証跡があれば入金の事実（PAID）を記録できる（Issue #341 PR-Cレビュー対応）', function () {
  var ctx = setup();
  var bookingId = createBookingRow(ctx, {
    status: 'EXPIRED',
    paymentStatus: 'failed',
    paymentAttemptId: 'PAY-1',
    stripeCheckoutSessionId: 'cs_1'
  });

  var result = ctx.sandbox.BookingRepository.applyPaymentStateUpdate(bookingId, 'paid', {
    stripePaymentIntentId: 'pi_1', lastStripeEventId: 'evt_1', paymentConfirmedAt: new Date()
  });
  assert.strictEqual(result.success, true);

  var found = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(bookingId);
  assert.strictEqual(found.record.paymentStatus, 'paid', '入金の事実が記録される');
  assert.strictEqual(found.record.status, 'EXPIRED', '予約のstatusには一切影響しない（自動確定はconfirmBooking側の責務）');
  assert.strictEqual(found.record.stripePaymentIntentId, 'pi_1');
});

/*
 * 2回目レビュー対応・項目2: 決済証跡の整合性検証。
 * paidへの遷移にはstripePaymentIntentId・lastStripeEventIdが必須（REQUIRED_EVIDENCE_FOR_STATUS_）。
 */
test('applyPaymentStateUpdate: 決済状態をpaidへ進めようとしても、必要な決済証跡（stripePaymentIntentId等）が欠落していればPAYMENT_EVIDENCE_MISSINGで処理を停止する', function () {
  var ctx = setup();
  var bookingId = createBookingRow(ctx, {
    paymentStatus: 'checkout_pending', paymentAttemptId: 'PAY-1', stripeCheckoutSessionId: 'cs_1'
  });

  // stripePaymentIntentId・lastStripeEventIdのいずれも渡さない、証跡の無い「決済成功」報告。
  var result = ctx.sandbox.BookingRepository.applyPaymentStateUpdate(bookingId, 'paid', { paymentConfirmedAt: new Date() });
  assert.strictEqual(result.success, false);
  assert.strictEqual(result.error.code, 'PAYMENT_EVIDENCE_MISSING');

  var found = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(bookingId);
  assert.strictEqual(found.record.paymentStatus, 'checkout_pending', '証跡が無いため決済状態は進めない');
  assert.strictEqual(found.record.paymentConfirmedAt, '', '台帳は一切変更しない');

  var recovery = ctx.sandbox.RecoveryRepository.listAll();
  assert.strictEqual(recovery.length, 1, '証跡欠落の監査記録は残す');
  assert.strictEqual(recovery[0].failureType, 'PAYMENT_EVIDENCE_MISSING');

  // 証跡が欠けていただけで台帳側の不整合ではないため、恒久ゲートは立てない
  // （正しい証跡を添えれば同じbookingIdへ即座に再試行できる）。
  var retryWithEvidence = ctx.sandbox.BookingRepository.applyPaymentStateUpdate(bookingId, 'paid', {
    stripePaymentIntentId: 'pi_1', lastStripeEventId: 'evt_1'
  });
  assert.strictEqual(retryWithEvidence.success, true, '正しい証跡を添えた再試行は成功する（恒久ゲートは立っていない）');
});

test('applyPaymentStateUpdate: Booking.canTransitionPaymentStatusで許可されない遷移はINVALID_PAYMENT_TRANSITIONを返し、何も書き込まない', function () {
  var ctx = setup();
  var bookingId = createBookingRow(ctx, { paymentStatus: 'not_started' });

  var result = ctx.sandbox.BookingRepository.applyPaymentStateUpdate(bookingId, 'paid', { paymentConfirmedAt: new Date() });
  assert.strictEqual(result.success, false);
  assert.strictEqual(result.error.code, 'INVALID_PAYMENT_TRANSITION');

  var found = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(bookingId);
  assert.strictEqual(found.record.paymentStatus, 'not_started');
});

test('applyPaymentStateUpdate: 存在しないbookingIdはNOT_FOUNDを返す', function () {
  var ctx = setup();
  var result = ctx.sandbox.BookingRepository.applyPaymentStateUpdate('NOT-EXIST', 'checkout_pending');
  assert.strictEqual(result.success, false);
  assert.strictEqual(result.error.code, 'NOT_FOUND');
});

test('applyPaymentStateUpdate: LockServiceがtryLockに失敗した場合はLOCK_TIMEOUTを返し、何も読み書きしない', function () {
  var ctx = setup({ lockService: stubs.createLockServiceStub({ forceTryLockFail: true }) });
  var bookingId = createBookingRow(ctx);

  var result = ctx.sandbox.BookingRepository.applyPaymentStateUpdate(bookingId, 'checkout_pending');
  assert.strictEqual(result.success, false);
  assert.strictEqual(result.error.code, 'LOCK_TIMEOUT');
});

/*
 * 要復旧ゲート（Issue #341 PR-Aレビュー対応・項目1）: paymentRecoveryRequiredAtが
 * 既に設定されている予約は、遷移の妥当性を判定するまでもなく即座に拒否する
 * （feeRecoveryRequiredAtと同じ設計方針）。
 */
test('applyPaymentStateUpdate: paymentRecoveryRequiredAtが設定済みの予約はPAYMENT_RECOVERY_REQUIREDで即座に拒否し、何も書き込まない', function () {
  var ctx = setup();
  var bookingId = createBookingRow(ctx, {
    paymentStatus: 'checkout_pending',
    paymentRecoveryRequiredAt: new Date('2026-09-30T12:00:00+09:00'),
    paymentRecoveryReason: 'TEST_SEED'
  });

  var result = ctx.sandbox.BookingRepository.applyPaymentStateUpdate(bookingId, 'paid', { paymentConfirmedAt: new Date() });
  assert.strictEqual(result.success, false);
  assert.strictEqual(result.error.code, 'PAYMENT_RECOVERY_REQUIRED');

  var sheet = ctx.globals.SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName('Bookings');
  assert.strictEqual(sheet._setValuesCalls.length, 0);
});

/*
 * 未知のpaymentStatusの扱い（Issue #341 PR-Aレビュー対応・項目2）: normalizePaymentStatusが
 * nullを返す（旧unpaid・既知の6値のいずれでもない）値は「未決済」とみなさず、
 * 決済処理を停止する。要復旧フラグを立て、Recoveryにも記録する。
 */
test('applyPaymentStateUpdate: 未知のpaymentStatus値が混入している場合はUNKNOWN_PAYMENT_STATUSで処理を停止し、要復旧フラグとRecovery記録を残す', function () {
  var ctx = setup();
  var bookingId = createBookingRow(ctx, { paymentStatus: 'some_unexpected_value' });

  var result = ctx.sandbox.BookingRepository.applyPaymentStateUpdate(bookingId, 'checkout_pending');
  assert.strictEqual(result.success, false);
  assert.strictEqual(result.error.code, 'UNKNOWN_PAYMENT_STATUS');

  var found = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(bookingId);
  assert.strictEqual(found.record.paymentStatus, 'some_unexpected_value', '不明な値そのものは書き換えない（上書きして証跡を消さない）');
  assert.ok(found.record.paymentRecoveryRequiredAt, '要復旧フラグが立つ');
  assert.ok(
    /paymentStatus/.test(found.record.paymentRecoveryReason),
    'paymentRecoveryReasonには管理者向けの説明文が入る（Recovery.failureTypeとは別にBookings上でも状況が分かるように）'
  );

  var recovery = ctx.sandbox.RecoveryRepository.listAll();
  assert.strictEqual(recovery.length, 1);
  assert.strictEqual(recovery[0].failureType, 'UNKNOWN_PAYMENT_STATUS');
  assert.strictEqual(recovery[0].bookingId, bookingId);
});

test('applyPaymentStateUpdate: 未知のpaymentStatus値で一度要復旧になった予約は、以後の呼び出しもPAYMENT_RECOVERY_REQUIREDで即座に拒否される', function () {
  var ctx = setup();
  var bookingId = createBookingRow(ctx, { paymentStatus: 'some_unexpected_value' });

  ctx.sandbox.BookingRepository.applyPaymentStateUpdate(bookingId, 'checkout_pending');
  var second = ctx.sandbox.BookingRepository.applyPaymentStateUpdate(bookingId, 'checkout_pending');
  assert.strictEqual(second.success, false);
  assert.strictEqual(second.error.code, 'PAYMENT_RECOVERY_REQUIRED');
});

/*
 * 部分失敗時のRecovery記録（Issue #341 PR-Aレビュー対応・項目1、更新順序の裏付け）:
 * 決済付随情報の書き込み自体が失敗した場合、この呼び出しでは何も変化していないため
 * 要復旧フラグは立てない（呼び出し元が最初からやり直せば足りる）。
 */
test('applyPaymentStateUpdate: 決済付随情報の書き込みが失敗した場合はPAYMENT_DETAIL_WRITE_FAILEDを返し、paymentStatus・要復旧フラグとも変化しない', function () {
  var ctx = setup();
  var bookingId = createBookingRow(ctx);

  ctx.sandbox.SpreadsheetRepository.updateBookingPaymentStateAtomic = function () {
    throw new Error('simulated sheets failure');
  };

  var result = ctx.sandbox.BookingRepository.applyPaymentStateUpdate(bookingId, 'checkout_pending', {
    paymentAttemptId: 'PAY-1', stripeCheckoutSessionId: 'cs_1'
  });
  assert.strictEqual(result.success, false);
  assert.strictEqual(result.error.code, 'PAYMENT_DETAIL_WRITE_FAILED');

  var found = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(bookingId);
  assert.strictEqual(found.record.paymentStatus, 'not_started', '書き込みが失敗した呼び出しではpaymentStatusを変更しない');
  assert.strictEqual(found.record.paymentRecoveryRequiredAt, '', '何も反映されていないため要復旧フラグは立てない（最初からやり直せる）');
  assert.strictEqual(ctx.sandbox.RecoveryRepository.listAll().length, 0);
});

/*
 * これがこのレビュー対応の核心テスト：決済付随情報は書き込みに成功したのに、
 * paymentStatus単独の書き込みだけが失敗した場合、台帳は「詳細情報は新しいが状態は古い」
 * という不整合のまま残る。この状態を検出し、要復旧フラグ・Recovery記録を残して
 * 以後の自動処理を止めることを検証する。
 */
test('applyPaymentStateUpdate: 決済付随情報は成功しpaymentStatusの書き込みだけ失敗した場合、不整合を検知して要復旧フラグ・Recoveryを記録する', function () {
  var ctx = setup();
  var bookingId = createBookingRow(ctx);

  var originalUpdateBookingFields = ctx.sandbox.SpreadsheetRepository.updateBookingFields;
  ctx.sandbox.SpreadsheetRepository.updateBookingFields = function (id, fields) {
    if (Object.prototype.hasOwnProperty.call(fields, 'paymentStatus')) {
      throw new Error('simulated sheets failure on paymentStatus write');
    }
    return originalUpdateBookingFields(id, fields);
  };

  var result = ctx.sandbox.BookingRepository.applyPaymentStateUpdate(bookingId, 'checkout_pending', {
    paymentAttemptId: 'PAY-1', stripeCheckoutSessionId: 'cs_1'
  });
  assert.strictEqual(result.success, false);
  assert.strictEqual(result.error.code, 'PAYMENT_STATUS_WRITE_FAILED_AFTER_DETAIL_COMMIT');

  var found = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(bookingId);
  assert.strictEqual(found.record.paymentAttemptId, 'PAY-1', '決済付随情報は既に反映されている');
  assert.strictEqual(found.record.stripeCheckoutSessionId, 'cs_1');
  assert.strictEqual(found.record.paymentStatus, 'not_started', 'paymentStatusは古いまま（不整合が可視化される）');
  assert.ok(found.record.paymentRecoveryRequiredAt, '不整合を検知して要復旧フラグを立てる');
  assert.ok(
    /paymentStatus/.test(found.record.paymentRecoveryReason) && /checkout_pending/.test(found.record.paymentRecoveryReason),
    'paymentRecoveryReasonには目標状態を含む管理者向けの説明文が入る'
  );

  var recovery = ctx.sandbox.RecoveryRepository.listAll();
  assert.strictEqual(recovery.length, 1);
  assert.strictEqual(recovery[0].failureType, 'PAYMENT_STATUS_WRITE_FAILED_AFTER_DETAIL_COMMIT');
  assert.strictEqual(recovery[0].bookingId, bookingId);

  // 以後の呼び出しは要復旧ゲートで即座に拒否される（自動リトライで二重に付随情報を書かない）。
  var second = ctx.sandbox.BookingRepository.applyPaymentStateUpdate(bookingId, 'checkout_pending', { paymentAttemptId: 'PAY-2' });
  assert.strictEqual(second.success, false);
  assert.strictEqual(second.error.code, 'PAYMENT_RECOVERY_REQUIRED');
  var foundAfter = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(bookingId);
  assert.strictEqual(foundAfter.record.paymentAttemptId, 'PAY-1', '要復旧ゲートにより2回目の呼び出しでは付随情報も書き換わらない');
});

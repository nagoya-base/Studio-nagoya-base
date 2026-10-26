/*
 * 会員限定特典（Issue #478）のテスト。Stripe・Sheets・Calendarはすべてスタブ/fixtureで、本番へは一切アクセスしない。
 *
 * - 会員限定2名ペアパック（独立プラン member_pair_3h）: 料金・保持・日程変更・人数・実会員資格
 * - 会員限定シャワー（OptionOrder系。SNB / mensのみ）
 * - Studio Xの有料オプション全般（rental全件 + staffService全件）のactual membership必須化
 * - 2026/12/1適用と、11/30までに作成済みの予約・OptionOrderのgrandfather
 * - 会員判定月の境界・月跨ぎの日程変更・fail-closed・列挙対策・Webhook/見積りAPIでは覆さない
 *
 * priceIsMember / mens価格優遇 は実会員資格ではない。会員台帳（MemberRepository.isMemberForMonth）のスタブで
 * 資格の有無を制御し、価格優遇と混同しないことを検証する。
 */
'use strict';

var test = require('node:test');
var assert = require('node:assert');
var loadBookingSandbox = require('./helpers/gas-sandbox').loadBookingSandbox;
var stubs = require('./helpers/gas-stubs');
var futureDate = require('./helpers/future-date');

var FILES = [
  'Config.gs', 'CalendarRepository.gs', 'Availability.gs', 'Booking.gs', 'JapaneseHolidays.gs', 'BookingPricing.gs',
  'FeeCalculator.gs', 'CardPayment.gs', 'MembershipRules.gs', 'MemberRepository.gs', 'EquipmentCatalog.gs',
  'BookingOptions.gs', 'StripeGateway.gs', 'RateLimiter.gs', 'SpreadsheetRepository.gs', 'OptionOrderRepository.gs',
  'RecoveryRepository.gs', 'FeeSettlementRepository.gs', 'StripeEventRepository.gs', 'BookingMailTemplates.gs',
  'BookingMailer.gs', 'OptionMailTemplates.gs', 'OptionOrderService.gs', 'BookingRepository.gs', 'AdminNotifier.gs',
  'BookingAdminAlerts.gs', 'BookingReschedule.gs', 'Code.gs'
];

var SPREADSHEET_ID = 'ss1';
var EMAIL = 'taro@example.com';
var DENIED_CODE = 'MEMBER_BENEFIT_NOT_AVAILABLE';

/* 新ルールの適用開始（2026/12/1 00:00 JST）の前後。 */
var NOW_BEFORE = new Date('2026-11-30T23:59:59+09:00');
var NOW_START = new Date('2026-12-01T00:00:00+09:00');
var NOW_DEC = new Date('2026-12-05T12:00:00+09:00');

/* 2026-12-07(月)=平日、2026-12-05(土)=土日祝、2027-01-11(月)=成人の日（祝日）、2027-01-12(火)=平日。 */
var WEEKDAY = '2026-12-07';
var WEEKEND = '2026-12-12';
var JAN_HOLIDAY = '2027-01-11';
var JAN_WEEKDAY = '2027-01-12';

function plain(v) { return JSON.parse(JSON.stringify(v)); }

function stripeStub(state) {
  return function (url, options) {
    var method = (options && options.method) || 'get';
    if (method === 'post' && /\/checkout\/sessions$/.test(url)) {
      state.createCalls.push(String(options.payload));
      state.counter += 1;
      var id = 'cs_test_' + state.counter;
      var params = {};
      String(options.payload).split('&').forEach(function (pair) {
        var kv = pair.split('=');
        params[decodeURIComponent(kv[0])] = decodeURIComponent(kv[1] || '');
      });
      state.sessions[id] = {
        id: id, status: 'open', payment_status: 'unpaid', url: 'https://checkout.stripe.com/c/pay/' + id,
        payment_intent: 'pi_' + id, client_reference_id: params.client_reference_id,
        amount_total: Number(params['line_items[0][price_data][unit_amount]']), currency: 'jpy',
        metadata: { bookingId: params['metadata[bookingId]'], brand: params['metadata[brand]'], paymentAttemptId: params['metadata[paymentAttemptId]'], orderType: params['metadata[orderType]'], optionOrderId: params['metadata[optionOrderId]'] },
        expires_at: Number(params.expires_at)
      };
      return { responseCode: 200, body: state.sessions[id] };
    }
    var m = /\/checkout\/sessions\/([^/?]+)$/.exec(url);
    if (m) return state.sessions[m[1]] ? { responseCode: 200, body: state.sessions[m[1]] } : { responseCode: 404, body: { error: { type: 'invalid_request_error', message: 'no' } } };
    throw new Error('未対応のStripe URL: ' + url);
  };
}

/*
 * opts.members: 会員台帳のスタブ。{ 'メール': ['YYYY-MM', ...] }（既定は誰も会員でない）。
 *               'THROW' で台帳エラー。lookups に照会履歴を残す。
 */
function setup(opts) {
  var o = opts || {};
  var calendarsById = { cal1: { events: [] } };
  var spreadsheetsById = {};
  spreadsheetsById[SPREADSHEET_ID] = {};
  var properties = {
    CALENDAR_ID: 'cal1', SPREADSHEET_ID: SPREADSHEET_ID,
    BOOKING_MAIL_DISPLAY_NAME: 'SNB', BOOKING_MAIL_REPLY_TO: 'noreply@example.com', BOOKING_CONTACT_EMAIL: 'contact@example.com',
    ADMIN_NOTIFICATION_EMAIL: 'admin@example.com',
    RATE_LIMIT_EMAIL_COUNT: '100', RATE_LIMIT_GLOBAL_COUNT: '1000',
    STRIPE_SECRET_KEY: 'sk_test_dummy', STRIPE_CHECKOUT_ENABLED: 'true',
    STRIPE_CHECKOUT_SUCCESS_URL: 'https://nagoya-base.github.io/Studio-nagoya-base/booking/payment-complete.html?session_id={CHECKOUT_SESSION_ID}',
    STRIPE_CHECKOUT_CANCEL_URL: 'https://nagoya-base.github.io/Studio-nagoya-base/booking/'
  };
  var stripe = { sessions: {}, counter: 0, createCalls: [] };
  var mailApp = stubs.createMailAppStub();
  var globals = {
    PropertiesService: stubs.createPropertiesServiceStub(properties),
    CalendarApp: stubs.createCalendarAppStub(calendarsById),
    Utilities: stubs.createUtilitiesStub(), LockService: stubs.createLockServiceStub(),
    CacheService: stubs.createCacheServiceStub(),
    SpreadsheetApp: stubs.createSpreadsheetAppStub(spreadsheetsById),
    MailApp: mailApp, UrlFetchApp: stubs.createUrlFetchAppStub(stripeStub(stripe)),
    Logger: stubs.createLoggerStub(), ContentService: stubs.createContentServiceStub()
  };
  var sandbox = loadBookingSandbox(FILES, globals);
  var ctx = { sandbox: sandbox, stripe: stripe, mailApp: mailApp, sheets: spreadsheetsById[SPREADSHEET_ID], members: o.members || {}, lookups: [] };
  sandbox.MemberRepository.isMemberForMonth = function (email, month) {
    ctx.lookups.push({ email: email, month: month });
    if (ctx.members === 'THROW') throw new Error('Sheets error');
    return (ctx.members[String(email).toLowerCase()] || []).indexOf(month) !== -1;
  };
  /* Issue #532: 資格判定は日付（isMemberOnDate）。月単位のスタブへ委譲して、既存の利用月ごとの試験を保つ。 */
  sandbox.MemberRepository.isMemberOnDate = function (email, date) {
    return sandbox.MemberRepository.isMemberForMonth(email, String(date).substring(0, 7));
  };
  return ctx;
}

function pairPayload(overrides) {
  return Object.assign({
    brand: 'mens', customerType: 'returning', date: WEEKDAY, startTime: '10:00', durationMinutes: 180,
    name: '山田太郎', email: EMAIL, phone: '090-1234-5678', people: '2名', purpose: '緊縛の自主練習',
    paymentMethod: '現金', note: '', source: 'test', isMember: true, plan: 'member_pair_3h'
  }, overrides || {});
}

function book(ctx, overrides, now) {
  return ctx.sandbox.BookingRepository.createBooking(pairPayload(overrides), now || NOW_DEC);
}

function bookingRecord(ctx, bookingId) {
  return ctx.sandbox.SpreadsheetRepository.findRowByBookingId(bookingId).record;
}

// ============================================================================
// 会員限定2名ペアパック: 料金（純粋ロジック）
// ============================================================================

test('ペアパック料金: 平日5,000円 / 土日祝6,000円（祝日含む）。3時間固定で通常3時間料金ではない', function () {
  var P = setup().sandbox.BookingPricing;
  function price(brand, date, minutes, extra) {
    return P.computeBookingPrice(Object.assign({ brand: brand, date: date, durationMinutes: minutes, generation: 'V2', plan: 'member_pair_3h' }, extra || {}));
  }
  ['snb', 'mens'].forEach(function (brand) {
    assert.strictEqual(price(brand, WEEKDAY, 180).price.amount, 5000);
    assert.strictEqual(price(brand, WEEKEND, 180).price.amount, 6000);
    assert.strictEqual(price(brand, JAN_HOLIDAY, 180).price.amount, 6000, '祝日は土日祝料金');
    assert.strictEqual(price(brand, WEEKDAY, 180).price.plan, 'member_pair_3h');
  });
  /* 通常のMEMBER 3時間料金（平日5,500円 / 土日祝7,000円）とは別商品。 */
  assert.strictEqual(P.computeBookingPrice({ brand: 'snb', date: WEEKDAY, durationMinutes: 180, isMember: true, generation: 'V2' }).price.amount, 5500);
  assert.strictEqual(P.computeBookingPrice({ brand: 'snb', date: WEEKEND, durationMinutes: 180, isMember: true, generation: 'V2' }).price.amount, 7000);
});

test('ペアパック料金: 延長は通常の会員延長料金（平日+1,500円 / 土日祝+2,000円）。他の優待・isMemberの影響を受けない', function () {
  var P = setup().sandbox.BookingPricing;
  function price(date, minutes, extra) {
    return P.computeBookingPrice(Object.assign({ brand: 'snb', date: date, durationMinutes: minutes, generation: 'V2', plan: 'member_pair_3h' }, extra || {})).price.amount;
  }
  assert.strictEqual(price(WEEKDAY, 240), 5000 + 1500);
  assert.strictEqual(price(WEEKDAY, 300), 5000 + 3000);
  assert.strictEqual(price(WEEKEND, 240), 6000 + 2000);
  assert.strictEqual(price(WEEKDAY, 180, { isMember: false }), 5000, 'isMemberの自己申告では変わらない');
  assert.strictEqual(price(WEEKDAY, 180, { isMember: true }), 5000);
});

test('ペアパック料金: 3時間未満・Studio X・V1(2026/11/30まで)・未知のプランは通常料金へ倒さず拒否', function () {
  var P = setup().sandbox.BookingPricing;
  function r(extra) { return P.computeBookingPrice(Object.assign({ brand: 'snb', date: WEEKDAY, durationMinutes: 180, generation: 'V2', plan: 'member_pair_3h' }, extra)); }
  assert.strictEqual(r({ durationMinutes: 120 }).error.code, 'PLAN_DURATION_INVALID');
  assert.strictEqual(r({ brand: 'studio_x' }).error.code, 'PLAN_NOT_AVAILABLE');
  /* Issue #539: 可否は予約作成日（料金世代）ではなく利用日で決まる。利用日が11/30以前なら世代に関わらず拒否する。 */
  assert.strictEqual(r({ date: '2026-11-30' }).error.code, 'PLAN_NOT_AVAILABLE');
  assert.strictEqual(r({ date: '2026-11-30', generation: 'V2' }).error.code, 'PLAN_NOT_AVAILABLE');
  assert.strictEqual(r({ plan: 'member_pair_9h' }).error.code, 'INVALID_PLAN');
  assert.strictEqual(r({ plan: '' }).price.plan, '', 'プラン無しは従来どおり');
});

test('ペアパック人数: 1〜2名のみ。3名以上・5名以上・形式不正は不可', function () {
  var P = setup().sandbox.BookingPricing;
  assert.strictEqual(P.isPairPackPeople('1名'), true);
  assert.strictEqual(P.isPairPackPeople('2名'), true);
  ['3名', '4名', '5名以上・要相談', '', '二名', '0名', '10名', undefined, null].forEach(function (v) {
    assert.strictEqual(P.isPairPackPeople(v), false, String(v));
  });
});

// ============================================================================
// 会員限定2名ペアパック: 予約作成（actual membership必須・priceIsMemberでは不可）
// ============================================================================

test('mensで priceIsMember=true でも actual membership が無ければペアパックは拒否（予約は作られない）', function () {
  var ctx = setup({ members: {} });
  var result = book(ctx, { brand: 'mens', isMember: true });
  assert.strictEqual(result.success, false);
  assert.strictEqual(result.error.code, DENIED_CODE);
  assert.strictEqual(ctx.sheets.Bookings === undefined || ctx.sheets.Bookings._rows.length <= 1, true, '予約行を作らない');

  /* 同じmens予約でもプラン指定なしなら従来どおり（mensの価格優遇＝MEMBER料金。実会員資格とは別）。 */
  var normal = book(ctx, { brand: 'mens', plan: '', durationMinutes: 180, isMember: false });
  assert.strictEqual(normal.success, true);
  assert.strictEqual(normal.price.tier, 'MEMBER');
  assert.strictEqual(normal.price.amount, 5500, 'mensの通常部屋料金は非会員でもMEMBER相当');
  var rec = bookingRecord(ctx, normal.bookingId);
  assert.strictEqual(rec.priceIsMember, true);
  assert.strictEqual(rec.membershipStatus, 'NOT_CHECKED', 'mensの価格優遇は実会員資格ではない');
  assert.strictEqual(rec.planCode, '');
});

test('actual membershipがあればペアパックを予約できる: 平日5,000円 / 土日祝6,000円、プラン識別子を保存', function () {
  var ctx = setup({ members: { [EMAIL]: ['2026-12'] } });
  var wk = book(ctx, { date: WEEKDAY });
  assert.strictEqual(wk.success, true, JSON.stringify(wk));
  assert.strictEqual(wk.price.amount, 5000);
  assert.strictEqual(wk.price.plan, 'member_pair_3h');
  var rec = bookingRecord(ctx, wk.bookingId);
  assert.strictEqual(rec.planCode, 'member_pair_3h');
  assert.strictEqual(rec.priceAmount, 5000);
  assert.strictEqual(rec.membershipStatus, 'ACTIVE');
  assert.strictEqual(rec.priceGeneration, 'V2');

  var we = book(ctx, { date: WEEKEND, startTime: '13:00' });
  assert.strictEqual(we.price.amount, 6000);

  var snb = book(ctx, { brand: 'snb', date: '2026-12-14', startTime: '10:00' });
  assert.strictEqual(snb.success, true);
  assert.strictEqual(snb.price.amount, 5000);
});

test('ペアパックは3名以上をサーバー側で拒否（会員でも）', function () {
  var ctx = setup({ members: { [EMAIL]: ['2026-12'] } });
  ['3名', '4名', '5名以上・要相談'].forEach(function (people) {
    var r = book(ctx, { people: people });
    assert.strictEqual(r.success, false, people);
    assert.strictEqual(r.error.code, 'PAIR_PACK_PEOPLE_EXCEEDED');
  });
  assert.strictEqual(book(ctx, { people: '1名' }).success, true);
});

test('ペアパックはSNB / mensのみ・3時間以上・2026/12/1以降の作成のみ。Studio Xや11/30までの作成は拒否', function () {
  var ctx = setup({ members: { [EMAIL]: ['2026-12'] } });
  assert.strictEqual(book(ctx, { brand: 'studio_x' }).error.code, 'PLAN_NOT_AVAILABLE');
  assert.strictEqual(book(ctx, { durationMinutes: 120 }).error.code, 'PLAN_DURATION_INVALID');
  assert.strictEqual(book(ctx, { plan: 'bogus' }).error.code, 'INVALID_PLAN');
  /* Issue #539: 提供開始は予約作成日ではなく利用日（2026/12/1以降）で判定する。 */
  assert.strictEqual(book(ctx, { date: '2026-11-30' }, new Date('2026-11-20T12:00:00+09:00')).error.code, 'PLAN_NOT_AVAILABLE', '利用日が11/30以前は不可');
  assert.strictEqual(book(ctx, {}, NOW_START).success, true, '利用日が12/1以降なら12/1 00:00 JST以降の作成で可');
});

test('会員判定月: 利用日の属する月で判定する（翌月の予約は翌月の支払い事実が必要・月境界）', function () {
  var ctx = setup({ members: { [EMAIL]: ['2026-12'] } });
  assert.strictEqual(book(ctx, { date: '2026-12-31', startTime: '10:00' }).success, true, '12月分の会員は12/31の利用に使える');
  var next = book(ctx, { date: '2027-01-05' });
  assert.strictEqual(next.success, false, '翌月分は翌月の当月会費決済成功後まで確定できない');
  assert.strictEqual(next.error.code, DENIED_CODE);
  /* 翌月1日の当月会費決済成功後（台帳に反映された後）は予約できる。猶予期間はない。 */
  ctx.members[EMAIL] = ['2026-12', '2027-01'];
  assert.strictEqual(book(ctx, { date: '2027-01-05' }).success, true);
  /* 現在月の状態から未来月を推測しない（12月の支払い事実だけで2月は不可）。 */
  assert.strictEqual(book(ctx, { date: '2027-02-02' }).error.code, DENIED_CODE);
});

test('外部向けエラーは非会員・利用月不一致・台帳エラーで同一（会員の有無を列挙できない）', function () {
  var nonMember = setup({ members: {} });
  var mismatch = setup({ members: { [EMAIL]: ['2026-11'] } });
  var broken = setup({ members: 'THROW' });
  var a = book(nonMember, {}).error;
  var b = book(mismatch, {}).error;
  var c = book(broken, {}).error;
  assert.deepStrictEqual(plain(a), plain(b));
  assert.deepStrictEqual(plain(a), plain(c));
  assert.strictEqual(a.code, DENIED_CODE);
  assert.ok(!/非会員|台帳|不一致|ledger/i.test(a.message));
});

test('会員照会にレート制限: 同じメールの照会が上限を超えると拒否（RATE_LIMITED）', function () {
  var ctx = setup({ members: {} });
  var codes = [];
  for (var i = 0; i < 7; i++) codes.push(book(ctx, { email: 'probe@example.com' }).error.code);
  assert.strictEqual(codes[0], DENIED_CODE);
  assert.strictEqual(codes[codes.length - 1], 'RATE_LIMITED');
  assert.strictEqual(ctx.lookups.length <= 5, true, '上限を超えた照会は台帳へ届かない');
});

test('見積りAPIは会員台帳を照会しない（プラン付き見積りでも）', function () {
  var ctx = setup({ members: { [EMAIL]: ['2026-12'] } });
  var out = ctx.sandbox.doGet({ parameter: { action: 'estimatePrice', brand: 'snb', date: WEEKDAY, durationMinutes: '180', plan: 'member_pair_3h' } });
  var body = JSON.parse(out.text);
  /* 実行時刻が12/1より前ならV1のためPLAN_NOT_AVAILABLE。いずれにせよ照会は発生しない。 */
  assert.ok(body.success === true || body.error.code === 'PLAN_NOT_AVAILABLE');
  assert.strictEqual(ctx.lookups.length, 0);
});

// ============================================================================
// 日程変更: プラン保持・曜日区分の再計算・月跨ぎの会員再確認
// ============================================================================

function rescheduleFixture(opts) {
  var o = opts || {};
  var ctx = setup({ members: o.members || {} });
  var sb = ctx.sandbox;
  var sheets = ctx.sheets;
  var d = o.date;
  var start = sb.CalendarRepository.parseDateTime(d, '10:00', 'Asia/Tokyo');
  var end = sb.CalendarRepository.parseDateTime(d, '13:00', 'Asia/Tokyo');
  var cal = sb.CalendarApp.getCalendarById('cal1');
  var event = cal.createEvent('booking', start, end);
  event.setTag('bookingId', 'MENS-PAIR-1');
  event.setTag('status', 'CONFIRMED');
  event.setTag('brand', 'mens');
  var quote = sb.BookingPricing.computeBookingPrice({ brand: 'mens', date: d, durationMinutes: 180, generation: 'V2', plan: 'member_pair_3h' });
  sb.SpreadsheetRepository.appendBooking({
    bookingId: 'MENS-PAIR-1', date: d, startAt: start, endAt: end, status: 'CONFIRMED', brand: 'mens',
    calendarEventId: event.getId(), name: '予約者', email: EMAIL, paymentMethod: 'PayPay', paymentStatus: 'PAID',
    confirmedMailSentAt: new Date(), priceAmount: quote.price.amount, priceTier: 'MEMBER', priceDayType: quote.price.dayType,
    priceIsMember: true, priceComputedAt: new Date(), priceGeneration: 'V2', feePaidAmount: quote.price.amount,
    membershipStatus: 'ACTIVE', planCode: o.noPlan ? '' : 'member_pair_3h'
  });
  return { ctx: ctx, sb: sb, date: d, event: event, version: event.getStartTime().getTime() + ':' + event.getEndTime().getTime() };
}

/* 現在から35日以上先の、指定条件の日付（JST）。 */
function nextDate(sb, startDaysAhead, wantWeekendHoliday, differentMonthFrom) {
  for (var i = startDaysAhead; i < startDaysAhead + 80; i++) {
    var d = futureDate.futureJstDate(i);
    var c = sb.JapaneseHolidays.classify(d);
    if (!c.ok) continue;
    var wd = new Date(d + 'T00:00:00Z').getUTCDay();
    var weekend = wd === 0 || wd === 6 || c.isHoliday;
    if (weekend !== wantWeekendHoliday) continue;
    if (differentMonthFrom && d.slice(0, 7) === differentMonthFrom.slice(0, 7)) continue;
    return d;
  }
  throw new Error('条件に合う日付が見つかりません');
}

function monthOf(d) { return d.slice(0, 7); }

/* 管理画面と同じく、プレビューで得たfeeQuoteTokenを付けて確定する。 */
function commitReschedule(f, input, feeNote) {
  var preview = f.sb.adminPreviewBookingReschedule('MENS-PAIR-1', input, f.version);
  if (!preview.success) return preview;
  return f.sb.adminRescheduleBooking('MENS-PAIR-1', input, f.version, '', feeNote || '', undefined, preview.feeQuoteToken);
}

test('日程変更: ペアパックのプランを保持し、平日→土日祝で変更先の6,000円を再計算（通常3時間料金に化けない）', function () {
  var probe = setup().sandbox;
  var weekday = nextDate(probe, 35, false);
  var weekend = nextDate(probe, 35, true);
  var f = rescheduleFixture({ date: weekday, members: { [EMAIL]: [monthOf(weekday), monthOf(weekend)] } });
  var input = { date: weekend, startTime: '10:00', endTime: '13:00' };
  var preview = f.sb.adminPreviewBookingReschedule('MENS-PAIR-1', input, f.version);
  assert.strictEqual(preview.success, true, JSON.stringify(preview));
  assert.strictEqual(preview.oldFeeAmount, 5000);
  assert.strictEqual(preview.newFeeAmount, 6000, '通常MEMBERの3時間土日祝7,000円ではなくプラン料金');
  assert.strictEqual(preview.feeDifference, 1000);
  assert.strictEqual(preview.refundStatus, 'ADDITIONAL_CHARGE_REQUIRED');
  var result = commitReschedule(f, input, '差額は別途請求');
  assert.strictEqual(result.success, true, JSON.stringify(result));
  var rec = bookingRecord(f.ctx, 'MENS-PAIR-1');
  assert.strictEqual(rec.planCode, 'member_pair_3h', '日程変更後もプランを保持');
  assert.strictEqual(f.sb.Booking.getEffectivePriceAmount(rec), 6000);
});

test('日程変更: 土日祝→平日では5,000円へ再計算し、差額は返金候補（プラン保持）', function () {
  var probe = setup().sandbox;
  var weekday = nextDate(probe, 35, false);
  var weekend = nextDate(probe, 35, true);
  var f = rescheduleFixture({ date: weekend, members: { [EMAIL]: [monthOf(weekday), monthOf(weekend)] } });
  var preview = f.sb.adminPreviewBookingReschedule('MENS-PAIR-1', { date: weekday, startTime: '10:00', endTime: '13:00' }, f.version);
  assert.strictEqual(preview.newFeeAmount, 5000);
  assert.strictEqual(preview.feeDifference, -1000);
});

test('日程変更: 3時間未満へ短縮するとプラン料金を自動算出できず通常料金へ化けない（手動確認が必須）', function () {
  var probe = setup().sandbox;
  var weekday = nextDate(probe, 35, false);
  var f = rescheduleFixture({ date: weekday, members: { [EMAIL]: [monthOf(weekday)] } });
  var preview = f.sb.adminPreviewBookingReschedule('MENS-PAIR-1', { date: weekday, startTime: '14:00', endTime: '16:00' }, f.version);
  assert.strictEqual(preview.success, true);
  assert.strictEqual(preview.feeReady, false);
  assert.strictEqual(preview.feeStatus, 'PLAN_DURATION_INVALID');
});

test('月跨ぎの日程変更: 変更先月のactual membershipを再確認し、無ければ拒否（特典を維持したまま変更しない）', function () {
  var probe = setup().sandbox;
  var thisMonth = nextDate(probe, 35, false);
  var otherMonth = nextDate(probe, 35, false, thisMonth);
  /* 変更元の月だけ会員。 */
  var f = rescheduleFixture({ date: thisMonth, members: { [EMAIL]: [monthOf(thisMonth)] } });
  var input = { date: otherMonth, startTime: '10:00', endTime: '13:00' };
  var denied = commitReschedule(f, input, '');
  assert.strictEqual(denied.success, false);
  assert.strictEqual(denied.error.code, DENIED_CODE);
  assert.strictEqual(f.event.getStartTime().getTime() + ':' + f.event.getEndTime().getTime(), f.version, '日時は変わらない');
  assert.strictEqual(f.sb.adminPreviewBookingReschedule('MENS-PAIR-1', input, f.version).error.code, DENIED_CODE, 'プレビューも同じ');

  /* 変更先月の当月会費決済が台帳に反映されたら変更できる。 */
  f.ctx.members[EMAIL] = [monthOf(thisMonth), monthOf(otherMonth)];
  var ok = commitReschedule(f, input, '差額は別途請求');
  assert.strictEqual(ok.success, true, JSON.stringify(ok));
  assert.strictEqual(bookingRecord(f.ctx, 'MENS-PAIR-1').planCode, 'member_pair_3h');
});

test('日程変更: 台帳エラー時もfail-closedで拒否。特典の無い予約は会員台帳を照会せず従来どおり', function () {
  var probe = setup().sandbox;
  var d1 = nextDate(probe, 35, false);
  var d2 = nextDate(probe, 36, false);
  var broken = rescheduleFixture({ date: d1, members: 'THROW' });
  assert.strictEqual(broken.sb.adminPreviewBookingReschedule('MENS-PAIR-1', { date: d2, startTime: '10:00', endTime: '13:00' }, broken.version).error.code, DENIED_CODE);

  var plainBooking = rescheduleFixture({ date: d1, members: {}, noPlan: true });
  var preview = plainBooking.sb.adminPreviewBookingReschedule('MENS-PAIR-1', { date: d2, startTime: '10:00', endTime: '13:00' }, plainBooking.version);
  assert.strictEqual(preview.success, true);
  assert.strictEqual(plainBooking.ctx.lookups.length, 0, '特典の無い予約は会員照会しない');
});

test('管理者手動確定: ペアパック予約は actual membership を再確認する。Stripe決済済みのWebhook確定は覆さない', function () {
  var ctx = setup({ members: { [EMAIL]: ['2026-12'] } });
  var booked = book(ctx, { date: WEEKDAY });
  assert.strictEqual(booked.success, true);
  /* 会員資格が失われた（台帳に支払い事実が無い）状態で管理者が手動確定しようとする。 */
  ctx.members = {};
  var denied = ctx.sandbox.BookingRepository.confirmBooking(booked.bookingId);
  assert.strictEqual(denied.success, false);
  assert.strictEqual(denied.error.code, DENIED_CODE);
  assert.strictEqual(bookingRecord(ctx, booked.bookingId).status, 'PENDING');
  /* Webhook確定（writeGuardあり）は決済済みのため会員資格不足を理由に覆さない。 */
  var viaWebhook = ctx.sandbox.BookingRepository.confirmBooking(booked.bookingId, { writeGuard: function () { return true; } });
  assert.strictEqual(viaWebhook.success, true, JSON.stringify(viaWebhook));
  assert.strictEqual(bookingRecord(ctx, booked.bookingId).status, 'CONFIRMED');
});

test('現地精算の確定: ペアパック予約の入金記録は actual membership を再確認（返金のみは対象外）', function () {
  var probe = setup().sandbox;
  var d = nextDate(probe, 35, false);
  var f = rescheduleFixture({ date: d, members: {} });
  var denied = f.sb.adminRecordRescheduleFeeSettlement('MENS-PAIR-1', '', 'SET-1', 'SETTLED', 1000, 0, '現地で受領');
  assert.strictEqual(denied.success, false);
  assert.strictEqual(denied.error.code, DENIED_CODE);
  f.ctx.members = { [EMAIL]: [monthOf(d)] };
  assert.strictEqual(f.sb.adminRecordRescheduleFeeSettlement('MENS-PAIR-1', '', 'SET-2', 'SETTLED', 1000, 0, '現地で受領').success, true);
});

// ============================================================================
// 会員限定シャワー（SNB / mensのみ。OptionOrder系）
// ============================================================================

function seedRoom(ctx, overrides) {
  var o = Object.assign({
    bookingId: 'MENS-20261207-AAAA0001', brand: 'mens', date: WEEKDAY, status: 'CONFIRMED', email: EMAIL,
    createdAt: NOW_DEC
  }, overrides || {});
  var start = ctx.sandbox.CalendarRepository.parseDateTime(o.date, '10:00', 'Asia/Tokyo');
  var end = ctx.sandbox.CalendarRepository.parseDateTime(o.date, '13:00', 'Asia/Tokyo');
  ctx.sandbox.SpreadsheetRepository.appendBooking({
    bookingId: o.bookingId, createdAt: o.createdAt, date: o.date, startAt: start, endAt: end, brand: o.brand, name: '山田太郎',
    email: o.email, phone: '090-0000-0000', people: '2名', purpose: 'x', paymentMethod: '現金', status: o.status,
    calendarEventId: 'ev-' + o.bookingId, source: 'test', customerType: 'returning', priceGeneration: 'V2'
  });
  return o.bookingId;
}

function addon(ctx, bookingId, selection, now, email) {
  return ctx.sandbox.OptionOrderService.submitAddonOptions(bookingId, email || EMAIL, selection, now || NOW_DEC);
}

test('シャワー: mensで priceIsMember 相当（価格優遇）でも actual membership が無ければ拒否', function () {
  var ctx = setup({ members: {} });
  var id = seedRoom(ctx, { brand: 'mens' });
  var r = addon(ctx, id, { shower: true });
  assert.strictEqual(r.success, false);
  assert.strictEqual(r.error.code, DENIED_CODE);
  assert.strictEqual(ctx.sandbox.OptionOrderRepository.listByBookingId(id).length, 0);
});

test('シャワー: actual membershipありなら1,000円のOptionOrder（MEMBER_SERVICE）。部屋料金へ埋め込まず、承認待ち（Issue #481）', function () {
  var ctx = setup({ members: { [EMAIL]: ['2026-12'] } });
  ['snb', 'mens'].forEach(function (brand, i) {
    var id = seedRoom(ctx, { brand: brand, bookingId: 'X-2026120' + (i + 1) + '-BBBB000' + i });
    var r = addon(ctx, id, { shower: true });
    assert.strictEqual(r.success, true, JSON.stringify(r.error));
    assert.strictEqual(r.orders.length, 1);
    var order = r.orders[0];
    assert.strictEqual(order.category, 'MEMBER_SERVICE');
    assert.strictEqual(order.amountJpy, 1000);
    assert.strictEqual(order.status, 'PENDING_APPROVAL');
    assert.strictEqual(order.approvalStatus, 'PENDING_APPROVAL');
    assert.strictEqual(order.requiresApproval, true);
    assert.strictEqual(order.payable, false);
    assert.strictEqual(order.items[0].code, 'SHOWER');
    assert.ok(/シャワー/.test(order.items[0].label));
  });
});

test('シャワーは1予約につき1回（重複申込は拒否。取消済みは数えない）', function () {
  var ctx = setup({ members: { [EMAIL]: ['2026-12'] } });
  var id = seedRoom(ctx, {});
  assert.strictEqual(addon(ctx, id, { shower: true }).success, true);
  var dup = addon(ctx, id, { shower: true });
  assert.strictEqual(dup.success, false);
  assert.strictEqual(dup.error.code, 'DUPLICATE_OPTION');
  assert.strictEqual(ctx.sandbox.OptionOrderRepository.listByBookingId(id).length, 1);
});

test('シャワーはStudio Xでは選べない。SNB / mensではStudio Xの機材・スタッフ対応を同時に申し込めない', function () {
  var ctx = setup({ members: { [EMAIL]: ['2026-12'] } });
  var x = seedRoom(ctx, { brand: 'studio_x', bookingId: 'SX-20261207-CCCC0001' });
  var r = addon(ctx, x, { shower: true });
  assert.strictEqual(r.success, false);
  assert.strictEqual(r.error.code, 'OPTIONS_NOT_AVAILABLE');
  var cat = ctx.sandbox.OptionOrderService.getCatalog('studio_x');
  assert.strictEqual(cat.shower, undefined, 'Studio Xのカタログにシャワーを出さない');

  var m = seedRoom(ctx, { brand: 'mens', bookingId: 'MENS-20261207-CCCC0002' });
  var mixed = addon(ctx, m, { shower: true, equipment: { COB_BICOLOR: 1 }, setupService: 'SELF', cleanupService: 'SELF' });
  assert.strictEqual(mixed.success, false);
  assert.strictEqual(mixed.error.code, 'OPTIONS_NOT_AVAILABLE');
  assert.strictEqual(addon(ctx, m, { layouts: ['CLASSROOM'], setupService: 'SELF', cleanupService: 'SELF' }).success === false, true, 'SNB/mensはシャワー以外のオプションを受け付けない');
});

test('シャワーは利用日が2026/12/1以降の予約のみ（Issue #541。注文の作成日は問わない）', function () {
  var NOW_OCT = new Date('2026-10-27T12:00:00+09:00');
  var ctx = setup({ members: { [EMAIL]: ['2026-12'] } });
  /* 作成日10/27・利用日12/10 → 可（提供開始前に作る注文でも利用日が12/1以降なら受け付ける）。 */
  var dec = seedRoom(ctx, { date: '2026-12-10', bookingId: 'MENS-20261210-EEEE0001' });
  assert.strictEqual(addon(ctx, dec, { shower: true }, NOW_OCT).success, true);
  /* 境界: 作成日11/30・利用日12/1 → 可。 */
  var edge = seedRoom(ctx, { date: '2026-12-01', bookingId: 'MENS-20261201-EEEE0002' });
  assert.strictEqual(addon(ctx, edge, { shower: true }, new Date('2026-11-30T12:00:00+09:00')).success, true);
  /* 境界: 利用日11/30 → 不可（作成日が12/1以降でも利用日で判定）。 */
  var nov = seedRoom(ctx, { date: '2026-11-30', bookingId: 'MENS-20261130-EEEE0003' });
  var denied = addon(ctx, nov, { shower: true }, NOW_OCT);
  assert.strictEqual(denied.success, false);
  assert.strictEqual(denied.error.code, 'OPTIONS_NOT_AVAILABLE');
  assert.strictEqual(ctx.sandbox.OptionOrderRepository.listByBookingId(nov).length, 0);
});

test('シャワー(#541): 予約同時申込の事前検証（preflight）も利用日で判定。非会員・Studio Xは従来どおり拒否', function () {
  var ctx = setup({ members: { [EMAIL]: ['2026-12'] } });
  var OOS = ctx.sandbox.OptionOrderService;
  var NOW_OCT = new Date('2026-10-27T12:00:00+09:00');
  function pre(brand, date, email) { return OOS.preflightForNewBooking(brand, { shower: true }, email || EMAIL, { date: date, now: NOW_OCT }); }
  assert.strictEqual(pre('mens', '2026-12-10').success, true);
  assert.strictEqual(pre('snb', '2026-12-01').success, true);
  var early = pre('snb', '2026-11-30');
  assert.strictEqual(early.success, false);
  assert.strictEqual(early.error.code, 'OPTIONS_NOT_AVAILABLE');
  assert.strictEqual(pre('snb', undefined).success, false, '利用日が不明ならfail-closed');
  assert.strictEqual(pre('snb', '2026-12-10', 'other@example.com').error.code, DENIED_CODE, '非会員は既存の拒否コード');
  assert.strictEqual(pre('studio_x', '2026-12-10').success, false, 'Studio Xは対象外');
});

test('シャワー(#541): 提供可否の純粋判定は利用日の境界（11/30=不可・12/1=可）。日程変更とCheckout前にも同じ判定を使う', function () {
  var BO = setup().sandbox.BookingOptions;
  assert.strictEqual(BO.isShowerAvailableOnDate('2026-11-30'), false);
  assert.strictEqual(BO.isShowerAvailableOnDate('2026-12-01'), true);
  assert.strictEqual(BO.isShowerAvailableOnDate('2027-01-12'), true);
  assert.strictEqual(BO.isShowerAvailableOnDate(''), false);
  assert.strictEqual(BO.isShowerAvailableOnDate(null), false);
  assert.strictEqual(BO.isShowerAvailableOnDate('2026/12/10'), false, '形式不正はfail-closed');
  var fs = require('fs');
  var resched = fs.readFileSync(__dirname + '/../gas/booking/admin/BookingReschedule.gs', 'utf8');
  assert.ok(resched.indexOf('BookingOptions.isShowerAvailableOnDate(newDateString)') !== -1, '日程変更で11/30以前へ移せない');
  var svc = fs.readFileSync(__dirname + '/../gas/booking/shared/OptionOrderService.gs', 'utf8');
  assert.ok(svc.indexOf('BookingOptions.isShowerAvailableOnDate(freshBooking.date)') !== -1, 'Checkout開始前の最終確認');
});

test('シャワーの会員判定月: 翌月分は翌月の当月会費決済成功後に確定可能（月境界）', function () {
  var ctx = setup({ members: { [EMAIL]: ['2026-12'] } });
  var jan = seedRoom(ctx, { date: JAN_WEEKDAY, bookingId: 'MENS-20270112-DDDD0001' });
  var denied = addon(ctx, jan, { shower: true });
  assert.strictEqual(denied.success, false);
  assert.strictEqual(denied.error.code, DENIED_CODE);
  ctx.members[EMAIL] = ['2026-12', '2027-01'];
  assert.strictEqual(addon(ctx, jan, { shower: true }).success, true);
});

test('シャワーのCheckout開始でも actual membership を再確認（失効したらStripeを呼ばない）', function () {
  var ctx = setup({ members: { [EMAIL]: ['2026-12'] } });
  var id = seedRoom(ctx, {});
  var order = addon(ctx, id, { shower: true }).orders[0];
  assert.strictEqual(ctx.sandbox.OptionOrderService.approveOrder(order.optionOrderId, NOW_DEC).success, true);
  ctx.members = {};
  var denied = ctx.sandbox.OptionOrderService.startOptionCheckout(id, EMAIL, order.optionOrderId, NOW_DEC);
  assert.strictEqual(denied.success, false);
  assert.strictEqual(denied.error.code, DENIED_CODE);
  assert.strictEqual(ctx.stripe.createCalls.length, 0);
  ctx.members = { [EMAIL]: ['2026-12'] };
  var ok = ctx.sandbox.OptionOrderService.startOptionCheckout(id, EMAIL, order.optionOrderId, NOW_DEC);
  assert.strictEqual(ok.success, true, JSON.stringify(ok));
  assert.strictEqual(ctx.stripe.createCalls.length, 1);
  assert.ok(/1000/.test(ctx.stripe.createCalls[0]));
});

test('決済済みWebhook後は会員資格不足を理由に覆さない（シャワーの決済反映）', function () {
  var ctx = setup({ members: { [EMAIL]: ['2026-12'] } });
  var id = seedRoom(ctx, {});
  var order = addon(ctx, id, { shower: true }).orders[0];
  assert.strictEqual(ctx.sandbox.OptionOrderService.approveOrder(order.optionOrderId, NOW_DEC).success, true);
  var started = ctx.sandbox.OptionOrderService.startOptionCheckout(id, EMAIL, order.optionOrderId, NOW_DEC);
  assert.strictEqual(started.success, true);
  var sessionId = Object.keys(ctx.stripe.sessions)[0];
  var session = ctx.stripe.sessions[sessionId];
  session.status = 'complete';
  session.payment_status = 'paid';
  /* 決済後に資格が失われても、決済済みの注文は確定のまま。 */
  ctx.members = {};
  var applied = ctx.sandbox.OptionOrderService.applyAddonPaymentSucceeded({
    session: { id: session.id, clientReferenceId: session.client_reference_id, metadata: session.metadata },
    paymentIntent: { id: session.payment_intent, status: 'succeeded', amountReceived: 1000, currency: 'JPY' },
    now: NOW_DEC
  });
  assert.strictEqual(applied.outcome, 'CONFIRMED', JSON.stringify(applied));
  var row = ctx.sandbox.OptionOrderRepository.findByOptionOrderId(order.optionOrderId).record;
  assert.strictEqual(row.status, 'CONFIRMED');
  assert.strictEqual(row.paymentStatus, 'PAID');
});

test('シャワー(#481): 承認前のCheckoutは直接APIでも拒否（Stripeを呼ばない）。承認後のみ1,000円のCheckoutへ進める', function () {
  var ctx = setup({ members: { [EMAIL]: ['2026-12'] } });
  var id = seedRoom(ctx, {});
  var order = addon(ctx, id, { shower: true }).orders[0];
  var early = ctx.sandbox.OptionOrderService.startOptionCheckout(id, EMAIL, order.optionOrderId, NOW_DEC);
  assert.strictEqual(early.success, false);
  assert.strictEqual(early.error.code, 'APPROVAL_REQUIRED');
  assert.strictEqual(ctx.stripe.createCalls.length, 0);
  var approved = ctx.sandbox.OptionOrderService.approveOrder(order.optionOrderId, NOW_DEC);
  assert.strictEqual(approved.success, true, JSON.stringify(approved));
  assert.strictEqual(approved.order.status, 'AWAITING_PAYMENT');
  assert.strictEqual(approved.order.approvalStatus, 'APPROVED');
  var ok = ctx.sandbox.OptionOrderService.startOptionCheckout(id, EMAIL, order.optionOrderId, NOW_DEC);
  assert.strictEqual(ok.success, true, JSON.stringify(ok));
  assert.strictEqual(ctx.stripe.createCalls.length, 1);
});

test('シャワー(#481): 管理者が否認するとCheckout不可。承認時にもactual membershipを再確認する。否認後は再申込できる', function () {
  var ctx = setup({ members: { [EMAIL]: ['2026-12'] } });
  var id = seedRoom(ctx, {});
  var order = addon(ctx, id, { shower: true }).orders[0];
  ctx.members = {};
  var denied = ctx.sandbox.OptionOrderService.approveOrder(order.optionOrderId, NOW_DEC);
  assert.strictEqual(denied.success, false);
  assert.strictEqual(denied.error.code, DENIED_CODE);
  ctx.members = { [EMAIL]: ['2026-12'] };
  var declined = ctx.sandbox.OptionOrderService.declineOrder(order.optionOrderId, '対応不可', NOW_DEC);
  assert.strictEqual(declined.success, true, JSON.stringify(declined));
  assert.strictEqual(declined.order.status, 'DECLINED');
  var pay = ctx.sandbox.OptionOrderService.startOptionCheckout(id, EMAIL, order.optionOrderId, NOW_DEC);
  assert.strictEqual(pay.success, false);
  assert.strictEqual(ctx.stripe.createCalls.length, 0);
  assert.strictEqual(addon(ctx, id, { shower: true }).success, true, '否認済みは重複に数えない');
});

test('シャワー(#481): 承認待ち・承認済みの有効注文がある間は重複申込を拒否', function () {
  var ctx = setup({ members: { [EMAIL]: ['2026-12'] } });
  var id = seedRoom(ctx, {});
  var order = addon(ctx, id, { shower: true }).orders[0];
  assert.strictEqual(addon(ctx, id, { shower: true }).error.code, 'DUPLICATE_OPTION');
  ctx.sandbox.OptionOrderService.approveOrder(order.optionOrderId, NOW_DEC);
  assert.strictEqual(addon(ctx, id, { shower: true }).error.code, 'DUPLICATE_OPTION');
});

// ============================================================================
// Studio X: 有料オプション全般（rental全件 + staffService全件）はactual membership必須
// ============================================================================

function xPlan(ctx, selection, member, now) {
  var B = ctx.sandbox.BookingOptions;
  var n = B.normalizeSelection(selection, 'studio_x');
  assert.ok(n.ok, JSON.stringify(n.error));
  return B.planOrders({
    normalized: n.normalized, existingOrders: [], optionsConfig: {}, brand: 'studio_x',
    eligibility: { eligibleEquipmentCodes: B.lectureRequiredEquipmentCodes() },
    actualMember: member, now: now || NOW_DEC
  });
}

test('Studio X: 有料カタログ（rental全件）は非会員では拒否・会員なら利用可（金額ではなくカタログ区分で判定）', function () {
  var ctx = setup();
  var rentals = ctx.sandbox.StudioXEquipmentCatalog.rental;
  assert.ok(rentals.length > 0);
  rentals.forEach(function (item) {
    var selection = { equipment: { [item.code]: 1 }, setupService: 'SELF', cleanupService: 'SELF' };
    var denied = xPlan(ctx, selection, false);
    assert.strictEqual(denied.ok, false, item.code + 'は非会員で拒否');
    assert.strictEqual(denied.error.code, DENIED_CODE, item.code);
    var allowed = xPlan(ctx, selection, true);
    assert.strictEqual(allowed.ok, true, item.code + 'は会員なら利用可');
  });
});

test('Studio X: staffService全件（事前設営・片付け・セット）は非会員では即拒否（保留にしない）', function () {
  var ctx = setup();
  [
    { layouts: ['CLASSROOM'], setupService: 'STAFF', cleanupService: 'SELF' },
    { layouts: ['CLASSROOM'], setupService: 'SELF', cleanupService: 'STAFF' },
    { layouts: ['JAPANESE'], setupService: 'STAFF', cleanupService: 'STAFF' }
  ].forEach(function (selection) {
    var denied = xPlan(ctx, selection, false);
    assert.strictEqual(denied.ok, false);
    assert.strictEqual(denied.error.code, 'STAFF_SERVICE_MEMBERS_ONLY');
    assert.strictEqual(xPlan(ctx, selection, true).ok, true);
  });
});

test('Studio X: セット無料で0円になる元有料オプション（ライトスタンド等）も非会員では拒否', function () {
  var ctx = setup();
  var rentals = ctx.sandbox.StudioXEquipmentCatalog.rental;
  var bundled = rentals.filter(function (item) { return item.freeWhenWith; });
  assert.ok(bundled.length > 0);
  bundled.forEach(function (item) {
    var companionCode = item.freeWhenWith.codes[0];
    var selection = { equipment: { [item.code]: 1, [companionCode]: 1 }, setupService: 'SELF', cleanupService: 'SELF' };
    var denied = xPlan(ctx, selection, false);
    assert.strictEqual(denied.ok, false, item.code + '（セット無料）も会員限定');
    assert.strictEqual(denied.error.code, DENIED_CODE);
    var allowed = xPlan(ctx, selection, true);
    assert.strictEqual(allowed.ok, true);
    var line = allowed.orders.reduce(function (acc, o) { return acc.concat(o.items); }, []).filter(function (x) { return x.indexOf('EQ:' + item.code + ':') === 0; })[0];
    assert.ok(/:F1/.test(line), 'セット無料の品が0円で計上される: ' + line);
  });
});

test('Studio X: 無料セルフ設営・セルフ原状復帰・メールサポート・無料のセルフ機材は非会員でも利用可', function () {
  var ctx = setup();
  var r = xPlan(ctx, { layouts: ['CLASSROOM', 'JAPANESE'], setupService: 'SELF', cleanupService: 'SELF', emailSupport: true }, false);
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(plain(r.orders.map(function (o) { return o.category; })), ['FREE']);
  var freeSelf = ctx.sandbox.StudioXEquipmentCatalog.freeSelf.filter(function (i) { return i.selectable === true; });
  freeSelf.forEach(function (item) {
    assert.strictEqual(xPlan(ctx, { equipment: { [item.code]: 1 }, setupService: 'SELF', cleanupService: 'SELF' }, false).ok, true, item.code);
  });
});

test('Studio X: 部屋料金は会員・非会員共通のまま（変更なし）', function () {
  var P = setup().sandbox.BookingPricing;
  ['2026-12-07', '2026-12-12'].forEach(function (d) {
    var g = P.computeBookingPrice({ brand: 'studio_x', date: d, durationMinutes: 180, generation: 'V2', isMember: false }).price.amount;
    var m = P.computeBookingPrice({ brand: 'studio_x', date: d, durationMinutes: 180, generation: 'V2', isMember: true }).price.amount;
    assert.strictEqual(g, m);
  });
  assert.strictEqual(P.computeBookingPrice({ brand: 'studio_x', date: WEEKDAY, durationMinutes: 180, generation: 'V2' }).price.amount, 3600);
});

// ============================================================================
// 2026/12/1適用とgrandfather
// ============================================================================

test('適用開始: 11/30 23:59:59までに作成する注文は旧ルール（Studio Xの機材レンタルは非会員でも可）、12/1 00:00から新ルール', function () {
  var ctx = setup();
  var selection = { equipment: { STROBE_MONOBLOCK: 1 }, setupService: 'SELF', cleanupService: 'SELF' };
  assert.strictEqual(xPlan(ctx, selection, false, NOW_BEFORE).ok, true, '旧ルール');
  assert.strictEqual(xPlan(ctx, selection, false, NOW_START).ok, false, '新ルール');
  assert.strictEqual(xPlan(ctx, selection, false, NOW_START).error.code, DENIED_CODE);
  /* スタッフ対応は#472から会員限定のまま（旧ルールでも非会員は不可）。 */
  assert.strictEqual(xPlan(ctx, { layouts: ['CLASSROOM'], setupService: 'STAFF', cleanupService: 'SELF' }, false, NOW_BEFORE).ok, false);
});

test('grandfather: 11/30までに作成済みの AWAITING_PAYMENT 機材注文は、12/1以降のCheckout開始でも旧ルールのまま（会員確認なし）', function () {
  var ctx = setup({ members: {} });
  var id = seedRoom(ctx, { brand: 'studio_x', bookingId: 'SX-20261215-EEEE0001', date: '2026-12-15', createdAt: new Date('2026-11-20T10:00:00+09:00') });
  ctx.sandbox.OptionOrderRepository.appendOrders([{
    optionOrderId: 'OPT-OLD00001', bookingId: id, brand: 'studio_x', category: 'EQUIPMENT', source: 'WITH_BOOKING',
    items: ['EQ:STROBE_MONOBLOCK:1'], amountJpy: 2000, currency: 'JPY', approvalStatus: 'NOT_REQUIRED',
    paymentStatus: 'NOT_STARTED', status: 'AWAITING_PAYMENT', customerEmail: EMAIL,
    createdAt: new Date('2026-11-20T10:05:00+09:00'), updatedAt: new Date('2026-11-20T10:05:00+09:00')
  }, {
    optionOrderId: 'OPT-NEW00001', bookingId: id, brand: 'studio_x', category: 'EQUIPMENT', source: 'ADDON',
    items: ['EQ:STROBE_MONOBLOCK:1'], amountJpy: 2000, currency: 'JPY', approvalStatus: 'NOT_REQUIRED',
    paymentStatus: 'NOT_STARTED', status: 'AWAITING_PAYMENT', customerEmail: EMAIL,
    createdAt: new Date('2026-12-01T00:00:00+09:00'), updatedAt: new Date('2026-12-01T00:00:00+09:00')
  }]);
  ctx.sandbox.OptionOrderService.grantVideoLightEligibility(EMAIL, 'STROBE_MONOBLOCK', 'test');
  var oldOrder = ctx.sandbox.OptionOrderService.startOptionCheckout(id, EMAIL, 'OPT-OLD00001', NOW_DEC);
  assert.strictEqual(oldOrder.success, true, JSON.stringify(oldOrder));
  var newOrder = ctx.sandbox.OptionOrderService.startOptionCheckout(id, EMAIL, 'OPT-NEW00001', NOW_DEC);
  assert.strictEqual(newOrder.success, false);
  assert.strictEqual(newOrder.error.code, DENIED_CODE, '12/1以降に作成された注文は新ルール');
});

test('grandfather: 11/30までに作成済みの PENDING_APPROVAL 機材注文は、12/1以降のAdmin承認でも旧ルール。12/1以降の作成分は承認時に会員再確認', function () {
  var ctx = setup({ members: {} });
  var id = seedRoom(ctx, { brand: 'studio_x', bookingId: 'SX-20261215-EEEE0002', date: '2026-12-15', createdAt: new Date('2026-11-20T10:00:00+09:00') });
  function pending(optionOrderId, createdAt, amount) {
    return {
      optionOrderId: optionOrderId, bookingId: id, brand: 'studio_x', category: 'EQUIPMENT', source: 'ADDON',
      items: ['EQ:STROBE_MONOBLOCK:1'], amountJpy: amount, currency: 'JPY', approvalStatus: 'PENDING_APPROVAL',
      paymentStatus: 'NOT_STARTED', status: 'PENDING_APPROVAL', customerEmail: EMAIL, createdAt: createdAt, updatedAt: createdAt
    };
  }
  ctx.sandbox.OptionOrderRepository.appendOrders([
    pending('OPT-OLDP0001', new Date('2026-11-25T10:00:00+09:00'), 2000),
    pending('OPT-NEWP0001', new Date('2026-12-02T10:00:00+09:00'), 2000)
  ]);
  var oldApproved = ctx.sandbox.OptionOrderService.approveOrder('OPT-OLDP0001', NOW_DEC);
  assert.strictEqual(oldApproved.success, true, JSON.stringify(oldApproved));
  var newApproved = ctx.sandbox.OptionOrderService.approveOrder('OPT-NEWP0001', NOW_DEC);
  assert.strictEqual(newApproved.success, false);
  assert.strictEqual(newApproved.error.code, DENIED_CODE);
  /* 不承認は資格を要しない。 */
  assert.strictEqual(ctx.sandbox.OptionOrderService.declineOrder('OPT-NEWP0001', '資格なし', NOW_DEC).success, true);
});

test('0円バンドルの確定（PENDING_APPROVAL→CONFIRMED）も、新ルールの注文は actual membership を再確認する', function () {
  var ctx = setup({ members: {} });
  var id = seedRoom(ctx, { brand: 'studio_x', bookingId: 'SX-20261215-EEEE0003', date: '2026-12-15' });
  ctx.sandbox.OptionOrderRepository.appendOrders([{
    optionOrderId: 'OPT-ZERO0001', bookingId: id, brand: 'studio_x', category: 'EQUIPMENT', source: 'WITH_BOOKING',
    items: ['EQ:STAND_260:1:F1'], amountJpy: 0, currency: 'JPY', approvalStatus: 'PENDING_APPROVAL',
    paymentStatus: 'NOT_STARTED', status: 'PENDING_APPROVAL', customerEmail: EMAIL,
    createdAt: new Date('2026-12-02T10:00:00+09:00'), updatedAt: new Date('2026-12-02T10:00:00+09:00')
  }]);
  var denied = ctx.sandbox.OptionOrderService.approveOrder('OPT-ZERO0001', NOW_DEC);
  assert.strictEqual(denied.success, false);
  assert.strictEqual(denied.error.code, DENIED_CODE);
  assert.strictEqual(ctx.sandbox.OptionOrderRepository.findByOptionOrderId('OPT-ZERO0001').record.status, 'PENDING_APPROVAL');
  ctx.members = { [EMAIL]: ['2026-12'] };
  var ok = ctx.sandbox.OptionOrderService.approveOrder('OPT-ZERO0001', NOW_DEC);
  assert.strictEqual(ok.success, true, JSON.stringify(ok));
  assert.strictEqual(ok.order.status, 'CONFIRMED');
});

test('Studio X 同時申込: 12/1以降の非会員は部屋予約ごと拒否（予約を作らない）。会員なら通る', function () {
  var ctx = setup({ members: {} });
  var payload = {
    brand: 'studio_x', customerType: 'returning', date: '2026-12-15', startTime: '10:00', durationMinutes: 120,
    name: '山田太郎', email: EMAIL, phone: '090-1234-5678', people: '2名', purpose: '作品撮り', paymentMethod: '現金',
    note: '', source: 'test', options: { equipment: { STROBE_MONOBLOCK: 1 }, setupService: 'SELF', cleanupService: 'SELF' }
  };
  var denied = ctx.sandbox.BookingRepository.createBooking(payload, NOW_DEC);
  assert.strictEqual(denied.success, false);
  assert.strictEqual(denied.error.code, DENIED_CODE);
  assert.strictEqual(ctx.sheets.Bookings === undefined || ctx.sheets.Bookings._rows.length <= 1, true);
  /* 11/30までは旧ルール（非会員でも機材レンタルを申し込める。管理者の利用許可は別途必要で、保留注文になる）。 */
  var legacy = ctx.sandbox.BookingRepository.createBooking(payload, new Date('2026-11-20T10:00:00+09:00'));
  assert.strictEqual(legacy.success, true, JSON.stringify(legacy.error));
});

// ============================================================================
// 純粋ルール: 適用開始・実会員判定
// ============================================================================

test('MembershipRules: 適用開始は2026/12/1 00:00 JST。実会員判定は利用月不一致・不正入力・台帳エラーをfail-closed', function () {
  var ctx = setup({ members: { [EMAIL]: ['2026-12'] } });
  var R = ctx.sandbox.MembershipRules;
  assert.strictEqual(R.isBenefitsRuleActive(NOW_BEFORE), false);
  assert.strictEqual(R.isBenefitsRuleActive(NOW_START), true);
  assert.strictEqual(R.isBenefitsRuleActive('invalid'), false);
  assert.strictEqual(R.verifyActualMembership(EMAIL, '2026-12-31').ok, true);
  assert.strictEqual(R.verifyActualMembership(EMAIL, '2027-01-01').ok, false);
  assert.strictEqual(R.verifyActualMembership('', '2026-12-31').ok, false);
  assert.strictEqual(R.verifyActualMembership(EMAIL, 'bad-date').ok, false);
  ctx.members = 'THROW';
  var ledger = R.verifyActualMembership(EMAIL, '2026-12-31');
  assert.strictEqual(ledger.ok, false);
  assert.strictEqual(ledger.reason, 'LEDGER_ERROR');
});

test('orderRequiresActualMember: シャワー・スタッフ・12/1以降のrental機材は必須、旧注文のrental・無料セルフは不要', function () {
  var B = setup().sandbox.BookingOptions;
  var old = new Date('2026-11-01T00:00:00+09:00');
  var cur = new Date('2026-12-02T00:00:00+09:00');
  assert.strictEqual(B.orderRequiresActualMember({ category: 'MEMBER_SERVICE', items: ['SHOWER'], createdAt: cur }), true);
  assert.strictEqual(B.orderRequiresActualMember({ category: 'STAFF_SERVICE', items: ['STAFF_PRE_SETUP:CLASSROOM'], createdAt: old }), true);
  assert.strictEqual(B.orderRequiresActualMember({ category: 'EQUIPMENT', items: ['EQ:STROBE_MONOBLOCK:1'], createdAt: cur }), true);
  assert.strictEqual(B.orderRequiresActualMember({ category: 'EQUIPMENT', items: ['EQ:STAND_260:1:F1'], createdAt: cur }), true, '0円でもrentalは必須');
  assert.strictEqual(B.orderRequiresActualMember({ category: 'EQUIPMENT', items: ['EQ:STROBE_MONOBLOCK:1'], createdAt: old }), false);
  assert.strictEqual(B.orderRequiresActualMember({ category: 'FREE', items: ['SELF_SETUP:CLASSROOM'], createdAt: cur }), false);
});

test('将来追加される有料category（未知category）も、既定で会員必須（fail-closed）。明示的な無料例外FREEだけが会員不要', function () {
  var B = setup().sandbox.BookingOptions;
  var old = new Date('2026-11-01T00:00:00+09:00');
  var cur = new Date('2026-12-02T00:00:00+09:00');
  ['PAID_SERVICE', 'FUTURE_PAID', '', undefined].forEach(function (category) {
    assert.strictEqual(B.orderRequiresActualMember({ category: category, items: ['X'], createdAt: cur }), true, String(category));
    assert.strictEqual(B.orderRequiresActualMember({ category: category, items: ['X'], createdAt: old }), true, String(category) + '（作成時刻に依らず）');
  });
  assert.strictEqual(B.orderRequiresActualMember({ category: 'FREE', items: ['SELF_SETUP:CLASSROOM'], createdAt: cur }), false);
});

test('planOrdersの最終防御: 12/1以降は非会員がFREE以外の注文を作れない（有料categoryの追加時の判定漏れ対策）', function () {
  var ctx = setup();
  /* 全rentalと全staffServiceを含む選択が、非会員ではどれも注文を1件も返さない。 */
  var rentals = ctx.sandbox.StudioXEquipmentCatalog.rental;
  rentals.forEach(function (item) {
    var r = xPlan(ctx, { equipment: { [item.code]: 1 }, setupService: 'SELF', cleanupService: 'SELF' }, false);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.orders, undefined);
  });
  var free = xPlan(ctx, { layouts: ['CLASSROOM'], setupService: 'SELF', cleanupService: 'SELF' }, false);
  assert.strictEqual(free.ok, true);
  assert.ok(free.orders.every(function (o) { return o.category === 'FREE'; }));
});

// ============================================================================
// Issue #539: ペアパックの提供可否は「利用日 >= 2026/12/1」（予約作成日は問わない）
// ============================================================================

test('Issue #539: 予約作成日が11/30以前でも、利用日が12/1以降ならペアパックを予約できる（actual membershipは必須のまま）', function () {
  /* 90日先行予約の資格（予約作成時の当月会員）は既存仕様のまま。10/27作成・12/10利用は30日超のため10月分の会員も要る。 */
  var ctx = setup({ members: { [EMAIL]: ['2026-10', '2026-12'] } });
  var early = new Date('2026-10-27T12:00:00+09:00');
  var ok = book(ctx, { brand: 'snb', date: '2026-12-10', startTime: '10:00' }, early);
  assert.strictEqual(ok.success, true, JSON.stringify(ok));
  assert.strictEqual(ok.price.amount, 5000);
  assert.strictEqual(ok.price.plan, 'member_pair_3h');
  var rec = bookingRecord(ctx, ok.bookingId);
  assert.strictEqual(rec.planCode, 'member_pair_3h');
  assert.strictEqual(rec.priceGeneration, 'V1', '料金世代（作成日基準）は変えない');
  assert.strictEqual(rec.membershipStatus, 'ACTIVE');

  var edge = book(ctx, { brand: 'mens', date: '2026-12-01', startTime: '10:00' }, new Date('2026-11-30T12:00:00+09:00'));
  assert.strictEqual(edge.success, true, '作成日11/30・利用日12/1');
  assert.strictEqual(edge.price.amount, 5000);
});

test('Issue #539: 作成日が11/30以前・利用日が12/1以降でも、非会員・利用月不一致は MEMBER_BENEFIT_NOT_AVAILABLE（資格を緩和しない）', function () {
  var early = new Date('2026-11-15T12:00:00+09:00');
  var nonMember = setup({ members: {} });
  assert.strictEqual(book(nonMember, { date: '2026-12-10' }, early).error.code, DENIED_CODE);
  var mismatch = setup({ members: { [EMAIL]: ['2026-11'] } });
  assert.strictEqual(book(mismatch, { date: '2026-12-10' }, early).error.code, DENIED_CODE);
});

test('Issue #539: 利用日が11/30以前・Studio Xでは、作成日に関わらずペアパックを拒否する', function () {
  var ctx = setup({ members: { [EMAIL]: ['2026-11', '2026-12'] } });
  var early = new Date('2026-11-15T12:00:00+09:00');
  assert.strictEqual(book(ctx, { date: '2026-11-30' }, early).error.code, 'PLAN_NOT_AVAILABLE');
  assert.strictEqual(book(ctx, { brand: 'studio_x', date: '2026-12-10' }, early).error.code, 'PLAN_NOT_AVAILABLE');
});

test('Issue #539: 見積り（BookingPricing）は利用日基準。V1世代でも12/1以降ならペアパック料金、11/30以前は拒否。金額は#478のまま', function () {
  var P = setup().sandbox.BookingPricing;
  function r(date, extra) { return P.computeBookingPrice(Object.assign({ brand: 'snb', date: date, durationMinutes: 180, generation: 'V1', plan: 'member_pair_3h' }, extra || {})); }
  assert.strictEqual(r('2026-12-01').valid, true);
  assert.strictEqual(r('2026-12-07').price.amount, 5000);
  assert.strictEqual(r('2026-12-12').price.amount, 6000);
  assert.strictEqual(r('2026-11-30').valid, false);
  assert.strictEqual(r('2026-11-30').error.code, 'PLAN_NOT_AVAILABLE');
  assert.strictEqual(P.isPairPackAvailableOnDate('2026-11-30'), false);
  assert.strictEqual(P.isPairPackAvailableOnDate('2026-12-01'), true);
  assert.strictEqual(P.isPairPackAvailableOnDate('2027-01-05'), true);
  assert.strictEqual(P.isPairPackAvailableOnDate(''), false);
  assert.strictEqual(P.isPairPackAvailableOnDate('2026/12/10'), false);
});

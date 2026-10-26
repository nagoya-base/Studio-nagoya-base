/*
 * 予約可能期間（Issue #480）のテスト。一般30日・actual SNB MEMBER 90日・管理者無制限。
 * Stripe・Sheets・Calendarはすべてスタブで、本番へは一切アクセスしない。
 *
 * 基準日は固定（2026-10-26 JST）。10/26の一般は11/25まで、会員は1/24までが境界日（含む）。
 */
'use strict';

var test = require('node:test');
var assert = require('node:assert');
var fs = require('node:fs');
var path = require('node:path');
var loadBookingSandbox = require('./helpers/gas-sandbox').loadBookingSandbox;
var stubs = require('./helpers/gas-stubs');

var FILES = [
  'Config.gs', 'CalendarRepository.gs', 'BookingWindow.gs', 'Availability.gs', 'Booking.gs', 'JapaneseHolidays.gs',
  'BookingPricing.gs', 'FeeCalculator.gs', 'CardPayment.gs', 'MembershipRules.gs', 'MemberRepository.gs',
  'EquipmentCatalog.gs', 'BookingOptions.gs', 'StripeGateway.gs', 'RateLimiter.gs', 'SpreadsheetRepository.gs',
  'OptionOrderRepository.gs', 'RecoveryRepository.gs', 'FeeSettlementRepository.gs', 'StripeEventRepository.gs',
  'BookingMailTemplates.gs', 'BookingMailer.gs', 'OptionMailTemplates.gs', 'OptionOrderService.gs',
  'BookingRepository.gs', 'AdminNotifier.gs'
];

var SPREADSHEET_ID = 'ss1';
var NOW = new Date('2026-10-26T10:00:00+09:00');
var TODAY = '2026-10-26';
var GENERAL_LAST = '2026-11-25'; /* +30日 */
var GENERAL_OVER = '2026-11-26'; /* +31日 */
var MEMBER_LAST = '2027-01-24'; /* +90日 */
var MEMBER_OVER = '2027-01-25'; /* +91日 */
var MEMBER_EMAIL = 'member@example.com';
var PERMANENT_EMAIL = 'koishi.s@gmail.com';
var ADMIN_EMAIL = 'nagoyabase2023@gmail.com';

function setup(opts) {
  var o = opts || {};
  var calendarsById = { cal1: { events: [] } };
  var spreadsheetsById = {};
  spreadsheetsById[SPREADSHEET_ID] = {};
  var properties = Object.assign({
    CALENDAR_ID: 'cal1', SPREADSHEET_ID: SPREADSHEET_ID,
    BOOKING_MAIL_DISPLAY_NAME: 'SNB', BOOKING_MAIL_REPLY_TO: 'noreply@example.com', BOOKING_CONTACT_EMAIL: 'contact@example.com',
    RATE_LIMIT_EMAIL_COUNT: '100', RATE_LIMIT_GLOBAL_COUNT: '1000'
  }, o.properties || {});
  var globals = {
    PropertiesService: stubs.createPropertiesServiceStub(properties),
    CalendarApp: stubs.createCalendarAppStub(calendarsById),
    Utilities: stubs.createUtilitiesStub(), LockService: stubs.createLockServiceStub(),
    CacheService: stubs.createCacheServiceStub(),
    SpreadsheetApp: stubs.createSpreadsheetAppStub(spreadsheetsById),
    MailApp: stubs.createMailAppStub(), UrlFetchApp: stubs.createUrlFetchAppStub(function () { throw new Error('Stripe呼び出し不可'); }),
    Logger: stubs.createLoggerStub(), ContentService: stubs.createContentServiceStub()
  };
  if (o.session) globals.Session = o.session;
  var sandbox = loadBookingSandbox(FILES, globals);
  var ctx = { sandbox: sandbox, sheets: spreadsheetsById[SPREADSHEET_ID], members: o.members || {}, lookups: [] };
  if (o.stubLedger !== false) {
    /* 台帳のスタブ: { 'メール': ['YYYY-MM', ...] }。'THROW'で台帳エラー。永久会員の共通判定は本物を通す。 */
    var realIsMember = sandbox.MemberRepository.isMemberForMonth;
    sandbox.MemberRepository.isMemberForMonth = function (email, month) {
      ctx.lookups.push({ email: email, month: month });
      if (sandbox.MembershipRules.isPermanentMember(email) && /^\d{4}-\d{2}$/.test(month || '')) return true;
      if (ctx.members === 'THROW') throw new Error('Sheets error');
      return (ctx.members[String(email).toLowerCase()] || []).indexOf(month) !== -1;
    };
    ctx.realIsMember = realIsMember;
  }
  return ctx;
}

function payload(overrides) {
  return Object.assign({
    brand: 'snb', customerType: 'returning', date: GENERAL_LAST, startTime: '10:00', durationMinutes: 120,
    name: '山田太郎', email: 'taro@example.com', phone: '090-1234-5678', people: '1名', purpose: '撮影',
    paymentMethod: '現金', note: '', source: 'test', isMember: false
  }, overrides || {});
}

function book(ctx, overrides) {
  return ctx.sandbox.BookingRepository.createBooking(payload(overrides), NOW);
}

/* ---------- BookingWindow（純粋ロジック） ---------- */

test('BookingWindow: 10/26の一般は11/25まで、会員は1/24まで（境界日を含む）', function () {
  var W = setup().sandbox.BookingWindow;
  assert.strictEqual(W.generalMaxDate(TODAY), GENERAL_LAST);
  assert.strictEqual(W.memberMaxDate(TODAY), MEMBER_LAST);
});

test('BookingWindow: 30日目/31日目・90日目/91日目の境界分類', function () {
  var W = setup().sandbox.BookingWindow;
  assert.strictEqual(W.classifyDate(TODAY, TODAY), 'GENERAL');
  assert.strictEqual(W.classifyDate(GENERAL_LAST, TODAY), 'GENERAL');
  assert.strictEqual(W.classifyDate(GENERAL_OVER, TODAY), 'MEMBER_ONLY');
  assert.strictEqual(W.classifyDate(MEMBER_LAST, TODAY), 'MEMBER_ONLY');
  assert.strictEqual(W.classifyDate(MEMBER_OVER, TODAY), 'OUT_OF_RANGE');
  assert.strictEqual(W.classifyDate('2026-02-30', TODAY), 'INVALID');
});

test('BookingWindow: 月またぎ・年またぎ・うるう日でも暦日で数える', function () {
  var W = setup().sandbox.BookingWindow;
  assert.strictEqual(W.addDays('2026-12-15', 30), '2027-01-14');
  assert.strictEqual(W.addDays('2027-12-20', 90), '2028-03-19');
  assert.strictEqual(W.addDays('2028-02-28', 1), '2028-02-29');
  assert.strictEqual(W.addDays('bad', 1), '');
});

test('BookingWindow: 管理者判定は認証済みメール×allowlistのみ。未設定・空・不一致はfail-closed', function () {
  var W = setup().sandbox.BookingWindow;
  assert.strictEqual(W.isAdminEmail(' NagoyaBase2023@gmail.com ', [ADMIN_EMAIL]), true);
  assert.strictEqual(W.isAdminEmail('', [ADMIN_EMAIL]), false);
  assert.strictEqual(W.isAdminEmail(null, [ADMIN_EMAIL]), false);
  assert.strictEqual(W.isAdminEmail(ADMIN_EMAIL, []), false);
  assert.strictEqual(W.isAdminEmail(ADMIN_EMAIL, undefined), false);
  assert.strictEqual(W.isAdminEmail('someone@example.com', [ADMIN_EMAIL]), false);
});

/* ---------- Availability（日別・月間） ---------- */

function availabilityConfig(ctx) { return ctx.sandbox.BookingConfig.getAvailabilityConfig(); }

test('getAvailability: 30日目は通常、31〜90日目は会員先行枠の印つき、91日目以降はDATE_OUT_OF_RANGE', function () {
  var ctx = setup();
  var A = ctx.sandbox.BookingAvailability;
  var cfg = availabilityConfig(ctx);
  var general = A.getAvailability({ date: GENERAL_LAST, durationMinutes: 120 }, [], cfg, NOW);
  assert.strictEqual(general.success, true);
  assert.strictEqual(general.memberAdvance, false);
  assert.strictEqual(general.generalMaxDate, GENERAL_LAST);
  assert.strictEqual(general.memberMaxDate, MEMBER_LAST);

  var advance31 = A.getAvailability({ date: GENERAL_OVER, durationMinutes: 120 }, [], cfg, NOW);
  assert.strictEqual(advance31.success, true);
  assert.strictEqual(advance31.memberAdvance, true);
  assert.ok(advance31.bookableStartTimes.length > 0);
  assert.strictEqual(A.getAvailability({ date: MEMBER_LAST, durationMinutes: 120 }, [], cfg, NOW).memberAdvance, true);

  var over = A.getAvailability({ date: MEMBER_OVER, durationMinutes: 120 }, [], cfg, NOW);
  assert.strictEqual(over.success, false);
  assert.strictEqual(over.error.code, 'DATE_OUT_OF_RANGE');
});

test('getAvailability: 応答はメールに依存せず全員同じ（会員有無を推測できない）', function () {
  var ctx = setup();
  var A = ctx.sandbox.BookingAvailability;
  var cfg = availabilityConfig(ctx);
  var a = A.getAvailability({ date: GENERAL_OVER, durationMinutes: 120, email: PERMANENT_EMAIL }, [], cfg, NOW);
  var b = A.getAvailability({ date: GENERAL_OVER, durationMinutes: 120, email: 'x@example.com' }, [], cfg, NOW);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)));
  assert.strictEqual(ctx.lookups.length, 0, 'Availabilityは会員台帳を一切照会しない');
});

test('getMonthlyAvailability: 30日目まで通常、31〜90日目は会員先行枠、91日目以降はOUT_OF_RANGE（月またぎ含む）', function () {
  var ctx = setup();
  var A = ctx.sandbox.BookingAvailability;
  var cfg = availabilityConfig(ctx);
  var nov = A.getMonthlyAvailability({ year: 2026, month: 11, durationMinutes: 120 }, {}, cfg, NOW);
  assert.strictEqual(nov.generalMaxDate, GENERAL_LAST);
  assert.strictEqual(nov.memberMaxDate, MEMBER_LAST);
  assert.strictEqual(nov.days[GENERAL_LAST].memberAdvance, undefined);
  assert.strictEqual(nov.days[GENERAL_OVER].memberAdvance, true);
  assert.notStrictEqual(nov.days[GENERAL_OVER].status, 'OUT_OF_RANGE');

  var jan = A.getMonthlyAvailability({ year: 2027, month: 1, durationMinutes: 120 }, {}, cfg, NOW);
  assert.strictEqual(jan.days[MEMBER_LAST].memberAdvance, true);
  assert.notStrictEqual(jan.days[MEMBER_LAST].status, 'OUT_OF_RANGE');
  assert.strictEqual(jan.days[MEMBER_OVER].status, 'OUT_OF_RANGE');
  assert.strictEqual(jan.days[MEMBER_OVER].memberAdvance, undefined);

  var feb = A.getMonthlyAvailability({ year: 2027, month: 2, durationMinutes: 120 }, {}, cfg, NOW);
  Object.keys(feb.days).forEach(function (d) { assert.strictEqual(feb.days[d].status, 'OUT_OF_RANGE'); });
});

test('Availabilityと月間は同じ境界を共有する（日別と月間で食い違わない）', function () {
  var ctx = setup();
  var A = ctx.sandbox.BookingAvailability;
  var cfg = availabilityConfig(ctx);
  var monthly = A.getMonthlyAvailability({ year: 2027, month: 1, durationMinutes: 120 }, {}, cfg, NOW);
  ['2027-01-23', MEMBER_LAST, MEMBER_OVER].forEach(function (d) {
    var daily = A.getAvailability({ date: d, durationMinutes: 120 }, [], cfg, NOW);
    assert.strictEqual(daily.success, monthly.days[d].status !== 'OUT_OF_RANGE', d);
  });
});

/* ---------- createBooking（サーバー側最終検証） ---------- */

test('createBooking: 一般は30日目まで予約できる', function () {
  var ctx = setup();
  assert.strictEqual(book(ctx, { date: GENERAL_LAST }).success, true);
  assert.strictEqual(ctx.lookups.length, 0, '30日以内は会員台帳を照会しない');
});

test('createBooking: 一般は31日目を直接APIから予約できない（自己申告isMemberでも不可）', function () {
  var ctx = setup();
  [{ isMember: false, startTime: '10:00' }, { isMember: true, startTime: '13:00' }].forEach(function (o) {
    var r = book(ctx, Object.assign({ date: GENERAL_OVER }, o));
    assert.strictEqual(r.success, false);
    assert.strictEqual(r.error.code, 'ADVANCE_BOOKING_MEMBER_ONLY');
  });
  assert.strictEqual(ctx.sandbox.SpreadsheetRepository.getAllPendingBookings().length, 0);
  assert.strictEqual(ctx.sandbox.CalendarApp.getCalendarById('cal1').getEvents(new Date(0), new Date(9e12)).length, 0);
});

test('createBooking: actual SNB MEMBERは予約作成時点の当月（10月）の資格で31〜90日目を予約できる', function () {
  var ctx = setup({ members: { 'member@example.com': ['2026-10'] } });
  assert.strictEqual(book(ctx, { email: MEMBER_EMAIL, date: GENERAL_OVER }).success, true);
  assert.strictEqual(book(ctx, { email: MEMBER_EMAIL, date: MEMBER_LAST, startTime: '13:00' }).success, true);
  assert.ok(ctx.lookups.some(function (l) { return l.month === '2026-10'; }), '判定月は予約作成時点の当月');
  assert.ok(ctx.lookups.every(function (l) { return l.month === '2026-10'; }), '利用日の月では判定しない');
});

test('createBooking: 会員でも91日目以降は直接APIから予約できない', function () {
  var ctx = setup({ members: { 'member@example.com': ['2026-10', '2027-01', '2027-02'] } });
  var r = book(ctx, { email: MEMBER_EMAIL, date: MEMBER_OVER });
  assert.strictEqual(r.success, false);
  assert.strictEqual(r.error.code, 'DATE_OUT_OF_RANGE');
});

test('createBooking: 利用月だけ会員（作成時点の当月は未払い）では先行予約できない', function () {
  var ctx = setup({ members: { 'member@example.com': ['2027-01'] } });
  var r = book(ctx, { email: MEMBER_EMAIL, date: MEMBER_LAST });
  assert.strictEqual(r.success, false);
  assert.strictEqual(r.error.code, 'ADVANCE_BOOKING_MEMBER_ONLY');
});

test('createBooking: 会員台帳エラーは一般扱いへ黙ってフォールバックせず、先行予約をfail-closedで拒否（30日以内は影響なし）', function () {
  var ctx = setup({ members: 'THROW' });
  var r = book(ctx, { email: MEMBER_EMAIL, date: GENERAL_OVER });
  assert.strictEqual(r.success, false);
  assert.strictEqual(r.error.code, 'ADVANCE_BOOKING_MEMBER_ONLY');
  assert.strictEqual(book(ctx, { email: MEMBER_EMAIL, date: GENERAL_LAST }).success, true);
});

test('createBooking: 非会員と台帳エラーは同一のエラーを返す（会員有無・台帳状態を探られない）', function () {
  var denied = book(setup(), { date: GENERAL_OVER });
  var ledgerError = book(setup({ members: 'THROW' }), { date: GENERAL_OVER });
  assert.deepStrictEqual(JSON.parse(JSON.stringify(denied.error)), JSON.parse(JSON.stringify(ledgerError.error)));
});

test('createBooking: mens非会員は料金優遇を維持しつつ予約可能期間は一般30日（priceIsMemberは資格にならない）', function () {
  var ctx = setup();
  var ok = book(ctx, { brand: 'mens', date: GENERAL_LAST });
  assert.strictEqual(ok.success, true);
  var found = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(ok.bookingId);
  assert.strictEqual(found.record.priceIsMember, true, 'mensの部屋料金は会員料金のまま');
  var over = book(ctx, { brand: 'mens', date: GENERAL_OVER, startTime: '13:00', isMember: true });
  assert.strictEqual(over.success, false);
  assert.strictEqual(over.error.code, 'ADVANCE_BOOKING_MEMBER_ONLY');
});

test('createBooking: Studio Xも会員なら90日先行予約でき、非会員は30日（部屋料金は会員・非会員共通のまま）', function () {
  var member = setup({ members: { 'member@example.com': ['2026-10'] } });
  var ok = book(member, { brand: 'studio_x', email: MEMBER_EMAIL, date: GENERAL_OVER });
  assert.strictEqual(ok.success, true);
  var general = book(setup(), { brand: 'studio_x', date: GENERAL_OVER });
  assert.strictEqual(general.success, false);
  assert.strictEqual(general.error.code, 'ADVANCE_BOOKING_MEMBER_ONLY');
});

test('createBooking: 予約成立後に退会しても通常の部屋予約は維持される', function () {
  var ctx = setup({ members: { 'member@example.com': ['2026-10'] } });
  var r = book(ctx, { email: MEMBER_EMAIL, date: MEMBER_LAST });
  assert.strictEqual(r.success, true);
  ctx.members = {};
  var found = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(r.bookingId);
  assert.strictEqual(found.record.status, 'PENDING');
  assert.strictEqual(found.record.date, MEMBER_LAST);
});

test('createBooking: 公開フォームに管理者メールを入力しても管理者扱いにならず30日を超えられない', function () {
  var ctx = setup();
  var r = book(ctx, { email: ADMIN_EMAIL, date: GENERAL_OVER });
  assert.strictEqual(r.success, false);
  assert.strictEqual(r.error.code, 'ADVANCE_BOOKING_MEMBER_ONLY');
  var far = book(ctx, { email: ADMIN_EMAIL, date: MEMBER_OVER });
  assert.strictEqual(far.success, false);
  assert.strictEqual(far.error.code, 'DATE_OUT_OF_RANGE');
});

/* ---------- 永久会員 ---------- */

test('永久会員: 台帳が空・対象年月が何でも、常にactual memberとして判定される（本物のMemberRepository）', function () {
  var ctx = setup({ stubLedger: false });
  var R = ctx.sandbox.MemberRepository;
  ['2020-01', '2026-10', '2027-01', '2099-12'].forEach(function (m) {
    assert.strictEqual(R.isMemberForMonth(PERMANENT_EMAIL, m), true, m);
  });
  assert.strictEqual(R.isMemberForMonth(' Koishi.S@Gmail.com ', '2027-01'), true, '大文字小文字・前後空白は既存メール正規化に従う');
  assert.strictEqual(R.isMemberForMonth('other@example.com', '2026-10'), false);
  assert.strictEqual(R.isMemberForMonth(PERMANENT_EMAIL, 'bad'), false, '不正な年月はfalseのまま');
  assert.strictEqual(R.isMemberForMonth('', '2026-10'), false);
});

test('永久会員: Stripe台帳（Members/MemberMonths）へシートも行も作らない', function () {
  var ctx = setup({ stubLedger: false });
  ctx.sandbox.MemberRepository.isMemberForMonth(PERMANENT_EMAIL, '2026-10');
  assert.deepStrictEqual(Object.keys(ctx.sheets), [], '永久会員の判定は台帳へ書き込まない・台帳を作らない');
});

test('永久会員: 90日先行予約・各特典の共通判定（verifyActualMembership）が成立する', function () {
  var ctx = setup({ stubLedger: false });
  var M = ctx.sandbox.MembershipRules;
  assert.strictEqual(M.verifyAdvanceBookingMembership(PERMANENT_EMAIL, TODAY).ok, true);
  assert.strictEqual(M.verifyActualMembership(PERMANENT_EMAIL, '2027-03-01').ok, true, '利用月基準の特典（ペア・シャワー等）も成立');
  assert.strictEqual(M.verifyActualMembership('other@example.com', '2027-03-01').ok, false);
  var r = ctx.sandbox.BookingRepository.createBooking(payload({ email: PERMANENT_EMAIL, date: MEMBER_LAST }), NOW);
  assert.strictEqual(r.success, true);
});

test('永久会員: PERMANENT_MEMBER_EMAILS未設定でも既定が有効で、設定すれば追加できる。不正値で通常判定を壊さない', function () {
  var base = setup({ stubLedger: false });
  assert.strictEqual(base.sandbox.MembershipRules.isPermanentMember(PERMANENT_EMAIL), true);
  assert.strictEqual(base.sandbox.MembershipRules.isPermanentMember('new@example.com'), false);
  var extra = setup({ stubLedger: false, properties: { PERMANENT_MEMBER_EMAILS: ' New@Example.com , ,other@example.com' } });
  assert.strictEqual(extra.sandbox.MembershipRules.isPermanentMember('new@example.com'), true);
  assert.strictEqual(extra.sandbox.MembershipRules.isPermanentMember(PERMANENT_EMAIL), true);
  assert.strictEqual(extra.sandbox.MembershipRules.isPermanentMember('stranger@example.com'), false);
});

test('永久会員メールの直書きはConfig.gs 1か所のみ（各機能へ重複ハードコードしない）', function () {
  var root = path.join(__dirname, '..', 'gas');
  var hits = [];
  (function walk(dir) {
    fs.readdirSync(dir, { withFileTypes: true }).forEach(function (e) {
      var p = path.join(dir, e.name);
      if (e.isDirectory()) return walk(p);
      if (/\.(gs|html|js)$/.test(e.name) && fs.readFileSync(p, 'utf8').indexOf(PERMANENT_EMAIL) !== -1) hits.push(path.relative(root, p));
    });
  })(root);
  assert.deepStrictEqual(hits, ['booking/shared/Config.gs']);
});

/* ---------- 管理者 ---------- */

test('管理者: Booking Admin側の認証済みGoogleアカウントがallowlistに一致する場合のみ管理者', function () {
  function sessionFor(email) {
    return { getActiveUser: function () { return { getEmail: function () { return email; } }; } };
  }
  var vm = require('node:vm');
  function verified(email, properties) {
    var ctx = setup({ session: sessionFor(email), properties: properties });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'gas', 'booking', 'admin', 'BookingAdminWeb.gs'), 'utf8'), ctx.sandbox);
    return vm.runInContext('isBookingAdminVerified_()', ctx.sandbox);
  }
  assert.strictEqual(verified(ADMIN_EMAIL), true);
  assert.strictEqual(verified('Extra@Example.com', { BOOKING_ADMIN_EMAILS: 'extra@example.com' }), true);
  assert.strictEqual(verified('attacker@example.com'), false);
  assert.strictEqual(verified(''), false, 'メール取得不可はfail-closed');
});

test('管理者: Session取得で例外が出てもfalse（fail-closed）', function () {
  var vm = require('node:vm');
  var ctx = setup({ session: { getActiveUser: function () { throw new Error('no session'); } } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'gas', 'booking', 'admin', 'BookingAdminWeb.gs'), 'utf8'), ctx.sandbox);
  assert.strictEqual(vm.runInContext('isBookingAdminVerified_()', ctx.sandbox), false);
});

test('管理者・永久会員のメールアドレスを公開JS・公開HTML・公開ページへ出さない', function () {
  var root = path.join(__dirname, '..');
  var offenders = [];
  ['scripts', '_includes', 'booking', 'membership', 'mens', 'studio-x', 'index.html', 'en.html', 'sitemap.xml'].forEach(function (rel) {
    var base = path.join(root, rel);
    if (!fs.existsSync(base)) return;
    (function walk(p) {
      var st = fs.statSync(p);
      if (st.isDirectory()) return fs.readdirSync(p).forEach(function (n) { walk(path.join(p, n)); });
      if (!/\.(js|html|md|json|xml)$/.test(p)) return;
      var text = fs.readFileSync(p, 'utf8');
      var rel2 = path.relative(root, p);
      /* 公開Googleカレンダー埋め込みのsrc（Issue #480以前から公開済みのカレンダーID）は管理者allowlistではないため除外する。 */
      var adminHit = text.indexOf(ADMIN_EMAIL) !== -1 && rel2 !== path.join('_includes', 'calendar_embed.html');
      if (text.indexOf(PERMANENT_EMAIL) !== -1 || adminHit) offenders.push(rel2);
    })(base);
  });
  assert.deepStrictEqual(offenders, []);
});

/* ---------- フロント（scripts/booking-logic.js） ---------- */

test('フロント: 先行予約系エラーは日付選び直しへ誘導し、会員先行枠はaria-labelで区別できる', function () {
  var Logic = require('../scripts/booking-logic.js');
  ['DATE_OUT_OF_RANGE', 'ADVANCE_BOOKING_MEMBER_ONLY'].forEach(function (code) {
    assert.strictEqual(Logic.recoveryActionForErrorCode(code), 'reselect-date');
    assert.notStrictEqual(Logic.messageForErrorCode(code, 'ja'), Logic.messageForErrorCode('UNKNOWN_CODE', 'ja'));
    assert.notStrictEqual(Logic.messageForErrorCode(code, 'en'), Logic.messageForErrorCode('UNKNOWN_CODE', 'en'));
  });
  var plain = Logic.dayAriaLabel('2026-11-26', 'AVAILABLE', 'returning', TODAY, 'ja', false);
  var advance = Logic.dayAriaLabel('2026-11-26', 'AVAILABLE', 'returning', TODAY, 'ja', true);
  assert.ok(advance.indexOf('SNB MEMBER先行予約枠') !== -1 && plain.indexOf('先行') === -1);
  assert.ok(Logic.dayAriaLabel('2026-11-26', 'AVAILABLE', 'returning', TODAY, 'en', true).indexOf('advance booking') !== -1);
});

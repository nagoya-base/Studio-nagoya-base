/*
 * BookingAdminPage.html のクライアント側フィルタ（visibleBookings()）のテスト。
 *
 * 要件: 「今日」「今後」タブにCANCELLEDを表示しない・CANCELLEDは新しい「キャンセル」
 * タブへ集約する・EXPIREDは「キャンセル」に含めない・「すべて」は従来どおり全件表示する。
 *
 * BookingAdminPage.html内の<script>をそのままvmで実行し（ロジックを別途Node用に
 * 書き写さない。test/helpers/gas-sandbox.jsと同じ方針）、DOM/google.script.runは
 * トップレベルの同期実行（イベント登録・初回loadBookings()呼び出し）が例外を
 * 投げない最小限のスタブのみ用意する。loadBookings()の応答は待たず、
 * state.bookings/state.todayJst/state.filterはテストから直接差し替えて
 * visibleBookings()の絞り込みだけを検証する。
 */
'use strict';

var test = require('node:test');
var assert = require('node:assert');
var fs = require('fs');
var path = require('path');
var vm = require('vm');

var PAGE_PATH = path.join(__dirname, '..', 'gas', 'booking', 'admin', 'BookingAdminPage.html');

function createElementStub() {
  return {
    textContent: '',
    innerHTML: '',
    classList: { add: function () {}, remove: function () {} },
    addEventListener: function () {}
  };
}

function loadClientSandbox() {
  var html = fs.readFileSync(PAGE_PATH, 'utf8');
  var match = html.match(/<script>([\s\S]*)<\/script>/);
  assert.ok(match, 'BookingAdminPage.htmlに<script>ブロックが見つかるべき');
  var scriptSrc = match[1];

  var scriptRunStub = {
    withSuccessHandler: function () { return scriptRunStub; },
    withFailureHandler: function () { return scriptRunStub; },
    getAdminBookings: function () {},
    getAdminBookingDetail: function () {},
    adminConfirmBooking: function () {},
    adminCancelBooking: function () {}
  };

  var documentStub = {
    getElementById: function () { return createElementStub(); },
    querySelectorAll: function () { return []; }
  };

  var sandbox = {
    document: documentStub,
    google: { script: { run: scriptRunStub } },
    window: {},
    alert: function () {}
  };
  vm.createContext(sandbox);
  vm.runInContext(scriptSrc, sandbox, { filename: PAGE_PATH });
  return sandbox;
}

function booking(overrides) {
  return Object.assign(
    {
      bookingId: 'SX-20260101-AAAAAAAA',
      date: '2026-09-22',
      startAt: '10:00',
      endAt: '12:00',
      brand: 'studio_x',
      name: '山田太郎',
      people: '2名',
      customerType: 'returning',
      purpose: 'テスト',
      paymentMethod: '現金',
      status: 'PENDING'
    },
    overrides || {}
  );
}

var TODAY = '2026-09-22';
var YESTERDAY = '2026-09-21';
var TOMORROW = '2026-09-23';

function setupState(sandbox, filter) {
  sandbox.state.todayJst = TODAY;
  sandbox.state.filter = filter;
  sandbox.state.bookings = [
    booking({ bookingId: 'today-pending', date: TODAY, status: 'PENDING' }),
    booking({ bookingId: 'today-confirmed', date: TODAY, status: 'CONFIRMED' }),
    booking({ bookingId: 'today-cancelled', date: TODAY, status: 'CANCELLED' }),
    booking({ bookingId: 'future-confirmed', date: TOMORROW, status: 'CONFIRMED' }),
    booking({ bookingId: 'future-cancelled', date: TOMORROW, status: 'CANCELLED' }),
    booking({ bookingId: 'past-cancelled', date: YESTERDAY, status: 'CANCELLED' }),
    booking({ bookingId: 'past-expired', date: YESTERDAY, status: 'EXPIRED' })
  ];
}

function idsOf(bookings) {
  return bookings.map(function (b) { return b.bookingId; }).sort();
}

test('visibleBookings: 「今日」タブにCANCELLEDは出ない', function () {
  var sandbox = loadClientSandbox();
  setupState(sandbox, 'today');

  var result = sandbox.visibleBookings();

  assert.deepStrictEqual(idsOf(result), ['today-confirmed', 'today-pending']);
});

test('visibleBookings: 「今後」タブにCANCELLEDは出ない', function () {
  var sandbox = loadClientSandbox();
  setupState(sandbox, 'upcoming');

  var result = sandbox.visibleBookings();

  assert.deepStrictEqual(idsOf(result), ['future-confirmed', 'today-confirmed', 'today-pending'].sort());
});

test('visibleBookings: 「キャンセル」タブにCANCELLEDが日付を問わず出る（過去・今日・未来）', function () {
  var sandbox = loadClientSandbox();
  setupState(sandbox, 'cancelled');

  var result = sandbox.visibleBookings();

  assert.deepStrictEqual(idsOf(result), ['future-cancelled', 'past-cancelled', 'today-cancelled'].sort());
});

test('visibleBookings: 「キャンセル」タブにPENDING/CONFIRMEDは出ない', function () {
  var sandbox = loadClientSandbox();
  setupState(sandbox, 'cancelled');

  var result = sandbox.visibleBookings();

  ['today-pending', 'today-confirmed', 'future-confirmed'].forEach(function (id) {
    assert.ok(idsOf(result).indexOf(id) === -1, id + 'は「キャンセル」タブに出てはいけない');
  });
});

test('visibleBookings: 「キャンセル」タブにEXPIREDは出ない', function () {
  var sandbox = loadClientSandbox();
  setupState(sandbox, 'cancelled');

  var result = sandbox.visibleBookings();

  assert.ok(idsOf(result).indexOf('past-expired') === -1, 'EXPIREDは「キャンセル」タブに含めてはいけない');
});

test('visibleBookings: 「すべて」にはCANCELLED・EXPIREDを含む全件が出る', function () {
  var sandbox = loadClientSandbox();
  setupState(sandbox, 'all');

  var result = sandbox.visibleBookings();

  assert.strictEqual(result.length, sandbox.state.bookings.length);
  assert.ok(idsOf(result).indexOf('today-cancelled') !== -1);
  assert.ok(idsOf(result).indexOf('past-expired') !== -1);
});

test('visibleBookings: 既存のtoday/upcoming判定（日付比較）は壊れていない', function () {
  var sandbox = loadClientSandbox();
  setupState(sandbox, 'today');
  assert.deepStrictEqual(idsOf(sandbox.visibleBookings()), ['today-confirmed', 'today-pending']);

  sandbox.state.filter = 'upcoming';
  var upcomingIds = idsOf(sandbox.visibleBookings());
  assert.ok(upcomingIds.indexOf('past-cancelled') === -1, '過去日は「今後」に出てはいけない');
  assert.ok(upcomingIds.indexOf('past-expired') === -1, '過去日は「今後」に出てはいけない');
  assert.ok(upcomingIds.indexOf('future-confirmed') !== -1, '未来日のCONFIRMEDは「今後」に出るべき');
  assert.ok(upcomingIds.indexOf('today-pending') !== -1, '今日のPENDINGは「今後」にも出るべき（date >= today）');
});

test('visibleBookings: todayJst未取得時（初回描画）は今日/今後タブでも空にならない（従来どおりの挙動を維持）', function () {
  var sandbox = loadClientSandbox();
  sandbox.state.todayJst = null;
  sandbox.state.bookings = [booking({ bookingId: 'x', date: TODAY, status: 'PENDING' })];

  sandbox.state.filter = 'today';
  assert.strictEqual(sandbox.visibleBookings().length, 1);

  sandbox.state.filter = 'upcoming';
  assert.strictEqual(sandbox.visibleBookings().length, 1);
});

/* ---------- sort（日付順 / 予約順） ---------- */

test('visibleBookings: デフォルトは日付順（date昇順、同一日はstartAt昇順）', function () {
  var sandbox = loadClientSandbox();
  sandbox.state.todayJst = TODAY;
  sandbox.state.filter = 'all';
  assert.strictEqual(sandbox.state.sort, 'date', 'デフォルトのソートは日付順であるべき');
  sandbox.state.bookings = [
    booking({ bookingId: 'b-late', date: TOMORROW, startAt: '10:00', createdAt: '2026-09-20 10:00' }),
    booking({ bookingId: 'a-early-late-time', date: TODAY, startAt: '18:00', createdAt: '2026-09-21 10:00' }),
    booking({ bookingId: 'a-early-early-time', date: TODAY, startAt: '09:00', createdAt: '2026-09-19 10:00' })
  ];

  var result = sandbox.visibleBookings();

  assert.deepStrictEqual(result.map(function (b) { return b.bookingId; }), [
    'a-early-early-time',
    'a-early-late-time',
    'b-late'
  ]);
});

test('visibleBookings: 「予約順」はcreatedAt降順（新しく予約されたものが上）', function () {
  var sandbox = loadClientSandbox();
  sandbox.state.todayJst = TODAY;
  sandbox.state.filter = 'all';
  sandbox.state.sort = 'reservation';
  sandbox.state.bookings = [
    booking({ bookingId: 'oldest', date: TODAY, createdAt: '2026-09-19 10:00' }),
    booking({ bookingId: 'newest', date: TOMORROW, createdAt: '2026-09-21 10:00' }),
    booking({ bookingId: 'middle', date: YESTERDAY, createdAt: '2026-09-20 10:00' })
  ];

  var result = sandbox.visibleBookings();

  assert.deepStrictEqual(result.map(function (b) { return b.bookingId; }), ['newest', 'middle', 'oldest']);
});

test('visibleBookings: 「予約順」でcreatedAtが同じ場合はbookingIdで安定ソートされる', function () {
  var sandbox = loadClientSandbox();
  sandbox.state.todayJst = TODAY;
  sandbox.state.filter = 'all';
  sandbox.state.sort = 'reservation';
  sandbox.state.bookings = [
    booking({ bookingId: 'z-same', date: TODAY, createdAt: '2026-09-20 10:00' }),
    booking({ bookingId: 'a-same', date: TODAY, createdAt: '2026-09-20 10:00' })
  ];

  var result = sandbox.visibleBookings();

  assert.deepStrictEqual(result.map(function (b) { return b.bookingId; }), ['a-same', 'z-same']);
});

test('visibleBookings: 各タブのフィルタ後にソートされる（「今後」タブ＋日付順）', function () {
  var sandbox = loadClientSandbox();
  sandbox.state.todayJst = TODAY;
  sandbox.state.filter = 'upcoming';
  sandbox.state.sort = 'date';
  sandbox.state.bookings = [
    booking({ bookingId: 'upcoming-late', date: TOMORROW, startAt: '20:00', status: 'CONFIRMED' }),
    booking({ bookingId: 'upcoming-early', date: TODAY, startAt: '09:00', status: 'PENDING' }),
    booking({ bookingId: 'excluded-cancelled', date: TODAY, startAt: '08:00', status: 'CANCELLED' }),
    booking({ bookingId: 'excluded-past', date: YESTERDAY, startAt: '08:00', status: 'CONFIRMED' })
  ];

  var result = sandbox.visibleBookings();

  assert.deepStrictEqual(result.map(function (b) { return b.bookingId; }), ['upcoming-early', 'upcoming-late']);
});

test('visibleBookings: 各タブのフィルタ後にソートされる（「キャンセル」タブ＋予約順、CANCELLEDタブ分離仕様は壊れていない）', function () {
  var sandbox = loadClientSandbox();
  sandbox.state.todayJst = TODAY;
  sandbox.state.filter = 'cancelled';
  sandbox.state.sort = 'reservation';
  sandbox.state.bookings = [
    booking({ bookingId: 'cancelled-old', date: YESTERDAY, status: 'CANCELLED', createdAt: '2026-09-18 10:00' }),
    booking({ bookingId: 'cancelled-new', date: TOMORROW, status: 'CANCELLED', createdAt: '2026-09-20 10:00' }),
    booking({ bookingId: 'not-cancelled', date: TODAY, status: 'PENDING', createdAt: '2026-09-21 10:00' }),
    booking({ bookingId: 'expired', date: YESTERDAY, status: 'EXPIRED', createdAt: '2026-09-22 10:00' })
  ];

  var result = sandbox.visibleBookings();

  assert.deepStrictEqual(result.map(function (b) { return b.bookingId; }), ['cancelled-new', 'cancelled-old']);
});

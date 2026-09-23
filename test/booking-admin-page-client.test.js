/*
 * admin/booking/booking-admin.js（Booking Admin Web UIの外部化されたクライアント側
 * ロジック。Issue #317）のvisibleBookings()等のテスト。
 *
 * 要件: 「今日」「今後」タブにCANCELLEDを表示しない・CANCELLEDは新しい「キャンセル」
 * タブへ集約する・EXPIREDは「キャンセル」に含めない・「すべて」は従来どおり全件表示する。
 *
 * Issue #317でBookingAdminPage.html内のインライン<script>をadmin/booking/booking-admin.js
 * （GitHub Pagesから配信する実ファイル）へ外部化したため、このテストもBookingAdminPage.html
 * からの正規表現抽出をやめ、booking-admin.jsを直接vmで実行する（ロジックを別途Node用に
 * 書き写さない。test/helpers/frontend-sandbox.js・gas-sandbox.jsと同じ方針）。
 * DOM/google.script.runは、トップレベルの同期実行（イベント登録・初回loadBookings()
 * 呼び出し）が例外を投げない最小限のスタブのみ用意する。loadBookings()の応答は待たず、
 * state.bookings/state.todayJst/state.filterはテストから直接差し替えて
 * visibleBookings()の絞り込みだけを検証する。
 */
'use strict';

var test = require('node:test');
var assert = require('node:assert');
var fs = require('fs');
var path = require('path');
var vm = require('vm');

var CLIENT_JS_PATH = path.join(__dirname, '..', 'admin', 'booking', 'booking-admin.js');

/*
 * Issue #322で追加したinitHeaderUi_/initSearchUi_（起動時に一度だけheader/main配下へ
 * 要素を生成・挿入する処理）が例外を投げないよう、document.querySelector/
 * document.createElementと、生成した要素へのappendChild/insertBeforeの
 * 最小限のスタブを追加した。実DOM上の親子関係を正しく再現する必要はなく
 * （render()から見えるのはgetElementById経由のtextContent/innerHTMLのみ）、
 * 「例外を投げない」ことだけを保証する。 */
function createElementStub() {
  return {
    id: '',
    type: '',
    value: '',
    placeholder: '',
    className: '',
    disabled: false,
    textContent: '',
    innerHTML: '',
    classList: { add: function () {}, remove: function () {} },
    addEventListener: function () {},
    appendChild: function () {},
    insertBefore: function () {},
    getAttribute: function () { return null; },
    setAttribute: function () {}
  };
}

function loadClientSandbox() {
  var scriptSrc = fs.readFileSync(CLIENT_JS_PATH, 'utf8');

  var scriptRunStub = {
    withSuccessHandler: function () { return scriptRunStub; },
    withFailureHandler: function () { return scriptRunStub; },
    getAdminBookings: function () {},
    getAdminBookingDetail: function () {},
    adminConfirmBooking: function () {},
    adminCancelBooking: function () {}
  };

  var elementsById = {};
  var elementsBySelector = {};
  var documentStub = {
    getElementById: function (id) {
      if (!elementsById[id]) elementsById[id] = createElementStub();
      return elementsById[id];
    },
    querySelector: function (selector) {
      if (!elementsBySelector[selector]) elementsBySelector[selector] = createElementStub();
      return elementsBySelector[selector];
    },
    querySelectorAll: function () { return []; },
    createElement: function () { return createElementStub(); }
  };

  var sandbox = {
    document: documentStub,
    google: { script: { run: scriptRunStub } },
    window: {},
    alert: function () {}
  };
  vm.createContext(sandbox);
  vm.runInContext(scriptSrc, sandbox, { filename: CLIENT_JS_PATH });
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

/*
 * Issue #326: EXPIREDになった予約が「今日」「今後」タブに残り続けて見づらいという
 * 運用課題への対応。past-expired（YESTERDAY）は日付比較だけでも今日/今後から
 * 自然に除外されるため、ここでは今日付・未来日付のEXPIREDを別途用意し、
 * 「日付が一致/未来であってもstatus=EXPIREDなら除外される」ことを明示的に検証する。
 */
function setupStateWithExpiredToday(sandbox, filter) {
  setupState(sandbox, filter);
  sandbox.state.bookings = sandbox.state.bookings.concat([
    booking({ bookingId: 'today-expired', date: TODAY, status: 'EXPIRED' }),
    booking({ bookingId: 'future-expired', date: TOMORROW, status: 'EXPIRED' })
  ]);
}

test('visibleBookings: 「今日」タブは今日日付であってもEXPIREDを除外する（Issue #326）', function () {
  var sandbox = loadClientSandbox();
  setupStateWithExpiredToday(sandbox, 'today');

  var result = sandbox.visibleBookings();

  assert.deepStrictEqual(idsOf(result), ['today-confirmed', 'today-pending']);
  assert.strictEqual(idsOf(result).indexOf('today-expired'), -1, '今日日付のEXPIREDは「今日」タブに出てはいけない');
});

test('visibleBookings: 「今後」タブは未来日付であってもEXPIREDを除外する（Issue #326）', function () {
  var sandbox = loadClientSandbox();
  setupStateWithExpiredToday(sandbox, 'upcoming');

  var result = sandbox.visibleBookings();

  assert.strictEqual(idsOf(result).indexOf('today-expired'), -1, '今日日付のEXPIREDは「今後」タブに出てはいけない');
  assert.strictEqual(idsOf(result).indexOf('future-expired'), -1, '未来日付のEXPIREDは「今後」タブに出てはいけない');
  assert.deepStrictEqual(idsOf(result), ['future-confirmed', 'today-confirmed', 'today-pending'].sort());
});

test('visibleBookings: 「キャンセル」タブは今日/未来日付のEXPIREDも含めない（CANCELLEDのみ）', function () {
  var sandbox = loadClientSandbox();
  setupStateWithExpiredToday(sandbox, 'cancelled');

  var result = sandbox.visibleBookings();

  assert.strictEqual(idsOf(result).indexOf('today-expired'), -1);
  assert.strictEqual(idsOf(result).indexOf('future-expired'), -1);
  assert.deepStrictEqual(idsOf(result), ['future-cancelled', 'past-cancelled', 'today-cancelled'].sort());
});

test('visibleBookings: 「すべて」は今日/未来日付のEXPIREDも含めて全件表示する', function () {
  var sandbox = loadClientSandbox();
  setupStateWithExpiredToday(sandbox, 'all');

  var result = sandbox.visibleBookings();

  assert.strictEqual(result.length, sandbox.state.bookings.length);
  assert.ok(idsOf(result).indexOf('today-expired') !== -1);
  assert.ok(idsOf(result).indexOf('future-expired') !== -1);
});

test('computeTabCounts: 今日/今後タブの件数は今日・未来日付のEXPIREDを数えない（Issue #326）', function () {
  var sandbox = loadClientSandbox();
  setupStateWithExpiredToday(sandbox, 'all');

  var counts = sandbox.computeTabCounts(sandbox.state.bookings, TODAY);
  assert.strictEqual(counts.today, 2, '今日タブの件数にtoday-expiredを含めてはいけない');
  assert.strictEqual(counts.upcoming, 3, '今後タブの件数にtoday-expired/future-expiredを含めてはいけない（today-pending, today-confirmed, future-confirmed）');
  assert.strictEqual(counts.cancelled, 3, 'キャンセルタブの件数にEXPIREDを含めない');
  assert.strictEqual(counts.all, sandbox.state.bookings.length, 'すべてタブは追加したEXPIRED 2件も含む');
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

/* ---------- customerTypeLabel / formatValue（表示専用の日本語ラベル変換） ---------- */

test('customerTypeLabel: first_time は「初回利用」に変換される', function () {
  var sandbox = loadClientSandbox();
  assert.strictEqual(sandbox.customerTypeLabel('first_time'), '初回利用');
});

test('customerTypeLabel: returning は「利用経験あり」に変換される', function () {
  var sandbox = loadClientSandbox();
  assert.strictEqual(sandbox.customerTypeLabel('returning'), '利用経験あり');
});

test('customerTypeLabel: 未知の値は例外にせず元値をそのまま返す', function () {
  var sandbox = loadClientSandbox();
  assert.strictEqual(sandbox.customerTypeLabel('unknown_value'), 'unknown_value');
});

test('customerTypeLabel: 空・未設定は空文字を返す（formatValue側で「（未設定）」に変換される）', function () {
  var sandbox = loadClientSandbox();
  assert.strictEqual(sandbox.customerTypeLabel(''), '');
  assert.strictEqual(sandbox.customerTypeLabel(null), '');
  assert.strictEqual(sandbox.customerTypeLabel(undefined), '');
});

test('formatValue: key=customerTypeはcustomerTypeLabel経由で日本語ラベルへ変換される（表示ロジックの一元化）', function () {
  var sandbox = loadClientSandbox();
  assert.strictEqual(sandbox.formatValue('customerType', 'first_time'), '初回利用');
  assert.strictEqual(sandbox.formatValue('customerType', 'returning'), '利用経験あり');
  assert.strictEqual(sandbox.formatValue('customerType', ''), '（未設定）');
  assert.strictEqual(sandbox.formatValue('customerType', 'unknown_value'), 'unknown_value');
});

test('render: 一覧カードにcustomerTypeの内部値がそのまま出ず、日本語ラベルで出る', function () {
  var sandbox = loadClientSandbox();
  sandbox.state.todayJst = TODAY;
  sandbox.state.filter = 'all';
  sandbox.state.bookings = [
    booking({ bookingId: 'a', customerType: 'first_time' }),
    booking({ bookingId: 'b', customerType: 'returning' })
  ];

  var list = sandbox.document.getElementById('list');
  sandbox.render();

  assert.ok(list.innerHTML.indexOf('初回利用') !== -1, '一覧カードに「初回利用」が出るべき');
  assert.ok(list.innerHTML.indexOf('利用経験あり') !== -1, '一覧カードに「利用経験あり」が出るべき');
  assert.ok(list.innerHTML.indexOf('first_time') === -1, '一覧カードにfirst_timeが直接出てはいけない');
  assert.ok(list.innerHTML.indexOf('returning') === -1, '一覧カードにreturningが直接出てはいけない');
});

test('showDetailModal: 詳細モーダルにcustomerTypeの内部値がそのまま出ず、日本語ラベルで出る', function () {
  var sandbox = loadClientSandbox();
  var body = sandbox.document.getElementById('modal-body');

  sandbox.showDetailModal(booking({ customerType: 'first_time' }));
  assert.ok(body.innerHTML.indexOf('初回利用') !== -1, '詳細モーダルに「初回利用」が出るべき');
  assert.ok(body.innerHTML.indexOf('first_time') === -1, '詳細モーダルにfirst_timeが直接出てはいけない');

  sandbox.showDetailModal(booking({ customerType: 'returning' }));
  assert.ok(body.innerHTML.indexOf('利用経験あり') !== -1, '詳細モーダルに「利用経験あり」が出るべき');
  assert.ok(body.innerHTML.indexOf('returning') === -1, '詳細モーダルにreturningが直接出てはいけない');
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

/* ---------- brandLabel / statusLabel（Issue #322 要件5: 表示専用の日本語/英語ラベル変換） ---------- */

test('brandLabel: snb/mens/studio_xが要件どおりのラベルに変換される', function () {
  var sandbox = loadClientSandbox();
  assert.strictEqual(sandbox.brandLabel('snb'), 'SNB');
  assert.strictEqual(sandbox.brandLabel('mens'), 'SNB mens');
  assert.strictEqual(sandbox.brandLabel('studio_x'), 'Studio X');
});

test('brandLabel: 未知の値は例外にせず元値をそのまま返す・空は空文字を返す', function () {
  var sandbox = loadClientSandbox();
  assert.strictEqual(sandbox.brandLabel('unknown_brand'), 'unknown_brand');
  assert.strictEqual(sandbox.brandLabel(''), '');
  assert.strictEqual(sandbox.brandLabel(null), '');
});

test('statusLabel: PENDING/CONFIRMED/CANCELLED/EXPIREDが要件どおりのラベルに変換される', function () {
  var sandbox = loadClientSandbox();
  assert.strictEqual(sandbox.statusLabel('PENDING'), '仮受付');
  assert.strictEqual(sandbox.statusLabel('CONFIRMED'), '確定');
  assert.strictEqual(sandbox.statusLabel('CANCELLED'), 'キャンセル');
  assert.strictEqual(sandbox.statusLabel('EXPIRED'), '期限切れ');
});

test('statusLabel: 未知の値は例外にせず元値をそのまま返す・空は空文字を返す', function () {
  var sandbox = loadClientSandbox();
  assert.strictEqual(sandbox.statusLabel('unknown_status'), 'unknown_status');
  assert.strictEqual(sandbox.statusLabel(''), '');
});

test('formatValue: key=brand/statusはbrandLabel/statusLabel経由で日本語ラベルへ変換される', function () {
  var sandbox = loadClientSandbox();
  assert.strictEqual(sandbox.formatValue('brand', 'studio_x'), 'Studio X');
  assert.strictEqual(sandbox.formatValue('brand', ''), '（未設定）');
  assert.strictEqual(sandbox.formatValue('status', 'CONFIRMED'), '確定');
  assert.strictEqual(sandbox.formatValue('status', ''), '（未設定）');
});

test('render: 一覧カードにブランド・statusが人間向けラベルで表示され、bookingId・支払方法・利用目的も表示される', function () {
  var sandbox = loadClientSandbox();
  sandbox.state.todayJst = TODAY;
  sandbox.state.filter = 'all';
  sandbox.state.bookings = [
    booking({ bookingId: 'brand-status-check', brand: 'studio_x', status: 'PENDING', paymentMethod: '現金', purpose: '撮影' })
  ];

  var list = sandbox.document.getElementById('list');
  sandbox.render();

  assert.ok(list.innerHTML.indexOf('Studio X') !== -1, 'ブランドは人間向けラベル（Studio X）で出るべき');
  assert.ok(list.innerHTML.indexOf('studio_x') === -1, 'ブランドの内部値がそのまま出てはいけない');
  assert.ok(list.innerHTML.indexOf('仮受付') !== -1, 'statusは人間向けラベル（仮受付）で出るべき');
  assert.ok(list.innerHTML.indexOf('brand-status-check') !== -1, 'bookingIdがカードに表示されるべき');
  assert.ok(list.innerHTML.indexOf('現金') !== -1, '支払方法がカードに表示されるべき');
  assert.ok(list.innerHTML.indexOf('撮影') !== -1, '利用目的がカードに表示されるべき');
});

/* ---------- filterBySearch（Issue #322 要件4: クライアント側検索） ---------- */

function searchBooking(overrides) {
  return booking(Object.assign({
    bookingId: 'SX-20260101-SEARCH01',
    name: '佐藤花子',
    purpose: '会議利用',
    date: '2026-09-22',
    brand: 'studio_x',
    customerType: 'first_time',
    paymentMethod: 'クレジットカード',
    status: 'PENDING'
  }, overrides || {}));
}

test('filterBySearch: 空文字・空白のみのqueryは絞り込まず全件を返す', function () {
  var sandbox = loadClientSandbox();
  var list = [searchBooking({ bookingId: 'a' }), searchBooking({ bookingId: 'b' })];

  assert.strictEqual(sandbox.filterBySearch(list, '').length, 2);
  assert.strictEqual(sandbox.filterBySearch(list, '   ').length, 2);
  assert.strictEqual(sandbox.filterBySearch(list, undefined).length, 2);
});

test('filterBySearch: 氏名で部分一致検索できる（大文字小文字を無視）', function () {
  var sandbox = loadClientSandbox();
  var list = [
    searchBooking({ bookingId: 'a', name: '佐藤花子' }),
    searchBooking({ bookingId: 'b', name: '山田太郎' })
  ];

  var result = sandbox.filterBySearch(list, '佐藤');
  assert.deepStrictEqual(result.map(function (b) { return b.bookingId; }), ['a']);
});

test('filterBySearch: bookingIdで検索できる', function () {
  var sandbox = loadClientSandbox();
  var list = [
    searchBooking({ bookingId: 'SX-20260101-AAAAAAAA' }),
    searchBooking({ bookingId: 'SX-20260102-BBBBBBBB' })
  ];

  var result = sandbox.filterBySearch(list, 'AAAAAAAA');
  assert.deepStrictEqual(result.map(function (b) { return b.bookingId; }), ['SX-20260101-AAAAAAAA']);
});

test('filterBySearch: 利用目的で検索できる', function () {
  var sandbox = loadClientSandbox();
  var list = [
    searchBooking({ bookingId: 'a', purpose: '会議利用' }),
    searchBooking({ bookingId: 'b', purpose: '撮影' })
  ];

  var result = sandbox.filterBySearch(list, '撮影');
  assert.deepStrictEqual(result.map(function (b) { return b.bookingId; }), ['b']);
});

test('filterBySearch: 日付で検索できる', function () {
  var sandbox = loadClientSandbox();
  var list = [
    searchBooking({ bookingId: 'a', date: '2026-09-22' }),
    searchBooking({ bookingId: 'b', date: '2026-10-01' })
  ];

  var result = sandbox.filterBySearch(list, '2026-10');
  assert.deepStrictEqual(result.map(function (b) { return b.bookingId; }), ['b']);
});

test('filterBySearch: ブランドは内部値・表示ラベルのいずれでも検索できる', function () {
  var sandbox = loadClientSandbox();
  var list = [
    searchBooking({ bookingId: 'a', brand: 'studio_x' }),
    searchBooking({ bookingId: 'b', brand: 'snb' })
  ];

  assert.deepStrictEqual(sandbox.filterBySearch(list, 'studio_x').map(function (b) { return b.bookingId; }), ['a']);
  assert.deepStrictEqual(sandbox.filterBySearch(list, 'Studio X').map(function (b) { return b.bookingId; }), ['a']);
  assert.deepStrictEqual(sandbox.filterBySearch(list, 'SNB').map(function (b) { return b.bookingId; }), ['b']);
});

test('filterBySearch: customerTypeは内部値・表示ラベルのいずれでも検索できる', function () {
  var sandbox = loadClientSandbox();
  var list = [
    searchBooking({ bookingId: 'a', customerType: 'first_time' }),
    searchBooking({ bookingId: 'b', customerType: 'returning' })
  ];

  assert.deepStrictEqual(sandbox.filterBySearch(list, 'first_time').map(function (b) { return b.bookingId; }), ['a']);
  assert.deepStrictEqual(sandbox.filterBySearch(list, '利用経験あり').map(function (b) { return b.bookingId; }), ['b']);
});

test('filterBySearch: 支払方法で検索できる', function () {
  var sandbox = loadClientSandbox();
  var list = [
    searchBooking({ bookingId: 'a', paymentMethod: 'クレジットカード' }),
    searchBooking({ bookingId: 'b', paymentMethod: '現金' })
  ];

  var result = sandbox.filterBySearch(list, '現金');
  assert.deepStrictEqual(result.map(function (b) { return b.bookingId; }), ['b']);
});

test('filterBySearch: statusは内部値・表示ラベルのいずれでも検索できる', function () {
  var sandbox = loadClientSandbox();
  var list = [
    searchBooking({ bookingId: 'a', status: 'PENDING' }),
    searchBooking({ bookingId: 'b', status: 'CONFIRMED' })
  ];

  assert.deepStrictEqual(sandbox.filterBySearch(list, 'CONFIRMED').map(function (b) { return b.bookingId; }), ['b']);
  assert.deepStrictEqual(sandbox.filterBySearch(list, '確定').map(function (b) { return b.bookingId; }), ['b']);
  assert.deepStrictEqual(sandbox.filterBySearch(list, '仮受付').map(function (b) { return b.bookingId; }), ['a']);
});

test('filterBySearch: 一致しないqueryは空配列を返す', function () {
  var sandbox = loadClientSandbox();
  var list = [searchBooking({ bookingId: 'a' })];

  assert.deepStrictEqual(sandbox.filterBySearch(list, '存在しない文字列xyz'), []);
});

test('visibleBookings: 検索クエリはタブフィルタ後・ソート前に適用される', function () {
  var sandbox = loadClientSandbox();
  sandbox.state.todayJst = TODAY;
  sandbox.state.filter = 'all';
  sandbox.state.sort = 'date';
  sandbox.state.searchQuery = '花子';
  sandbox.state.bookings = [
    searchBooking({ bookingId: 'match', name: '佐藤花子', date: TODAY }),
    searchBooking({ bookingId: 'no-match', name: '山田太郎', date: TODAY })
  ];

  var result = sandbox.visibleBookings();

  assert.deepStrictEqual(result.map(function (b) { return b.bookingId; }), ['match']);
});

/* ---------- computeSummaryCounts / computeTabCounts（Issue #322 要件2・3: 件数集計の純粋関数） ---------- */

function countsBookingSet() {
  return [
    booking({ bookingId: 'today-pending', date: TODAY, status: 'PENDING' }),
    booking({ bookingId: 'today-confirmed', date: TODAY, status: 'CONFIRMED' }),
    booking({ bookingId: 'today-cancelled', date: TODAY, status: 'CANCELLED' }),
    booking({ bookingId: 'future-pending', date: TOMORROW, status: 'PENDING' }),
    booking({ bookingId: 'future-confirmed', date: TOMORROW, status: 'CONFIRMED' }),
    booking({ bookingId: 'future-cancelled', date: TOMORROW, status: 'CANCELLED' }),
    booking({ bookingId: 'past-cancelled', date: YESTERDAY, status: 'CANCELLED' }),
    booking({ bookingId: 'past-expired', date: YESTERDAY, status: 'EXPIRED' })
  ];
}

test('computeSummaryCounts: 今日/仮受付(PENDING)/確定(CONFIRMED)/全件を正しく集計する', function () {
  var sandbox = loadClientSandbox();
  var counts = sandbox.computeSummaryCounts(countsBookingSet(), TODAY);

  assert.strictEqual(counts.today, 2, '今日はCANCELLEDを除いた今日日付の件数（today-pending, today-confirmed）');
  assert.strictEqual(counts.pending, 2, 'PENDINGは日付を問わず全件（today-pending, future-pending）');
  assert.strictEqual(counts.confirmed, 2, 'CONFIRMEDは日付を問わず全件（today-confirmed, future-confirmed）');
  assert.strictEqual(counts.all, 8, '全件はbookings.length');
});

test('computeSummaryCounts: 空配列では全てゼロを返す', function () {
  var sandbox = loadClientSandbox();
  var counts = sandbox.computeSummaryCounts([], TODAY);

  assert.strictEqual(counts.today, 0);
  assert.strictEqual(counts.pending, 0);
  assert.strictEqual(counts.confirmed, 0);
  assert.strictEqual(counts.all, 0);
});

test('computeSummaryCounts: todayJst未取得(null)でも例外にならない', function () {
  var sandbox = loadClientSandbox();
  var counts = sandbox.computeSummaryCounts(countsBookingSet(), null);

  assert.strictEqual(counts.all, 8);
});

test('computeTabCounts: 今日/今後/キャンセル/すべての件数を正しく集計する', function () {
  var sandbox = loadClientSandbox();
  var counts = sandbox.computeTabCounts(countsBookingSet(), TODAY);

  assert.strictEqual(counts.today, 2, '今日タブ: today-pending, today-confirmed');
  assert.strictEqual(counts.upcoming, 4, '今後タブ: today-pending, today-confirmed, future-pending, future-confirmed');
  assert.strictEqual(counts.cancelled, 3, 'キャンセルタブ: today-cancelled, future-cancelled, past-cancelled（EXPIREDは含まない）');
  assert.strictEqual(counts.all, 8, 'すべてタブ: 全件');
});

test('computeSummaryCounts/computeTabCounts: 検索クエリの影響を受けない（全件ベースで計算される）', function () {
  var sandbox = loadClientSandbox();
  sandbox.state.bookings = countsBookingSet();
  sandbox.state.todayJst = TODAY;
  sandbox.state.filter = 'today';
  sandbox.state.searchQuery = '存在しない文字列xyz';

  var visible = sandbox.visibleBookings();
  assert.strictEqual(visible.length, 0, '検索にマッチしないため表示件数は0件のはず');

  var summary = sandbox.computeSummaryCounts(sandbox.state.bookings, sandbox.state.todayJst);
  var tabCounts = sandbox.computeTabCounts(sandbox.state.bookings, sandbox.state.todayJst);
  assert.strictEqual(summary.all, 8, 'サマリーは検索クエリの影響を受けず全件ベースのまま');
  assert.strictEqual(tabCounts.today, 2, 'タブ件数は検索クエリの影響を受けず全件ベースのまま');
});

/* ---------- render()がsummary/タブ件数用のDOM要素を更新し、例外を投げないこと ---------- */

test('render: summary/タブ件数用のDOM要素（getElementById経由）が更新される', function () {
  var sandbox = loadClientSandbox();
  sandbox.state.todayJst = TODAY;
  sandbox.state.filter = 'all';
  sandbox.state.bookings = countsBookingSet();

  sandbox.render();

  assert.strictEqual(sandbox.document.getElementById('summary-today-count').textContent, '2');
  assert.strictEqual(sandbox.document.getElementById('summary-pending-count').textContent, '2');
  assert.strictEqual(sandbox.document.getElementById('summary-confirmed-count').textContent, '2');
  assert.strictEqual(sandbox.document.getElementById('summary-all-count').textContent, '8');
  assert.strictEqual(sandbox.document.getElementById('tab-count-today').textContent, '2');
  assert.strictEqual(sandbox.document.getElementById('tab-count-all').textContent, '8');
});

test('render: 検索結果が0件でも空表示になり例外を投げない（summary/タブ件数は更新される）', function () {
  var sandbox = loadClientSandbox();
  sandbox.state.todayJst = TODAY;
  sandbox.state.filter = 'all';
  sandbox.state.searchQuery = '存在しない文字列xyz';
  sandbox.state.bookings = countsBookingSet();

  sandbox.render();

  var list = sandbox.document.getElementById('list');
  assert.ok(list.innerHTML.indexOf('該当する予約がありません') !== -1);
  assert.strictEqual(sandbox.document.getElementById('summary-all-count').textContent, '8');
});

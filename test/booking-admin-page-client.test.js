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
/*
 * addEventListenerは実際にハンドラを_listenersへ保持する（Issue #330 PRレビュー
 * 対応で追加した非同期レスポンス制御・二重実行防止のテストのため、fireメソッドで
 * テストからイベント発火をシミュレートできるようにした）。他のプロパティ・
 * メソッドは従来どおり「例外を投げない」ことだけを保証する最小限のスタブ。
 */
function createElementStub() {
  var listeners = {};
  return {
    id: '',
    type: '',
    value: '',
    placeholder: '',
    className: '',
    disabled: false,
    checked: false,
    textContent: '',
    innerHTML: '',
    classList: { add: function () {}, remove: function () {} },
    addEventListener: function (type, handler) {
      if (!listeners[type]) listeners[type] = [];
      listeners[type].push(handler);
    },
    fire: function (type, eventArg) {
      (listeners[type] || []).forEach(function (handler) { handler(eventArg || {}); });
    },
    appendChild: function () {},
    insertBefore: function () {},
    getAttribute: function () { return null; },
    setAttribute: function () {}
  };
}

/*
 * google.script.runのスタブ。実際のGASと同じく、withSuccessHandler/
 * withFailureHandlerで登録したハンドラは即座には呼ばれず、対応するAPIメソッド
 * （例: diagnoseReminderEligibility(...)）が呼ばれた時点で呼び出しを`calls`へ
 * キューし、テスト側が`resolveCall(index, result)`/`rejectCall(index, error)`で
 * 明示的に・任意の順序で解決できるようにする（Issue #330 PRレビュー対応:
 * リクエスト連番による非同期レスポンス制御のテストのため。応答順序が発行順と
 * 一致しない＝古いリクエストの応答が新しいリクエストの応答より後に返るケースを
 * 再現できる）。既存のgetAdminBookings等も同じ仕組みに統一したが、戻り値・
 * 呼び出し可否は従来と変わらない（呼んでも例外を投げないだけで、解決するか
 * どうかは各テストの任意）。
 */
function createScriptRunStub() {
  var calls = [];
  var pendingSuccess = null;
  var pendingFailure = null;
  var API_METHODS = [
    'getAdminBookings',
    'getAdminBookingDetail',
    'adminConfirmBooking',
    'adminCancelBooking',
    'diagnoseReminderEligibility',
    'previewReminderMail',
    'sendReminderTestMail'
  ];

  var stub = {
    calls: calls,
    withSuccessHandler: function (fn) { pendingSuccess = fn; return stub; },
    withFailureHandler: function (fn) { pendingFailure = fn; return stub; },
    resolveCall: function (index, result) { calls[index].onSuccess && calls[index].onSuccess(result); },
    rejectCall: function (index, error) { calls[index].onFailure && calls[index].onFailure(error); }
  };

  API_METHODS.forEach(function (name) {
    stub[name] = function () {
      calls.push({
        name: name,
        args: Array.prototype.slice.call(arguments),
        onSuccess: pendingSuccess,
        onFailure: pendingFailure
      });
      pendingSuccess = null;
      pendingFailure = null;
    };
  });

  return stub;
}

function loadClientSandbox(options) {
  var opts = options || {};
  var scriptSrc = fs.readFileSync(CLIENT_JS_PATH, 'utf8');

  var scriptRunStub = createScriptRunStub();

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
    createElement: function () { return createElementStub(); },
    /* Issue #330: buildReminderDiagnosticsModal_がdocument.body.appendChild/
       document.createTextNodeを使うため追加した（他の要素はheader/main配下へ挿入する
       initHeaderUi_/initSearchUi_と異なり、診断モーダルはdocument.body直下へ追加するため）。 */
    body: createElementStub(),
    createTextNode: function (text) { return { nodeType: 3, textContent: text }; }
  };

  var sandbox = {
    document: documentStub,
    google: { script: { run: scriptRunStub } },
    /* window.confirm: 既定はtrue（テスト送信の確認ダイアログを常に「実行する」扱いにする）。
       確認ダイアログでキャンセルする挙動を検証したいテストはoptions.confirmResultに
       falseを渡す（Issue #330 PRレビュー対応の二重実行防止テストのため追加）。 */
    window: { confirm: function () { return opts.confirmResult !== false; } },
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

/* ---------- Issue #330: 前日リマインド診断 ---------- */

test('reminderReasonLabel: 理由コードを日本語ラベルへ変換する。未知の値はそのまま返す', function () {
  var sandbox = loadClientSandbox();
  assert.strictEqual(sandbox.reminderReasonLabel('ELIGIBLE'), '送信対象');
  assert.strictEqual(sandbox.reminderReasonLabel('NOT_NEXT_DAY'), '翌日対象外');
  assert.strictEqual(sandbox.reminderReasonLabel('INVALID_STATUS'), '対象外ステータス');
  assert.strictEqual(sandbox.reminderReasonLabel('ALREADY_SENT'), '送信済み');
  assert.strictEqual(sandbox.reminderReasonLabel('EMAIL_MISSING'), 'メール未登録');
  assert.strictEqual(sandbox.reminderReasonLabel('MAIL_NOT_READY'), '設定不足');
  assert.strictEqual(sandbox.reminderReasonLabel('SOMETHING_UNKNOWN'), 'SOMETHING_UNKNOWN');
});

test('renderReminderDiagnosisResult_: 成功時は判定・対象日・予約者メールを表示する', function () {
  var sandbox = loadClientSandbox();
  var html = sandbox.renderReminderDiagnosisResult_({
    success: true,
    eligible: true,
    reasonCode: 'ELIGIBLE',
    targetDate: '2026-10-02',
    message: '送信対象です。',
    booking: { brand: 'studio_x', status: 'CONFIRMED', date: '2026-10-02', email: 'taro@example.com' }
  });

  assert.match(html, /送信対象/);
  assert.match(html, /2026-10-02/);
  assert.match(html, /taro@example\.com/);
});

test('renderReminderDiagnosisResult_: 失敗時はエラーメッセージを表示する', function () {
  var sandbox = loadClientSandbox();
  var html = sandbox.renderReminderDiagnosisResult_({ success: false, error: { message: 'bookingIdが見つかりません' } });

  assert.match(html, /判定できませんでした/);
  assert.match(html, /bookingIdが見つかりません/);
});

test('renderReminderPreviewResult_: 成功時は宛先2種・件名・本文を表示し、マスク中は注意書きを出す', function () {
  var sandbox = loadClientSandbox();
  var html = sandbox.renderReminderPreviewResult_({
    success: true,
    subject: '【Studio X】明日のご利用案内',
    body: 'キーボックス番号: ••••••',
    recipientEmail: 'taro@example.com',
    testRecipientEmail: 'admin@example.com',
    revealed: false
  });

  assert.match(html, /taro@example\.com/);
  assert.match(html, /admin@example\.com/);
  assert.match(html, /明日のご利用案内/);
  assert.match(html, /マスクしています/);
});

test('renderReminderPreviewResult_: revealed:trueの場合はマスク注意書きを出さない', function () {
  var sandbox = loadClientSandbox();
  var html = sandbox.renderReminderPreviewResult_({
    success: true,
    subject: 'subject',
    body: 'body',
    recipientEmail: 'taro@example.com',
    testRecipientEmail: 'admin@example.com',
    revealed: true
  });

  assert.strictEqual(html.indexOf('マスクしています'), -1);
});

test('renderReminderSendResult_: 成功時は送信先を表示する', function () {
  var sandbox = loadClientSandbox();
  var html = sandbox.renderReminderSendResult_({ success: true, sentTo: 'admin@example.com' });

  assert.match(html, /テスト送信しました/);
  assert.match(html, /admin@example\.com/);
});

test('renderReminderSendResult_: 対象外の場合は理由コードのラベルを表示する', function () {
  var sandbox = loadClientSandbox();
  var html = sandbox.renderReminderSendResult_({
    success: false,
    reasonCode: 'ALREADY_SENT',
    error: { message: '前日リマインドは送信済みです。' }
  });

  assert.match(html, /送信済み/);
});

test('openReminderDiagnostics_: 初回クリックで診断モーダルをDOM生成し、例外を投げない（BookingAdminPage.html自体は変更しない設計の確認）', function () {
  var sandbox = loadClientSandbox();
  sandbox.state.todayJst = '2026-09-22';

  assert.doesNotThrow(function () { sandbox.openReminderDiagnostics_(); });
  assert.strictEqual(sandbox.reminderDiagState_.bookingIdInput.id, 'reminder-diag-booking-id');
  assert.strictEqual(sandbox.reminderDiagState_.baseDateInput.value, '2026-09-22', '基準日の初期値はstate.todayJst');

  /* 2回目のクリックでもDOMを再生成せず例外を投げない。 */
  assert.doesNotThrow(function () { sandbox.openReminderDiagnostics_(); });
});

/* ---------- PRレビュー対応: 想定外例外時にerror.messageを描画しない ---------- */

test('REMINDER_DIAG_GENERIC_FAILURE_RESULT_: 固定の安全な文言のみを持ち、渡された例外由来の情報を含まない', function () {
  var sandbox = loadClientSandbox();
  var fixed = sandbox.REMINDER_DIAG_GENERIC_FAILURE_RESULT_;

  assert.strictEqual(fixed.success, false);
  assert.strictEqual(typeof fixed.error.message, 'string');
  assert.ok(fixed.error.message.length > 0);
});

test('renderReminderDiagnosisResult_/renderReminderPreviewResult_/renderReminderSendResult_: withFailureHandler相当（REMINDER_DIAG_GENERIC_FAILURE_RESULT_）を渡しても固定文言のみ表示し例外を投げない', function () {
  var sandbox = loadClientSandbox();
  var fixed = sandbox.REMINDER_DIAG_GENERIC_FAILURE_RESULT_;

  assert.doesNotThrow(function () {
    assert.match(sandbox.renderReminderDiagnosisResult_(fixed), /通信エラー/);
    assert.match(sandbox.renderReminderPreviewResult_(fixed), /通信エラー/);
    assert.match(sandbox.renderReminderSendResult_(fixed), /通信エラー/);
  });
});

/* ---------- PRレビュー対応: プレビュー成功と送信対象の区別・秘密値表示状態のリセット ---------- */

test('renderReminderPreviewResult_: eligible:falseの場合は「プレビュー成功」と「対象外」を区別して表示する', function () {
  var sandbox = loadClientSandbox();
  var html = sandbox.renderReminderPreviewResult_({
    success: true,
    targetDate: '2026-10-02',
    subject: 'subject',
    body: 'body',
    recipientEmail: 'taro@example.com',
    testRecipientEmail: 'admin@example.com',
    revealed: false,
    eligible: false,
    reasonCode: 'NOT_NEXT_DAY'
  });

  assert.match(html, /プレビューを生成しました/, 'プレビュー自体の成功を示す文言');
  assert.match(html, /対象外/);
  assert.match(html, /翌日対象外/, 'reasonCodeのラベルも表示する');
});

test('renderReminderPreviewResult_: eligible:trueの場合は「対象」と表示する', function () {
  var sandbox = loadClientSandbox();
  var html = sandbox.renderReminderPreviewResult_({
    success: true,
    targetDate: '2026-10-02',
    subject: 'subject',
    body: 'body',
    recipientEmail: 'taro@example.com',
    testRecipientEmail: 'admin@example.com',
    revealed: false,
    eligible: true,
    reasonCode: 'ELIGIBLE'
  });

  assert.match(html, /プレビューを生成しました/);
  assert.match(html, /対象（本番なら送信されます）/);
});

test('resetReminderDiagDisplay_: 結果表示と「解錠コードを表示する」チェックをリセットする', function () {
  var sandbox = loadClientSandbox();
  sandbox.openReminderDiagnostics_();
  sandbox.reminderDiagState_.resultEl.innerHTML = '<p>前回の結果（解錠コード表示中）</p>';
  sandbox.reminderDiagState_.revealInput.checked = true;

  sandbox.resetReminderDiagDisplay_();

  assert.strictEqual(sandbox.reminderDiagState_.resultEl.innerHTML, '');
  assert.strictEqual(sandbox.reminderDiagState_.revealInput.checked, false);
});

test('closeReminderDiagnostics_: モーダルを閉じると表示状態もリセットされる（次回開いたときに前回の解錠コード表示が残らない）', function () {
  var sandbox = loadClientSandbox();
  sandbox.openReminderDiagnostics_();
  sandbox.reminderDiagState_.resultEl.innerHTML = '<p>前回の結果（解錠コード表示中）</p>';
  sandbox.reminderDiagState_.revealInput.checked = true;

  sandbox.closeReminderDiagnostics_();

  assert.strictEqual(sandbox.reminderDiagState_.resultEl.innerHTML, '');
  assert.strictEqual(sandbox.reminderDiagState_.revealInput.checked, false);
});

/* ---------- PRレビュー対応: 診断モーダルの非同期レスポンス制御・二重実行防止 ---------- */

test('診断（判定）: 古いリクエストの成功応答が後から返っても、新しいリクエストの表示を上書きしない', function () {
  var sandbox = loadClientSandbox();
  sandbox.openReminderDiagnostics_();
  sandbox.google.script.run.calls.length = 0;
  var state = sandbox.reminderDiagState_;
  var calls = sandbox.google.script.run.calls;

  state.bookingIdInput.value = 'BOOKING-A';
  state.evaluateButton.fire('click');
  assert.strictEqual(calls.length, 1);

  /* 予約IDを変更（リクエスト連番が進み、表示もクリアされる）。 */
  state.bookingIdInput.value = 'BOOKING-B';
  state.bookingIdInput.fire('input');
  state.evaluateButton.fire('click');
  assert.strictEqual(calls.length, 2);
  assert.strictEqual(calls[0].args[0], 'BOOKING-A');
  assert.strictEqual(calls[1].args[0], 'BOOKING-B');

  /* 新しい方（BOOKING-B）の応答が先に返る。 */
  sandbox.google.script.run.resolveCall(1, {
    success: true, eligible: true, reasonCode: 'ELIGIBLE', targetDate: '2026-10-02',
    message: 'ok', booking: { brand: 'studio_x', status: 'CONFIRMED', date: '2026-10-02', email: 'b@example.com' }
  });
  assert.match(state.resultEl.innerHTML, /b@example\.com/);

  /* 古い方（BOOKING-A）の応答が後から返っても、表示は上書きされない。 */
  sandbox.google.script.run.resolveCall(0, {
    success: true, eligible: true, reasonCode: 'ELIGIBLE', targetDate: '2026-10-02',
    message: 'ok', booking: { brand: 'studio_x', status: 'CONFIRMED', date: '2026-10-02', email: 'a@example.com' }
  });
  assert.match(state.resultEl.innerHTML, /b@example\.com/, '古いリクエストの応答で上書きされてはいけない');
  assert.strictEqual(state.resultEl.innerHTML.indexOf('a@example.com'), -1);
});

test('診断（判定）: 古いリクエストの失敗応答（withFailureHandler相当）が後から返っても、新しいリクエストの表示を上書きしない', function () {
  var sandbox = loadClientSandbox();
  sandbox.openReminderDiagnostics_();
  sandbox.google.script.run.calls.length = 0;
  var state = sandbox.reminderDiagState_;
  var scriptRun = sandbox.google.script.run;

  state.bookingIdInput.value = 'BOOKING-A';
  state.evaluateButton.fire('click');
  state.bookingIdInput.value = 'BOOKING-B';
  state.bookingIdInput.fire('input');
  state.evaluateButton.fire('click');

  scriptRun.resolveCall(1, { success: false, error: { code: 'NOT_FOUND', message: 'not found' } });
  assert.match(state.resultEl.innerHTML, /判定できませんでした/);

  /* 古いリクエスト（0番目）が想定外の例外でwithFailureHandlerを呼んでも、
     resultElは新しい応答の表示のまま変わらない。 */
  var beforeReject = state.resultEl.innerHTML;
  scriptRun.rejectCall(0, { message: 'leak@example.com should not appear' });
  assert.strictEqual(state.resultEl.innerHTML, beforeReject);
});

test('診断（プレビュー）: 基準日を変更すると結果欄が即座にクリアされ、その後に古いプレビュー応答が返っても再表示されない', function () {
  var sandbox = loadClientSandbox();
  sandbox.openReminderDiagnostics_();
  sandbox.google.script.run.calls.length = 0;
  var state = sandbox.reminderDiagState_;
  var scriptRun = sandbox.google.script.run;

  state.bookingIdInput.value = 'SX-BOOKING';
  state.baseDateInput.value = '2026-10-01';
  state.previewButton.fire('click');
  assert.strictEqual(scriptRun.calls.length, 1);

  /* 基準日を変更すると、応答を待たずに即座に結果欄がクリアされる（PRレビュー
     再対応。以前は連番だけ進めて表示はそのまま残していたが、解錠コード入りの
     プレビューを表示済みの状態だと実値が画面に残ってしまうため仕様変更した）。 */
  state.baseDateInput.value = '2026-10-05';
  state.baseDateInput.fire('input');
  assert.strictEqual(state.resultEl.innerHTML, '', '基準日変更で結果欄が即座にクリアされるべき');

  /* 変更前に発行したプレビュー応答が後から返っても、再表示されない。 */
  scriptRun.resolveCall(0, {
    success: true, targetDate: '2026-10-02', subject: 'stale subject', body: 'stale body',
    recipientEmail: 'x@example.com', testRecipientEmail: 'admin@example.com', revealed: false,
    eligible: true, reasonCode: 'ELIGIBLE'
  });
  assert.strictEqual(state.resultEl.innerHTML, '', '基準日変更前の古い応答で表示を更新してはいけない');
});

test('診断（プレビュー）: 「解錠コードを表示する」チェックの変更後に古いプレビュー応答が返っても表示を上書きしない（結果欄は即座にクリアされる）', function () {
  var sandbox = loadClientSandbox();
  sandbox.openReminderDiagnostics_();
  sandbox.google.script.run.calls.length = 0;
  var state = sandbox.reminderDiagState_;
  var scriptRun = sandbox.google.script.run;

  state.bookingIdInput.value = 'SX-BOOKING';
  state.baseDateInput.value = '2026-10-01';
  state.previewButton.fire('click');

  state.revealInput.checked = true;
  state.revealInput.fire('change');
  assert.strictEqual(state.resultEl.innerHTML, '', 'reveal変更で結果欄が即座にクリアされるべき');

  scriptRun.resolveCall(0, {
    success: true, targetDate: '2026-10-02', subject: 'stale', body: 'stale (masked)',
    recipientEmail: 'x@example.com', testRecipientEmail: 'admin@example.com', revealed: false,
    eligible: true, reasonCode: 'ELIGIBLE'
  });
  assert.strictEqual(state.resultEl.innerHTML, '', 'reveal変更前の古い応答で表示を更新してはいけない');
});

/* ---------- PRレビュー再対応: 表示済みの秘密値の即時消去 ---------- */

test('プレビューで解錠コードを表示済みの状態から「表示する」チェックをOFFにすると、実値が即座にDOMから消える', function () {
  var sandbox = loadClientSandbox();
  sandbox.openReminderDiagnostics_();
  sandbox.google.script.run.calls.length = 0;
  var state = sandbox.reminderDiagState_;
  var scriptRun = sandbox.google.script.run;

  state.bookingIdInput.value = 'SX-BOOKING';
  state.baseDateInput.value = '2026-10-01';
  state.revealInput.checked = true;
  state.previewButton.fire('click');

  scriptRun.resolveCall(0, {
    success: true, targetDate: '2026-10-02', subject: '【Studio X】明日のご利用案内',
    body: 'キーボックス番号: REAL-KEYBOX\n解錠コード: REAL-CODE',
    recipientEmail: 'taro@example.com', testRecipientEmail: 'admin@example.com', revealed: true,
    eligible: true, reasonCode: 'ELIGIBLE'
  });
  assert.match(state.resultEl.innerHTML, /REAL-KEYBOX/, '前提: 実値入りのプレビューが表示されていること');
  assert.match(state.resultEl.innerHTML, /REAL-CODE/);

  /* チェックをOFFにする。 */
  state.revealInput.checked = false;
  state.revealInput.fire('change');

  assert.strictEqual(state.resultEl.innerHTML.indexOf('REAL-KEYBOX'), -1, 'チェックOFF後にキーボックス番号の実値がDOMに残ってはいけない');
  assert.strictEqual(state.resultEl.innerHTML.indexOf('REAL-CODE'), -1, 'チェックOFF後に解錠コードの実値がDOMに残ってはいけない');
  assert.strictEqual(state.resultEl.innerHTML, '');
});

test('プレビューで解錠コードを表示済みの状態から基準日を変更すると、古い本文（実値を含む）が即座に消える', function () {
  var sandbox = loadClientSandbox();
  sandbox.openReminderDiagnostics_();
  sandbox.google.script.run.calls.length = 0;
  var state = sandbox.reminderDiagState_;
  var scriptRun = sandbox.google.script.run;

  state.bookingIdInput.value = 'SX-BOOKING';
  state.baseDateInput.value = '2026-10-01';
  state.revealInput.checked = true;
  state.previewButton.fire('click');

  scriptRun.resolveCall(0, {
    success: true, targetDate: '2026-10-02', subject: 'subject',
    body: 'キーボックス番号: REAL-KEYBOX\n解錠コード: REAL-CODE',
    recipientEmail: 'taro@example.com', testRecipientEmail: 'admin@example.com', revealed: true,
    eligible: true, reasonCode: 'ELIGIBLE'
  });
  assert.match(state.resultEl.innerHTML, /REAL-CODE/, '前提: 実値入りのプレビューが表示されていること');

  state.baseDateInput.value = '2026-10-08';
  state.baseDateInput.fire('input');

  assert.strictEqual(state.resultEl.innerHTML.indexOf('REAL-KEYBOX'), -1, '基準日変更後にキーボックス番号の実値が残ってはいけない');
  assert.strictEqual(state.resultEl.innerHTML.indexOf('REAL-CODE'), -1, '基準日変更後に解錠コードの実値が残ってはいけない');
  assert.strictEqual(state.resultEl.innerHTML, '');
});

test('実値入りのプレビュー表示後にrevealをOFFにし、その後に古い（表示済みと同じ）応答が届いても秘密値は再表示されない', function () {
  var sandbox = loadClientSandbox();
  sandbox.openReminderDiagnostics_();
  sandbox.google.script.run.calls.length = 0;
  var state = sandbox.reminderDiagState_;
  var scriptRun = sandbox.google.script.run;

  state.bookingIdInput.value = 'SX-BOOKING';
  state.baseDateInput.value = '2026-10-01';
  state.revealInput.checked = true;
  state.previewButton.fire('click'); /* calls[0]: reveal=true */

  var staleResult = {
    success: true, targetDate: '2026-10-02', subject: 'subject',
    body: 'キーボックス番号: REAL-KEYBOX\n解錠コード: REAL-CODE',
    recipientEmail: 'taro@example.com', testRecipientEmail: 'admin@example.com', revealed: true,
    eligible: true, reasonCode: 'ELIGIBLE'
  };

  /* チェックをOFFにしてから、直前のリクエスト（reveal=trueで発行済み）の
     応答が遅れて届いたと仮定する。 */
  state.revealInput.checked = false;
  state.revealInput.fire('change');
  scriptRun.resolveCall(0, staleResult);

  assert.strictEqual(state.resultEl.innerHTML.indexOf('REAL-KEYBOX'), -1, '古い応答で秘密値が再表示されてはいけない');
  assert.strictEqual(state.resultEl.innerHTML.indexOf('REAL-CODE'), -1);
  assert.strictEqual(state.resultEl.innerHTML, '');
});

test('チェックを再度ONにしても、以前（OFFにする前）の結果は復活しない', function () {
  var sandbox = loadClientSandbox();
  sandbox.openReminderDiagnostics_();
  sandbox.google.script.run.calls.length = 0;
  var state = sandbox.reminderDiagState_;
  var scriptRun = sandbox.google.script.run;

  state.bookingIdInput.value = 'SX-BOOKING';
  state.baseDateInput.value = '2026-10-01';
  state.revealInput.checked = true;
  state.previewButton.fire('click');
  scriptRun.resolveCall(0, {
    success: true, targetDate: '2026-10-02', subject: 'subject',
    body: 'キーボックス番号: REAL-KEYBOX\n解錠コード: REAL-CODE',
    recipientEmail: 'taro@example.com', testRecipientEmail: 'admin@example.com', revealed: true,
    eligible: true, reasonCode: 'ELIGIBLE'
  });
  assert.match(state.resultEl.innerHTML, /REAL-CODE/);

  state.revealInput.checked = false;
  state.revealInput.fire('change');
  assert.strictEqual(state.resultEl.innerHTML, '');

  /* 再度ONにしても、新しいプレビューを実行していない限り何も表示されない
     （以前の結果がキャッシュ等から復活しない）。 */
  state.revealInput.checked = true;
  state.revealInput.fire('change');

  assert.strictEqual(state.resultEl.innerHTML, '', 'チェックを再度ONにしただけで以前の結果が復活してはいけない');
  assert.strictEqual(state.resultEl.innerHTML.indexOf('REAL-CODE'), -1);
});

test('診断: モーダルを閉じた後に発行済みリクエストの応答が返っても表示を更新しない', function () {
  var sandbox = loadClientSandbox();
  sandbox.openReminderDiagnostics_();
  sandbox.google.script.run.calls.length = 0;
  var state = sandbox.reminderDiagState_;
  var scriptRun = sandbox.google.script.run;

  state.bookingIdInput.value = 'SX-BOOKING';
  state.baseDateInput.value = '2026-10-01';
  state.evaluateButton.fire('click');

  sandbox.closeReminderDiagnostics_();
  assert.strictEqual(state.resultEl.innerHTML, '', '閉じた時点でリセットされている');

  scriptRun.resolveCall(0, {
    success: true, eligible: true, reasonCode: 'ELIGIBLE', targetDate: '2026-10-02',
    message: 'ok', booking: { brand: 'studio_x', status: 'CONFIRMED', date: '2026-10-02', email: 'late@example.com' }
  });
  assert.strictEqual(state.resultEl.innerHTML, '', '閉じた後に返った応答で表示を更新してはいけない');
});

test('テスト送信: 応答が返るまではボタンがdisabledのまま二重実行できず、成功後に再度実行できる状態へ復旧する', function () {
  var sandbox = loadClientSandbox({ confirmResult: true });
  sandbox.openReminderDiagnostics_();
  sandbox.google.script.run.calls.length = 0;
  var state = sandbox.reminderDiagState_;
  var scriptRun = sandbox.google.script.run;

  state.bookingIdInput.value = 'SX-BOOKING';
  state.baseDateInput.value = '2026-10-01';

  state.sendTestButton.fire('click');
  assert.strictEqual(scriptRun.calls.length, 1, '1回目は実行される');
  assert.strictEqual(state.sendTestButton.disabled, true, '応答が返るまではdisabledにする');
  assert.strictEqual(state.sendTestInFlight, true);

  /* 応答が返る前に連打しても2回目は実行されない（二重実行防止）。 */
  state.sendTestButton.fire('click');
  assert.strictEqual(scriptRun.calls.length, 1, '応答が返るまでは2回目のクリックを無視する');

  scriptRun.resolveCall(0, { success: true, sentTo: 'admin@example.com' });

  assert.strictEqual(state.sendTestButton.disabled, false, '応答が返ったら再度実行できる状態へ戻す');
  assert.match(state.resultEl.innerHTML, /admin@example\.com/);

  /* busy状態が解除されているため、再度クリックすれば新しいリクエストが発行される。 */
  state.sendTestButton.fire('click');
  assert.strictEqual(scriptRun.calls.length, 2, '完了後は再度実行できる');
});

test('テスト送信: 想定外の失敗（withFailureHandler相当）が返ってもbusyを解除し、再度実行できる状態へ復旧する', function () {
  var sandbox = loadClientSandbox({ confirmResult: true });
  sandbox.openReminderDiagnostics_();
  sandbox.google.script.run.calls.length = 0;
  var state = sandbox.reminderDiagState_;
  var scriptRun = sandbox.google.script.run;

  state.bookingIdInput.value = 'SX-BOOKING';
  state.baseDateInput.value = '2026-10-01';
  state.sendTestButton.fire('click');
  assert.strictEqual(state.sendTestButton.disabled, true);

  scriptRun.rejectCall(0, { message: 'unexpected failure' });

  assert.strictEqual(state.sendTestButton.disabled, false, '失敗時もbusyを解除して再実行できるようにする');
  assert.match(state.resultEl.innerHTML, /テスト送信できませんでした/);

  state.sendTestButton.fire('click');
  assert.strictEqual(scriptRun.calls.length, 2);
});

test('テスト送信: 確認ダイアログでキャンセルした場合はリクエストを発行せず、busyにもしない', function () {
  var sandbox = loadClientSandbox({ confirmResult: false });
  sandbox.openReminderDiagnostics_();
  sandbox.google.script.run.calls.length = 0;
  var state = sandbox.reminderDiagState_;

  state.bookingIdInput.value = 'SX-BOOKING';
  state.baseDateInput.value = '2026-10-01';
  state.sendTestButton.fire('click');

  assert.strictEqual(sandbox.google.script.run.calls.length, 0);
  assert.strictEqual(state.sendTestButton.disabled, false);
});

test('テスト送信: 古いテスト送信応答が返っても、その間に発行された判定の表示を上書きしない', function () {
  var sandbox = loadClientSandbox({ confirmResult: true });
  sandbox.openReminderDiagnostics_();
  sandbox.google.script.run.calls.length = 0;
  var state = sandbox.reminderDiagState_;
  var scriptRun = sandbox.google.script.run;

  state.bookingIdInput.value = 'SX-BOOKING';
  state.baseDateInput.value = '2026-10-01';
  state.sendTestButton.fire('click');
  assert.strictEqual(scriptRun.calls.length, 1);

  /* テスト送信の応答を待っている間に、判定を実行する（別のリクエスト）。 */
  state.evaluateButton.fire('click');
  assert.strictEqual(scriptRun.calls.length, 2);

  scriptRun.resolveCall(1, {
    success: true, eligible: true, reasonCode: 'ELIGIBLE', targetDate: '2026-10-02',
    message: 'ok', booking: { brand: 'studio_x', status: 'CONFIRMED', date: '2026-10-02', email: 'new@example.com' }
  });
  assert.match(state.resultEl.innerHTML, /new@example\.com/);

  /* テスト送信（古い方）の応答が後から返っても、判定結果の表示を上書きしない。
     ただしbusy状態自体はこの応答で正しく解除される。 */
  scriptRun.resolveCall(0, { success: true, sentTo: 'admin@example.com' });
  assert.match(state.resultEl.innerHTML, /new@example\.com/, 'テスト送信の古い応答で判定結果を上書きしてはいけない');
  assert.strictEqual(state.sendTestButton.disabled, false, 'テスト送信自体のbusyは応答が返った時点で解除する');
});

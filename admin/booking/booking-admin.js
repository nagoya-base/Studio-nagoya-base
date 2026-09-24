/*
 * booking-admin.js — Booking Admin Web UI（Issue #305）のクライアント側ロジック。
 * Issue #317でBookingAdminPage.html（gas/booking/admin/）のインラインJavaScriptから
 * このファイルへ外部化した。GitHub Pages（admin/booking/booking-admin.js）から配信し、
 * BookingAdminPage.html側のローダーが実行時にキャッシュ回避クエリ付きで動的に読み込む。
 *
 * BookingAdminPage.html（GAS HtmlService）が提供するDOM（header/tabs/sort-select/
 * main/list/modal-overlay等。id/class名は変更していない）とgoogle.script.run
 * （getAdminBookings/getAdminBookingDetail/adminConfirmBooking/adminCancelBooking。
 * いずれも既存のBookingAdminWeb.gs API）にのみ依存する。ロジック自体はIssue #305時点から
 * 変更していない（customerTypeの表示ラベル変換を含む）。
 *
 * 表示文言・カードUI・ソートUI等、通常のフロントエンド変更はこのファイルと
 * booking-admin.cssの更新のみで反映でき、GAS Web Appの再デプロイは不要
 * （BookingAdminPage.html自体・google.script.run APIを変更しない限り）。
 *
 * Issue #322で、個人運用しやすいダッシュボードUI（ヘッダー・件数サマリー・
 * タブ件数・クライアント側検索・カードレイアウト刷新）を追加した。
 * BookingAdminPage.htmlはこのIssueでも変更していないため、ヘッダー内の見出し・
 * 最終更新表示・更新ボタン・件数サマリー・検索欄は、いずれもこのファイルが
 * 起動時にDOM要素を生成してheader/main配下へ挿入する（固定HTML側にはid/要素を
 * 追加していない）。google.script.run APIは追加していない（最終更新時刻は
 * 端末ローカル時刻をそのまま表示するだけで、JST統一のための新規呼び出しはしない）。
 */
var state = {
  bookings: [],
  todayJst: null,
  filter: 'today',
  sort: 'date',
  searchQuery: '',
  busyIds: {}
};

/* サーバー側（BookingAdminWeb.gs）がAsia/Tokyo基準で正規化した文字列をそのまま
   表示する。startAt/endAtは一覧では'HH:mm'、詳細では'YYYY-MM-DD HH:mm'として
   既にサーバー側で整形済み（google.script.run越しにDateオブジェクトを渡さない）。 */
var DETAIL_FIELDS = [
  ['bookingId', 'bookingId'],
  ['date', '利用日'],
  ['startAt', '開始'],
  ['endAt', '終了'],
  ['brand', 'ブランド'],
  ['status', 'ステータス'],
  ['name', '氏名'],
  ['email', 'メール'],
  ['phone', '電話'],
  ['people', '人数'],
  ['customerType', '利用区分'],
  ['purpose', '利用目的'],
  ['paymentMethod', '支払方法'],
  ['source', '受付経路'],
  ['note', '備考'],
  ['pendingMailSentAt', '仮予約メール送信'],
  ['confirmedMailSentAt', '確定メール送信'],
  ['cancelMailSentAt', 'キャンセルメール送信'],
  ['reminderSentAt', '前日リマインド送信'],
  ['accessGuideSentAt', '来場案内送信'],
  ['hasMailError', 'メールエラー']
];

/* customerTypeの内部値（Booking.gsのCUSTOMER_TYPES）を表示用の日本語ラベルへ
   変換するだけの関数。内部値・Spreadsheet保存値・APIレスポンスは変更しない
   （表示直前にのみ変換する）。未知の値が来ても例外にせず元値をそのまま返す。 */
function customerTypeLabel(value) {
  if (value === 'first_time') return '初回利用';
  if (value === 'returning') return '利用経験あり';
  return value || '';
}

/* brand（Booking.gs側の内部値）を表示用の日本語/英語ラベルへ変換するだけの関数
   （Issue #322 要件5）。customerTypeLabelと同じ方針で、内部値・保存値・APIレス
   ポンスは変更せず、表示直前にのみ変換する。未知の値は例外にせず元値を返す。 */
function brandLabel(value) {
  if (value === 'snb') return 'SNB';
  if (value === 'mens') return 'SNB mens';
  if (value === 'studio_x') return 'Studio X';
  return value || '';
}

/* statusの内部値（PENDING/CONFIRMED/CANCELLED/EXPIRED）を表示用の日本語ラベルへ
   変換するだけの関数（Issue #322 要件5）。customerTypeLabel/brandLabelと同じ方針。
   バッジのCSSクラス（badge-PENDING等）は内部値のまま使うため、ここでは表示文言のみ
   変える。 */
function statusLabel(value) {
  if (value === 'PENDING') return '仮受付';
  if (value === 'CONFIRMED') return '確定';
  if (value === 'CANCELLED') return 'キャンセル';
  if (value === 'EXPIRED') return '期限切れ';
  return value || '';
}

/* hasMailErrorのみ真偽値、customerType/brand/statusのみ表示用ラベルへ変換、
   それ以外はサーバー側で整形済みの文字列（空文字列＝未設定）。
   lastMailError*の詳細（内容・種別・日時）はWeb UIへは出さない（障害調査は
   Spreadsheetを直接確認する運用のまま。BookingAdminWeb.gs参照）。 */
function formatValue(key, value) {
  if (key === 'hasMailError') return value ? 'あり' : 'なし';
  if (key === 'customerType') return customerTypeLabel(value) || '（未設定）';
  if (key === 'brand') return brandLabel(value) || '（未設定）';
  if (key === 'status') return statusLabel(value) || '（未設定）';
  if (value === null || value === undefined || value === '') return '（未設定）';
  return String(value);
}

/* 「今日/今後」の判定はtodayJst（サーバーがAsia/Tokyo基準で計算した値。
   getAdminBookingsの応答に含まれる）とbooking.date（同じくJST基準の
   'YYYY-MM-DD'）の単純な文字列比較で行う。端末のtimezone設定には一切依存しない。
   CANCELLEDは「今日」「今後」には出さず、日付を問わず「キャンセル」タブへ集約する
   （EXPIREDはここに含めない。「すべて」で確認できれば十分という要件のため）。
   Issue #322で件数サマリー・タブ件数（computeSummaryCounts/computeTabCounts）にも
   同じ判定を使うため、stateに依存しない純粋関数として切り出した（DOM操作からも
   分離しているため、この関数単体を直接テストできる）。 */
function filterBookingsByTab(bookings, filter, todayJst) {
  var today = todayJst;
  return bookings.filter(function (b) {
    if (filter === 'all') return true;
    if (filter === 'cancelled') return b.status === 'CANCELLED';
    if (!today) return true;
    if (filter === 'today') return b.date === today && b.status !== 'CANCELLED';
    if (filter === 'upcoming') return b.date >= today && b.status !== 'CANCELLED';
    return true;
  });
}

/* 現在のstate（filter/todayJst）に対してfilterBookingsByTabを適用するだけの
   薄いラッパー。既存の呼び出し側（visibleBookings）はこの関数名のまま使い続ける。 */
function filteredBookings() {
  return filterBookingsByTab(state.bookings, state.filter, state.todayJst);
}

/* 「日付順」: date昇順、同一日はstartAt昇順（デフォルト）。date/startAtはいずれも
   サーバー側で'YYYY-MM-DD'/'HH:mm'の文字列へ正規化済みのため、単純な文字列比較で
   時系列順になる。 */
function compareByDate_(a, b) {
  if (a.date !== b.date) return a.date < b.date ? -1 : 1;
  if (a.startAt !== b.startAt) return a.startAt < b.startAt ? -1 : 1;
  return 0;
}

/* 「予約順」: createdAt降順（新しく予約されたものを上）。createdAtが同じ場合は
   bookingIdの昇順で安定させる（要件どおり、createdAt同値の順序はbookingIdで決めてよい）。 */
function compareByReservation_(a, b) {
  var aCreatedAt = a.createdAt || '';
  var bCreatedAt = b.createdAt || '';
  if (aCreatedAt !== bCreatedAt) return aCreatedAt < bCreatedAt ? 1 : -1;
  if (a.bookingId !== b.bookingId) return a.bookingId < b.bookingId ? -1 : 1;
  return 0;
}

function sortBookings(bookings) {
  var comparator = state.sort === 'reservation' ? compareByReservation_ : compareByDate_;
  return bookings.slice().sort(comparator);
}

/* Issue #322のクライアント側検索。対象候補は氏名/bookingId/利用目的/日付/ブランド/
   customerType/支払方法/status（要件どおり。サーバーAPI・Spreadsheet検索APIは
   追加しない、クライアント側のみの単純な部分一致）。ブランド/customerType/status
   は内部値だけでなく表示ラベル（brandLabel/customerTypeLabel/statusLabel）でも
   一致させる。カード・詳細モーダルに表示されるのはラベルのため、画面に見えている
   文字列で検索できないと使いづらいことに対応するだけで、対象フィールド自体は
   要件の候補から増やしていない。 */
function normalizeSearchText_(value) {
  return String(value === null || value === undefined ? '' : value).toLowerCase();
}

function bookingSearchHaystack_(b) {
  return [
    b.bookingId,
    b.name,
    b.purpose,
    b.date,
    b.brand,
    brandLabel(b.brand),
    b.customerType,
    customerTypeLabel(b.customerType),
    b.paymentMethod,
    b.status,
    statusLabel(b.status)
  ].map(normalizeSearchText_).join(' ');
}

/* DOM（検索input）から分離した純粋関数。空・空白のみのqueryは絞り込みなし
   （元のbookingsをそのまま返す）。 */
function filterBySearch(bookings, query) {
  var q = normalizeSearchText_(query).trim();
  if (!q) return bookings;
  return bookings.filter(function (b) {
    return bookingSearchHaystack_(b).indexOf(q) !== -1;
  });
}

/* filter → search → sortの順（要件どおり）。タブ切り替え・検索入力・ソート切り替え
   のいずれからもrender()経由でこの関数だけを呼べばよいようにしている。
   件数サマリー・タブ件数（computeSummaryCounts/computeTabCounts）は検索クエリの
   影響を受けない仕様のため、意図的にstate.bookings全件を別ルートで集計する
   （このvisibleBookings()の結果を使い回さない）。 */
function visibleBookings() {
  return sortBookings(filterBySearch(filteredBookings(), state.searchQuery));
}

/* 予約サマリー（要件2: 今日/仮受付(PENDING)/確定(CONFIRMED)/全件）の集計。
   検索クエリ・現在のタブ選択のいずれにも影響されず、常にbookings全件ベースで
   計算する（要件どおり）。DOM操作から分離した純粋関数として実装し、直接テスト
   できるようにしている。 */
function computeSummaryCounts(bookings, todayJst) {
  var list = bookings || [];
  return {
    today: filterBookingsByTab(list, 'today', todayJst).length,
    pending: list.filter(function (b) { return b.status === 'PENDING'; }).length,
    confirmed: list.filter(function (b) { return b.status === 'CONFIRMED'; }).length,
    all: list.length
  };
}

/* 既存4タブ（今日/今後/キャンセル/すべて）それぞれの件数。サマリーと同様、
   検索クエリの影響を受けず全件ベースで計算する純粋関数。 */
function computeTabCounts(bookings, todayJst) {
  return {
    today: filterBookingsByTab(bookings, 'today', todayJst).length,
    upcoming: filterBookingsByTab(bookings, 'upcoming', todayJst).length,
    cancelled: filterBookingsByTab(bookings, 'cancelled', todayJst).length,
    all: filterBookingsByTab(bookings, 'all', todayJst).length
  };
}

function setStatusLine(message) {
  document.getElementById('status-line').textContent = message || '';
}

function setElementText_(id, text) {
  document.getElementById(id).textContent = text;
}

/* 予約サマリー（要件2）のDOM反映のみを担当。集計自体はcomputeSummaryCountsで行う。 */
function renderSummary() {
  var counts = computeSummaryCounts(state.bookings, state.todayJst);
  setElementText_('summary-today-count', String(counts.today));
  setElementText_('summary-pending-count', String(counts.pending));
  setElementText_('summary-confirmed-count', String(counts.confirmed));
  setElementText_('summary-all-count', String(counts.all));
}

/* 各タブの件数（要件3）のDOM反映のみを担当。集計自体はcomputeTabCountsで行う。
   タブ本体（ボタン要素）はBookingAdminPage.html側の固定DOMのため、件数表示用の
   子要素はinitTabCountsUi()が初回に生成する。 */
function renderTabCounts() {
  var counts = computeTabCounts(state.bookings, state.todayJst);
  setElementText_('tab-count-today', String(counts.today));
  setElementText_('tab-count-upcoming', String(counts.upcoming));
  setElementText_('tab-count-cancelled', String(counts.cancelled));
  setElementText_('tab-count-all', String(counts.all));
}

function render() {
  renderSummary();
  renderTabCounts();

  var list = document.getElementById('list');
  var bookings = visibleBookings();
  if (bookings.length === 0) {
    list.innerHTML = '<div class="empty">該当する予約がありません</div>';
    return;
  }

  list.innerHTML = bookings.map(function (b) {
    var busy = !!state.busyIds[b.bookingId];
    var canConfirm = b.status === 'PENDING';
    var canCancel = b.status === 'PENDING' || b.status === 'CONFIRMED';
    var actions = '<button type="button" class="action detail" data-action="detail" data-id="' + escapeHtml(b.bookingId) + '">詳細</button>';
    if (canConfirm) {
      actions += '<button type="button" class="action confirm" data-action="confirm" data-id="' + escapeHtml(b.bookingId) + '"' + (busy ? ' disabled' : '') + '>確定</button>';
    }
    if (canCancel) {
      actions += '<button type="button" class="action cancel" data-action="cancel" data-id="' + escapeHtml(b.bookingId) + '"' + (busy ? ' disabled' : '') + '>キャンセル</button>';
    }

    return (
      '<div class="card">' +
        '<div class="card-top">' +
          '<span class="card-brand">' + escapeHtml(brandLabel(b.brand)) + '</span>' +
          '<span class="badge badge-' + escapeHtml(b.status) + '">' + escapeHtml(statusLabel(b.status)) + '</span>' +
        '</div>' +
        '<div class="card-datetime">' + escapeHtml(b.date) + ' ' + escapeHtml(b.startAt) + '-' + escapeHtml(b.endAt) + '</div>' +
        '<div class="card-name">' + escapeHtml(b.name) + '</div>' +
        '<div class="card-meta">' + escapeHtml(b.people) + ' / ' + escapeHtml(customerTypeLabel(b.customerType)) + '</div>' +
        '<div class="card-sub">' + escapeHtml(b.paymentMethod) + ' ・ ' + escapeHtml(b.purpose) + '</div>' +
        '<div class="card-id">' + escapeHtml(b.bookingId) + '</div>' +
        '<div class="card-actions">' + actions + '</div>' +
      '</div>'
    );
  }).join('');
}

function escapeHtml(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/* 端末ローカル時刻をそのまま'HH:mm:ss'で表示するだけ（要件: 最終更新時刻は端末
   ローカル時刻でよく、JST統一のための新規API呼び出しは追加しない）。 */
function formatLocalTime_(date) {
  function pad(n) { return n < 10 ? '0' + n : String(n); }
  return pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds());
}

function updateLastUpdatedNow_() {
  setElementText_('last-updated', '最終更新: ' + formatLocalTime_(new Date()));
}

/* loadRequestSeqは呼び出しごとに採番し、応答が返ってきた時点で「今なお最新の
   呼び出しか」を確認してから反映する。連打等で複数のgetAdminBookings呼び出しが
   飛び、ネットワークの都合で応答が逆順に返ってきても、古い応答でstateを
   上書きしないようにするためのガード（新しい機能ではなく、単なる採番による
   ガードのみ）。 */
var loadRequestSeq = 0;

/* onDone: このloadBookings呼び出し自身の応答が返ってきた時点で必ず呼ばれる
   コールバック（省略可。応答が古くてstate反映をスキップした場合も呼ぶ）。
   confirm/cancel直後はこのコールバック内でbusy状態を解除することで、
   「自分の呼び出しに対する一覧再取得が完了するまで」ボタンをdisableし続ける。
   ここでonDoneの呼び出し自体を古い応答か否かのガードでskipすると、後発の
   loadBookings呼び出しに追い越された古い呼び出し側のbusyIdsがいつまでも
   残り、該当ボタンが永久にdisableのままになってしまう（PRレビュー対応）。
   手動更新ボタン（Issue #322）もこの関数をそのまま呼ぶだけで、新しいAPI呼び出しは
   追加していない。 */
function loadBookings(onDone) {
  setStatusLine('読み込み中…');
  loadRequestSeq += 1;
  var requestId = loadRequestSeq;
  google.script.run
    .withSuccessHandler(function (result) {
      /* 「今なお最新の呼び出しか」はstateへの反映・再描画・最終更新時刻の更新だけを
         スキップする条件で、onDone（busy解除）は呼び出し元に関わらず必ず実行する。 */
      if (requestId === loadRequestSeq) {
        state.bookings = (result && result.bookings) || [];
        state.todayJst = result && result.todayJst;
        setStatusLine('');
        updateLastUpdatedNow_();
        render();
      }
      if (typeof onDone === 'function') onDone();
    })
    .withFailureHandler(function (error) {
      if (requestId === loadRequestSeq) {
        setStatusLine('読み込みに失敗しました: ' + (error && error.message ? error.message : error));
      }
      if (typeof onDone === 'function') onDone();
    })
    .getAdminBookings();
}

function openDetail(bookingId) {
  setStatusLine('詳細を取得中…');
  google.script.run
    .withSuccessHandler(function (result) {
      setStatusLine('');
      if (!result || !result.success) {
        alert('詳細を取得できませんでした: ' + (result && result.error && result.error.message));
        return;
      }
      showDetailModal(result.booking);
    })
    .withFailureHandler(function (error) {
      setStatusLine('詳細の取得に失敗しました: ' + (error && error.message ? error.message : error));
    })
    .getAdminBookingDetail(bookingId);
}

function showDetailModal(booking) {
  var body = document.getElementById('modal-body');
  body.innerHTML = DETAIL_FIELDS.map(function (pair) {
    var key = pair[0];
    var label = pair[1];
    return '<dt>' + escapeHtml(label) + '</dt><dd>' + escapeHtml(formatValue(key, booking[key])) + '</dd>';
  }).join('');
  document.getElementById('modal-overlay').classList.add('open');
}

function closeModal() {
  document.getElementById('modal-overlay').classList.remove('open');
}

function setBusy(bookingId, busy) {
  if (busy) {
    state.busyIds[bookingId] = true;
  } else {
    delete state.busyIds[bookingId];
  }
  render();
}

/* 確定処理そのものが終わってもbookingIdのbusyはすぐには解除しない。
   loadBookings()が最新一覧を取得・再描画し終えたコールバック内で初めて解除する
   （途中で古い一覧のまま再度「確定」を押せてしまう隙をなくすため）。 */
function runConfirm(bookingId) {
  var booking = state.bookings.find(function (b) { return b.bookingId === bookingId; });
  var confirmed = window.confirm(
    (booking
      ? '予約ID: ' + booking.bookingId + '\n' +
        '利用日: ' + booking.date + ' ' + booking.startAt + '-' + booking.endAt + '\n' +
        '利用者名: ' + booking.name + '\n' +
        'ブランド: ' + booking.brand + '\n' +
        '支払方法: ' + booking.paymentMethod + '\n\n'
      : '') +
    'この予約を確定します。\n\n' +
    'Calendarへ確定反映し、利用者へ予約確定メールを送信します。\n\n' +
    '実行しますか？'
  );
  if (!confirmed) return;

  setBusy(bookingId, true);
  setStatusLine('確定処理中…');
  google.script.run
    .withSuccessHandler(function (result) {
      if (!result || !result.success) {
        alert('確定できませんでした: ' + (result && result.error && result.error.message));
      }
      loadBookings(function () { setBusy(bookingId, false); });
    })
    .withFailureHandler(function (error) {
      alert('確定でエラーが発生しました: ' + (error && error.message ? error.message : error));
      loadBookings(function () { setBusy(bookingId, false); });
    })
    .adminConfirmBooking(bookingId);
}

function runCancel(bookingId) {
  var confirmed = window.confirm(
    'この予約をキャンセルします。\n\n' +
    'Calendarの予約枠を削除し、利用者へキャンセルメールを送信します。\n\n' +
    '実行しますか？'
  );
  if (!confirmed) return;

  setBusy(bookingId, true);
  setStatusLine('キャンセル処理中…');
  google.script.run
    .withSuccessHandler(function (result) {
      if (!result || !result.success) {
        alert('キャンセルできませんでした: ' + (result && result.error && result.error.message));
      }
      loadBookings(function () { setBusy(bookingId, false); });
    })
    .withFailureHandler(function (error) {
      alert('キャンセルでエラーが発生しました: ' + (error && error.message ? error.message : error));
      loadBookings(function () { setBusy(bookingId, false); });
    })
    .adminCancelBooking(bookingId);
}

/* Issue #322: ヘッダー（要件1）・件数サマリー（要件2）・タブ件数（要件3）・
   検索欄（要件4）は、いずれもBookingAdminPage.html側には存在しない要素のため、
   このファイルの初回実行時にDOM要素を生成してheader/main配下へ挿入する
   （BookingAdminPage.htmlは変更しない制約のため）。
   検索input要素は、ここで一度だけ生成してイベントを登録する。render()は
   このinput自体を再生成・再挿入しない（入力中のフォーカス・IME変換状態を
   壊さないための要件どおりの実装）。 */
function initHeaderUi_() {
  var header = document.querySelector('header');
  var h1 = document.querySelector('header h1');
  if (h1) h1.textContent = 'Studio Nagoya Base / 予約管理';

  var metaRow = document.createElement('div');
  metaRow.className = 'header-meta';

  var lastUpdated = document.createElement('span');
  lastUpdated.id = 'last-updated';
  lastUpdated.className = 'last-updated';
  metaRow.appendChild(lastUpdated);

  var refreshButton = document.createElement('button');
  refreshButton.type = 'button';
  refreshButton.id = 'refresh-button';
  refreshButton.className = 'refresh-button';
  refreshButton.textContent = '更新';
  metaRow.appendChild(refreshButton);

  var summaryRow = document.createElement('div');
  summaryRow.className = 'summary';
  summaryRow.innerHTML =
    '<div class="summary-item"><span class="summary-label">今日</span><span class="summary-count" id="summary-today-count">0</span></div>' +
    '<div class="summary-item"><span class="summary-label">仮受付</span><span class="summary-count" id="summary-pending-count">0</span></div>' +
    '<div class="summary-item"><span class="summary-label">確定</span><span class="summary-count" id="summary-confirmed-count">0</span></div>' +
    '<div class="summary-item"><span class="summary-label">全件</span><span class="summary-count" id="summary-all-count">0</span></div>';

  var tabsDiv = document.querySelector('.tabs');
  header.insertBefore(metaRow, tabsDiv);
  header.insertBefore(summaryRow, tabsDiv);

  refreshButton.addEventListener('click', function () {
    refreshButton.disabled = true;
    loadBookings(function () {
      refreshButton.disabled = false;
    });
  });

  /* Issue #330: 前日リマインド診断を開くボタン。一覧・確定・キャンセルとは独立した
     機能のため、既存のsummary/tabsとは別に更新ボタンの隣へ追加するのみで、
     既存要素・既存のgoogle.script.run呼び出し配線は変更しない。 */
  var reminderDiagButton = document.createElement('button');
  reminderDiagButton.type = 'button';
  reminderDiagButton.id = 'reminder-diag-open-button';
  reminderDiagButton.className = 'refresh-button';
  reminderDiagButton.textContent = '前日リマインド診断';
  metaRow.appendChild(reminderDiagButton);

  reminderDiagButton.addEventListener('click', openReminderDiagnostics_);
}

/*
 * Issue #330: 前日リマインド診断の理由コード（BookingMailer.gsの
 * REMINDER_REASON_CODESと同じ値）を表示用の日本語ラベルへ変換するだけの関数
 * （customerTypeLabel/brandLabel/statusLabelと同じ方針。内部値・APIレスポンスは
 * 変更せず、表示直前にのみ変換する）。未知の値は例外にせず元値を返す。
 */
function reminderReasonLabel(code) {
  var labels = {
    ELIGIBLE: '送信対象',
    NOT_NEXT_DAY: '翌日対象外',
    INVALID_STATUS: '対象外ステータス',
    ALREADY_SENT: '送信済み',
    EMAIL_MISSING: 'メール未登録',
    MAIL_NOT_READY: '設定不足'
  };
  return labels[code] || code || '';
}

/*
 * 診断結果（diagnoseReminderEligibilityのレスポンス）から結果表示欄のHTMLを組み立てる
 * 純粋関数（DOM操作から分離し、単体テスト可能にする）。宛先表示は予約者の
 * メールアドレスとテスト送信先を区別する要件（Issue #330）のため、それぞれ別の行で表示する。
 */
function renderReminderDiagnosisResult_(result) {
  if (!result || !result.success) {
    return '<p class="reminder-diag-error">判定できませんでした: ' + escapeHtml((result && result.error && result.error.message) || '') + '</p>';
  }
  var booking = result.booking || {};
  return (
    '<dl class="reminder-diag-dl">' +
    '<dt>判定</dt><dd>' + escapeHtml(result.eligible ? '送信対象' : '対象外') + '（' + escapeHtml(reminderReasonLabel(result.reasonCode)) + '）</dd>' +
    '<dt>翌日（対象日）</dt><dd>' + escapeHtml(result.targetDate || '') + '</dd>' +
    '<dt>ブランド</dt><dd>' + escapeHtml(brandLabel(booking.brand)) + '</dd>' +
    '<dt>ステータス</dt><dd>' + escapeHtml(statusLabel(booking.status)) + '</dd>' +
    '<dt>利用日</dt><dd>' + escapeHtml(booking.date || '') + '</dd>' +
    '<dt>予約者メール</dt><dd>' + escapeHtml(booking.email || '（未登録）') + '</dd>' +
    '</dl>' +
    '<p class="reminder-diag-message">' + escapeHtml(result.message || '') + '</p>'
  );
}

/*
 * previewReminderMailのレスポンスから結果表示欄のHTMLを組み立てる純粋関数。
 * 「プレビューの生成に成功したこと」（success）と「本番なら実際に送信対象であること」
 * （eligible/reasonCode）は別物のため、対象外の予約でもプレビュー自体は表示しつつ、
 * 見出しで両者をはっきり区別する（Issue #330 PRレビュー対応）。
 */
function renderReminderPreviewResult_(result) {
  if (!result || !result.success) {
    return '<p class="reminder-diag-error">プレビューできませんでした: ' + escapeHtml((result && result.error && result.error.message) || '') + '</p>';
  }
  var eligibilityLine = typeof result.eligible === 'boolean'
    ? '<dt>送信対象</dt><dd>' + escapeHtml(result.eligible ? '対象（本番なら送信されます）' : '対象外（' + reminderReasonLabel(result.reasonCode) + '）') + '</dd>'
    : '';
  return (
    '<p class="reminder-diag-success">プレビューを生成しました（対象日: ' + escapeHtml(result.targetDate || '') + '）</p>' +
    '<dl class="reminder-diag-dl">' +
    eligibilityLine +
    '<dt>予約者宛</dt><dd>' + escapeHtml(result.recipientEmail || '（未登録）') + '</dd>' +
    '<dt>テスト送信先</dt><dd>' + escapeHtml(result.testRecipientEmail || '（未設定）') + '</dd>' +
    '<dt>件名</dt><dd>' + escapeHtml(result.subject || '') + '</dd>' +
    '</dl>' +
    '<pre class="reminder-diag-body">' + escapeHtml(result.body || '') + '</pre>' +
    (result.revealed ? '' : '<p class="reminder-diag-note">解錠コード・キーボックス番号はマスクしています。「解錠コードを表示する」を選んでから再度プレビューしてください。</p>')
  );
}

/* sendReminderTestMailのレスポンスから結果表示欄のHTMLを組み立てる純粋関数。 */
function renderReminderSendResult_(result) {
  if (!result || !result.success) {
    var reason = result && result.reasonCode ? '（' + reminderReasonLabel(result.reasonCode) + '）' : '';
    return '<p class="reminder-diag-error">テスト送信できませんでした' + reason + ': ' + escapeHtml((result && result.error && result.error.message) || '') + '</p>';
  }
  return '<p class="reminder-diag-success">テスト送信しました宛先: ' + escapeHtml(result.sentTo || '') + '</p>';
}

/*
 * 前日リマインド診断モーダル（Issue #330）。BookingAdminPage.htmlは変更しない制約の
 * ため、既存の#modal-overlay/#modalとは別に、このファイルの初回実行時に専用の
 * オーバーレイをDOM生成する（initHeaderUi_/initSearchUi_と同じ方針）。
 * サーバー側API（diagnoseReminderEligibility/previewReminderMail/
 * sendReminderTestMail。いずれもgas/booking/admin/BookingReminderDiagnostics.gs）は
 * 読み取り専用の判定・プレビューと、管理者宛（ADMIN_NOTIFICATION_EMAIL固定）への
 * テスト送信のみを行い、予約者への送信・SentAt更新・一覧再取得の必要な状態変更は
 * 一切発生しないため、成功後にloadBookings()を呼び直す必要はない。
 */
var reminderDiagState_ = {
  overlay: null,
  resultEl: null,
  bookingIdInput: null,
  baseDateInput: null,
  revealInput: null,
  evaluateButton: null,
  previewButton: null,
  sendTestButton: null,
  sendTestInFlight: false
};

/*
 * 診断モーダルのリクエスト連番（Issue #330 PRレビュー対応。loadRequestSeqと同じ方針）。
 * 判定/プレビュー/テスト送信のいずれかを実行するたび、また予約ID・基準日・
 * 「解錠コードを表示する」チェック・モーダル終了のいずれかが変化するたびに1増やす。
 * 各google.script.runのsuccess/failureハンドラは、応答が返ってきた時点でこの値と
 * 発行時のrequestIdを比較し、一致しなければ（＝その後に別の変更・別のリクエストが
 * あった＝古い応答）resultElへ反映しない。GASのgoogle.script.runには応答順序の
 * 保証がないため、後から発行したリクエストの応答が先に、先に発行したリクエストの
 * 応答が後から返ってくることがあり得る。
 *
 * 予約ID・基準日の変更、「解錠コードを表示する」チェックの変更、モーダルを
 * 閉じる操作は、連番を進めることに加えてresultEl.innerHTMLも即座にクリアする
 * （PRレビュー再対応）。プレビューで解錠コード・キーボックス番号の実値を
 * 表示済みの状態のまま、連番だけを進めて古い応答の反映だけを防いでも、
 * 既に画面に表示済みの実値そのものは残ってしまうため、表示中の秘密値を
 * 即時に消去する必要がある。 */
var reminderDiagRequestSeq_ = 0;

function bumpReminderDiagRequestSeq_() {
  reminderDiagRequestSeq_ += 1;
}

/*
 * google.script.runのwithFailureHandlerは、サーバー関数が想定外の例外を投げた
 * 場合に呼ばれる（診断3関数は通常、想定内のエラーは例外を投げず戻り値として
 * 返すため、これは主にネットワーク断・GASランタイム側の障害等への保険）。
 * error.messageをそのまま画面へ出すと、HTMLエスケープしていても秘密値の
 * redactionにはならない（エスケープは表示上の安全対策であって値の削除ではない）
 * ため、クライアント側でも固定の安全な文言のみを表示する（Issue #330 PRレビュー
 * 対応。error自体は使わない）。 */
var REMINDER_DIAG_GENERIC_FAILURE_RESULT_ = { success: false, error: { message: '通信エラーが発生しました。時間をおいて再度お試しください。' } };

function buildReminderDiagnosticsModal_() {
  var overlay = document.createElement('div');
  overlay.id = 'reminder-diag-overlay';

  var modal = document.createElement('div');
  modal.id = 'reminder-diag-modal';
  overlay.appendChild(modal);

  var heading = document.createElement('h2');
  heading.textContent = '前日リマインド診断';
  modal.appendChild(heading);

  var description = document.createElement('p');
  description.className = 'reminder-diag-description';
  description.textContent = '既存予約IDと基準日（今日扱い。その翌日が対象日になります）を指定して、本番と同じ判定・テンプレートを確認できます。本番予約データは変更されません。';
  modal.appendChild(description);

  var bookingIdLabel = document.createElement('label');
  bookingIdLabel.textContent = '予約ID';
  var bookingIdInput = document.createElement('input');
  bookingIdInput.type = 'text';
  bookingIdInput.id = 'reminder-diag-booking-id';
  bookingIdLabel.appendChild(bookingIdInput);
  modal.appendChild(bookingIdLabel);

  var baseDateLabel = document.createElement('label');
  baseDateLabel.textContent = '基準日（今日扱い）';
  var baseDateInput = document.createElement('input');
  baseDateInput.type = 'date';
  baseDateInput.id = 'reminder-diag-base-date';
  baseDateLabel.appendChild(baseDateInput);
  modal.appendChild(baseDateLabel);

  var revealLabel = document.createElement('label');
  revealLabel.className = 'reminder-diag-reveal-label';
  var revealInput = document.createElement('input');
  revealInput.type = 'checkbox';
  revealInput.id = 'reminder-diag-reveal';
  revealLabel.appendChild(revealInput);
  revealLabel.appendChild(document.createTextNode('プレビューで解錠コード・キーボックス番号を表示する'));
  modal.appendChild(revealLabel);

  var actions = document.createElement('div');
  actions.className = 'reminder-diag-actions';
  modal.appendChild(actions);

  var evaluateButton = document.createElement('button');
  evaluateButton.type = 'button';
  evaluateButton.textContent = '判定';
  actions.appendChild(evaluateButton);

  var previewButton = document.createElement('button');
  previewButton.type = 'button';
  previewButton.textContent = 'プレビュー';
  actions.appendChild(previewButton);

  var sendTestButton = document.createElement('button');
  sendTestButton.type = 'button';
  sendTestButton.textContent = 'テスト送信';
  actions.appendChild(sendTestButton);

  var resultEl = document.createElement('div');
  resultEl.id = 'reminder-diag-result';
  modal.appendChild(resultEl);

  var closeButton = document.createElement('button');
  closeButton.type = 'button';
  closeButton.id = 'reminder-diag-close';
  closeButton.textContent = '閉じる';
  modal.appendChild(closeButton);

  document.body.appendChild(overlay);

  function currentInput_() {
    return {
      bookingId: (bookingIdInput.value || '').trim(),
      baseDateString: baseDateInput.value || '',
      reveal: !!revealInput.checked
    };
  }

  evaluateButton.addEventListener('click', function () {
    var input = currentInput_();
    bumpReminderDiagRequestSeq_();
    var requestId = reminderDiagRequestSeq_;
    resultEl.innerHTML = '判定中…';
    google.script.run
      .withSuccessHandler(function (result) {
        if (requestId !== reminderDiagRequestSeq_) return;
        resultEl.innerHTML = renderReminderDiagnosisResult_(result);
      })
      .withFailureHandler(function () {
        if (requestId !== reminderDiagRequestSeq_) return;
        resultEl.innerHTML = renderReminderDiagnosisResult_(REMINDER_DIAG_GENERIC_FAILURE_RESULT_);
      })
      .diagnoseReminderEligibility(input.bookingId, input.baseDateString);
  });

  previewButton.addEventListener('click', function () {
    var input = currentInput_();
    bumpReminderDiagRequestSeq_();
    var requestId = reminderDiagRequestSeq_;
    resultEl.innerHTML = 'プレビュー生成中…';
    google.script.run
      .withSuccessHandler(function (result) {
        if (requestId !== reminderDiagRequestSeq_) return;
        resultEl.innerHTML = renderReminderPreviewResult_(result);
      })
      .withFailureHandler(function () {
        if (requestId !== reminderDiagRequestSeq_) return;
        resultEl.innerHTML = renderReminderPreviewResult_(REMINDER_DIAG_GENERIC_FAILURE_RESULT_);
      })
      .previewReminderMail(input.bookingId, { baseDateString: input.baseDateString, reveal: input.reveal });
  });

  /* テスト送信は実際にメールを送るため、応答が返るまで二重実行を防止する
     （Issue #330 PRレビュー対応）。busyの間はクリックを無視し、成功・失敗の
     いずれでも必ずbusyを解除してボタンを再度押せる状態へ戻す（このbusy解除は
     表示の新旧に関わらず常に行う。resultElへの反映のみリクエスト連番で判定する）。 */
  sendTestButton.addEventListener('click', function () {
    if (reminderDiagState_.sendTestInFlight) return;
    var input = currentInput_();
    var confirmed = window.confirm(
      '管理者宛テストメール（ADMIN_NOTIFICATION_EMAIL）を送信します。\n' +
      '予約ID: ' + input.bookingId + '\n' +
      '基準日: ' + input.baseDateString + '\n\n' +
      '実予約者へは送信されません。実行しますか？'
    );
    if (!confirmed) return;

    bumpReminderDiagRequestSeq_();
    var requestId = reminderDiagRequestSeq_;
    reminderDiagState_.sendTestInFlight = true;
    sendTestButton.disabled = true;
    resultEl.innerHTML = 'テスト送信中…';
    google.script.run
      .withSuccessHandler(function (result) {
        reminderDiagState_.sendTestInFlight = false;
        sendTestButton.disabled = false;
        if (requestId !== reminderDiagRequestSeq_) return;
        resultEl.innerHTML = renderReminderSendResult_(result);
      })
      .withFailureHandler(function () {
        reminderDiagState_.sendTestInFlight = false;
        sendTestButton.disabled = false;
        if (requestId !== reminderDiagRequestSeq_) return;
        resultEl.innerHTML = renderReminderSendResult_(REMINDER_DIAG_GENERIC_FAILURE_RESULT_);
      })
      .sendReminderTestMail(input.bookingId, input.baseDateString);
  });

  /* Issue #330 PRレビュー対応: 予約IDを変えたら、前回入力に対する結果（解錠コードを
     表示していた場合はその本文も含む）を残さない。表示状態は既定（マスク）へ戻す。
     あわせてリクエスト連番を進め、変更前に発行された判定・プレビュー・テスト送信の
     応答が後から返ってきても画面を更新しないようにする。 */
  bookingIdInput.addEventListener('input', function () {
    bumpReminderDiagRequestSeq_();
    resetReminderDiagDisplay_();
  });

  /*
   * 基準日・「解錠コードを表示する」チェックの変更（Issue #330 PRレビュー再対応）。
   * 連番を進めて変更前に発行済みの応答を無効化するだけでは不十分で、reveal:trueの
   * プレビューで解錠コード・キーボックス番号の実値が既にresultEl.innerHTMLへ
   * 表示済みの場合、チェックをOFFにしても実値が画面に残ったままになってしまう
   * （基準日変更で古い判定結果・秘密値が残る場合も同様）。そのため、連番を
   * 進めることに加えてresultElも即座にクリアする。これによりチェックを
   * 再度ONに戻しても以前の結果が復活することはない（表示は完全に消えており、
   * 次に判定/プレビュー/テスト送信を実行するまで何も表示されない）。
   */
  function invalidateReminderDiagDisplay_() {
    bumpReminderDiagRequestSeq_();
    resultEl.innerHTML = '';
  }
  baseDateInput.addEventListener('input', invalidateReminderDiagDisplay_);
  revealInput.addEventListener('change', invalidateReminderDiagDisplay_);

  closeButton.addEventListener('click', closeReminderDiagnostics_);
  overlay.addEventListener('click', function (event) {
    if (event.target === overlay) closeReminderDiagnostics_();
  });

  reminderDiagState_.overlay = overlay;
  reminderDiagState_.resultEl = resultEl;
  reminderDiagState_.bookingIdInput = bookingIdInput;
  reminderDiagState_.baseDateInput = baseDateInput;
  reminderDiagState_.revealInput = revealInput;
  reminderDiagState_.evaluateButton = evaluateButton;
  reminderDiagState_.previewButton = previewButton;
  reminderDiagState_.sendTestButton = sendTestButton;
}

/* Issue #330 PRレビュー対応: 前回の判定・プレビュー結果（解錠コード表示中の本文を
   含む）をクリアし、「解錠コードを表示する」チェックを既定（オフ＝マスク）へ戻す。
   予約IDを変えたとき・モーダルを閉じたときの両方から呼ぶ共通処理。 */
function resetReminderDiagDisplay_() {
  if (!reminderDiagState_.overlay) return;
  reminderDiagState_.resultEl.innerHTML = '';
  reminderDiagState_.revealInput.checked = false;
}

function openReminderDiagnostics_() {
  if (!reminderDiagState_.overlay) buildReminderDiagnosticsModal_();
  resetReminderDiagDisplay_();
  if (!reminderDiagState_.baseDateInput.value) {
    reminderDiagState_.baseDateInput.value = state.todayJst || '';
  }
  reminderDiagState_.overlay.classList.add('open');
}

function closeReminderDiagnostics_() {
  if (!reminderDiagState_.overlay) return;
  reminderDiagState_.overlay.classList.remove('open');
  resetReminderDiagDisplay_();
  /* Issue #330 PRレビュー対応: モーダルを閉じた後に、閉じる前に発行した判定・
     プレビュー・テスト送信の応答が返ってきても画面を更新しないようにする
     （次に開いたときに古い結果が一瞬表示されるのを防ぐ）。テスト送信の
     busy状態（sendTestInFlight/ボタンのdisabled）はここではリセットしない
     （実際のMailApp送信はキャンセルできないため、応答が返るまではbusyのままにし、
     二重送信防止を優先する）。 */
  bumpReminderDiagRequestSeq_();
}

/* 既存4タブ（今日/今後/キャンセル/すべて）の各ボタンへ、件数表示用の子要素だけを
   追加する（要件3: 可能なら各タブに件数を表示する）。タブボタン本体・タブ切替
   ロジックはBookingAdminPage.html/既存のクリックハンドラのまま変更しない。 */
function initTabCountsUi_() {
  document.querySelectorAll('.tab-button').forEach(function (btn) {
    var filter = btn.getAttribute('data-filter');
    var span = document.createElement('span');
    span.className = 'tab-count';
    span.id = 'tab-count-' + filter;
    btn.appendChild(span);
  });
}

function initSearchUi_() {
  var main = document.querySelector('main');
  var statusLine = document.getElementById('status-line');

  var input = document.createElement('input');
  input.type = 'search';
  input.id = 'search-input';
  input.className = 'search-input';
  input.placeholder = '氏名・bookingID・利用目的・日付・ブランド・利用区分・支払方法・statusで検索';
  input.value = state.searchQuery;
  main.insertBefore(input, statusLine);

  input.addEventListener('input', function (event) {
    state.searchQuery = event.target.value;
    render();
  });
}

document.querySelectorAll('.tab-button').forEach(function (btn) {
  btn.addEventListener('click', function () {
    document.querySelectorAll('.tab-button').forEach(function (b) { b.classList.remove('active'); });
    btn.classList.add('active');
    state.filter = btn.getAttribute('data-filter');
    render();
  });
});

document.getElementById('list').addEventListener('click', function (event) {
  var target = event.target.closest('button[data-action]');
  if (!target) return;
  var action = target.getAttribute('data-action');
  var bookingId = target.getAttribute('data-id');
  if (action === 'detail') openDetail(bookingId);
  if (action === 'confirm') runConfirm(bookingId);
  if (action === 'cancel') runCancel(bookingId);
});

document.getElementById('sort-select').addEventListener('change', function (event) {
  state.sort = event.target.value;
  render();
});

document.getElementById('modal-close').addEventListener('click', closeModal);
document.getElementById('modal-overlay').addEventListener('click', function (event) {
  if (event.target.id === 'modal-overlay') closeModal();
});

initHeaderUi_();
initTabCountsUi_();
initSearchUi_();

loadBookings();

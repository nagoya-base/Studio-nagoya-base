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
  /* Issue #334: カード予約のみサーバー側で非空（読み取り専用）。 */
  ['cardPaymentDueAt', 'カード支払期限'],
  ['pendingMailSentAt', '仮予約メール送信'],
  ['confirmedMailSentAt', '確定メール送信'],
  ['cancelMailSentAt', 'キャンセルメール送信'],
  ['expiredMailSentAt', '失効通知メール送信'],
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
   CANCELLED・EXPIREDは「今日」「今後」には出さない。CANCELLEDは日付を問わず
   「キャンセル」タブへ集約する。EXPIREDは対応不要な既失効予約が運用中の一覧を
   埋めないよう「今日」「今後」から除外し、「すべて」でのみ確認できるようにする
   （「キャンセル」タブにも含めない。EXPIREDは管理者キャンセルではなく支払期限
   到達による自動失効のため）。
   Issue #322で件数サマリー・タブ件数（computeSummaryCounts/computeTabCounts）にも
   同じ判定を使うため、stateに依存しない純粋関数として切り出した（DOM操作からも
   分離しているため、この関数単体を直接テストできる）。 */
function filterBookingsByTab(bookings, filter, todayJst) {
  var today = todayJst;
  return bookings.filter(function (b) {
    if (filter === 'all') return true;
    if (filter === 'cancelled') return b.status === 'CANCELLED';
    if (!today) return true;
    if (filter === 'today') return b.date === today && b.status !== 'CANCELLED' && b.status !== 'EXPIRED';
    if (filter === 'upcoming') return b.date >= today && b.status !== 'CANCELLED' && b.status !== 'EXPIRED';
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
    /* Issue #334: EXPIREDのみ復活可能（利用開始後かどうか・枠の空きはサーバー側
       （reviveExpiredBooking）が最終判定する。ここでは表示上の出し分けのみ）。 */
    var canRevive = b.status === 'EXPIRED';
    var actions = '<button type="button" class="action detail" data-action="detail" data-id="' + escapeHtml(b.bookingId) + '">詳細</button>';
    if (canConfirm) {
      actions += '<button type="button" class="action confirm" data-action="confirm" data-id="' + escapeHtml(b.bookingId) + '"' + (busy ? ' disabled' : '') + '>確定</button>';
    }
    if (canCancel) {
      actions += '<button type="button" class="action cancel" data-action="cancel" data-id="' + escapeHtml(b.bookingId) + '"' + (busy ? ' disabled' : '') + '>キャンセル</button>';
    }
    if (canRevive) {
      actions += '<button type="button" class="action revive" data-action="revive" data-id="' + escapeHtml(b.bookingId) + '"' + (busy ? ' disabled' : '') + '>復活</button>';
    }

    /* Issue #334: カード予約のPENDINGのみサーバー側でcardPaymentDueAtが非空になる
       （computeAdminCardPaymentDueAt_参照）。読み取り専用表示のみで、値の編集はしない。 */
    var cardDueLine = b.cardPaymentDueAt
      ? '<div class="card-due">カード支払期限: ' + escapeHtml(b.cardPaymentDueAt) + '</div>'
      : '';

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
        cardDueLine +
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

/* Issue #334 PR-C: 予約詳細モーダルに表示中のbooking（getAdminBookingDetailの
   応答そのもの）。決済リンク送信ボタンのクリック時・送信後の詳細再取得時に、
   どの予約に対する操作かを判断するために保持する。モーダルを閉じたらnullへ戻す。 */
var currentDetailBooking_ = null;
var detailModalOpen_ = false;

function showDetailModal(booking) {
  currentDetailBooking_ = booking;
  detailModalOpen_ = true;

  var body = document.getElementById('modal-body');
  body.innerHTML = DETAIL_FIELDS.map(function (pair) {
    var key = pair[0];
    var label = pair[1];
    return '<dt>' + escapeHtml(label) + '</dt><dd>' + escapeHtml(formatValue(key, booking[key])) + '</dd>';
  }).join('');
  renderPaymentLinkSection_(booking);
  renderRescheduleSection_(booking);
  document.getElementById('modal-overlay').classList.add('open');
}

/* Issue #344: 変更のプレビュー・確定をサーバー側の同じ検証へ通す。
   料金は現行Bookingsに金額が無いため手動確認。 */
function renderRescheduleSection_(booking) {
  var modalBody = document.getElementById('modal-body');
  if (!modalBody || typeof modalBody.insertAdjacentElement !== 'function') return;
  var existing = document.getElementById('reschedule-section');
  if (existing) existing.remove();
  if (booking.status !== 'CONFIRMED') return;
  var section = document.createElement('section');
  section.id = 'reschedule-section';
  section.className = 'reschedule-section';
  var start = (booking.startAt || '').split(' ')[1] || '';
  var end = (booking.endAt || '').split(' ')[1] || '';
  section.innerHTML =
    '<h3>予約日時の変更</h3>' +
    '<p>変更後の日時を入力し、空き確認後に確定します。料金・差額は管理者が別途確認してください。</p>' +
    '<label>利用日 <input id="reschedule-date" type="date" value="' + escapeHtml(booking.date) + '"></label>' +
    '<label>開始 <input id="reschedule-start" type="time" step="900" value="' + escapeHtml(start) + '"></label>' +
    '<label>終了 <input id="reschedule-end" type="time" step="900" value="' + escapeHtml(end) + '"></label>' +
    '<label>変更理由（任意）<textarea id="reschedule-reason" maxlength="500" rows="2"></textarea></label>' +
    '<label>料金・精算案内（メールへ記載）<textarea id="reschedule-fee-note" maxlength="500" rows="2">料金差額がある場合は運営から別途ご案内します。</textarea></label>' +
    '<button type="button" id="reschedule-preview">空き状況を確認</button>' +
    '<div id="reschedule-result" role="status" aria-live="polite"></div>' +
    '<div id="reschedule-history"></div>';
  modalBody.insertAdjacentElement('afterend', section);
  var previewButton = section.querySelector('#reschedule-preview');
  previewButton.addEventListener('click', function () { previewReschedule_(booking, section); });
  section.querySelectorAll('input, textarea').forEach(function (field) {
    field.addEventListener('input', function () {
      var result = section.querySelector('#reschedule-result');
      result.textContent = '入力内容が変わりました。再度空き状況を確認してください。';
      var commit = section.querySelector('#reschedule-commit');
      if (commit) commit.remove();
    });
  });
  google.script.run
    .withSuccessHandler(function (history) {
      if (!section.isConnected || !Array.isArray(history)) return;
      var area = section.querySelector('#reschedule-history');
      if (!history.length) return;
      area.innerHTML = '<h4>変更履歴</h4>' + history.map(function (item) {
        var canRetry = item.mailState === 'FAILED';
        return '<div class="reschedule-history-item">' +
          escapeHtml(item.oldDate) + ' → ' + escapeHtml(item.newDate) +
          ' ／ 通知: ' + escapeHtml(item.mailState) +
          (canRetry ? ' <button type="button" data-change-id="' + escapeHtml(item.changeId) + '">通知を再送</button>' : '') +
          '</div>';
      }).join('');
      area.querySelectorAll('button[data-change-id]').forEach(function (button) {
        button.addEventListener('click', function () {
          if (!window.confirm('送信失敗が確認されたメールだけ再送します。実行しますか？')) return;
          button.disabled = true;
          google.script.run
            .withSuccessHandler(function (outcome) {
              alert(outcome && outcome.success ? '通知を再送しました。' :
                '再送できませんでした: ' + (outcome && outcome.error && outcome.error.message));
              refreshOpenDetail_(booking.bookingId);
            })
            .withFailureHandler(function (error) {
              button.disabled = false;
              alert('再送に失敗しました: ' + (error && error.message ? error.message : error));
            }).adminResendRescheduleMail(item.changeId);
        });
      });
    })
    .withFailureHandler(function () {})
    .adminGetBookingChanges(booking.bookingId);
}

function rescheduleInput_(section) {
  return {
    date: section.querySelector('#reschedule-date').value,
    startTime: section.querySelector('#reschedule-start').value,
    endTime: section.querySelector('#reschedule-end').value
  };
}

function previewReschedule_(booking, section) {
  var input = rescheduleInput_(section);
  var resultArea = section.querySelector('#reschedule-result');
  var button = section.querySelector('#reschedule-preview');
  button.disabled = true;
  resultArea.textContent = '空き状況を確認中…';
  google.script.run
    .withSuccessHandler(function (preview) {
      button.disabled = false;
      if (!section.isConnected || !currentDetailBooking_ || currentDetailBooking_.bookingId !== booking.bookingId) return;
      if (!preview || !preview.success) {
        resultArea.textContent = '変更できません: ' + (preview && preview.error && preview.error.message);
        return;
      }
      resultArea.textContent = '変更前: ' + preview.oldDate + ' ' + preview.oldStartTime + '〜' + preview.oldEndTime +
        ' ／ 変更後: ' + preview.newDate + ' ' + preview.newStartTime + '〜' + preview.newEndTime +
        '（' + preview.durationMinutes + '分）\n' + preview.feeNotice;
      var apply = document.createElement('button');
      apply.type = 'button';
      apply.id = 'reschedule-commit';
      apply.textContent = '変更を確定して通知';
      resultArea.appendChild(apply);
      apply.addEventListener('click', function () {
        var current = rescheduleInput_(section);
        if (JSON.stringify(current) !== JSON.stringify(input)) {
          resultArea.textContent = '入力内容が変わりました。再度確認してください。';
          return;
        }
        var feeNote = section.querySelector('#reschedule-fee-note').value.trim();
        if (!feeNote) {
          alert('料金・精算案内を入力してください。');
          return;
        }
        if (!window.confirm(
          '予約ID: ' + booking.bookingId + '\n' +
          '変更前: ' + preview.oldDate + ' ' + preview.oldStartTime + '〜' + preview.oldEndTime + '\n' +
          '変更後: ' + preview.newDate + ' ' + preview.newStartTime + '〜' + preview.newEndTime + '\n' +
          '料金・精算: ' + feeNote + '\n\n変更を確定し、利用者へメールを送りますか？'
        )) return;
        apply.disabled = true;
        button.disabled = true;
        resultArea.textContent = '変更処理中…';
        google.script.run
          .withSuccessHandler(function (outcome) {
            if (!outcome || !outcome.success) {
              resultArea.textContent = '変更できませんでした: ' + (outcome && outcome.error && outcome.error.message);
              button.disabled = false;
              return;
            }
            alert('予約日時を変更しました。' + (outcome.mailSent ? '利用者へ通知しました。' :
              '通知は未完了です。' + (outcome.warning || '変更履歴を確認してください。')));
            loadBookings();
            refreshOpenDetail_(booking.bookingId);
          })
          .withFailureHandler(function (error) {
            resultArea.textContent = '処理結果を確認できません。台帳とCalendarを確認し、二重実行しないでください。' +
              (error && error.message ? error.message : '');
          })
          .adminRescheduleBooking(booking.bookingId, input, preview.expectedVersion,
            section.querySelector('#reschedule-reason').value, feeNote);
      });
    })
    .withFailureHandler(function (error) {
      button.disabled = false;
      resultArea.textContent = '確認に失敗しました: ' + (error && error.message ? error.message : error);
    })
    .adminPreviewBookingReschedule(booking.bookingId, input, booking.rescheduleVersion);
}

function closeModal() {
  document.getElementById('modal-overlay').classList.remove('open');
  currentDetailBooking_ = null;
  detailModalOpen_ = false;
}

/*
 * Stripe決済リンク送信欄（Issue #334 PR-C）。対象は「支払方法がオンラインクレジット
 * カードのPENDING予約のみ」（Issue #334本文）。isCardPaymentはgetAdminBookingDetail
 * （BookingAdminWeb.gs）がBooking.isCardPaymentMethodで判定した値をそのまま使い、
 * 支払方法の内部文字列（'オンラインクレジットカード'）をこのファイルに複製しない。
 */
function canSendPaymentLink(booking) {
  return !!booking && !!booking.isCardPayment && booking.status === 'PENDING';
}

/*
 * PRレビュー対応: MailApp送信自体は成功したがpaymentLinkSentAtの記録に失敗し、送信済みか
 * どうか確定できていない「履行未確認」状態を、通常の「未送信」より優先して表示する
 * （admin側に必ず気付いてもらう必要があるため）。GAS側（BookingMailer.gsの
 * evaluatePaymentLinkEligibility_）も同じ優先順位（ALREADY_SENT→SEND_UNCONFIRMED）で
 * 通常送信を拒否する。 */
function paymentLinkStatusLabel_(booking) {
  if (!booking) return '未送信';
  if (booking.paymentLinkSendUnconfirmedAt) return '送信結果未確認（要確認）';
  return booking.paymentLinkSentAt ? '送信済み' : '未送信';
}

/* 通常送信（forceなし）がGAS側で拒否される状態（送信済み、または履行未確認）かどうか。
   この状態では、ボタンラベルを「再送」に変え、確認ダイアログ・GAS呼び出しの両方を
   明示的な再送として扱う（isResend）。 */
function paymentLinkRequiresExplicitResend_(booking) {
  return !!(booking && (booking.paymentLinkSentAt || booking.paymentLinkSendUnconfirmedAt));
}

/*
 * 第3回PRレビュー対応: 送信履歴に記録不整合（paymentLinkMetadataInconsistentAt）がある間は、
 * 送信履歴の照合・補正（「送信履歴を補正」操作）が完了するまで、通常送信・明示的な再送の
 * いずれも送信できない（GAS側のevaluatePaymentLinkEligibility_のMETADATA_INCONSISTENT判定と
 * 同じ方針。forceでも無視しない）。
 */
function paymentLinkBlockedByMetadataInconsistency_(booking) {
  return !!(booking && booking.paymentLinkMetadataInconsistentAt);
}

/*
 * GAS側（Booking.gs のisValidStripePaymentLinkUrl）と同じ正規表現。フロント側は
 * 即時フィードバックのための事前チェックのみで、送信可否の正はGAS側の再検証とする
 * （Issue #334本文「フロント側でも入力チェックして構いませんが、GAS側の検証を
 * 必須としてください」）。
 *
 * PRレビュー対応（前後の空白の扱いを統一）: GAS側のBooking.isValidStripePaymentLinkUrlは
 * 値をtrimせず、生の値をそのまま`^...$`の正規表現へ通すfail-closedな検証にしている
 * （前後に空白がある入力は形式エラーとして拒否する）。このクライアント側の事前チェックも
 * 同じ方針に統一する（呼び出し側でtrimしてから検証・送信すると、前後に空白のある入力を
 * 気付かれないまま黙って受理してしまい、GAS側の方針と食い違う）。
 */
var STRIPE_PAYMENT_LINK_URL_PATTERN_CLIENT_ = /^https:\/\/buy\.stripe\.com\/[A-Za-z0-9_-]+$/;

function isValidStripePaymentLinkUrlClient(url) {
  return typeof url === 'string' && STRIPE_PAYMENT_LINK_URL_PATTERN_CLIENT_.test(url);
}

/*
 * 第5回PRレビュー対応: 記録不整合の補正（runResolvePaymentLinkMetadataInconsistency_）で
 * confirmedSentToを事前チェックするための、GAS側（Booking.gsのisValidEmail_）と同じ
 * 正規表現。予約作成時のメールアドレス検証と同じ形式検証で、trimせず生の値のまま
 * 検証する（isValidStripePaymentLinkUrlClientと同じ方針。送信可否の正はGAS側の
 * 再検証とする）。
 */
var EMAIL_PATTERN_CLIENT_ = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isValidEmailClient_(value) {
  return typeof value === 'string' && value.length <= 254 && EMAIL_PATTERN_CLIENT_.test(value);
}

/*
 * 送信直前の確認ダイアログの文面（DOM操作から分離した純粋関数。単体テスト可能にする）。
 * Issue #334本文「送信前には、予約者名・メールアドレス・利用日時・支払期限・送信する
 * Stripe URLを確認できるようにしてください」に対応する。金額は表示しない
 * （Bookings台帳に確定料金列がないため）。isResendがtrueの場合、明示的な再送であることを
 * 文面で明示する（「通常の送信操作」と「明示的な再送」を管理者が混同しないようにする）。
 */
function buildPaymentLinkConfirmMessage_(booking, url, isResend) {
  return (
    '予約ID: ' + booking.bookingId + '\n' +
    '氏名: ' + booking.name + '\n' +
    'メール: ' + booking.email + '\n' +
    '利用開始: ' + booking.startAt + '\n' +
    '利用終了: ' + booking.endAt + '\n' +
    '支払期限: ' + (booking.cardPaymentDueAt || '（未設定）') + '\n' +
    'Stripe URL: ' + url + '\n\n' +
    (isResend
      ? '既に送信済みです。決済リンクメールを再送します。\n\n'
      : '決済リンクメールを送信します。\n\n') +
    '実行しますか？'
  );
}

/* Issue #334 PR-C: 決済リンク送信欄のDOM（#modal内。#modal-bodyのdlとは別に、
   初回のみ生成して以後は内容だけを更新する。入力中の値を毎回破棄しないため）。 */
var paymentLinkUi_ = {
  container: null,
  statusEl: null,
  urlInput: null,
  sendButton: null,
  sendInFlight: false,
  resolveButton: null,
  resolveInFlight: false
};

function initPaymentLinkUi_() {
  var modal = document.getElementById('modal');
  var closeButton = document.getElementById('modal-close');

  var container = document.createElement('div');
  container.id = 'payment-link-section';

  var heading = document.createElement('h3');
  heading.textContent = 'Stripe決済リンク送信';
  container.appendChild(heading);

  var statusEl = document.createElement('div');
  statusEl.id = 'payment-link-status';
  container.appendChild(statusEl);

  /* 第3回PRレビュー対応: 送信履歴の記録不整合（paymentLinkMetadataInconsistentAt）を
     解消するための専用ボタン。通常の送信ボタンとは別に用意し、記録不整合が解消される
     まで表示する（renderPaymentLinkSection_参照）。 */
  var resolveButton = document.createElement('button');
  resolveButton.type = 'button';
  resolveButton.id = 'payment-link-resolve-button';
  resolveButton.textContent = '送信履歴を補正';
  resolveButton.classList.add('hidden');
  container.appendChild(resolveButton);

  var urlLabel = document.createElement('label');
  urlLabel.textContent = 'Stripe決済リンクURL';
  var urlInput = document.createElement('input');
  urlInput.type = 'url';
  urlInput.id = 'payment-link-url-input';
  urlInput.placeholder = 'https://buy.stripe.com/...';
  urlLabel.appendChild(urlInput);
  container.appendChild(urlLabel);

  var sendButton = document.createElement('button');
  sendButton.type = 'button';
  sendButton.id = 'payment-link-send-button';
  container.appendChild(sendButton);

  modal.insertBefore(container, closeButton);
  sendButton.addEventListener('click', runSendPaymentLink_);
  resolveButton.addEventListener('click', runResolvePaymentLinkMetadataInconsistency_);

  paymentLinkUi_.container = container;
  paymentLinkUi_.statusEl = statusEl;
  paymentLinkUi_.urlInput = urlInput;
  paymentLinkUi_.sendButton = sendButton;
  paymentLinkUi_.resolveButton = resolveButton;
}

/* 決済リンク送信欄の表示内容の更新のみを担当する（DOM生成はinitPaymentLinkUi_で1回のみ）。
   カード決済以外はセクション自体を隠す。カード決済でもPENDING以外（送信後にCONFIRMED/
   CANCELLED/EXPIREDへ進んだ場合等）は、履歴（URL・送信状況・送信回数・最終エラー）は
   読み取り専用で表示しつつ、入力・送信操作は無効化する。 */
function renderPaymentLinkSection_(booking) {
  var ui = paymentLinkUi_;
  if (!ui.container) return;

  if (!booking || !booking.isCardPayment) {
    ui.container.classList.add('hidden');
    return;
  }
  ui.container.classList.remove('hidden');

  var lastErrorLine = booking.paymentLinkLastErrorMessage
    ? booking.paymentLinkLastErrorMessage + '（' + (booking.paymentLinkLastErrorAt || '') + '）'
    : 'なし';
  var statusRows = [
    ['状態', paymentLinkStatusLabel_(booking)],
    ['送信日時', booking.paymentLinkSentAt || '（未送信）'],
    ['送信先', booking.paymentLinkSentTo || '（未送信）'],
    ['送信回数', String(booking.paymentLinkSendCount || 0)],
    ['最終送信エラー', lastErrorLine]
  ];
  /* PRレビュー対応: 履行未確認（MailApp送信は成功したが送信履歴の記録に失敗した）状態を
     専用の行として表示し、実際の到達確認と明示的な再送が必要であることを案内する。 */
  var warningRowIndexes = {};
  if (booking.paymentLinkSendUnconfirmedAt) {
    warningRowIndexes[statusRows.length] = true;
    statusRows.push(['要確認', '前回（' + booking.paymentLinkSendUnconfirmedAt + '）の送信結果が未確認です。実際に届いているか確認したうえで、必要であれば再送してください。']);
  }
  /*
   * 第2回→第3回PRレビュー対応: 送信履行は確定している（二重送信のおそれはない）が、
   * 続くURL/送信先/送信回数の記録が失敗し、送信回数等の記録が古いままの可能性がある
   * 状態を別行で案内する。第3回レビュー対応で、この状態の間は送信履歴の照合・補正が
   * 完了するまで送信操作自体を禁止する方針に変更したため、文言も「送信履歴の確認・
   * 補正が必要」であることを明示するよう更新した。
   */
  var blockedByInconsistency = paymentLinkBlockedByMetadataInconsistency_(booking);
  if (blockedByInconsistency) {
    warningRowIndexes[statusRows.length] = true;
    statusRows.push([
      '記録不整合',
      '前回（' + booking.paymentLinkMetadataInconsistentAt + '）の送信で、送信回数・URL等の記録更新に失敗しました。' +
        '送信回数が実際より少なく表示されている可能性があります。送信履歴の確認・補正が完了するまで送信できません。' +
        '下の「送信履歴を補正」から、確認した正しい送信回数へ補正してください。'
    ]);
  }
  ui.statusEl.innerHTML = statusRows.map(function (pair, index) {
    var rowClass = 'payment-link-status-row' + (warningRowIndexes[index] ? ' payment-link-status-row-warning' : '');
    return '<div class="' + rowClass + '"><span>' + escapeHtml(pair[0]) + '</span>' + escapeHtml(pair[1]) + '</div>';
  }).join('');

  ui.urlInput.value = booking.stripePaymentLinkUrl || '';

  /* 第3回PRレビュー対応: 記録不整合が解消されるまでは、canSendPaymentLink（カード×
     PENDING）を満たしていても送信操作自体を禁止する。 */
  var sendable = canSendPaymentLink(booking) && !blockedByInconsistency;
  ui.urlInput.disabled = !sendable;
  ui.sendButton.disabled = !sendable || ui.sendInFlight;
  ui.sendButton.textContent = !canSendPaymentLink(booking)
    ? ('送信不可（' + statusLabel(booking.status) + '）')
    : (blockedByInconsistency
      ? '送信不可（記録不整合。補正が必要）'
      : (paymentLinkRequiresExplicitResend_(booking) ? '決済リンクを再送' : '決済リンクを送信'));

  /* 記録不整合が解消されるまでは「送信履歴を補正」ボタンを表示する。カード決済であれば
     現在のstatusを問わない（送信操作とは別の、履歴データの補正操作のため）。 */
  if (blockedByInconsistency) {
    ui.resolveButton.classList.remove('hidden');
    ui.resolveButton.disabled = ui.resolveInFlight;
  } else {
    ui.resolveButton.classList.add('hidden');
  }
}

/*
 * adminSendCardPaymentLinkの応答（google.script.run経由）から、管理者へ表示するアラート
 * 文言を組み立てる純粋関数（不具合修正: 送信直後に「送信できませんでした: null」と
 * 表示される問題）。
 *
 * GAS側（BookingAdminWeb.gs sanitizeForClient_）でDateオブジェクト・明示的なundefined
 * プロパティは既に取り除いているはずだが、それでもresultがnull/undefined、または
 * success/error/skipped/requiresManualConfirmationのいずれの既知フィールドも
 * 持たない想定外の形で届く可能性を完全には排除できない（実行環境依存のシリアライズ
 * 不具合・将来のサーバー側戻り値仕様変更の考慮漏れ等）。MailApp.sendEmailの送信自体は
 * この関数に届く前（サーバー側）で完了しているため、「戻り値を正しく解釈できない」ことは
 * 「送信していない」ことの証拠にはならない。このため、既知の失敗パターン
 * （result.errorが存在する等）に一致しない場合は「送信できませんでした」と断定しない。
 * 第2回PRレビュー対応: この不明なケースでは、確認前に安易な再送を促さない。送信済みか
 * どうか自体が確認できていない状態でまで「再送してください」と案内すると、既に送信済みの
 * メールを管理者が誤って再送してしまう引き金になりかねないため、予約詳細の送信回数・
 * 最終送信日時と、実際に届いたメールを確認するよう案内するにとどめ、確認できるまでは
 * 再送しないことを明示する（呼び出し元は常にrefreshOpenDetail_/loadBookingsで最新状態を
 * 取得し直す）。この関数はアラート文言を返すだけで、再送を含むいかなるgoogle.script.run
 * 呼び出しも行わない（自動再送はしない）。
 */
function describePaymentLinkSendResult_(result) {
  if (result && result.success && result.skipped && result.reason === 'ALREADY_SENT') {
    /*
     * 第2回PRレビュー対応: 通常送信（forceなし）が「既に送信済みのため何もしない」で
     * 正常終了したケース（BookingMailer.gsのevaluatePaymentLinkEligibility_の
     * ALREADY_SENT判定。sendPaymentLinkMailForBookingは
     * `{ success: true, skipped: true, reason: 'ALREADY_SENT', ... }`を返し、
     * sendCountを含まない）。success:trueではあるが今回は新たなメールを送信していない
     * ため、この判定を通常の送信成功ブランチ（sendCountを表示する）より先に行わないと、
     * success:trueにだけ反応する下のブランチに先に一致してしまい
     * 「送信しました（送信回数: undefined）」のように、今回送信していないのに送信した
     * かのような表示になり、かつsendCountがundefinedのまま表示されてしまう。
     */
    return '既に送信済みのため、今回は新たにメールを送信していません。';
  }
  if (result && result.success && result.metadataInconsistent) {
    /* 第2回PRレビュー対応: 送信自体・二重送信防止用の記録は成功しているが、
       送信回数等の付随情報の記録に失敗している。メール自体は再送しない
       （送信は既に完了している）。管理者にBookingsシートの確認を促す。 */
    return '送信しました。ただし送信回数等の記録更新に失敗しました（送信回数の表示が実際より少ない可能性があります。Bookingsシートを確認してください）。';
  }
  if (result && result.success) {
    return '送信しました（送信回数: ' + result.sendCount + '）';
  }
  if (result && result.requiresManualConfirmation) {
    /* PRレビュー対応: メール自体は送信された可能性があるが、送信履歴の記録に失敗し
       二重送信防止の状態が確定できていない。管理者に実際の到達確認を促す。 */
    return '送信結果を確認できませんでした（メールは送信された可能性があります）: ' + (result.error && result.error.message);
  }
  if (result && result.error && result.error.code === 'SEND_HISTORY_CONFLICT') {
    return '他の画面から既に操作された可能性があります。最新の状態を確認してください: ' + result.error.message;
  }
  if (result && result.error && result.error.code === 'METADATA_INCONSISTENT') {
    /* 第3回PRレビュー対応: 送信履歴の記録不整合が解消されるまで送信できない。
       「送信履歴を補正」操作を案内する。 */
    return '送信履歴に記録不整合があるため送信できません。下の「送信履歴を補正」から、確認した正しい送信回数へ補正してください。';
  }
  if (result && result.skipped) {
    return '送信条件を満たさないため送信しませんでした: ' + (result.error && result.error.message);
  }
  if (result && result.error && result.error.message) {
    /* success:falseかつ既知のerror.codeブランチに一致しない場合（INVALID_PAYMENT_LINK_URL・
       MAIL_NOT_READY・MAIL_SEND_FAILED等）。これらはいずれもMailApp.sendEmailを呼ぶ前、
       またはメール本文の組み立てに失敗した時点のエラーであり、メールは送信されて
       いないと断定してよい。 */
    return '送信できませんでした: ' + result.error.message;
  }
  /*
   * 不具合修正: resultがnull/undefined、または上記いずれのパターンにも一致しない想定外の
   * 形の場合。メールは既に送信されている可能性があるため「送信できませんでした」とは
   * 断定しない。
   * 第2回PRレビュー対応: この時点では送信済みかどうか自体が確認できていないため、
   * 「再送してください」とは案内しない（確認前に再送を促すと、既に送信済みのメールを
   * 誤って再送してしまう引き金になりかねない）。送信回数・最終送信日時と、実際に届いた
   * メールを確認すること、確認できるまでは再送しないことを案内するにとどめる。
   * 自動での再送は行わない。
   */
  return '送信結果を確認できませんでした。予約詳細の送信回数・最終送信日時と、実際に届いたメールを確認してください。送信済みかどうか確認できるまでは再送しないでください。';
}

/*
 * 決済リンク送信ボタンの実処理。二重クリック・連打による重複送信は、クライアント側
 * （sendInFlightガード＋送信中はボタンをdisabled）とGAS側（LockService.getScriptLock()に
 * よる直列化＋paymentLinkSentAtの二重送信防止）の両方で防ぐ（Issue #334本文
 * 「既存のLockServiceとメール送信管理の実装を確認し、それに整合する方式を採用してください」）。
 * 「明示的な再送」（isResend）かどうかはpaymentLinkSentAtの有無から判断し、確認ダイアログの
 * 文面・GAS側へ渡すforceフラグの両方に反映する。ただし送信可否の最終判定は必ずGAS側
 * （BookingMailer.sendPaymentLinkMailForBooking）で行い、ここでのisResend判定はUI文面と
 * forceフラグの初期値にのみ使う。
 */
function runSendPaymentLink_() {
  var booking = currentDetailBooking_;
  /* 第3回PRレビュー対応: 記録不整合が解消されるまでは、送信ボタンが押されても
     GASを呼び出さない（ボタン自体はrenderPaymentLinkSection_で無効化されるが、
     画面が最新化される前の古いbooking情報からの呼び出しにも備える）。 */
  if (!booking || !canSendPaymentLink(booking) || paymentLinkBlockedByMetadataInconsistency_(booking)) return;
  if (paymentLinkUi_.sendInFlight) return;

  /*
   * PRレビュー対応（前後の空白の扱いを統一）: 以前はここでtrim()した値を検証・送信して
   * いたため、前後に空白を含む入力が黙って除去されたうえで送信されてしまい、GAS側
   * （trimせずに検証するfail-closedな方針）と扱いが食い違っていた。ここではtrimせず
   * 生の入力値をそのまま検証し、空白を含む・形式に一致しない入力はすべて入力エラーとして
   * 案内する（送信もしない）。
   */
  var rawUrl = paymentLinkUi_.urlInput.value || '';
  if (!rawUrl.trim()) {
    alert('Stripeの決済リンクURLを入力してください。');
    return;
  }
  if (!isValidStripePaymentLinkUrlClient(rawUrl)) {
    alert('URLの形式が正しくありません。前後に空白が入っていないか確認し、buy.stripe.com の決済リンクをそのまま貼り付けてください（クエリ・フラグメント・末尾の余分な文字は不可）。');
    return;
  }
  var url = rawUrl;

  var isResend = paymentLinkRequiresExplicitResend_(booking);
  var confirmed = window.confirm(buildPaymentLinkConfirmMessage_(booking, url, isResend));
  if (!confirmed) return;

  paymentLinkUi_.sendInFlight = true;
  paymentLinkUi_.sendButton.disabled = true;
  setStatusLine('決済リンクを送信中…');

  /*
   * PRレビュー対応（同時再送の競合防止）: この画面が最後に取得したpaymentLinkSendCount
   * （=画面が把握している送信履歴のバージョン）をexpectedSendCountとしてそのまま渡す。
   * GAS側（BookingMailer.gsのcheckSendHistoryVersion_）が、Lock取得後の最新値と比較し、
   * 別タブ・別端末が先に送信していればこのリクエストをSEND_HISTORY_CONFLICTとして拒否する。
   *
   * 第2回PRレビュー対応: paymentLinkSendCountだけでは、送信履歴2回目の書き込みだけが
   * 失敗して送信回数が変化しないケースの競合を検知できないため、
   * paymentLinkSentAtVersion（epoch ms。getAdminBookingDetailが返す内部トークン）も
   * 独立に渡す。値の意味を解釈・加工せず、そのまま往復させるだけでよい。
   */
  var expectedSendCount = booking.paymentLinkSendCount;
  var expectedSentAtVersion = booking.paymentLinkSentAtVersion;

  google.script.run
    .withSuccessHandler(function (result) {
      paymentLinkUi_.sendInFlight = false;
      setStatusLine('');
      alert(describePaymentLinkSendResult_(result));
      refreshOpenDetail_(booking.bookingId);
      loadBookings();
    })
    .withFailureHandler(function (error) {
      paymentLinkUi_.sendInFlight = false;
      setStatusLine('');
      alert('送信でエラーが発生しました: ' + (error && error.message ? error.message : error));
      refreshOpenDetail_(booking.bookingId);
    })
    .adminSendCardPaymentLink(booking.bookingId, url, isResend, expectedSendCount, expectedSentAtVersion);
}

/*
 * 第3回PRレビュー対応: 送信履歴の記録不整合（paymentLinkMetadataInconsistentAt）を
 * 解消する。GAS側（BookingMailer.resolvePaymentLinkMetadataInconsistency）の再検証
 * （対象が本当に記録不整合の状態か・補正値が現在の記録より小さくないか・URL/送信先の
 * 形式が正しいか）に依存し、このファイル側では入力値の形式チェックのみ行う。メールは
 * 送信しない（送信履歴の記録のみを補正する操作）。
 *
 * 第5回PRレビュー対応: 記録不整合の原因となった書き込みはpaymentLinkSendCountだけでなく
 * stripePaymentLinkUrl・paymentLinkSentToも対象のため、送信回数だけを確認・補正すると
 * URL・送信先が古いまま（実際に送信したものと食い違ったまま）不整合フラグだけが解除
 * されてしまう。そのため送信回数に加えてURL・送信先も管理者に確認・入力してもらう
 * （既定値は現在Bookingsシートに記録されている値。実際の送信履歴と一致していれば
 * そのまま確定でよい）。
 */
function parseConfirmedSendCount_(rawInput) {
  if (rawInput === null || rawInput === undefined) return null;
  var trimmed = String(rawInput).trim();
  if (!/^\d+$/.test(trimmed)) return null;
  return parseInt(trimmed, 10);
}

function runResolvePaymentLinkMetadataInconsistency_() {
  var booking = currentDetailBooking_;
  if (!booking || !paymentLinkBlockedByMetadataInconsistency_(booking)) return;
  if (paymentLinkUi_.resolveInFlight) return;

  var currentCount = booking.paymentLinkSendCount;
  var rawCountInput = window.prompt(
    '決済リンクの送信回数が実際より少なく記録されている可能性があります（現在の記録: ' + currentCount + '回）。\n' +
    'Bookingsシート・Recoveryシート（PAYMENT_LINK_METADATA_UPDATE_FAILED）・実際のメール送信状況を確認したうえで、\n' +
    '正しい送信回数を入力してください（' + currentCount + '回以上の整数）。',
    String(currentCount)
  );
  if (rawCountInput === null) return;

  var confirmedCount = parseConfirmedSendCount_(rawCountInput);
  if (confirmedCount === null || confirmedCount < currentCount) {
    alert('送信回数は' + currentCount + '回以上の整数で入力してください。');
    return;
  }

  var currentUrl = booking.stripePaymentLinkUrl || '';
  var rawUrlInput = window.prompt(
    '実際に送信したStripe決済リンクURLを確認してください（現在の記録: ' + (currentUrl || '（未記録）') + '）。\n' +
    '正しいURL（https://buy.stripe.com/で始まる形式）を入力してください。',
    currentUrl
  );
  if (rawUrlInput === null) return;
  if (!isValidStripePaymentLinkUrlClient(rawUrlInput)) {
    alert('Stripeの決済リンクURL（https://buy.stripe.com/で始まる形式）を正しく入力してください（前後の空白も不可）。');
    return;
  }

  var currentSentTo = booking.paymentLinkSentTo || booking.email || '';
  var rawSentToInput = window.prompt(
    '実際の送信先メールアドレスを確認してください（現在の記録: ' + (currentSentTo || '（未記録）') + '）。\n' +
    '正しいメールアドレスを入力してください。',
    currentSentTo
  );
  if (rawSentToInput === null) return;
  if (!isValidEmailClient_(rawSentToInput)) {
    alert('送信先メールアドレスを正しい形式で入力してください（前後の空白も不可）。');
    return;
  }

  var confirmed = window.confirm(
    '予約ID: ' + booking.bookingId + '\n' +
    '送信回数を ' + currentCount + '回 → ' + confirmedCount + '回 へ補正します。\n' +
    'URL: ' + rawUrlInput + '\n' +
    '送信先: ' + rawSentToInput + '\n\n' +
    'この操作は送信履歴の記録のみを補正します。メールは送信されません。\n\n' +
    '実行しますか？'
  );
  if (!confirmed) return;

  paymentLinkUi_.resolveInFlight = true;
  paymentLinkUi_.resolveButton.disabled = true;
  setStatusLine('送信履歴を補正中…');

  google.script.run
    .withSuccessHandler(function (result) {
      paymentLinkUi_.resolveInFlight = false;
      setStatusLine('');
      if (result && result.success) {
        alert('送信履歴を補正しました（送信回数: ' + result.paymentLinkSendCount + '）。');
      } else {
        alert('補正できませんでした: ' + (result && result.error && result.error.message));
      }
      refreshOpenDetail_(booking.bookingId);
      loadBookings();
    })
    .withFailureHandler(function (error) {
      paymentLinkUi_.resolveInFlight = false;
      setStatusLine('');
      alert('補正でエラーが発生しました: ' + (error && error.message ? error.message : error));
      refreshOpenDetail_(booking.bookingId);
    })
    .adminResolvePaymentLinkMetadataInconsistency(booking.bookingId, confirmedCount, rawUrlInput, rawSentToInput);
}

/* 送信後、開いたままの詳細モーダルを最新状態へ更新する（サーバーから再取得したもので
   置き換える。クライアント側でpaymentLinkSentAt等を推測して書き換えることはしない。
   既存のconfirm/cancel/revive直後にloadBookings()で一覧を再取得する方針と同じ）。 */
function refreshOpenDetail_(bookingId) {
  if (!detailModalOpen_ || !currentDetailBooking_ || currentDetailBooking_.bookingId !== bookingId) return;
  google.script.run
    .withSuccessHandler(function (result) {
      if (result && result.success && detailModalOpen_ && currentDetailBooking_ && currentDetailBooking_.bookingId === bookingId) {
        showDetailModal(result.booking);
      }
    })
    .withFailureHandler(function () {})
    .getAdminBookingDetail(bookingId);
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

/*
 * EXPIRED予約の復活（Issue #334）。runConfirm/runCancelと同じ配線
 * （window.confirmでYES/NO確認 → google.script.run → 成否問わずloadBookings()で
 * 最新一覧を再取得してから該当bookingIdのbusyを解除）。枠の空き・利用開始後かどうかの
 * 最終判定はサーバー側（adminReviveExpiredBooking→reviveExpiredBooking）が行う。
 */
function runRevive(bookingId) {
  var booking = state.bookings.find(function (b) { return b.bookingId === bookingId; });
  var confirmed = window.confirm(
    (booking
      ? '予約ID: ' + booking.bookingId + '\n' +
        '利用日: ' + booking.date + ' ' + booking.startAt + '-' + booking.endAt + '\n' +
        '利用者名: ' + booking.name + '\n' +
        'ブランド: ' + booking.brand + '\n\n'
      : '') +
    'この失効した予約をCONFIRMEDへ復活します。\n\n' +
    '枠の空きを再確認したうえでCalendarへ確定予定を作成し、利用者へ予約確定メールを送信します。\n\n' +
    '実行しますか？'
  );
  if (!confirmed) return;

  setBusy(bookingId, true);
  setStatusLine('復活処理中…');
  google.script.run
    .withSuccessHandler(function (result) {
      if (!result || !result.success) {
        alert('復活できませんでした: ' + (result && result.error && result.error.message));
      }
      loadBookings(function () { setBusy(bookingId, false); });
    })
    .withFailureHandler(function (error) {
      alert('復活でエラーが発生しました: ' + (error && error.message ? error.message : error));
      loadBookings(function () { setBusy(bookingId, false); });
    })
    .adminReviveExpiredBooking(bookingId);
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
  if (action === 'revive') runRevive(bookingId);
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
initPaymentLinkUi_();

loadBookings();

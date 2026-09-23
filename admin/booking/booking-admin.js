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
 */
var state = {
  bookings: [],
  todayJst: null,
  filter: 'today',
  sort: 'date',
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

/* hasMailErrorのみ真偽値、customerTypeのみ表示用ラベルへ変換、それ以外は
   サーバー側で整形済みの文字列（空文字列＝未設定）。
   lastMailError*の詳細（内容・種別・日時）はWeb UIへは出さない（障害調査は
   Spreadsheetを直接確認する運用のまま。BookingAdminWeb.gs参照）。 */
function formatValue(key, value) {
  if (key === 'hasMailError') return value ? 'あり' : 'なし';
  if (key === 'customerType') return customerTypeLabel(value) || '（未設定）';
  if (value === null || value === undefined || value === '') return '（未設定）';
  return String(value);
}

/* 「今日/今後」の判定はstate.todayJst（サーバーがAsia/Tokyo基準で計算した値。
   getAdminBookingsの応答に含まれる）とbooking.date（同じくJST基準の
   'YYYY-MM-DD'）の単純な文字列比較で行う。端末のtimezone設定には一切依存しない。
   CANCELLEDは「今日」「今後」には出さず、日付を問わず「キャンセル」タブへ集約する
   （EXPIREDはここに含めない。「すべて」で確認できれば十分という要件のため）。 */
function filteredBookings() {
  var today = state.todayJst;
  return state.bookings.filter(function (b) {
    if (state.filter === 'all') return true;
    if (state.filter === 'cancelled') return b.status === 'CANCELLED';
    if (!today) return true;
    if (state.filter === 'today') return b.date === today && b.status !== 'CANCELLED';
    if (state.filter === 'upcoming') return b.date >= today && b.status !== 'CANCELLED';
    return true;
  });
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

/* filter → sortの順（要件どおり）。タブ切り替え・ソート切り替えの双方でrender()から
   この関数だけを呼べばよいようにしている。 */
function visibleBookings() {
  return sortBookings(filteredBookings());
}

function setStatusLine(message) {
  document.getElementById('status-line').textContent = message || '';
}

function render() {
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
    var actions = '<button type="button" class="action detail" data-action="detail" data-id="' + b.bookingId + '">詳細</button>';
    if (canConfirm) {
      actions += '<button type="button" class="action confirm" data-action="confirm" data-id="' + b.bookingId + '"' + (busy ? ' disabled' : '') + '>確定</button>';
    }
    if (canCancel) {
      actions += '<button type="button" class="action cancel" data-action="cancel" data-id="' + b.bookingId + '"' + (busy ? ' disabled' : '') + '>キャンセル</button>';
    }

    return (
      '<div class="card">' +
        '<div class="card-datetime">' + escapeHtml(b.date) + ' ' + escapeHtml(b.startAt) + '-' + escapeHtml(b.endAt) + '</div>' +
        '<div class="card-brand">' + escapeHtml(b.brand) + '</div>' +
        '<div class="card-name">' + escapeHtml(b.name) + '</div>' +
        '<div class="card-meta">' + escapeHtml(b.people) + ' / ' + escapeHtml(customerTypeLabel(b.customerType)) + '</div>' +
        '<span class="badge badge-' + escapeHtml(b.status) + '">' + escapeHtml(b.status) + '</span>' +
        '<div class="card-actions">' + actions + '</div>' +
      '</div>'
    );
  }).join('');
}

function escapeHtml(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
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
   残り、該当ボタンが永久にdisableのままになってしまう（PRレビュー対応）。 */
function loadBookings(onDone) {
  setStatusLine('読み込み中…');
  loadRequestSeq += 1;
  var requestId = loadRequestSeq;
  google.script.run
    .withSuccessHandler(function (result) {
      /* 「今なお最新の呼び出しか」はstateへの反映・再描画だけをスキップする条件で、
         onDone（busy解除）は呼び出し元に関わらず必ず実行する。 */
      if (requestId === loadRequestSeq) {
        state.bookings = (result && result.bookings) || [];
        state.todayJst = result && result.todayJst;
        setStatusLine('');
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

loadBookings();

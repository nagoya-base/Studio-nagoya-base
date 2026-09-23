/*
 * booking-admin.js — Booking Admin Web UI.
 * Issue #317でGitHub Pages側へ外部化済み。
 * このファイルの更新だけで通常のフロントUI変更を反映できる。
 */
var state = {
  bookings: [],
  todayJst: null,
  filter: 'today',
  sort: 'date',
  query: '',
  busyIds: {}
};

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

function customerTypeLabel(value) {
  if (value === 'first_time') return '初回利用';
  if (value === 'returning') return '利用経験あり';
  return value || '';
}

function statusLabel(value) {
  if (value === 'PENDING') return '仮受付';
  if (value === 'CONFIRMED') return '確定';
  if (value === 'CANCELLED') return 'キャンセル';
  if (value === 'EXPIRED') return '期限切れ';
  return value || '';
}

function brandLabel(value) {
  if (value === 'snb') return 'SNB';
  if (value === 'mens') return 'SNB mens';
  if (value === 'studio_x') return 'Studio X';
  return value || '';
}

function formatValue(key, value) {
  if (key === 'hasMailError') return value ? 'あり' : 'なし';
  if (key === 'customerType') return customerTypeLabel(value) || '（未設定）';
  if (key === 'status') return statusLabel(value) || '（未設定）';
  if (key === 'brand') return brandLabel(value) || '（未設定）';
  if (value === null || value === undefined || value === '') return '（未設定）';
  return String(value);
}

function filteredBookings() {
  var today = state.todayJst;
  return state.bookings.filter(function (b) {
    if (state.filter === 'cancelled' && b.status !== 'CANCELLED') return false;
    if (state.filter === 'today' && today && !(b.date === today && b.status !== 'CANCELLED')) return false;
    if (state.filter === 'upcoming' && today && !(b.date >= today && b.status !== 'CANCELLED')) return false;
    return true;
  });
}

function searchedBookings(bookings) {
  var q = String(state.query || '').trim().toLowerCase();
  if (!q) return bookings;
  return bookings.filter(function (b) {
    return [
      b.bookingId,
      b.date,
      b.startAt,
      b.endAt,
      b.name,
      brandLabel(b.brand),
      customerTypeLabel(b.customerType),
      b.purpose,
      b.paymentMethod,
      statusLabel(b.status)
    ].some(function (value) {
      return String(value || '').toLowerCase().indexOf(q) !== -1;
    });
  });
}

function compareByDate_(a, b) {
  if (a.date !== b.date) return a.date < b.date ? -1 : 1;
  if (a.startAt !== b.startAt) return a.startAt < b.startAt ? -1 : 1;
  return 0;
}

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

function visibleBookings() {
  return sortBookings(searchedBookings(filteredBookings()));
}

function escapeHtml(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function setStatusLine(message) {
  document.getElementById('status-line').textContent = message || '';
}

function countByStatus(status) {
  return state.bookings.filter(function (b) { return b.status === status; }).length;
}

function updateOverview() {
  var overview = document.getElementById('admin-overview');
  if (overview) {
    var todayCount = state.bookings.filter(function (b) {
      return b.date === state.todayJst && b.status !== 'CANCELLED';
    }).length;
    overview.innerHTML =
      '<div class="metric"><span class="metric-label">今日</span><strong>' + todayCount + '</strong></div>' +
      '<div class="metric metric-pending"><span class="metric-label">仮受付</span><strong>' + countByStatus('PENDING') + '</strong></div>' +
      '<div class="metric metric-confirmed"><span class="metric-label">確定</span><strong>' + countByStatus('CONFIRMED') + '</strong></div>' +
      '<div class="metric"><span class="metric-label">全件</span><strong>' + state.bookings.length + '</strong></div>';
  }

  var tabButtons = document.querySelectorAll('.tab-button');
  if (tabButtons && tabButtons.forEach) {
    tabButtons.forEach(function (btn) {
      var filter = btn.getAttribute('data-filter');
      var count = state.bookings.length;
      if (filter === 'today') {
        count = state.bookings.filter(function (b) {
          return b.date === state.todayJst && b.status !== 'CANCELLED';
        }).length;
      } else if (filter === 'upcoming') {
        count = state.bookings.filter(function (b) {
          return !state.todayJst || (b.date >= state.todayJst && b.status !== 'CANCELLED');
        }).length;
      } else if (filter === 'cancelled') {
        count = countByStatus('CANCELLED');
      }
      var base = filter === 'today' ? '今日' : filter === 'upcoming' ? '今後' : filter === 'cancelled' ? 'キャンセル' : 'すべて';
      btn.textContent = base + ' ' + count;
    });
  }
}

function render() {
  updateOverview();
  var list = document.getElementById('list');
  var bookings = visibleBookings();

  if (bookings.length === 0) {
    list.innerHTML =
      '<div class="empty">' +
        '<div class="empty-icon">⌕</div>' +
        '<strong>該当する予約がありません</strong>' +
        '<span>条件を変えて確認してください</span>' +
      '</div>';
    return;
  }

  list.innerHTML = bookings.map(function (b) {
    var busy = !!state.busyIds[b.bookingId];
    var canConfirm = b.status === 'PENDING';
    var canCancel = b.status === 'PENDING' || b.status === 'CONFIRMED';

    var actions = '<button type="button" class="action detail" data-action="detail" data-id="' + escapeHtml(b.bookingId) + '">詳細</button>';
    if (canConfirm) {
      actions += '<button type="button" class="action confirm" data-action="confirm" data-id="' + escapeHtml(b.bookingId) + '"' + (busy ? ' disabled' : '') + '>予約を確定</button>';
    }
    if (canCancel) {
      actions += '<button type="button" class="action cancel" data-action="cancel" data-id="' + escapeHtml(b.bookingId) + '"' + (busy ? ' disabled' : '') + '>キャンセル</button>';
    }

    return (
      '<article class="card status-' + escapeHtml(String(b.status || '').toLowerCase()) + '">' +
        '<div class="card-topline">' +
          '<span class="brand-chip">' + escapeHtml(brandLabel(b.brand)) + '</span>' +
          '<span class="badge badge-' + escapeHtml(b.status) + '">' + escapeHtml(statusLabel(b.status)) + '</span>' +
        '</div>' +
        '<div class="card-datetime">' +
          '<span class="card-date">' + escapeHtml(b.date) + '</span>' +
          '<span class="card-time">' + escapeHtml(b.startAt) + '–' + escapeHtml(b.endAt) + '</span>' +
        '</div>' +
        '<div class="card-name">' + escapeHtml(b.name) + '</div>' +
        '<div class="card-meta">' +
          '<span>' + escapeHtml(b.people) + '</span>' +
          '<span>' + escapeHtml(customerTypeLabel(b.customerType)) + '</span>' +
          (b.paymentMethod ? '<span>' + escapeHtml(b.paymentMethod) + '</span>' : '') +
        '</div>' +
        (b.purpose ? '<div class="card-purpose">' + escapeHtml(b.purpose) + '</div>' : '') +
        '<div class="card-id">' + escapeHtml(b.bookingId) + '</div>' +
        '<div class="card-actions">' + actions + '</div>' +
      '</article>'
    );
  }).join('');
}

var loadRequestSeq = 0;

function loadBookings(onDone) {
  setStatusLine('予約を読み込んでいます…');
  loadRequestSeq += 1;
  var requestId = loadRequestSeq;
  google.script.run
    .withSuccessHandler(function (result) {
      if (requestId === loadRequestSeq) {
        state.bookings = (result && result.bookings) || [];
        state.todayJst = result && result.todayJst;
        setStatusLine('');
        render();
        var stamp = document.getElementById('last-updated');
        if (stamp) stamp.textContent = '更新 ' + new Date().toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
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
    return '<div class="detail-row"><dt>' + escapeHtml(label) + '</dt><dd>' + escapeHtml(formatValue(key, booking[key])) + '</dd></div>';
  }).join('');
  document.getElementById('modal-overlay').classList.add('open');
}

function closeModal() {
  document.getElementById('modal-overlay').classList.remove('open');
}

function setBusy(bookingId, busy) {
  if (busy) state.busyIds[bookingId] = true;
  else delete state.busyIds[bookingId];
  render();
}

function runConfirm(bookingId) {
  var booking = state.bookings.find(function (b) { return b.bookingId === bookingId; });
  var confirmed = window.confirm(
    (booking
      ? '予約ID: ' + booking.bookingId + '\n' +
        '利用日: ' + booking.date + ' ' + booking.startAt + '-' + booking.endAt + '\n' +
        '利用者名: ' + booking.name + '\n' +
        'ブランド: ' + brandLabel(booking.brand) + '\n' +
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

function mountManagementUi() {
  if (typeof document.querySelector !== 'function') return;
  var header = document.querySelector('header');
  var main = document.querySelector('main');
  if (!header || !main) return;

  var title = header.querySelector('h1');
  if (title) title.innerHTML = '<span class="title-eyebrow">Studio Nagoya Base</span><span class="title-main">予約管理</span>';

  if (!document.getElementById('header-meta')) {
    var meta = document.createElement('div');
    meta.id = 'header-meta';
    meta.className = 'header-meta';
    meta.innerHTML = '<span id="last-updated">未更新</span><button type="button" id="refresh-button" class="refresh-button" aria-label="予約一覧を更新">↻ 更新</button>';
    header.insertBefore(meta, header.querySelector('.tabs'));
  }

  if (!document.getElementById('admin-overview')) {
    var overview = document.createElement('section');
    overview.id = 'admin-overview';
    overview.className = 'overview';
    main.insertBefore(overview, main.firstChild);
  }

  if (!document.getElementById('booking-search')) {
    var toolbar = document.createElement('div');
    toolbar.className = 'toolbar';
    toolbar.innerHTML = '<label class="search-field"><span>検索</span><input id="booking-search" type="search" autocomplete="off" placeholder="名前・予約ID・目的で検索"></label>';
    var statusLine = document.getElementById('status-line');
    main.insertBefore(toolbar, statusLine);
  }

  var search = document.getElementById('booking-search');
  if (search) {
    search.addEventListener('input', function (event) {
      state.query = event.target.value || '';
      render();
    });
  }

  var refresh = document.getElementById('refresh-button');
  if (refresh) refresh.addEventListener('click', function () { loadBookings(); });
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

mountManagementUi();
loadBookings();

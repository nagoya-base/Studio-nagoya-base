/*
 * ops-client.js — 運営アプリ段階1のフロントエンド画面ロジック（Issue #936）。
 *
 * - 通信方式に依存しない。バックエンドとは「共通接続契約」（docs/ops-reservations-936.md §6）を満たす
 *   アダプター { list(params, ok, ng), detail(id, ok, ng) } を介してのみ話す。google.script.run・HTTP・
 *   Sheets/SwitchBot への直接接続はここに持たない（アダプター側の責務）。
 * - 秘密情報を保持しない。権限・予約状態・元データの正しさを独自に確定しない（バックエンドの応答を描画するだけ）。
 * - 描画は文字列をすべてエスケープして行う。
 * - 遅れて返った古い応答は破棄（最新の要求のみ採用）。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.OpsClient = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var SERVICES = [['all', 'すべて'], ['snb', 'SNB'], ['studio_x', 'Studio X'], ['snb_mens', 'SNB Mens'], ['snb_community', 'SNB Community（未接続）'], ['unclassified', '未分類']];
  var STATUSES = [['all', 'すべて'], ['PENDING', '仮予約'], ['CONFIRMED', '確定'], ['CANCELLED', 'キャンセル'], ['EXPIRED', '失効'], ['UNKNOWN', '不明']];
  var PHASE_LABELS = { upcoming: 'これから', in_progress: '利用中', ended: '終了済み', unknown: '開始済み（終了不明）' };
  var DENIED_CODES = ['UNAUTHENTICATED', 'FORBIDDEN'];

  function esc(value) {
    return String(value === null || value === undefined ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /* null=未入力、0=0。空欄と0を混同しない。 */
  function show(value, suffix) {
    if (value === null || value === undefined || value === '') return '<span class="empty">未入力</span>';
    return esc(value) + (suffix || '');
  }

  /* 契約の日時はタイムゾーン付きISO。表示は日本時間（JST）に固定し、端末のタイムゾーンに依存しない。 */
  function jstText(iso, withDate) {
    if (typeof iso !== 'string') return null;
    var ms = Date.parse(iso);
    if (isNaN(ms)) return null;
    var d = new Date(ms + 9 * 3600 * 1000);
    function p(n) { return (n < 10 ? '0' : '') + n; }
    var clock = p(d.getUTCHours()) + ':' + p(d.getUTCMinutes());
    return withDate ? d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate()) + ' ' + clock : clock;
  }

  /* 一覧の終了表示。JSTで開始と終了の日付が違う（日またぎ・複数日）場合は、終了日も併記して
     「22:00〜01:00」のような逆転した時間帯に見えないようにする。 */
  function endLabel(startAt, endAt) {
    var end = jstText(endAt, true);
    if (end === null) return null;
    var start = jstText(startAt, true);
    return start !== null && start.slice(0, 10) !== end.slice(0, 10) ? end + '（翌日以降）' : end.slice(11);
  }

  /* 手動再取得・連続操作で、遅れて返った古い応答が最新結果を上書きしないようにする。 */
  function createController(api, onChange) {
    var state = { phase: 'idle', data: null, lastSuccessAt: null, error: null, stale: false, detail: null, detailId: null, detailPhase: 'idle', detailError: null, mock: api && api.kind === 'mock' };
    var listSeq = 0, detailSeq = 0;
    function emit() { if (onChange) onChange(state); }
    function fail(err) {
      state.error = err;
      if (DENIED_CODES.indexOf(err.code) !== -1) {
        /* 認可失敗では、以前の表示を残さない。 */
        state.phase = 'denied'; state.data = null; state.stale = false; state.detail = null; state.detailPhase = 'idle'; state.detailId = null;
        /* 実行中の他の要求（一覧・詳細）の遅れて返る成功応答が、消した表示を復活させないよう、保留中の要求を無効化する。 */
        listSeq++; detailSeq++;
      } else {
        state.phase = err.code === 'NOT_CONNECTED' ? 'not_connected' : 'error';
        state.stale = !!state.data;
      }
    }
    function load(params) {
      var mine = ++listSeq;
      /* 詳細を開いたまま再取得した場合も、詳細を最新の台帳から取り直す。 */
      if (state.detailId !== null) openDetail(state.detailId);
      state.phase = 'loading';
      state.error = null;
      emit();
      api.list(params, function (res) {
        if (mine !== listSeq) return;
        if (res && res.ok) {
          state.data = res; state.lastSuccessAt = res.fetchedAt; state.stale = false; state.error = null; state.phase = 'ready';
        } else {
          fail(res && res.error ? res.error : { code: 'FETCH_FAILED', message: '取得に失敗しました。' });
        }
        emit();
      }, function () {
        if (mine !== listSeq) return;
        fail({ code: 'FETCH_FAILED', message: '取得に失敗しました。通信状況を確認して再取得してください。' });
        emit();
      });
    }
    function openDetail(id) {
      var mine = ++detailSeq;
      state.detailId = id;
      state.detail = null; state.detailPhase = 'loading'; state.detailError = null;
      emit();
      api.detail(id, function (res) {
        if (mine !== detailSeq) return;
        if (res && res.ok) { state.detail = res.reservation; state.detailPhase = 'ready'; }
        else {
          state.detailPhase = 'error'; state.detailError = res && res.error ? res.error : { message: '取得に失敗しました。' };
          if (res && res.error && DENIED_CODES.indexOf(res.error.code) !== -1) fail(res.error);
        }
        emit();
      }, function () {
        if (mine !== detailSeq) return;
        state.detailPhase = 'error'; state.detailError = { message: '取得に失敗しました。' };
        emit();
      });
    }
    function closeDetail() { detailSeq++; state.detailId = null; state.detail = null; state.detailPhase = 'idle'; state.detailError = null; emit(); }
    return { state: state, load: load, openDetail: openDetail, closeDetail: closeDetail };
  }

  function renderBanner(state) {
    var html = '';
    if (state.mock) html += '<div class="banner stale">モックデータ（架空）を表示しています。実際の予約ではありません。</div>';
    if (state.phase === 'loading') html += '<div class="banner">取得中…</div>';
    if (state.phase === 'denied') html += '<div class="banner err">' + esc(state.error.message) + '（予約情報は表示しません）</div>';
    if (state.phase === 'error' || state.phase === 'not_connected') {
      html += '<div class="banner err">' + esc(state.error.message) + '</div>';
      if (state.stale) html += '<div class="banner stale">古いデータを表示しています（最終取得成功: ' + esc(jstText(state.lastSuccessAt, true) || state.lastSuccessAt) + ' JST）。最新ではありません。</div>';
    }
    if (state.phase === 'ready' && state.data) html += '<div class="banner">最終取得成功: ' + esc(jstText(state.lastSuccessAt, true) || state.lastSuccessAt) + ' JST</div>';
    return html;
  }

  function renderCard(item) {
    var phase = PHASE_LABELS[item.phase];
    return '<li><button type="button" class="card" data-id="' + esc(item.bookingId) + '">' +
      '<div class="top"><span class="tag">' + esc(item.serviceLabel) + '</span><span class="tag">' + esc(item.statusLabel) + '</span>' + (phase ? '<span class="tag">' + esc(phase) + '</span>' : '') + '</div>' +
      '<div class="when">' + esc(item.date) + ' ' + show(jstText(item.startAt)) + '〜' + show(endLabel(item.startAt, item.endAt)) + '</div>' +
      '<div>' + show(item.name) + ' / ' + show(item.people, '名') + '</div>' +
      '<div class="note">' + esc(item.bookingId) + '</div></button></li>';
  }

  function renderIssues(issues) {
    if (!issues || !issues.length) return '';
    var errors = issues.filter(function (i) { return i.severity === 'error'; }).length;
    var list = issues.map(function (i) {
      return '<li>' + esc(i.row) + '行目' + (i.bookingId ? '（' + esc(i.bookingId) + '）' : '') + ': ' + (i.severity === 'error' ? '【除外】' : '【注意】') + esc(i.reasons.join('、')) + '</li>';
    }).join('');
    return '<details><summary>確認が必要な行 ' + esc(issues.length) + '件（うち一覧から除外 ' + esc(errors) + '件）</summary><ul>' + list + '</ul></details>';
  }

  function renderList(state) {
    var d = state.data;
    if (!d) return '';
    var a = d.applied;
    var html = '<p class="note">条件: ' + esc(a.from) + '〜' + esc(a.to) + '（日本時間 0:00〜翌0:00の重なり） / ' + esc(a.order === 'asc' ? '開始が早い順' : '開始が遅い順') +
      ' / 該当 ' + esc(d.counts.matched) + '件（台帳 ' + esc(d.counts.sheetRows) + '行を全件取得）</p>';
    var notConnected = d.serviceStates.filter(function (s) { return s.state === 'not_connected'; });
    if (notConnected.length) html += '<p class="note">未接続: ' + notConnected.map(function (s) { return esc(s.label); }).join('、') + '（0件ではなく、まだ取り込んでいません）</p>';
    if (d.notConnectedSelected) {
      html += '<div class="banner stale">選択したサービスは未接続です。予約が0件という意味ではありません。</div>';
    } else if (!d.items.length) {
      html += '<div class="banner">条件に該当する予約は0件です（取得は正常に完了しています）。</div>';
    } else {
      html += '<ul class="cards">' + d.items.map(renderCard).join('') + '</ul>';
    }
    return html + renderIssues(d.issues);
  }

  function renderDetail(state) {
    if (state.detailPhase === 'idle') return '';
    var html = '<div class="banner"><button type="button" id="detail-close">一覧へ戻る</button></div>';
    if (state.detailPhase === 'loading') return html + '<div class="banner">取得中…</div>';
    if (state.detailPhase === 'error') return html + '<div class="banner err">' + esc(state.detailError.message) + '</div>';
    var r = state.detail;
    var price = r.effectivePriceAmount === null ? '<span class="empty">未計算</span>' : esc(r.effectivePriceAmount) + '円' + (r.priceOverridden ? '（修正済み）' : '');
    var rows = [
      ['予約ID', show(r.bookingId)], ['サービス', show(r.serviceLabel) + (r.service === 'unclassified' ? '（元の値: ' + show(r.brandRaw) + '）' : '')],
      ['状態', show(r.statusLabel) + (r.status === null ? '（元の値: ' + show(r.statusRaw) + '）' : '')],
      ['利用の進行', show(PHASE_LABELS[r.phase] || null)],
      ['利用日', show(r.date)], ['開始', show(jstText(r.startAt, true))], ['終了', show(jstText(r.endAt, true))],
      ['氏名', show(r.name)], ['人数', show(r.people, '名')], ['利用者区分', show(r.customerType)], ['利用目的', show(r.purpose)],
      ['プラン', show(r.planCode)], ['大人数利用', r.largeParty ? 'はい' : 'いいえ'],
      ['支払方法', show(r.paymentMethod)], ['決済状態', show(r.paymentStatus)], ['利用料金', price],
      ['受付経路', show(r.source)], ['作成', show(jstText(r.createdAt, true))], ['更新', show(jstText(r.updatedAt, true))],
      ['確定', show(jstText(r.confirmedAt, true))], ['キャンセル', show(jstText(r.cancelledAt, true))], ['失効', show(jstText(r.expiredAt, true))]
    ];
    return html + '<dl>' + rows.map(function (x) { return '<dt>' + esc(x[0]) + '</dt><dd>' + x[1] + '</dd>'; }).join('') + '</dl>';
  }

  function renderView(state) {
    return state.detailPhase !== 'idle' ? renderDetail(state) : renderList(state);
  }

  function optionsHtml(list) {
    return list.map(function (o) { return '<option value="' + esc(o[0]) + '">' + esc(o[1]) + '</option>'; }).join('');
  }

  /* 画面の入力 → 契約の一覧要求。custom以外ではfrom/toを送らずバックエンドの既定期間を使う。 */
  function paramsFromInputs(inputs) {
    var p = { service: inputs.service, status: inputs.status };
    if (inputs.scope === 'custom') {
      if (inputs.from) p.from = inputs.from;
      if (inputs.to) p.to = inputs.to;
      p.scope = 'upcoming';
    } else {
      p.scope = inputs.scope;
    }
    return p;
  }

  /* DOMへの結線（ブラウザーでのみ呼ぶ）。api は契約アダプター。 */
  function mount(doc, api) {
    function $(id) { return doc.getElementById(id); }
    $('f-service').innerHTML = optionsHtml(SERVICES);
    $('f-status').innerHTML = optionsHtml(STATUSES);
    var ctl = createController(api, function (state) {
      $('banner').innerHTML = renderBanner(state);
      $('view').innerHTML = renderView(state);
    });
    function reload() {
      ctl.load(paramsFromInputs({ service: $('f-service').value, status: $('f-status').value, scope: $('f-scope').value, from: $('f-from').value, to: $('f-to').value }));
    }
    ['f-service', 'f-status', 'f-scope', 'f-from', 'f-to'].forEach(function (id) { $(id).addEventListener('change', reload); });
    $('f-reload').addEventListener('click', reload);
    $('view').addEventListener('click', function (e) {
      var node = e.target;
      while (node && node !== $('view')) {
        if (node.id === 'detail-close') { ctl.closeDetail(); return; }
        if (node.getAttribute && node.getAttribute('data-id')) { ctl.openDetail(node.getAttribute('data-id')); return; }
        node = node.parentNode;
      }
    });
    reload();
    return ctl;
  }

  return { esc: esc, jstText: jstText, endLabel: endLabel, createController: createController, renderBanner: renderBanner, renderView: renderView,
    optionsHtml: optionsHtml, paramsFromInputs: paramsFromInputs, mount: mount, SERVICES: SERVICES, STATUSES: STATUSES, PHASE_LABELS: PHASE_LABELS };
});

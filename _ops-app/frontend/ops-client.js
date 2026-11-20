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
  var STATUSES = [['active', 'キャンセル除外'], ['all', 'すべて（キャンセル含む）'], ['PENDING', '仮予約'], ['CONFIRMED', '確定'], ['CANCELLED', 'キャンセル'], ['EXPIRED', '失効'], ['UNKNOWN', '不明']];
  var PHASE_LABELS = { upcoming: 'これから', in_progress: '利用中', ended: '終了済み', unknown: '開始済み（終了不明）' };
  var DENIED_CODES = ['UNAUTHENTICATED', 'FORBIDDEN'];
  /* 運営枠（#1003。読み取り専用）の表示切替。予約の絞り込みではなく画面側だけの切替（再取得しない）。 */
  var KINDS = [['all', '予約と運営枠'], ['res', '予約のみ'], ['slots', '運営枠のみ']];
  /* 運営枠を取得できない理由。どれも「運営枠0件」ではない（0件と書くのは取得成功のときだけ）。 */
  var SLOT_STATE_TEXT = {
    not_configured: '運営枠の読取先が未設定です。',
    no_access: '運営枠のカレンダーを開けません（見つからない、またはアクセス権がありません）。',
    auth_required: '運営枠の読み取り承認が済んでいません。所有者本人で専用URLを開き直し、カレンダーの閲覧の承認画面が出たら承認してください。',
    read_failed: '運営枠の取得に失敗しました。'
  };
  var IDLE_SLOTS = { phase: 'idle', data: null, error: null, fetchedAt: null };

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
    var state = { phase: 'idle', data: null, lastSuccessAt: null, error: null, stale: false, detail: null, detailId: null, detailPhase: 'idle', detailError: null, key: { phase: 'idle', data: null, error: null, fetchedAt: null }, mock: api && api.kind === 'mock', slots: IDLE_SLOTS, kind: 'all', request: null };
    var listSeq = 0, detailSeq = 0, keySeq = 0, slotSeq = 0;
    function emit() { if (onChange) onChange(state); }
    function fail(err) {
      state.error = err;
      if (DENIED_CODES.indexOf(err.code) !== -1) {
        /* 認可失敗では、以前の表示を残さない。 */
        state.phase = 'denied'; state.data = null; state.stale = false; state.detail = null; state.detailPhase = 'idle'; state.detailId = null; keySeq++; state.key = { phase: 'idle', data: null, error: null, fetchedAt: null };
        /* 実行中の他の要求（一覧・詳細）の遅れて返る成功応答が、消した表示を復活させないよう、保留中の要求を無効化する。 */
        listSeq++; detailSeq++; slotSeq++; state.slots = IDLE_SLOTS;
      } else {
        state.phase = err.code === 'NOT_CONNECTED' ? 'not_connected' : 'error';
        state.stale = !!state.data;
      }
    }
    /* 状態「キャンセル除外」（初期表示）はバックエンドの絞り込み値ではない。台帳は従来どおり全件取得し、
       キャンセル済みだけを画面側で外して、件数も表示結果に合わせる。履歴は消さず、状態「キャンセル」「すべて」で確認できる。 */
    function withoutCancelled(res) {
      var items = res.items.filter(function (i) { return i.status !== 'CANCELLED'; });
      return Object.assign({}, res, { items: items, counts: Object.assign({}, res.counts, { matched: items.length }), applied: Object.assign({}, res.applied, { status: 'active' }) });
    }
    /* 運営枠（#1003）は予約台帳とは別の要求。失敗しても予約一覧は壊さず、取得失敗として別に表示する（0件にしない）。 */
    function loadSlots() {
      var mine = ++slotSeq;
      if (!api.internalSlots) { state.slots = IDLE_SLOTS; return; }
      state.slots = { phase: 'loading', data: null, error: null, fetchedAt: null };
      api.internalSlots(function (res) {
        if (mine !== slotSeq) return;
        if (res && res.ok && res.internalSlots && typeof res.internalSlots.state === 'string') {
          state.slots = { phase: 'ready', data: res.internalSlots, error: null, fetchedAt: res.fetchedAt || null };
        } else if (res && res.error && DENIED_CODES.indexOf(res.error.code) !== -1) {
          fail(res.error);
        } else {
          state.slots = { phase: 'error', data: null, error: res && res.error ? res.error : { message: '運営枠の取得に失敗しました。' }, fetchedAt: null };
        }
        emit();
      }, function () {
        if (mine !== slotSeq) return;
        state.slots = { phase: 'error', data: null, error: { message: '運営枠の取得に失敗しました。' }, fetchedAt: null };
        emit();
      });
    }
    function setKind(kind) {
      state.kind = KINDS.some(function (k) { return k[0] === kind; }) ? kind : 'all';
      emit();
    }
    function load(params) {
      var mine = ++listSeq;
      /* 要求した条件を保持する。台帳の取得に失敗しても、運営枠へ同じ期間・サービスの絞り込みをかけるため（#1003）。 */
      state.request = { service: params.service || 'all', status: params.status || 'all', scope: params.scope || 'upcoming', from: params.from || '', to: params.to || '' };
      var hideCancelled = params.status === 'active';
      if (hideCancelled) params = Object.assign({}, params, { status: 'all' });
      /* 詳細を開いたまま再取得した場合も、詳細を最新の台帳から取り直す。 */
      if (state.detailId !== null) openDetail(state.detailId);
      state.phase = 'loading';
      state.error = null;
      loadSlots();
      emit();
      api.list(params, function (res) {
        if (mine !== listSeq) return;
        if (res && res.ok) {
          state.data = hideCancelled ? withoutCancelled(res) : res; state.lastSuccessAt = res.fetchedAt; state.stale = false; state.error = null; state.phase = 'ready';
        } else {
          fail(res && res.error ? res.error : { code: 'FETCH_FAILED', message: '取得に失敗しました。' });
        }
        emit();
      }, function () {
        if (mine !== listSeq) return;
        fail({ code: 'FETCH_FAILED', message: '取得に失敗しました。', diagnostic: CLIENT_CALL_FAILED });
        emit();
      });
    }
    function openDetail(id) {
      var mine = ++detailSeq;
      state.detailId = id;
      state.detail = null; state.detailPhase = 'loading'; state.detailError = null;
      keySeq++; state.key = { phase: 'idle', data: null, error: null, fetchedAt: null };
      emit();
      api.detail(id, function (res) {
        if (mine !== detailSeq) return;
        if (res && res.ok) { state.detail = res.reservation; state.detailPhase = 'ready'; loadKey(id); }
        else {
          state.detailPhase = 'error'; state.detailError = res && res.error ? res.error : { message: '取得に失敗しました。' };
          if (res && res.error && DENIED_CODES.indexOf(res.error.code) !== -1) fail(res.error);
        }
        emit();
      }, function () {
        if (mine !== detailSeq) return;
        state.detailPhase = 'error'; state.detailError = { message: '取得に失敗しました。', diagnostic: CLIENT_CALL_FAILED };
        emit();
      });
    }
    /* 鍵・案内の状況（#942）は予約詳細とは別の要求。失敗しても詳細は壊さず、「未取得」と表示する（成功扱いにしない）。 */
    function loadKey(id) {
      var mine = ++keySeq;
      if (!api.keyStatus) { state.key = { phase: 'error', data: null, error: { message: 'この画面では鍵・案内の状況を取得できません。' }, fetchedAt: null }; return; }
      state.key = { phase: 'loading', data: null, error: null, fetchedAt: null };
      api.keyStatus(id, function (res) {
        if (mine !== keySeq) return;
        if (res && res.ok && res.keyStatus) state.key = { phase: 'ready', data: res.keyStatus, error: null, fetchedAt: res.fetchedAt || null };
        else state.key = { phase: 'error', data: null, error: res && res.error ? res.error : { message: '取得に失敗しました。' }, fetchedAt: null };
        emit();
      }, function () {
        if (mine !== keySeq) return;
        state.key = { phase: 'error', data: null, error: { message: '取得に失敗しました。', diagnostic: CLIENT_CALL_FAILED }, fetchedAt: null };
        emit();
      });
    }
    function closeDetail() { detailSeq++; keySeq++; state.detailId = null; state.detail = null; state.detailPhase = 'idle'; state.detailError = null; state.key = { phase: 'idle', data: null, error: null, fetchedAt: null }; emit(); }
    return { state: state, load: load, openDetail: openDetail, closeDetail: closeDetail, setKind: setKind };
  }

  /* 取得失敗の診断コード（#953）。サーバーが返す固定形式（STAGE/REASON[/HTTP]）だけを表示し、
     形式外の文字列は表示しない（生のエラー本文を画面へ出さない）。対応案はサーバー側の固定文。 */
  var DIAG_CODE_RE = /^(?:(?:META|HEADER|DATA|CLIENT)\/)?[A-Z][A-Z0-9_]{1,40}(?:\/\d{3})?$/;
  var CLIENT_CALL_FAILED = { code: 'CLIENT/CALL_FAILED', advice: '画面からバックエンドへの呼び出しに失敗しました（台帳の取得に入る前の失敗です）。専用URLを開き直し、Googleのログイン・承認画面が出たら完了してから再取得してください。続く場合はこの診断コードを開発担当へ共有してください。' };
  function renderDiag(err) {
    var d = err && err.diagnostic;
    if (!d || typeof d.code !== 'string' || !DIAG_CODE_RE.test(d.code)) return '';
    var advice = typeof d.advice === 'string' ? d.advice : '';
    return '<div class="diag">診断コード: <code>' + esc(d.code) + '</code>' + (advice ? '<br>' + esc(advice) : '') + '</div>';
  }

  function renderBanner(state) {
    var html = '';
    if (state.mock) html += '<div class="banner stale">モックデータ（架空）を表示しています。実際の予約ではありません。</div>';
    if (state.phase === 'loading') html += '<div class="banner loading" role="status">取得中…</div>';
    if (state.phase === 'denied') html += '<div class="banner err">' + esc(state.error.message) + '（予約情報は表示しません）</div>';
    if (state.phase === 'error' || state.phase === 'not_connected') {
      html += '<div class="banner err">' + esc(state.error.message) + renderDiag(state.error) + '</div>';
      if (state.stale) html += '<div class="banner stale">古いデータを表示しています（最終取得成功: ' + esc(jstText(state.lastSuccessAt, true) || state.lastSuccessAt) + ' JST）。最新ではありません。</div>';
    }
    if (state.phase === 'ready' && state.data) html += '<div class="banner">最終取得成功: ' + esc(jstText(state.lastSuccessAt, true) || state.lastSuccessAt) + ' JST</div>';
    return html;
  }

  function renderCard(item) {
    var phase = PHASE_LABELS[item.phase];
    return '<li><button type="button" class="card" data-id="' + esc(item.bookingId) + '">' +
      '<div class="top"><span class="tag">' + esc(item.serviceLabel) + '</span><span class="tag st-' + esc(item.status) + '">' + esc(item.statusLabel) + '</span>' + (phase ? '<span class="tag">' + esc(phase) + '</span>' : '') + '</div>' +
      '<div class="when">' + esc(item.date) + ' ' + show(jstText(item.startAt)) + '〜' + show(endLabel(item.startAt, item.endAt)) + '</div>' +
      '<div>' + show(item.name) + ' / ' + show(item.people, '名') + '</div>' +
      '<div class="note">' + esc(item.bookingId) + '</div><div class="more">タップで詳細・鍵の状況</div></button></li>';
  }

  function renderIssues(issues) {
    if (!issues || !issues.length) return '';
    var errors = issues.filter(function (i) { return i.severity === 'error'; }).length;
    var list = issues.map(function (i) {
      return '<li>' + esc(i.row) + '行目' + (i.bookingId ? '（' + esc(i.bookingId) + '）' : '') + ': ' + (i.severity === 'error' ? '【除外】' : '【注意】') + esc(i.reasons.join('、')) + '</li>';
    }).join('');
    return '<details><summary>確認が必要な行 ' + esc(issues.length) + '件（うち一覧から除外 ' + esc(errors) + '件）</summary><ul>' + list + '</ul></details>';
  }

  /* ---- 運営枠（#1003）。予約とは別の種類・別の件数で、詳細・鍵・現地払いへは進めない ---- */
  function slotCard(slot) {
    return '<li><div class="card slot" data-slot="1">' +
      '<div class="top"><span class="tag slot">運営枠</span><span class="tag">' + esc(slot.typeLabel) + '</span><span class="tag">' + esc(slot.placeLabel) + '</span>' + (slot.reminded ? '<span class="tag">リマインド済み</span>' : '') + '</div>' +
      '<div class="when">' + esc(slot.date) + ' ' + show(jstText(slot.startAt)) + '〜' + show(endLabel(slot.startAt, slot.endAt)) + '</div>' +
      '<div>' + show(slot.title) + '</div>' +
      '<div class="note">運営枠（閲覧専用）。予約の件数・売上には含みません。</div></div></li>';
  }

  /* 台帳の応答が無いときの代替。要求した条件から期間を同じ定義（今日から30日／過去30日、JST）で求める。 */
  function requestedRange(req) {
    if (!req) return null;
    function day(ms) { return new Date(ms).toISOString().slice(0, 10); }
    var DAY = 24 * 3600 * 1000;
    var today = Date.parse(day(Date.now() + 9 * 3600 * 1000));
    var from = req.from, to = req.to;
    if (req.scope === 'past') { to = to || day(today - DAY); from = from || day(Date.parse(to) - 29 * DAY); }
    else { from = from || day(today); to = to || day(Date.parse(from) + 29 * DAY); }
    return { service: req.service, status: req.status, from: from, to: to };
  }

  /* 取得に成功した運営枠だけを、予約と同じ条件（期間・サービス・状態）で絞る。取得失敗は null（0件と区別する）。 */
  function visibleSlots(state) {
    var s = state.slots;
    if (!s || s.phase !== 'ready' || !s.data || s.data.state !== 'ready') return null;
    /* 台帳の応答が最新の要求に対するもの（ready）のときだけ、その正規化済み applied を使う。再取得中・失敗後に残る前回の応答（古い条件）は使わず、
       画面で要求した最新の条件から絞る（予約一覧を古いデータとして残す挙動は変えない）。 */
    var a = state.phase === 'ready' && state.data && state.data.applied ? state.data.applied : requestedRange(state.request);
    /* 運営枠に「確定・仮予約」などの状態は無い。個別の状態で絞っているときは運営枠を出さない（0件とも言わない）。 */
    if (a && a.status !== 'active' && a.status !== 'all') return { items: [], statusHidden: true };
    var items = (s.data.slots || []).filter(function (x) {
      if (!a) return true;
      return x.date >= a.from && x.date <= a.to && (a.service === 'all' || x.service === a.service);
    });
    return { items: items, statusHidden: false };
  }

  function renderSlotStatus(state) {
    var s = state.slots;
    if (!s || s.phase === 'idle') return '';
    if (s.phase === 'loading') return '<div class="banner loading" role="status">運営枠を取得中…</div>';
    if (s.phase === 'error') return '<div class="banner err" role="alert">' + esc(s.error && s.error.message || '運営枠の取得に失敗しました。') + '運営枠が0件という意味ではありません（予約の一覧には影響しません）。</div>';
    var d = s.data;
    if (d.state !== 'ready') {
      return '<div class="banner err" role="alert">' + esc(SLOT_STATE_TEXT[d.state] || SLOT_STATE_TEXT.read_failed) + '運営枠が0件という意味ではありません（予約の一覧には影響しません）。</div>';
    }
    var html = '';
    if (d.invalid > 0) html += '<div class="banner stale">種類・場所のタグを読めない運営枠が ' + esc(d.invalid) + ' 件あり、表示していません（タグの不一致）。</div>';
    var v = visibleSlots(state);
    if (v.statusHidden) return html + '<p class="note">状態で絞り込み中のため、運営枠は表示していません。</p>';
    html += '<p class="note">運営枠 ' + esc(v.items.length) + ' 件（閲覧専用・予約の件数と売上には含みません。登録・変更・取消は Booking Admin の運営枠パネルで行います）</p>';
    if (!v.items.length) html += '<div class="banner">条件に該当する運営枠は0件です（取得は正常に完了しています）。</div>';
    return html;
  }

  /* 予約カードと運営枠カードを開始時刻の順に並べる（同時刻は予約が先）。 */
  function mergedCards(state, showRes, showSlots) {
    var order = state.data && state.data.applied && state.data.applied.order === 'desc' ? -1 : 1;
    var rows = [];
    if (showRes && state.data) state.data.items.forEach(function (i, n) { rows.push({ ms: Date.parse(i.startAt) || 0, rank: 0, n: n, html: renderCard(i) }); });
    var v = showSlots ? visibleSlots(state) : null;
    if (v) v.items.forEach(function (x, n) { rows.push({ ms: Date.parse(x.startAt) || 0, rank: 1, n: n, html: slotCard(x) }); });
    rows.sort(function (x, y) { return (x.ms - y.ms) * order || (x.rank - y.rank) || (x.n - y.n); });
    return rows.map(function (r) { return r.html; }).join('');
  }

  function renderList(state) {
    var d = state.data;
    var kind = state.kind || 'all';
    var showRes = kind !== 'slots';
    var showSlots = kind !== 'res';
    if (!d) {
      /* 予約台帳を読めなくても、運営枠は別ソースとして表示する（予約の取得失敗は上のバナーに出ている）。 */
      if (!showSlots) return '';
      var only = mergedCards(state, false, true);
      return renderSlotStatus(state) + (only ? '<ul class="cards">' + only + '</ul>' : '');
    }
    var a = d.applied;
    var html = '<p class="note">条件: ' + esc(a.from) + '〜' + esc(a.to) + '（日本時間 0:00〜翌0:00の重なり） / ' + esc(a.order === 'asc' ? '開始が早い順' : '開始が遅い順') +
      ' / 該当 ' + esc(d.counts.matched) + '件（台帳 ' + esc(d.counts.sheetRows) + '行を全件取得）</p>';
    var notConnected = d.serviceStates.filter(function (s) { return s.state === 'not_connected'; });
    if (notConnected.length) html += '<p class="note">未接続: ' + notConnected.map(function (s) { return esc(s.label); }).join('、') + '（0件ではなく、まだ取り込んでいません）</p>';
    if (showSlots) html += renderSlotStatus(state);
    if (showRes && d.notConnectedSelected) {
      html += '<div class="banner stale">選択したサービスは未接続です。予約が0件という意味ではありません。</div>';
    } else {
      if (showRes && !d.items.length) html += '<div class="banner">条件に該当する予約は0件です（取得は正常に完了しています）。</div>';
      var cards = mergedCards(state, showRes, showSlots);
      if (cards) html += '<ul class="cards">' + cards + '</ul>';
    }
    return html + (showRes ? renderIssues(d.issues) : '');
  }

  function renderDetail(state) {
    if (state.detailPhase === 'idle') return '';
    var html = '<div class="banner"><button type="button" id="detail-close">‹ 一覧へ戻る</button></div>';
    if (state.detailPhase === 'loading') return html + '<div class="banner">取得中…</div>';
    if (state.detailPhase === 'error') return html + '<div class="banner err">' + esc(state.detailError.message) + renderDiag(state.detailError) + '</div>';
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
    return html + '<dl>' + rows.map(function (x) { return '<dt>' + esc(x[0]) + '</dt><dd>' + x[1] + '</dd>'; }).join('') + '</dl>' + renderMailRecords(r) + renderKeyStatus(state) + renderOnsiteSlot(r) +
      '<p><button type="button" id="detail-to-tasks">メモ・期限を開く</button></p>';
  }

  /* 現地払い（カード決済でない）の予約にだけ、受領記録欄（#995。records-client.js が中身を描画）の差し込み先を置く。 */
  function renderOnsiteSlot(r) {
    return String(r.paymentMethod || '').trim() === 'オンラインクレジットカード' ? '' : '<div id="onsite-box"></div>';
  }

  /* 予約台帳のメール送信記録（#967。読み取り専用）。Bookingsの既存列を直接読んだ「送信記録」で、
     個別鍵の発行・暗証番号の別送・失効の状況ではない（それは下の鍵ブロックが別に示す）。
     「未送信」とは断定しない（空欄は「台帳上の記録なし」、列が無い場合は「確認不能」）。 */
  function mailRecordText(rec) {
    if (!rec || typeof rec !== 'object') return '<span class="empty">確認不能（台帳から読めません）</span>';
    if (rec.state === 'recorded') {
      var t = jstText(rec.at, true);
      return t === null ? '送信記録あり（日時を表示できません）' : '送信記録あり（' + esc(t) + ' JST）';
    }
    if (rec.state === 'none') return '<span class="empty">台帳上の記録なし</span>';
    if (rec.state === 'invalid') return '<span class="empty">日時不正・不明（台帳の値を日時として読めません）</span>';
    return '<span class="empty">確認不能（台帳に該当の項目がありません）</span>';
  }
  function renderMailRecords(r) {
    return '<h2>予約台帳のメール送信記録（読み取り専用）</h2><dl>' +
      '<dt>予約台帳／来場案内メール</dt><dd>' + mailRecordText(r.accessGuideMail) + '</dd>' +
      '<dt>予約台帳／確定メール</dt><dd>' + mailRecordText(r.confirmedMail) + '</dd></dl>' +
      '<p class="note">メールの送信記録です。個別鍵の登録・暗証番号の別送・解錠の成否を意味しません。</p>';
  }

  /* 鍵・案内の状況（#942。読み取り専用）。取得失敗・未接続・確認不能・不一致・要確認は別の表示。ジョブの稼働は別枠で、鍵の成功を意味しない。 */
  var TONE_CLASS = { ok: 'ok', info: '', warn: 'stale', ng: 'err' };
  function renderKeyStatus(state) {
    var k = state.key;
    var head = '<h2>鍵・案内の状況（読み取り専用）</h2>';
    if (!k || k.phase === 'idle') return '';
    if (k.phase === 'loading') return head + '<div class="banner">取得中…</div>';
    if (k.phase === 'error') return head + '<div class="banner err">未取得: ' + esc(k.error && k.error.message || '取得に失敗しました。') + renderDiag(k.error || {}) + '</div>';
    var d = k.data;
    var html = head;
    /* 主表示は個別鍵の実状態（#969）。メール送信記録・予約時刻では代用しない。下の照合結果は鍵の記録と予約台帳の突合。 */
    if (d.lifecycle) html += '<div class="banner ' + (TONE_CLASS[d.lifecycle.tone] || '') + '" data-lifecycle="' + esc(d.lifecycle.code) + '"><strong>個別鍵の状態: ' + esc(d.lifecycle.label) + '</strong>' + (d.lifecycle.alert ? '<div class="banner err" data-lifecycle-alert="1">⚠ 予約・案内との照合に警告があります。下の照合結果を必ず確認してください。</div>' : '') + '</div><p class="note">照合結果（鍵の記録と予約台帳の突合）:</p>';
    /* Bookings保存の過去の最終確認（#971）。Accessが正常にNONEで、保存値が現在の台帳と一致するときだけサーバーが返す。保存時点の確認結果で、現在の鍵の状態の保証ではない。 */
    if (d.savedFinal) html += '<div class="banner" data-saved-final="' + esc(d.savedFinal.code) + '"><strong>Bookings保存：過去の最終確認 — ' + esc(d.savedFinal.label) + '</strong><p class="note">保存時点の確認結果です。鍵の現在の状態を保証するものではありません。Accessの履歴は回収済みで、現行の記録はありません。</p></div>';
    html += '<div class="banner ' + (TONE_CLASS[d.verdict.tone] || '') + '" data-verdict="' + esc(d.verdict.code) + '"><strong>' + esc(d.verdict.label) + '</strong>';
    if (d.reasons && d.reasons.length) html += '<ul>' + d.reasons.map(function (x) { return '<li>' + esc(x.text) + '</li>'; }).join('') + '</ul>';
    html += '</div>';
    if (d.ops && d.ops.length) {
      html += '<ul class="cards">' + d.ops.map(function (o) {
        return '<li class="card"><div class="top"><span class="tag">' + esc(o.kindLabel) + '</span><span class="tag">改訂 ' + esc(o.rev === null ? '不明' : o.rev) + (o.current ? '（現在）' : '') + '</span></div>' +
          '<dl><dt>状態</dt><dd>' + esc(o.stateLabel) + '</dd>' +
          '<dt>鍵の有効時間</dt><dd>' + show(jstText(o.validFrom, true)) + ' 〜 ' + show(jstText(o.validTo, true)) + '</dd>' +
          (o.deliveryLabel ? '<dt>案内</dt><dd>' + esc(o.deliveryLabel) + '</dd>' : '') +
          '<dt>記録の更新</dt><dd>' + show(jstText(o.updatedAt, true)) + '</dd></dl></li>';
      }).join('') + '</ul>';
    }
    if (d.truncated) html += '<div class="banner stale">操作履歴は ' + esc(d.opCount) + ' 件あり、最新の分だけを読んでいます。</div>';
    (d.notes || []).forEach(function (n) { html += '<p class="note">' + esc(n) + '</p>'; });
    if (d.jobs && d.jobs.length) {
      html += '<details><summary>処理ジョブの稼働（予約ごとの鍵の成功ではありません）</summary><ul>' + d.jobs.map(function (j) {
        return '<li>' + esc(j.label) + ': ' + (j.ageMinutes === null ? '<span class="empty">記録なし</span>' : esc(j.ageMinutes) + '分前に実行') + '</li>';
      }).join('') + '</ul></details>';
    }
    html += '<p class="note">最終取得: ' + show(jstText(k.fetchedAt, true)) + '（JST）。参考表示です。実際に解錠できるかは確認していません。</p>';
    return html;
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
  function mount(doc, api, options) {
    var opts = options || {};
    function $(id) { return doc.getElementById(id); }
    $('f-service').innerHTML = optionsHtml(SERVICES);
    $('f-status').innerHTML = optionsHtml(STATUSES);
    $('f-kind').innerHTML = optionsHtml(KINDS);
    var ctl = createController(api, function (state) {
      $('banner').innerHTML = renderBanner(state);
      $('view').innerHTML = renderView(state);
      if (opts.onChange) opts.onChange(state);
    });
    var FILTER_IDS = { service: 'f-service', status: 'f-status', scope: 'f-scope', from: 'f-from', to: 'f-to' };
    /* ホーム（#990）が予約一覧と同じ絞り込みを共有するための入出力。値は画面の入力欄そのもの。 */
    function getFilters() {
      var f = {};
      Object.keys(FILTER_IDS).forEach(function (k) { f[k] = $(FILTER_IDS[k]).value; });
      return f;
    }
    function setFilters(f) {
      Object.keys(FILTER_IDS).forEach(function (k) { if (f && f[k] !== undefined) $(FILTER_IDS[k]).value = f[k]; });
    }
    function reload() { ctl.load(paramsFromInputs(getFilters())); }
    if (opts.initial) setFilters(opts.initial);
    ['f-service', 'f-status', 'f-scope', 'f-from', 'f-to'].forEach(function (id) { $(id).addEventListener('change', reload); });
    $('f-reload').addEventListener('click', reload);
    /* 運営枠の表示切替は画面側だけ（再取得しない）。 */
    $('f-kind').addEventListener('change', function () { ctl.setKind($('f-kind').value); });
    $('view').addEventListener('click', function (e) {
      var node = e.target;
      while (node && node !== $('view')) {
        if (node.id === 'detail-close') { ctl.closeDetail(); return; }
        if (node.id === 'detail-to-tasks') { var tab = $('tab-tasks'); if (tab) tab.click(); return; }
        if (node.getAttribute && node.getAttribute('data-id')) { ctl.openDetail(node.getAttribute('data-id')); return; }
        node = node.parentNode;
      }
    });
    reload();
    ctl.reload = reload; ctl.getFilters = getFilters; ctl.setFilters = setFilters;
    return ctl;
  }

  return { esc: esc, jstText: jstText, endLabel: endLabel, createController: createController, visibleSlots: visibleSlots, renderSlotStatus: renderSlotStatus, KINDS: KINDS, renderBanner: renderBanner, renderView: renderView,
    optionsHtml: optionsHtml, paramsFromInputs: paramsFromInputs, mount: mount, SERVICES: SERVICES, STATUSES: STATUSES, PHASE_LABELS: PHASE_LABELS };
});

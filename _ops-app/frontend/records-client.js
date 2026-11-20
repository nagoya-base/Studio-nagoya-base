/*
 * records-client.js — SNBC売上の記録／現地払いの受領記録の画面ロジック（Issue #995 PR-C）。
 *
 * - 通信方式に依存しない。バックエンドとは gas-adapter.js の createGasRecordsApi と同じ形のアダプター
 *   { snbcList, snbcSave, snbcDelete, onsiteGet, onsiteSave, onsiteDelete }（それぞれ (引数, ok, ng)）だけで話す。保存先ID・タブ名は扱わない。
 * - 入力検証・版・競合・二重計上の判断はサーバーが正本。ここは入力の整形と応答の描画だけ（年商の金額は計算しない）。
 * - 保存の成否は、サーバーが ok:true を返したときだけ成功と表示する。通信失敗は「保存できたか確認できていない」とし、成功にしない。入力は消さない。
 * - 二重送信: 保存中は再送しない。新規のイベントIDは入力フォームを開くたびに1つ採番し、失敗後の再送でも使い回す（サーバー側は上書きで冪等）。
 * - 氏名・電話・メール・DM本文は入力欄を設けない。描画は文字列をすべてエスケープする。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.OpsRecordsClient = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var DENIED_CODES = ['UNAUTHENTICATED', 'FORBIDDEN'];
  var CARD_METHOD = 'オンラインクレジットカード';
  var METHOD_OPTIONS = [['cash', '現金'], ['paypay', 'PayPay'], ['other', 'その他・混在']];
  var UNCONFIRMED = '保存できたか確認できていません。再読み込みして内容を確認してください（入力は残しています）。';

  function esc(value) {
    return String(value === null || value === undefined ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function yen(n) { return '¥' + Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
  function withHint(err) {
    var m = (err && err.message) || '';
    if (err && typeof err.hint === 'string' && err.hint) m += ' ' + err.hint;
    if (err && typeof err.reason === 'string' && /^[A-Z0-9_\/]{1,48}$/.test(err.reason)) m += '（診断コード: ' + err.reason + '）';
    return m;
  }
  function newId(prefix) {
    var chars = '0123456789abcdefghijklmnopqrstuvwxyz', s = '';
    for (var i = 0; i < 12; i++) s += chars.charAt(Math.floor(Math.random() * chars.length));
    return prefix + '-' + s;
  }
  /* 入力欄の文字列 → 整数円。空欄は ''（任意項目）。整数でなければ NaN。全角数字・カンマは受け付けない（誤入力を防ぐ）。 */
  function toInt(text) {
    var t = String(text === undefined || text === null ? '' : text).trim();
    if (t === '') return '';
    return /^\d{1,9}$/.test(t) ? Number(t) : NaN;
  }
  function field(label, html) { return '<label>' + esc(label) + html + '</label>'; }

  /* ===================== SNBC売上 ===================== */
  function emptySnbcForm() { return { eventId: newId('E'), eventDate: '', title: '', receivedJpy: '', refundedJpy: '0', paidCount: '', directCostJpy: '' }; }

  function createSnbcController(api, onChange, options) {
    var opts = options || {};
    var state = { phase: 'idle', items: [], storeReady: true, skipped: 0, today: null, error: null, open: false, form: emptySnbcForm(), editing: null, saving: false, message: null, formError: null, confirmDelete: false };
    var seq = 0;
    var formGen = 0; /* フォームの世代。保存・削除の完了時に、送信したフォームがまだ現在のものか判定する。 */
    function emit() { if (onChange) onChange(state); }
    function load() {
      var mine = ++seq;
      state.phase = state.items.length ? 'refreshing' : 'loading'; state.error = null; emit();
      api.snbcList(function (res) {
        if (mine !== seq) return;
        if (res && res.ok) { state.items = res.items || []; state.storeReady = res.storeReady !== false; state.skipped = res.skippedRows || 0; state.today = res.todayJst || null; state.phase = 'ready'; }
        else if (res && res.error && DENIED_CODES.indexOf(res.error.code) !== -1) { state.phase = 'denied'; state.error = res.error; }
        else { state.phase = 'error'; state.error = res && res.error ? res.error : { message: 'SNBC記録の取得に失敗しました。' }; }
        emit();
      }, function () {
        if (mine !== seq) return;
        state.phase = 'error'; state.error = { message: 'SNBC記録の取得に失敗しました（通信エラー）。' }; emit();
      });
    }
    function resetForm() { formGen++; state.form = emptySnbcForm(); state.editing = null; state.confirmDelete = false; state.formError = null; }
    function setOpen(on) {
      state.open = !!on; state.message = null;
      if (state.open) { resetForm(); load(); } else resetForm();
      emit();
    }
    function toggle() { setOpen(!state.open); }
    function setField(k, v) { if (Object.prototype.hasOwnProperty.call(state.form, k)) state.form[k] = v; }
    function edit(id) {
      if (state.saving) return; /* 保存・削除の進行中は編集対象を切り替えない（完了通知が別イベントの入力を消さないように） */
      var it = state.items.filter(function (x) { return x.eventId === id; })[0];
      if (!it) return;
      formGen++;
      state.editing = { eventId: it.eventId, revision: it.revision }; state.confirmDelete = false; state.message = null; state.formError = null;
      state.form = { eventId: it.eventId, eventDate: it.eventDate, title: it.title, receivedJpy: String(it.receivedJpy), refundedJpy: String(it.refundedJpy), paidCount: it.paidCount === '' ? '' : String(it.paidCount), directCostJpy: it.directCostJpy === '' ? '' : String(it.directCostJpy) };
      emit();
    }
    function cancelEdit() { resetForm(); state.message = null; emit(); }
    function buildInput() {
      var f = state.form;
      var rec = toInt(f.receivedJpy), ref = toInt(f.refundedJpy), cnt = toInt(f.paidCount), cost = toInt(f.directCostJpy);
      if (!String(f.eventDate).trim()) return { error: '開催日を入力してください。' };
      if (!String(f.title).trim()) return { error: 'イベント名を入力してください（参加者の情報は入れないでください）。' };
      if (rec === '' || rec !== rec) return { error: '受領総額は0以上の整数円で入力してください。' };
      if (ref === '' || ref !== ref || ref > rec) return { error: '返金済総額は0以上の整数円で、受領総額以下にしてください（返金が無ければ0）。' };
      if (cnt !== cnt) return { error: '有料人数は整数で入力してください（任意）。' };
      if (cost !== cost) return { error: '直接経費は整数円で入力してください（任意）。' };
      return { input: { eventId: f.eventId, eventDate: String(f.eventDate).trim(), title: String(f.title).trim(), receivedJpy: rec, refundedJpy: ref, paidCount: cnt, directCostJpy: cost } };
    }
    function save() {
      if (state.saving) return;
      var built = buildInput();
      if (built.error) { state.formError = built.error; emit(); return; }
      state.saving = true; state.formError = null; state.message = null; emit();
      var gen = formGen;
      api.snbcSave({ input: built.input, expectedRevision: state.editing ? state.editing.revision : null }, function (res) {
        state.saving = false;
        if (res && res.ok) {
          if (gen !== formGen) { load(); if (opts.onSaved) opts.onSaved(); emit(); return; } /* 別のフォームに切り替わっていれば触れない */
          state.message = res.replayed ? '保存済みです（同じ内容の再送でした。金額は重ねていません）。' : '保存しました。年商に反映します。';
          resetForm(); load(); if (opts.onSaved) opts.onSaved();
        } else {
          if (gen !== formGen) { emit(); return; }
          var err = res && res.error ? res.error : { message: UNCONFIRMED };
          state.formError = withHint(err);
          if (err.code === 'CONFLICT') { state.message = null; load(); }
          if (res && res.error && DENIED_CODES.indexOf(res.error.code) !== -1) state.phase = 'denied';
          emit();
        }
      }, function () { state.saving = false; state.formError = UNCONFIRMED; emit(); });
    }
    function askDelete() { if (state.editing) { state.confirmDelete = true; emit(); } }
    function cancelDelete() { state.confirmDelete = false; emit(); }
    function confirmDelete() {
      if (state.saving || !state.editing) return;
      state.saving = true; state.formError = null; emit();
      var gen = formGen;
      api.snbcDelete({ eventId: state.editing.eventId, expectedRevision: state.editing.revision }, function (res) {
        state.saving = false;
        if (gen !== formGen) { if (res && res.ok) { load(); if (opts.onSaved) opts.onSaved(); } emit(); return; }
        if (res && res.ok) { state.message = '削除しました。年商から外れます。'; resetForm(); load(); if (opts.onSaved) opts.onSaved(); }
        else { state.confirmDelete = false; state.formError = withHint(res && res.error ? res.error : { message: UNCONFIRMED }); if (res && res.error && res.error.code === 'CONFLICT') load(); emit(); }
      }, function () { state.saving = false; state.confirmDelete = false; state.formError = UNCONFIRMED; emit(); });
    }
    return { state: state, load: load, setOpen: setOpen, toggle: toggle, setField: setField, edit: edit, cancelEdit: cancelEdit, save: save, askDelete: askDelete, cancelDelete: cancelDelete, confirmDelete: confirmDelete };
  }

  function renderSnbc(state) {
    if (!state.open) return '';
    var head = '<h2 class="sec">SNBC売上を記録</h2>';
    if (state.phase === 'denied') return head + '<div class="banner err">この操作の権限がありません。</div>';
    var html = head + '<p class="note">開催後に1イベント1回、実際に受領を確認できた金額だけを入力します（DM・メモから転記。参加者名は入力しません）。将来の開催・見込みは入れないでください。</p>';
    if (state.phase === 'loading' && !state.items.length) html += '<div class="banner loading" role="status">取得中…</div>';
    if (state.phase === 'error') html += '<div class="banner err">' + esc(withHint(state.error)) + '<br><button type="button" class="inline" data-rec="snbc-reload">再取得</button></div>';
    if (state.storeReady === false && state.phase !== 'error') return html + '<div class="banner stale">保存先（既存メモ用スプレッドシート）が未設定のため、記録できません。</div><button type="button" class="inline" data-rec="snbc-close">閉じる</button>';
    if (state.skipped > 0) html += '<div class="banner stale">保存先の ' + esc(state.skipped) + ' 行が不正で読み込めていません（年商に含めていません）。</div>';
    if (state.message) html += '<div class="banner ok" role="status">' + esc(state.message) + '</div>';
    var f = state.form, editing = !!state.editing;
    html += '<form class="taskform" data-rec-form="snbc" novalidate><strong>' + (editing ? 'イベントを訂正' : 'イベントを追加') + '</strong>' +
      field('開催日（開催済みの日。今日を含む過去）', '<input type="date" data-f="eventDate" value="' + esc(f.eventDate) + '"' + (state.today ? ' max="' + esc(state.today) + '"' : '') + '>') +
      field('イベント名（必須・80文字まで）', '<input type="text" data-f="title" maxlength="80" autocomplete="off" value="' + esc(f.title) + '">') +
      field('実受領総額（円）', '<input type="text" inputmode="numeric" data-f="receivedJpy" autocomplete="off" value="' + esc(f.receivedJpy) + '">') +
      field('返金済総額（円。無ければ0）', '<input type="text" inputmode="numeric" data-f="refundedJpy" autocomplete="off" value="' + esc(f.refundedJpy) + '">') +
      field('有料人数（任意。年商には使いません）', '<input type="text" inputmode="numeric" data-f="paidCount" autocomplete="off" value="' + esc(f.paidCount) + '">') +
      field('直接経費（円・任意。年商から引きません）', '<input type="text" inputmode="numeric" data-f="directCostJpy" autocomplete="off" value="' + esc(f.directCostJpy) + '">');
    if (state.formError) html += '<div class="banner err" role="alert">' + esc(state.formError) + '</div>';
    if (state.confirmDelete) {
      html += '<div class="banner stale" role="alert"><strong>この1件を削除しますか？</strong>（年商から外れます）</div><div class="formbtns"><button type="button" data-rec="snbc-delete-yes"' + (state.saving ? ' disabled' : '') + '>削除する</button><button type="button" data-rec="snbc-delete-no">やめる</button></div>';
    } else {
      html += '<div class="formbtns"><button type="submit" id="rec-snbc-submit"' + (state.saving ? ' disabled' : '') + '>' + (state.saving ? '保存中…' : '保存') + '</button>' +
        (editing ? '<button type="button" data-rec="snbc-cancel">訂正をやめる</button>' : '<button type="button" data-rec="snbc-close">閉じる</button>') + '</div>' +
        (editing ? '<button type="button" class="inline" data-rec="snbc-delete">誤登録として削除…</button>' : '');
    }
    html += '</form>';
    html += '<h3 class="sub3">登録済みのイベント（開催日・差引売上）</h3>';
    if (!state.items.length && state.phase === 'ready') html += '<div class="banner">登録済みのイベントはありません（0円という意味ではなく、未入力です）。</div>';
    else html += '<ul class="rbreak">' + state.items.map(function (it) {
      return '<li><button type="button" class="mrow" data-rec="snbc-edit"' + (state.saving ? ' disabled' : '') + ' data-id="' + esc(it.eventId) + '" style="grid-template-columns:6.5em 1fr auto"><span>' + esc(it.eventDate) + '</span><span>' + esc(it.title) + '</span><b>' + esc(yen(it.net)) + '</b></button></li>';
    }).join('') + '</ul><p class="note">行を押すと訂正・削除できます。差引売上＝受領−返金（開催月に計上）。</p>';
    return html;
  }

  /* ===================== 現地払いの受領 ===================== */
  function emptyOnsiteForm() { return { receivedJpy: '', refundedJpy: '0', method: 'cash', receivedOn: '' }; }

  function createOnsiteController(api, onChange, options) {
    var opts = options || {};
    var state = { bookingId: null, ref: null, phase: 'idle', data: null, error: null, form: emptyOnsiteForm(), saving: false, message: null, formError: null, confirmDelete: false };
    var seq = 0;
    function emit() { if (onChange) onChange(state); }
    function fillFrom(rec) {
      state.form = rec ? { receivedJpy: String(rec.receivedJpy), refundedJpy: String(rec.refundedJpy), method: rec.method, receivedOn: rec.receivedOn } : emptyOnsiteForm();
    }
    function load(keepMessage) {
      var mine = ++seq;
      var id = state.bookingId;
      state.phase = 'loading'; state.error = null; if (!keepMessage) state.message = null; emit();
      api.onsiteGet(id, function (res) {
        if (mine !== seq || id !== state.bookingId) return;
        if (res && res.ok) { state.data = res; state.phase = 'ready'; fillFrom(res.record); }
        else if (res && res.error && DENIED_CODES.indexOf(res.error.code) !== -1) { state.phase = 'denied'; state.error = res.error; }
        else { state.phase = 'error'; state.error = res && res.error ? res.error : { message: '受領記録の取得に失敗しました。' }; }
        emit();
      }, function () {
        if (mine !== seq || id !== state.bookingId) return;
        state.phase = 'error'; state.error = { message: '受領記録の取得に失敗しました（通信エラー）。' }; emit();
      });
    }
    /* 予約詳細（ops-client の state）が変わるたびに呼ぶ。現地払いの予約だけが対象。 */
    function sync(opsState) {
      var d = opsState && opsState.detailPhase === 'ready' ? opsState.detail : null;
      var eligible = d && String(d.paymentMethod || '').trim() !== CARD_METHOD;
      if (!eligible) {
        if (state.bookingId !== null) { seq++; state.bookingId = null; state.ref = null; state.phase = 'idle'; state.data = null; state.message = null; state.formError = null; state.confirmDelete = false; state.saving = false; state.form = emptyOnsiteForm(); }
        return;
      }
      state.ref = { bookingId: d.bookingId, date: d.date, serviceLabel: d.serviceLabel, price: d.effectivePriceAmount, cancelled: d.status === 'CANCELLED' };
      if (state.bookingId !== d.bookingId) { state.saving = false; state.bookingId = d.bookingId; state.data = null; state.message = null; state.formError = null; state.confirmDelete = false; state.form = emptyOnsiteForm(); load(); }
    }
    function setField(k, v) { if (Object.prototype.hasOwnProperty.call(state.form, k)) state.form[k] = v; }
    function save() {
      if (state.saving) return;
      var f = state.form, rec = toInt(f.receivedJpy), ref = toInt(f.refundedJpy);
      var err = null;
      if (rec === '' || rec !== rec) err = '受け取った累計金額は0以上の整数円で入力してください（0円でも、実際に確認した場合は0と入力）。';
      else if (ref === '' || ref !== ref || ref > rec) err = '返金済みの累計金額は0以上の整数円で、受領額以下にしてください（返金が無ければ0）。';
      else if (!String(f.receivedOn).trim()) err = '受領確認日を入力してください。';
      if (err) { state.formError = err; emit(); return; }
      state.saving = true; state.formError = null; state.message = null; emit();
      var rev = state.data && state.data.record ? state.data.record.revision : null;
      var id = state.bookingId; /* 送信時の予約。応答が戻ったときに別の予約を開いていたら、その予約の入力・表示には触れない。 */
      /* 取消済みの予約での保存は、返金結果の再確認（金額が同じでも確認日時を進める）としてサーバーへ明示する。 */
      api.onsiteSave({ input: { bookingId: id, receivedJpy: rec, refundedJpy: ref, method: f.method, receivedOn: String(f.receivedOn).trim() }, expectedRevision: rev, reconfirm: !!(state.ref && state.ref.cancelled) }, function (res) {
        if (id !== state.bookingId) { if (res && res.ok && opts.onSaved) opts.onSaved(); return; }
        state.saving = false;
        if (res && res.ok) { state.message = res.replayed ? '保存済みです（同じ内容の再送でした。金額は重ねていません）。' : '受領を記録しました。利用終了後に年商へ反映します。'; load(true); if (opts.onSaved) opts.onSaved(); }
        else { var e = res && res.error ? res.error : { message: UNCONFIRMED }; state.formError = withHint(e); if (e.code === 'CONFLICT') load(); emit(); }
      }, function () { if (id !== state.bookingId) return; state.saving = false; state.formError = UNCONFIRMED; emit(); });
    }
    function askDelete() { state.confirmDelete = true; emit(); }
    function cancelDelete() { state.confirmDelete = false; emit(); }
    function confirmDelete() {
      if (state.saving || !state.data || !state.data.record) return;
      state.saving = true; state.formError = null; emit();
      var id = state.bookingId;
      api.onsiteDelete({ bookingId: id, expectedRevision: state.data.record.revision }, function (res) {
        if (id !== state.bookingId) { if (res && res.ok && opts.onSaved) opts.onSaved(); return; }
        state.saving = false; state.confirmDelete = false;
        if (res && res.ok) { state.message = '記録を削除しました。'; load(true); if (opts.onSaved) opts.onSaved(); }
        else { state.formError = withHint(res && res.error ? res.error : { message: UNCONFIRMED }); if (res && res.error && res.error.code === 'CONFLICT') load(); emit(); }
      }, function () { if (id !== state.bookingId) return; state.saving = false; state.confirmDelete = false; state.formError = UNCONFIRMED; emit(); });
    }
    return { state: state, sync: sync, load: load, setField: setField, save: save, askDelete: askDelete, cancelDelete: cancelDelete, confirmDelete: confirmDelete };
  }

  function renderOnsite(state) {
    if (state.phase === 'idle' || !state.ref) return '';
    var head = '<h2>現地払いの受領を記録</h2>';
    if (state.phase === 'loading' && !state.data) return head + '<div class="banner loading" role="status">取得中…</div>';
    if (state.phase === 'denied') return head + '<div class="banner err">この操作の権限がありません。</div>';
    if (state.phase === 'error') return head + '<div class="banner err">' + esc(withHint(state.error)) + '<br><button type="button" class="inline" data-rec="onsite-reload">再取得</button></div>';
    var d = state.data, rec = d.record, r = state.ref;
    var html = head + '<dl><dt>予約ID</dt><dd>' + esc(r.bookingId) + '</dd><dt>利用日</dt><dd>' + esc(r.date) + '</dd><dt>ブランド</dt><dd>' + esc(r.serviceLabel) + '</dd>' +
      '<dt>現在の予定料金</dt><dd>' + (r.price === null || r.price === undefined ? '未計算' : esc(yen(r.price))) + '（参考値。実際の受領額として自動確定しません）</dd></dl>';
    if (d.storeReady === false) return html + '<div class="banner stale">保存先（既存メモ用スプレッドシート）が未設定のため、記録できません。</div>';
    if (state.message) html += '<div class="banner ok" role="status">' + esc(state.message) + '</div>';
    if (d.ledgerReceipt) {
      html += '<div class="banner ok" data-ledger="1"><strong>台帳に記録あり</strong>（カード決済済み、または予約台帳に受領額の記録があります）。台帳を正本とするため、ここでの新規記録は不要です（重複計上の防止）。</div>';
      if (rec) html += '<div class="banner stale" role="alert">手入力の受領記録も残っています（受領 ' + esc(yen(rec.receivedJpy)) + '・返金済 ' + esc(yen(rec.refundedJpy)) + '）。台帳と重複するため年商では「要確認」になります。不要なら削除してください。</div>' +
        (state.confirmDelete ? '<div class="formbtns"><button type="button" data-rec="onsite-delete-yes"' + (state.saving ? ' disabled' : '') + '>削除する</button><button type="button" data-rec="onsite-delete-no">やめる</button></div>' : '<button type="button" class="inline" data-rec="onsite-delete">手入力の記録を削除…</button>');
      if (state.formError) html += '<div class="banner err" role="alert">' + esc(state.formError) + '</div>';
      return html;
    }
    html += '<p class="note">実際に受け取ったことを確認できたときだけ記録してください。金額は取引ごとではなく<strong>累計</strong>です。売上への計上は利用終了後（取消後は取消確定月）です。</p>';
    html += rec ? '<div class="banner" data-recorded="1">記録済み: 受領 ' + esc(yen(rec.receivedJpy)) + '・返金済 ' + esc(yen(rec.refundedJpy)) + '・' + esc(rec.methodLabel) + '・確認日 ' + esc(rec.receivedOn) + '</div>'
      : '<div class="banner">まだ記録がありません（未入力。0円という意味ではありません）。</div>';
    var f = state.form;
    html += '<form class="taskform" data-rec-form="onsite" novalidate>' +
      field('受け取った累計金額（円）', '<input type="text" inputmode="numeric" data-f="receivedJpy" autocomplete="off" value="' + esc(f.receivedJpy) + '">') +
      field('完了した返金の累計金額（円。無ければ0）', '<input type="text" inputmode="numeric" data-f="refundedJpy" autocomplete="off" value="' + esc(f.refundedJpy) + '">') +
      field('方法', '<select data-f="method">' + METHOD_OPTIONS.map(function (o) { return '<option value="' + esc(o[0]) + '"' + (f.method === o[0] ? ' selected' : '') + '>' + esc(o[1]) + '</option>'; }).join('') + '</select>') +
      field('受領確認日', '<input type="date" data-f="receivedOn" value="' + esc(f.receivedOn) + '"' + (d.todayJst ? ' max="' + esc(d.todayJst) + '"' : '') + '>');
    if (state.formError) html += '<div class="banner err" role="alert">' + esc(state.formError) + '</div>';
    if (state.confirmDelete) {
      html += '<div class="banner stale" role="alert"><strong>この予約の受領記録を削除しますか？</strong></div><div class="formbtns"><button type="button" data-rec="onsite-delete-yes"' + (state.saving ? ' disabled' : '') + '>削除する</button><button type="button" data-rec="onsite-delete-no">やめる</button></div>';
    } else {
      html += '<div class="formbtns"><button type="submit" id="rec-onsite-submit"' + (state.saving ? ' disabled' : '') + '>' + (state.saving ? '保存中…' : r.cancelled && rec ? '取消後の返金結果を再確認して保存' : rec ? '訂正して保存' : '受領を記録') + '</button>' +
        (rec ? '<button type="button" data-rec="onsite-delete">誤登録として削除…</button>' : '') + '</div>';
    }
    return html + '</form>';
  }

  /* 現地払い欄の差し込み先。ops-client の予約詳細が、現地払いの予約にだけ置く。 */
  var ONSITE_BOX = '<div id="onsite-box"></div>';

  /*
   * DOMへの結線（ブラウザーでのみ呼ぶ）。api は { snbcList, snbcSave, snbcDelete, onsiteGet, onsiteSave, onsiteDelete }。
   * options.onSaved(): 保存・削除に成功したとき（年商を再取得する）。
   */
  function mount(doc, api, options) {
    var opts = options || {};
    function $(id) { return doc.getElementById(id); }
    var snbc = createSnbcController(api, function () { var el = $('snbc-view'); if (el) el.innerHTML = renderSnbc(snbc.state); }, opts);
    var onsite = createOnsiteController(api, function () { var el = $('onsite-box'); if (el) el.innerHTML = renderOnsite(onsite.state); }, opts);
    function delegate(root, getCtl, prefix) {
      root.addEventListener('input', function (e) { var k = e.target && e.target.getAttribute && e.target.getAttribute('data-f'); if (k && root.contains(e.target)) getCtl().setField(k, e.target.value); });
      root.addEventListener('change', function (e) { var k = e.target && e.target.getAttribute && e.target.getAttribute('data-f'); if (k) getCtl().setField(k, e.target.value); });
      root.addEventListener('submit', function (e) { var f = e.target && e.target.getAttribute && e.target.getAttribute('data-rec-form'); if (f === prefix) { e.preventDefault(); getCtl().save(); } });
      root.addEventListener('click', function (e) {
        var node = e.target;
        while (node && node !== root) {
          var act = node.getAttribute && node.getAttribute('data-rec');
          if (act && act.indexOf(prefix + '-') === 0) {
            var c = getCtl(), a = act.slice(prefix.length + 1);
            if (a === 'edit') c.edit(node.getAttribute('data-id'));
            else if (a === 'cancel') c.cancelEdit();
            else if (a === 'close') c.setOpen(false);
            else if (a === 'reload') c.load();
            else if (a === 'delete') c.askDelete();
            else if (a === 'delete-yes') c.confirmDelete();
            else if (a === 'delete-no') c.cancelDelete();
            return;
          }
          node = node.parentNode;
        }
      });
    }
    if ($('snbc-view')) delegate($('snbc-view'), function () { return snbc; }, 'snbc');
    if ($('view')) delegate($('view'), function () { return onsite; }, 'onsite');
    /* 予約タブの変更通知から呼ぶ。詳細が再描画されても入力中の内容は state に残っている。 */
    function syncOnsite(opsState) { onsite.sync(opsState); var el = $('onsite-box'); if (el) el.innerHTML = renderOnsite(onsite.state); }
    return { snbc: snbc, onsite: onsite, toggleSnbc: function () { snbc.toggle(); }, syncOnsite: syncOnsite };
  }

  return { esc: esc, yen: yen, toInt: toInt, createSnbcController: createSnbcController, createOnsiteController: createOnsiteController,
    renderSnbc: renderSnbc, renderOnsite: renderOnsite, mount: mount, ONSITE_BOX: ONSITE_BOX, CARD_METHOD: CARD_METHOD };
});

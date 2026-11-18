/*
 * tasks-client.js — 未対応メモと期限管理のフロントエンド画面ロジック（Issue #941）。
 *
 * - 通信方式に依存しない。バックエンドとは「メモ用の接続契約」（docs/ops-tasks-941.md §4）を満たす
 *   アダプター { list(ok, ng), save(payload, ok, ng), remove(payload, ok, ng) } を介してのみ話す。
 * - 権限・版・期限超過・保持期限は独自に確定しない（バックエンドの応答を描画するだけ）。入力検証の正本はサーバー。
 * - 保存の成否は「バックエンドが ok:true を返し、照合済みの task を返した」場合だけ成功と表示する。
 *   通信失敗・タイムアウト・応答不正は「保存できたか確認できていない」と表示し、成功にしない。入力は消さない。
 * - 二重送信: 保存中は再送しない。新規は端末が採番したID（新規フォームを開くたびに1つ）を失敗後の再送でも使い回し、
 *   サーバーが同じ内容の再送を重複させない。
 * - 競合: 上書きしない。サーバーが返した最新内容を示し、入力は残す（保存し直すと明示的に上書きする）。
 * - 描画は文字列をすべてエスケープして行う。遅れて返った古い一覧応答は破棄する。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.OpsTasksClient = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var STATUS_OPTIONS = [['todo', '未対応'], ['doing', '対応中'], ['done', '完了']];
  var SERVICE_OPTIONS = [['', '（なし・予約と無関係）'], ['snb', 'SNB'], ['studio_x', 'Studio X'], ['snb_mens', 'SNB Mens'], ['snb_community', 'SNB Community'], ['unclassified', '未分類']];
  var DENIED_CODES = ['UNAUTHENTICATED', 'FORBIDDEN'];
  /* サーバーが返す固定の対応案と診断コード（許可リスト由来。IDや応答本文は含まれない）を、原因を断定せずに添える。 */
  function withHint(err) {
    var m = (err && err.message) || '';
    if (err && typeof err.hint === 'string' && err.hint) m += ' ' + err.hint;
    if (err && typeof err.reason === 'string' && /^[A-Z0-9_\/]{1,48}$/.test(err.reason)) m += '（診断コード: ' + err.reason + '）';
    return m;
  }
  var UNCONFIRMED = '保存できたか確認できていません。一覧を再読み込みして内容を確認してください（入力は残しています）。';

  function esc(value) {
    return String(value === null || value === undefined ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function jstText(iso) {
    if (typeof iso !== 'string') return null;
    var ms = Date.parse(iso);
    if (isNaN(ms)) return null;
    var d = new Date(ms + 9 * 3600 * 1000);
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate()) + ' ' + p(d.getUTCHours()) + ':' + p(d.getUTCMinutes());
  }

  /* 新規メモの端末採番ID（サーバーの形式 T-[0-9a-z]{8,32}）。重複送信の冪等キー。 */
  function newTaskId() {
    var s = '';
    var c = typeof crypto !== 'undefined' && crypto && typeof crypto.getRandomValues === 'function' ? crypto : null;
    while (s.length < 12) {
      var n;
      if (c) { var a = new Uint32Array(1); c.getRandomValues(a); n = a[0]; } else { n = Math.floor(Math.random() * 4294967296); }
      s += n.toString(36);
    }
    return 'T-' + s.slice(0, 12);
  }

  /* 画面の入力 → サーバーへ送る項目（許可された項目だけ。保存先・版などは含めない）。 */
  function inputFromFields(f) {
    return { taskId: f.taskId, title: f.title, bookingId: f.bookingId, service: f.service, status: f.status, memo: f.memo, dueDate: f.dueDate, evidenceUrl: f.evidenceUrl };
  }

  function contentOf(task, status) {
    return { taskId: task.taskId, title: task.title, bookingId: task.bookingId, service: task.service, status: status || task.status, memo: task.memo, dueDate: task.dueDate, evidenceUrl: task.evidenceUrl };
  }

  function createController(api, onChange) {
    var state = {
      phase: 'idle', data: null, error: null, lastSuccessAt: null, stale: false,
      save: { phase: 'idle', message: '', current: null, at: null },
      showDone: false, expanded: {}, mock: !!(api && api.kind === 'mock')
    };
    var listSeq = 0;
    function emit() { if (onChange) onChange(state); }

    function deny(err) {
      state.error = err; state.phase = 'denied'; state.data = null; state.stale = false;
      state.save = { phase: 'idle', message: '', current: null, at: null };
      listSeq++; /* 遅れて返る成功応答が、消した表示を復活させない */
    }

    function load(quiet) {
      var mine = ++listSeq;
      if (!quiet) { state.phase = 'loading'; state.error = null; emit(); }
      api.list(function (res) {
        if (mine !== listSeq) return;
        if (res && res.ok) {
          state.data = res; state.lastSuccessAt = res.fetchedAt; state.stale = false; state.error = null; state.phase = 'ready';
        } else if (res && res.error && DENIED_CODES.indexOf(res.error.code) !== -1) {
          deny(res.error);
        } else {
          state.error = res && res.error ? res.error : { code: 'STORE_FAILED', message: 'メモの取得に失敗しました。' };
          state.phase = 'error'; state.stale = !!state.data;
        }
        emit();
      }, function () {
        if (mine !== listSeq) return;
        state.error = { code: 'STORE_FAILED', message: 'メモの取得に失敗しました（通信エラー）。' };
        state.phase = 'error'; state.stale = !!state.data;
        emit();
      });
    }

    /* 保存・削除の共通の結果処理。失敗を成功にしない。 */
    function finish(res, okMessage) {
      if (res && res.ok) {
        state.save = { phase: 'saved', message: okMessage(res), current: null, at: res.fetchedAt || null };
        emit();
        load(true);
        return true;
      }
      var err = res && res.error ? res.error : null;
      if (err && DENIED_CODES.indexOf(err.code) !== -1) { deny(err); emit(); return false; }
      if (err && err.code === 'CONFLICT') {
        state.save = { phase: 'conflict', message: err.message || '別の端末・操作で先に更新されています。', current: err.current || null, at: null };
        emit();
        load(true);
        return false;
      }
      state.save = { phase: 'failed', message: withHint(err) || UNCONFIRMED, current: null, at: null, code: err ? err.code : null };
      emit();
      return false;
    }
    function failedCall() {
      state.save = { phase: 'failed', message: '通信に失敗しました。' + UNCONFIRMED, current: null, at: null, code: 'NETWORK' };
      emit();
    }

    /* payload: { input, expectedRevision|null }。保存中は受け付けない（二重送信防止）。 */
    function save(input, expectedRevision, done) {
      if (state.save.phase === 'saving') return false;
      state.save = { phase: 'saving', message: '保存中…', current: null, at: null };
      emit();
      var settled = false;
      api.save({ input: input, expectedRevision: expectedRevision === undefined ? null : expectedRevision }, function (res) {
        if (settled) return; settled = true;
        var ok = finish(res, function (r) { return r.replayed ? '保存済みでした（重複して追加していません）。' : r.unchanged ? '変更はありません（保存済みの内容と同じです）。' : '保存しました。'; });
        if (done) done(ok);
      }, function () {
        if (settled) return; settled = true;
        failedCall();
        if (done) done(false);
      });
      return true;
    }

    function remove(task, done) {
      if (state.save.phase === 'saving') return false;
      state.save = { phase: 'saving', message: '削除中…', current: null, at: null };
      emit();
      var settled = false;
      api.remove({ taskId: task.taskId, expectedRevision: task.revision }, function (res) {
        if (settled) return; settled = true;
        var ok = finish(res, function (r) { return r.alreadyDeleted ? 'すでに削除されています。' : '削除しました。'; });
        if (done) done(ok);
      }, function () {
        if (settled) return; settled = true;
        failedCall();
        if (done) done(false);
      });
      return true;
    }

    function setStatus(task, status, done) { return save(contentOf(task, status), task.revision, done); }
    function toggleDone() { state.showDone = !state.showDone; emit(); }
    function toggleOpen(id) { state.expanded[id] = !state.expanded[id]; emit(); }
    function find(id) {
      var hit = null;
      ((state.data && state.data.items) || []).forEach(function (t) { if (t.taskId === id) hit = t; });
      return hit;
    }

    return { state: state, load: load, save: save, remove: remove, setStatus: setStatus, toggleDone: toggleDone, toggleOpen: toggleOpen, find: find };
  }

  function renderBanner(state) {
    var html = '';
    if (state.mock) html += '<div class="banner stale">モックデータ（架空）です。実際のメモは保存されません。</div>';
    if (state.phase === 'loading') html += '<div class="banner loading" role="status">取得中…</div>';
    if (state.phase === 'denied') html += '<div class="banner err">' + esc(state.error.message) + '（メモは表示しません）</div>';
    if (state.phase === 'error') {
      html += '<div class="banner err">' + esc(withHint(state.error)) + '</div>';
      if (state.stale) html += '<div class="banner stale">古い内容を表示しています（最終取得成功: ' + esc(jstText(state.lastSuccessAt) || state.lastSuccessAt) + ' JST）。最新ではありません。</div>';
    }
    var s = state.save;
    if (s.phase === 'saving') html += '<div class="banner" role="status">' + esc(s.message) + '</div>';
    if (s.phase === 'saved') html += '<div class="banner ok" role="status">' + esc(s.message) + '</div>';
    if (s.phase === 'failed') html += '<div class="banner err" role="alert">保存に失敗しました: ' + esc(s.message) + '</div>';
    if (s.phase === 'conflict') {
      html += '<div class="banner err" role="alert">' + esc(s.message) + '<br>最新の内容を読み込みました。入力欄の内容で上書きする場合は、もう一度「保存」を押してください。' +
        (s.current ? '<br>先に保存されている内容: 「' + esc(s.current.title) + '」/ ' + esc(s.current.statusLabel) + ' / 更新 ' + esc(jstText(s.current.updatedAt) || '') + ' JST' : '') + '</div>';
    }
    var d = state.data;
    if (state.phase === 'ready' && d) {
      if (d.skippedRows > 0) html += '<div class="banner err" role="alert">保存先の ' + esc(d.skippedRows) + ' 行を読み込めませんでした。一覧・件数は不完全です（未対応のメモが表示されていない可能性があります）。メモ専用スプレッドシートの該当行（taskId・状態・版番号）を確認・修正してください。</div>';
      if (d.storeReady === false) html += '<div class="banner stale">メモの保存先が未設定です（OPS_TASKS_SPREADSHEET_ID）。予約台帳とは別の専用スプレッドシートを設定すると保存できます。ファイルは自動では作りません。</div>';
      if (d.purge && d.purge.deleted > 0) html += '<div class="banner">完了から' + esc(d.retentionDays) + '日を過ぎたメモ ' + esc(d.purge.deleted) + '件を削除しました。</div>';
      if (d.purge && d.purge.failed) html += '<div class="banner stale">期限切れメモの削除に失敗しました（次回の取得で再試行します）。</div>';
      html += '<div class="note">最終取得成功: ' + esc(jstText(state.lastSuccessAt) || state.lastSuccessAt) + ' JST</div>';
    }
    return html;
  }

  function renderSummary(state) {
    var d = state.data;
    if (!d || state.phase === 'denied') return '';
    var c = d.counts;
    return '<div class="summary"><span class="tag">未完了 ' + esc(c.open) + '件</span> ' +
      '<span class="tag ' + (c.overdue ? 'danger' : '') + '">期限超過 ' + esc(c.overdue) + '件</span>' +
      (c.stale ? ' <span class="tag">見直し ' + esc(c.stale) + '件</span>' : '') +
      (d.skippedRows > 0 ? ' <span class="tag danger">一覧は不完全（読込不可 ' + esc(d.skippedRows) + '行）</span>' : '') + '</div>';
  }

  function renderCard(t, busy, open) {
    var dis = busy ? ' disabled' : '';
    var tags = '<span class="tag">' + esc(t.statusLabel) + '</span>';
    if (t.overdue) tags += '<span class="tag danger">期限超過</span>';
    if (t.stale) tags += '<span class="tag">' + '更新なし・要見直し</span>';
    var service = '';
    SERVICE_OPTIONS.forEach(function (o) { if (o[0] && o[0] === t.service) service = o[1]; });
    if (service) tags += '<span class="tag">' + esc(service) + '</span>';
    var meta = [];
    if (t.dueDate) meta.push('期限 ' + esc(t.dueDate));
    if (t.bookingId) meta.push('予約ID ' + esc(t.bookingId));
    meta.push('更新 ' + esc(jstText(t.updatedAt) || '') + ' JST');
    var link = /^https:\/\/[^\s<>"'\\@]+$/.test(t.evidenceUrl || '') ? '<div><a href="' + esc(t.evidenceUrl) + '" target="_blank" rel="noopener noreferrer">証跡リンク（新しいタブで開く）</a></div>' : '';
    var quick = STATUS_OPTIONS.filter(function (o) { return o[0] !== t.status; }).map(function (o) {
      return '<button type="button" data-act="status" data-id="' + esc(t.taskId) + '" data-status="' + esc(o[0]) + '"' + dis + '>' + esc(o[1]) + 'にする</button>';
    }).join('');
    return '<li class="card task' + (t.overdue ? ' overdue' : '') + '"><button type="button" class="taskhead" data-act="open" data-id="' + esc(t.taskId) + '" aria-expanded="' + (open ? 'true' : 'false') + '"><div class="top">' + tags + '</div>' +
      '<div class="when">' + esc(t.title) + '</div>' +
      '<div class="note">' + meta.join(' / ') + '</div></button>' +
      (t.memo ? '<div class="memo">' + esc(t.memo) + '</div>' : '') + link +
      '<div class="actions"' + (open ? '' : ' hidden') + '>' + quick + '<button type="button" data-act="edit" data-id="' + esc(t.taskId) + '"' + dis + '>編集</button><button type="button" data-act="delete" data-id="' + esc(t.taskId) + '"' + dis + '>削除</button></div></li>';
  }

  function renderList(state) {
    var d = state.data;
    if (!d) return '';
    var busy = state.save.phase === 'saving';
    var skipped = d.skippedRows > 0;
    var overdue = d.items.filter(function (t) { return t.overdue; });
    var open = d.items.filter(function (t) { return !t.overdue && t.status !== 'done'; });
    var done = d.items.filter(function (t) { return t.status === 'done'; });
    var html = '';
    if (overdue.length) html += '<h2>期限超過（' + esc(overdue.length) + '件）</h2><ul class="cards">' + overdue.map(function (t) { return renderCard(t, busy, state.expanded[t.taskId]); }).join('') + '</ul>';
    html += '<h2>未対応・対応中（' + esc(open.length) + '件）</h2>';
    html += open.length ? '<ul class="cards">' + open.map(function (t) { return renderCard(t, busy, state.expanded[t.taskId]); }).join('') + '</ul>' : (skipped ? '<div class="banner stale">表示できる未完了のメモはありません。ただし読み込めない行があるため、一覧は不完全です。</div>' : '<div class="banner">未対応のメモはありません（取得は正常に完了しています）。</div>');
    html += '<h2>完了（' + esc(done.length) + '件）</h2><button type="button" data-act="toggle-done">' + (state.showDone ? '完了を隠す' : '完了を表示') + '</button>';
    if (state.showDone) html += done.length ? '<ul class="cards">' + done.map(function (t) { return renderCard(t, busy, state.expanded[t.taskId]); }).join('') + '</ul>' : '<div class="banner">完了したメモはありません。</div>';
    html += '<p class="note">完了から' + esc(d.retentionDays) + '日を過ぎたメモは自動で削除されます（完了後に編集すると起算が更新されます）。未完了のメモは自動削除されません。</p>';
    return html;
  }

  function optionsHtml(list) {
    return list.map(function (o) { return '<option value="' + esc(o[0]) + '">' + esc(o[1]) + '</option>'; }).join('');
  }

  /* DOMへの結線（ブラウザーでのみ呼ぶ）。api はメモ用の契約アダプター。 */
  function mount(doc, api, options) {
    var opts = options || {};
    function $(id) { return doc.getElementById(id); }
    var confirmFn = opts.confirm || function (m) { return typeof confirm === 'function' ? confirm(m) : false; };
    $('t-service').innerHTML = optionsHtml(SERVICE_OPTIONS);
    $('t-status').innerHTML = optionsHtml(STATUS_OPTIONS);
    var editing = { revision: null, taskId: null };
    var FIELD_IDS = ['t-title', 't-service', 't-booking', 't-status', 't-due', 't-memo', 't-url'];
    function snapshot() { return FIELD_IDS.map(function (id) { return $(id).value; }).join('\u0001'); }
    /* 保存中は下書きを切り替える操作・編集を止める（保存した下書きと別の入力を、遅れて返った応答が閉じない）。 */
    function setBusy(busy) {
      FIELD_IDS.concat(['t-cancel', 't-new']).forEach(function (id) { $(id).disabled = busy; });
    }

    var ctl = createController(api, function (state) {
      $('tasks-banner').innerHTML = renderBanner(state);
      $('tasks-summary').innerHTML = renderSummary(state);
      $('tasks-view').innerHTML = renderList(state);
      $('t-submit').disabled = state.save.phase === 'saving';
      $('t-submit').textContent = state.save.phase === 'saving' ? '保存中…' : '保存';
      setBusy(state.save.phase === 'saving');
      /* 競合時は、次の保存を「最新の版に対する明示的な上書き」にする（入力は消さない）。 */
      if (state.save.phase === 'conflict' && state.save.current && editing.taskId === state.save.current.taskId) editing.revision = state.save.current.revision;
    });

    function setField(id, v) { $(id).value = v === null || v === undefined ? '' : v; }
    function openForm(task) {
      editing = task ? { revision: task.revision, taskId: task.taskId } : { revision: null, taskId: newTaskId() };
      setField('t-title', task && task.title); setField('t-service', task && task.service); setField('t-booking', task && task.bookingId);
      setField('t-status', task ? task.status : 'todo'); setField('t-due', task && task.dueDate); setField('t-memo', task && task.memo); setField('t-url', task && task.evidenceUrl);
      $('t-form').hidden = false;
      $('t-form-title').textContent = task ? 'メモを編集' : 'メモを追加';
      $('t-title').focus();
    }
    function closeForm() { $('t-form').hidden = true; editing = { revision: null, taskId: null }; }

    $('t-new').addEventListener('click', function () { if (ctl.state.save.phase !== 'saving') openForm(null); });
    $('t-cancel').addEventListener('click', function () { if (ctl.state.save.phase !== 'saving') closeForm(); });
    $('t-form').addEventListener('submit', function (e) {
      e.preventDefault();
      var input = inputFromFields({
        taskId: editing.taskId, title: $('t-title').value, bookingId: $('t-booking').value, service: $('t-service').value, status: $('t-status').value,
        memo: $('t-memo').value, dueDate: $('t-due').value, evidenceUrl: $('t-url').value
      });
      if (ctl.state.save.phase === 'saving') return;
      /* 成功するまでフォームを閉じない・入力を消さない。送信した下書きと同一（同じ下書き・未変更）の場合だけ閉じる。 */
      var submitted = editing, sent = snapshot();
      ctl.save(input, editing.revision, function (ok) {
        if (ok && editing === submitted && snapshot() === sent) closeForm();
      });
    });
    $('tasks-view').addEventListener('click', function (e) {
      var node = e.target;
      if (ctl.state.save.phase === 'saving') return; /* 保存中は対象の操作を受け付けない */
      while (node && node !== $('tasks-view')) {
        var act = node.getAttribute && node.getAttribute('data-act');
        if (act === 'toggle-done') { ctl.toggleDone(); return; }
        if (act === 'open') { ctl.toggleOpen(node.getAttribute('data-id')); return; }
        if (act) {
          var task = ctl.find(node.getAttribute('data-id'));
          if (!task) return;
          if (act === 'edit') openForm(task);
          else if (act === 'status') ctl.setStatus(task, node.getAttribute('data-status'));
          else if (act === 'delete' && confirmFn('このメモを削除します。元に戻せません。よろしいですか？')) ctl.remove(task);
          return;
        }
        node = node.parentNode;
      }
    });

    /* タブ切替（予約 / メモ）。メモを開くたびに最新を取得する。 */
    var tabs = { res: ['tab-res', ['res-filters', 'res-panel']], tasks: ['tab-tasks', ['tasks-panel']] };
    function show(which) {
      Object.keys(tabs).forEach(function (k) {
        var on = k === which;
        $(tabs[k][0]).setAttribute('aria-selected', on ? 'true' : 'false');
        tabs[k][1].forEach(function (id) { $(id).hidden = !on; });
      });
      if (which === 'tasks') ctl.load();
    }
    $('tab-res').addEventListener('click', function () { show('res'); });
    $('tab-tasks').addEventListener('click', function () { show('tasks'); });
    return ctl;
  }

  return { esc: esc, jstText: jstText, newTaskId: newTaskId, inputFromFields: inputFromFields, contentOf: contentOf, createController: createController,
    renderBanner: renderBanner, renderSummary: renderSummary, renderList: renderList, renderCard: renderCard, mount: mount,
    STATUS_OPTIONS: STATUS_OPTIONS, SERVICE_OPTIONS: SERVICE_OPTIONS };
});

/*
 * home-client.js — 運営アプリのホーム画面（Issue #990 Phase 2）。
 *
 * - 新しい通信は持たない。予約コントローラー（ops-client.js）とメモコントローラー（tasks-client.js）が
 *   すでに取得した応答だけを集計して描画する（予約の全件再取得・鍵の全件照会・新規GAS関数は追加しない）。
 * - 数値カードは「押した先の一覧の件数と一致するもの」だけをクリック可能にする。
 *   取得失敗・読込中・未接続を 0 件として表示しない。片方のAPIが失敗しても、もう片方は表示する。
 * - 売上・参加者・DM・鍵の要確認（一覧の応答に鍵状態が無く、全件照会を禁止しているため）・前回更新との差分
 *   （永続スナップショットが無い）は、根拠となるデータがないので表示しない。
 * - 描画は文字列をすべてエスケープして行う。個人名は表示しない。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.OpsHomeClient = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ホームのサービス切替。Community は予約アダプター未接続のため「0件」ではなく未接続と表示する。 */
  var SERVICE_CHIPS = [['all', 'すべて'], ['snb', 'SNB'], ['studio_x', 'Studio X'], ['snb_mens', 'SNB Mens'], ['snb_community', 'SNB Community（未接続）']];
  var DAY_MS = 24 * 3600 * 1000;
  var WEEK = ['日', '月', '火', '水', '木', '金', '土'];
  var VALID_UPCOMING = ['CONFIRMED', 'PENDING'];

  function esc(value) {
    return String(value === null || value === undefined ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function p2(n) { return (n < 10 ? '0' : '') + n; }

  /* ---- 日付（すべてJST。端末のタイムゾーンに依存しない） ---- */
  function jstDate(ms) { return new Date(ms + 9 * 3600 * 1000); }
  function jstMonth(nowMs) { var d = jstDate(nowMs); return d.getUTCFullYear() + '-' + p2(d.getUTCMonth() + 1); }
  function todayText(nowMs) { var d = jstDate(nowMs); return d.getUTCFullYear() + '年' + (d.getUTCMonth() + 1) + '月' + d.getUTCDate() + '日（' + WEEK[d.getUTCDay()] + '）'; }
  /* 'YYYY-MM' → その月の初日・末日（YYYY-MM-DD）。不正な値は null。 */
  function monthRange(ym) {
    var m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(String(ym));
    if (!m) return null;
    var y = +m[1], mo = +m[2];
    var last = new Date(Date.UTC(y, mo, 0)).getUTCDate();
    return { from: m[1] + '-' + m[2] + '-01', to: m[1] + '-' + m[2] + '-' + p2(last) };
  }
  function addMonths(ym, n) {
    var m = /^(\d{4})-(\d{2})$/.exec(ym);
    var d = new Date(Date.UTC(+m[1], +m[2] - 1 + n, 1));
    return d.getUTCFullYear() + '-' + p2(d.getUTCMonth() + 1);
  }
  /* 切替できる月: 今月の前後2か月。 */
  function monthOptions(nowMs) {
    var cur = jstMonth(nowMs), out = [];
    for (var i = -2; i <= 2; i++) { var ym = addMonths(cur, i); out.push([ym, ym.slice(0, 4) + '年' + (+ym.slice(5)) + '月']); }
    return out;
  }
  function clock(iso) {
    var ms = Date.parse(iso);
    if (typeof iso !== 'string' || isNaN(ms)) return null;
    var d = jstDate(ms);
    return p2(d.getUTCHours()) + ':' + p2(d.getUTCMinutes());
  }
  /* 終了表示。JSTで開始と終了の日付が違う（日またぎ・複数日）ときは終了日も併記する。 */
  function endText(startAt, endAt) {
    var e = Date.parse(endAt), st = Date.parse(startAt);
    if (typeof endAt !== 'string' || isNaN(e)) return null;
    var de = jstDate(e), ds = isNaN(st) ? null : jstDate(st);
    var t = p2(de.getUTCHours()) + ':' + p2(de.getUTCMinutes());
    if (ds && (ds.getUTCFullYear() !== de.getUTCFullYear() || ds.getUTCMonth() !== de.getUTCMonth() || ds.getUTCDate() !== de.getUTCDate())) return (de.getUTCMonth() + 1) + '/' + de.getUTCDate() + ' ' + t;
    return t;
  }
  function dayLabel(dateText) {
    var m = /^\d{4}-(\d{2})-(\d{2})$/.exec(dateText || '');
    return m ? (+m[1]) + '/' + (+m[2]) : (dateText || '');
  }
  function stamp(iso) {
    var ms = Date.parse(iso);
    if (typeof iso !== 'string' || isNaN(ms)) return null;
    var d = jstDate(ms);
    return (d.getUTCMonth() + 1) + '/' + d.getUTCDate() + ' ' + p2(d.getUTCHours()) + ':' + p2(d.getUTCMinutes());
  }

  /* ---- 優先して確認（既存メモの未完了から。独自の重要度は作らない） ---- */
  /* 期限超過 → 期限あり（近い順） → 期限なし、の決定的な順。同順位は更新が古い順 → taskId。 */
  function selectPriority(items, limit) {
    var open = (items || []).filter(function (t) { return t && t.status !== 'done'; });
    function group(t) { return t.overdue ? 0 : t.dueDate ? 1 : 2; }
    open.sort(function (a, b) {
      var g = group(a) - group(b);
      if (g) return g;
      if ((a.dueDate || '') !== (b.dueDate || '')) return (a.dueDate || '') < (b.dueDate || '') ? -1 : 1;
      var ua = Date.parse(a.updatedAt) || 0, ub = Date.parse(b.updatedAt) || 0;
      if (ua !== ub) return ua - ub;
      return String(a.taskId) < String(b.taskId) ? -1 : 1;
    });
    return open.slice(0, limit === undefined ? 3 : limit);
  }

  /* ---- 直近の予約（表示月の範囲内の、未来の有効な予約を開始が早い順に） ---- */
  function selectUpcoming(items, limit) {
    var list = (items || []).filter(function (i) { return i && i.phase === 'upcoming' && VALID_UPCOMING.indexOf(i.status) !== -1 && !isNaN(Date.parse(i.startAt)); });
    list.sort(function (a, b) {
      var d = Date.parse(a.startAt) - Date.parse(b.startAt);
      if (d) return d;
      return String(a.bookingId) < String(b.bookingId) ? -1 : 1;
    });
    return { total: list.length, items: list.slice(0, limit === undefined ? 5 : limit) };
  }

  /* ---- 予約側・メモ側の利用可否（片方の失敗で他方を巻き込まない） ---- */
  function resStatus(res, want) {
    if (!res) return { kind: 'loading' };
    if (res.phase === 'denied') return { kind: 'denied' };
    var d = res.data;
    var a = d && d.applied;
    /* 画面の絞り込みがホームの条件（表示月・サービス・キャンセル除外）と違うデータは使わない（再取得待ち）。 */
    var fits = !!a && a.status === 'active' && a.from === want.from && a.to === want.to && (a.service === undefined || a.service === want.service);
    if (d && fits && (res.phase === 'ready' || res.phase === 'error' || res.phase === 'not_connected' || res.phase === 'loading')) {
      if (d.notConnectedSelected) return { kind: 'not_connected', data: d };
      /* 台帳の読めない行（重複ID・必須項目不正など）は一覧から除外されている。件数・予定は不完全。 */
      var excluded = (d.issues || []).filter(function (x) { return x.severity === 'error'; }).length;
      return { kind: 'ready', data: d, stale: res.phase === 'error' || res.phase === 'not_connected', refreshing: res.phase === 'loading', excluded: excluded, incomplete: excluded > 0 };
    }
    if (res.phase === 'error' || res.phase === 'not_connected') return { kind: 'error', error: res.error };
    return { kind: 'loading' };
  }
  function taskStatus(tasks) {
    if (!tasks) return { kind: 'loading' };
    if (tasks.phase === 'denied') return { kind: 'denied' };
    var d = tasks.data;
    if (d) {
      if (d.storeReady === false) return { kind: 'not_ready', data: d };
      return { kind: 'ready', data: d, stale: tasks.phase === 'error', refreshing: tasks.phase === 'loading', incomplete: d.skippedRows > 0 };
    }
    if (tasks.phase === 'error') return { kind: 'error', error: tasks.error };
    return { kind: 'loading' };
  }

  /* ---- 概要カード（4枚。押した先の一覧の件数と一致する定義だけ） ---- */
  function buildCards(rs, ts) {
    var items = rs.kind === 'ready' ? rs.data.items : null;
    var tasks = ts.kind === 'ready' ? ts.data.items : null;
    return [
      { key: 'reservations', label: '今月の予約', note: 'キャンセルを除く・表示月', st: rs, value: items ? items.length : null, target: 'res' },
      { key: 'pending', label: '仮予約', note: '確定前の予約・表示月', st: rs, value: items ? items.filter(function (i) { return i.status === 'PENDING'; }).length : null, target: 'res-pending' },
      { key: 'tasks', label: '未対応メモ', note: '未対応＋対応中（完了を除く）', st: ts, value: tasks ? tasks.filter(function (t) { return t.status !== 'done'; }).length : null, target: 'tasks' },
      { key: 'overdue', label: '期限超過メモ', note: '期限を過ぎた未完了メモ', st: ts, value: tasks ? tasks.filter(function (t) { return t.overdue; }).length : null, target: 'tasks' }
    ];
  }

  function renderCard(c) {
    var s = c.st, body, clickable = false;
    if (s.kind === 'ready') {
      clickable = true;
      body = '<span class="v">' + esc(c.value) + '<small>件</small></span>' + (s.incomplete ? '<span class="sub warn">不完全（読めない行を除外）</span>' : s.stale ? '<span class="sub warn">古い内容の可能性</span>' : '<span class="sub">' + esc(c.note) + '</span>');
    } else if (s.kind === 'loading') {
      body = '<span class="v dim">…</span><span class="sub">取得中</span>';
    } else if (s.kind === 'not_connected') {
      body = '<span class="v dim">未接続</span><span class="sub">0件ではなく、まだ取り込んでいません</span>';
    } else if (s.kind === 'not_ready') {
      body = '<span class="v dim">未設定</span><span class="sub">メモの保存先が未設定です</span>';
    } else if (s.kind === 'denied') {
      body = '<span class="v dim">—</span><span class="sub">表示権限がありません</span>';
    } else {
      body = '<span class="v dim">取得失敗</span><span class="sub">0件ではありません</span>';
    }
    var inner = '<span class="lbl">' + esc(c.label) + '</span>' + body;
    return clickable
      ? '<li><button type="button" class="kpi" data-home="card" data-target="' + esc(c.target) + '">' + inner + '</button></li>'
      : '<li><div class="kpi off">' + inner + '</div></li>';
  }

  function statusTag(item) { return '<span class="tag st-' + esc(item.status) + '">' + esc(item.statusLabel) + '</span>'; }

  function renderPriority(ts, tasksState) {
    var head = '<h2 class="sec">優先して確認</h2>';
    if (ts.kind === 'loading') return head + '<div class="banner loading" role="status">メモを取得中…</div>';
    if (ts.kind === 'denied') return head + '<div class="banner err">メモを表示する権限がありません。</div>';
    if (ts.kind === 'not_ready') return head + '<div class="banner stale">メモの保存先が未設定のため、優先して確認するメモを出せません。</div>';
    if (ts.kind === 'error') {
      var m = tasksState && tasksState.error && tasksState.error.message ? tasksState.error.message : 'メモの取得に失敗しました。';
      return head + '<div class="banner err">' + esc(m) + '<br><button type="button" class="inline" data-home="retry-tasks">メモを再取得</button></div>';
    }
    var picks = selectPriority(ts.data.items, 3);
    var html = head;
    if (ts.stale) html += '<div class="banner stale">メモの最新取得に失敗しました。古い内容を表示しています。</div>';
    if (ts.incomplete) html += '<div class="banner stale">保存先の ' + esc(ts.data.skippedRows) + ' 行を読み込めていません。一覧は不完全です。</div>';
    if (!picks.length) return html + '<div class="banner">優先して確認するメモはありません</div>';
    return html + '<ol class="prio">' + picks.map(function (t, i) {
      var sub = [t.statusLabel];
      if (t.dueDate) sub.push('期限 ' + t.dueDate);
      return '<li><button type="button" class="prow' + (t.overdue ? ' overdue' : '') + '" data-home="task" data-id="' + esc(t.taskId) + '">' +
        '<span class="rank" aria-hidden="true">' + (i + 1) + '</span>' +
        '<span class="ptxt"><strong>' + esc(t.title) + '</strong><span class="psub">' + esc(sub.join(' ・ ')) + '</span></span>' +
        (t.overdue ? '<span class="tag danger">期限超過</span>' : '') + '<span class="chev" aria-hidden="true">›</span></button></li>';
    }).join('') + '</ol>';
  }

  function renderChips(service) {
    return '<div class="chips" role="group" aria-label="サービスで絞り込む">' + SERVICE_CHIPS.map(function (o) {
      return '<button type="button" class="chip" data-home="service" data-service="' + esc(o[0]) + '" aria-pressed="' + (o[0] === service ? 'true' : 'false') + '">' + esc(o[1]) + '</button>';
    }).join('') + '</div>';
  }

  function renderUpcoming(rs, resState) {
    var head = '<h2 class="sec">直近の予約・開催</h2>';
    if (rs.kind === 'denied') return head + '<div class="banner err">予約を表示する権限がありません。</div>';
    if (rs.kind === 'loading') return head + '<div class="banner loading" role="status">予約を取得中…</div>';
    if (rs.kind === 'not_connected') return head + '<div class="banner stale">選択したサービスは未接続です。予約が0件という意味ではありません。</div>';
    if (rs.kind === 'error') {
      var m = resState && resState.error && resState.error.message ? resState.error.message : '予約の取得に失敗しました。';
      return head + '<div class="banner err">' + esc(m) + '<br><button type="button" class="inline" data-home="retry-res">予約を再取得</button></div>';
    }
    var u = selectUpcoming(rs.data.items, 5);
    var html = head;
    if (rs.incomplete) html += '<div class="banner err" role="alert">台帳の ' + esc(rs.excluded) + ' 件が読み込めず一覧から除外されています。件数・予定は不完全です（予約タブの「確認が必要な行」を確認してください）。</div>';
    if (rs.stale) html += '<div class="banner stale">予約の最新取得に失敗しました。古い内容を表示しています。</div>';
    if (!u.items.length) return html + (rs.incomplete ? '<div class="banner stale">表示できるこれからの予約はありません（ただし除外された行があるため、予約がないとは限りません）。</div>' : '<div class="banner">表示月にこれからの有効な予約はありません（取得は正常に完了しています）。</div>');
    html += '<div class="uphead" aria-hidden="true"><span>利用日</span><span>サービス</span><span>人数</span><span>状態</span></div><ul class="uplist">' + u.items.map(function (i) {
      var end = endText(i.startAt, i.endAt);
      return '<li><button type="button" class="uprow" data-home="res" data-id="' + esc(i.bookingId) + '">' +
        '<span class="c-when"><strong>' + esc(dayLabel(i.date)) + '</strong> ' + esc(clock(i.startAt) || '') + (end ? '〜' + esc(end) : '') + '</span>' +
        '<span class="c-svc">' + esc(i.serviceLabel) + '</span>' +
        '<span class="c-ppl">' + (i.people === null || i.people === undefined ? '人数未入力' : esc(i.people) + '名') + '</span>' +
        '<span class="c-st">' + statusTag(i) + '</span><span class="chev" aria-hidden="true">›</span></button></li>';
    }).join('') + '</ul>';
    html += '<p class="note">' + (u.total > u.items.length ? '表示月の ' + esc(u.total) + ' 件のうち、開始が早い ' + esc(u.items.length) + ' 件を表示。' : '') + '</p><button type="button" class="inline" data-home="card" data-target="res">予約の一覧を見る</button>';
    return html;
  }

  /* 画面全体（#home-view の中身）。res / tasks は各コントローラーの state。ctx: { service, range }。 */
  function renderHome(res, tasks, ctx) {
    var rs = resStatus(res, { from: ctx.range.from, to: ctx.range.to, service: ctx.service });
    var ts = taskStatus(tasks);
    var html = '';
    html += renderPriority(ts, tasks);
    html += '<h2 class="sec">概要</h2><ul class="kpis">' + buildCards(rs, ts).map(renderCard).join('') + '</ul>';
    html += renderChips(ctx.service);
    html += renderUpcoming(rs, res);
    return html;
  }

  function renderStamp(res, tasks, mock) {
    var parts = [];
    var r = res && res.lastSuccessAt ? stamp(res.lastSuccessAt) : null;
    var t = tasks && tasks.lastSuccessAt ? stamp(tasks.lastSuccessAt) : null;
    parts.push('予約 最終取得 ' + (r ? esc(r) + ' JST' : '—'));
    parts.push('メモ 最終取得 ' + (t ? esc(t) + ' JST' : '—'));
    return (mock ? '<div class="banner stale">モックデータ（架空）です。実際の予約・メモではありません。</div>' : '') + '<p class="note">' + parts.join(' ／ ') + '</p>';
  }

  function optionsHtml(list) {
    return list.map(function (o) { return '<option value="' + esc(o[0]) + '">' + esc(o[1]) + '</option>'; }).join('');
  }

  /*
   * DOMへの結線（ブラウザーでのみ呼ぶ）。deps: { res: 予約コントローラー, tasks: メモコントローラー, revenue?: 売上コントローラー（再取得で一緒に更新）, now(): ms, mock }
   * 予約コントローラーは getFilters / setFilters / reload / openDetail、メモコントローラーは load / openTask を使う。
   */
  function mount(doc, deps) {
    function $(id) { return doc.getElementById(id); }
    var now = deps.now || function () { return Date.now(); };
    var res = deps.res, tasks = deps.tasks, revenue = deps.revenue || null;
    var model = { month: jstMonth(now()), service: 'all' };
    var selected = ['home', 'res', 'tasks'];

    $('home-month').innerHTML = optionsHtml(monthOptions(now()));
    $('home-service').innerHTML = optionsHtml(SERVICE_CHIPS);
    $('home-today').textContent = todayText(now());

    function wanted() {
      var r = monthRange(model.month);
      return { service: model.service, status: 'active', scope: 'custom', from: r.from, to: r.to };
    }
    function differs(a, b) { return ['service', 'status', 'scope', 'from', 'to'].some(function (k) { return a[k] !== b[k]; }); }
    /* ホームの条件（表示月・サービス・キャンセル除外）に予約一覧の絞り込みを合わせる。違うときだけ再取得する。 */
    function sync() {
      var w = wanted();
      if (differs(res.getFilters(), w)) { res.setFilters(w); res.reload(); }
    }
    function render() {
      $('home-month').value = model.month;
      $('home-service').value = model.service;
      $('home-stamp').innerHTML = renderStamp(res.state, tasks.state, !!res.state.mock);
      $('home-view').innerHTML = renderHome(res.state, tasks.state, { service: model.service, range: monthRange(model.month) });
    }
    function show(which) {
      var panelOf = { home: ['home-panel'], res: ['res-filters', 'res-panel'], tasks: ['tasks-panel'] };
      selected.forEach(function (k) {
        var on = k === which;
        $('tab-' + k).setAttribute('aria-selected', on ? 'true' : 'false');
        panelOf[k].forEach(function (id) { $(id).hidden = !on; });
      });
      if (which === 'home') { adoptService(); sync(); render(); }
    }
    /* 予約タブで選んだサービスがホームのチップにあれば引き継ぐ（無ければ「すべて」）。 */
    function adoptService() {
      var s = res.getFilters().service;
      model.service = SERVICE_CHIPS.some(function (o) { return o[0] === s; }) ? s : 'all';
    }
    function go(which) { $('tab-' + which).click(); }

    /* 予約タブ・メモタブ側の切替ではホームを隠す（それぞれの表示は既存のタブ処理が行う）。 */
    ['res', 'tasks'].forEach(function (k) {
      $('tab-' + k).addEventListener('click', function () { $('home-panel').hidden = true; $('tab-home').setAttribute('aria-selected', 'false'); });
    });
    $('tab-home').addEventListener('click', function () { show('home'); });

    $('home-month').addEventListener('change', function () { model.month = $('home-month').value; sync(); render(); });
    $('home-service').addEventListener('change', function () { model.service = $('home-service').value; sync(); render(); });
    $('home-reload').addEventListener('click', function () { res.reload(); tasks.load(); if (revenue) revenue.load(); });
    $('home-add').addEventListener('click', function () { go('tasks'); $('t-new').click(); });

    $('home-view').addEventListener('click', function (e) {
      var node = e.target;
      while (node && node !== $('home-view')) {
        var act = node.getAttribute && node.getAttribute('data-home');
        if (act) {
          var id = node.getAttribute('data-id');
          if (act === 'service') { model.service = node.getAttribute('data-service'); sync(); render(); }
          else if (act === 'retry-res') res.reload();
          else if (act === 'retry-tasks') tasks.load();
          else if (act === 'task') { go('tasks'); tasks.openTask(id); }
          else if (act === 'res') { go('res'); res.openDetail(id); }
          else if (act === 'card') {
            var target = node.getAttribute('data-target');
            if (target === 'res' || target === 'res-pending') res.closeDetail(); /* 開いたままの詳細が一覧の代わりに出ないようにする */
            if (target === 'res-pending') { var f = res.getFilters(); f.status = 'PENDING'; res.setFilters(f); res.reload(); go('res'); }
            else go(target);
          }
          return;
        }
        node = node.parentNode;
      }
    });

    /* 起動時のホームは既に表示中。取得済みの応答は各コントローラーの変更通知で描画する。 */
    tasks.load();
    render();
    /* 売上の月別行から、その月の予約一覧（キャンセル除外・全サービス）へ移る。ホームに戻ると条件はホームの月へ戻る。 */
    function drill(ym) {
      var r = monthRange(ym);
      if (!r) return;
      res.closeDetail();
      res.setFilters({ service: 'all', status: 'active', scope: 'custom', from: r.from, to: r.to });
      res.reload();
      go('res');
    }
    return { render: render, model: model, show: show, sync: sync, drill: drill };
  }

  return { esc: esc, jstMonth: jstMonth, monthRange: monthRange, addMonths: addMonths, monthOptions: monthOptions, todayText: todayText,
    selectPriority: selectPriority, selectUpcoming: selectUpcoming, resStatus: resStatus, taskStatus: taskStatus, buildCards: buildCards,
    renderHome: renderHome, renderCard: renderCard, renderStamp: renderStamp, mount: mount, SERVICE_CHIPS: SERVICE_CHIPS };
});

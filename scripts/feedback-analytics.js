/*
 * scripts/feedback-analytics.js — 利用後アンケート管理画面（Issue #849 第2段階）の集計・カード生成。
 *
 * 管理者GAS（gas/feedback-admin/）が FeedbackAnalytics.gs として読み込む。DOM・GASサービスに依存しない純粋関数だけを置く。
 * 入力は回答Spreadsheet（#835 で作成。Bookingとは別）の responses シートの行。列定義は FeedbackCore.COLUMNS。
 *
 * - テスト回答（is_test=1）は既定ですべての集計・一覧から除外し、scope:'test' のときだけテスト回答だけを扱う。
 * - 問題率の分母は「問題なかった／少し気になった／困った」の件数（未回答・該当なしは除外）。
 * - ステータスは 未対応／対応中／対応済み／対応不要。#835 の初期値（未対応・対応不要）と整合する。
 */
'use strict';

var FeedbackAnalytics = (function () {
  var STATUS_OPTIONS = ['未対応', '対応中', '対応済み', '対応不要'];
  var STATUS_PRIORITY = { '未対応': 0, '対応中': 1 };
  var MEMO_MAX_CHARS = 200;
  var LOW_RATING_MAX = 2;
  var CARD_LIMIT = 200;
  var PERIOD_DAYS = { '30': 30, '90': 90, all: 0 };
  var DAY_MS = 24 * 60 * 60 * 1000;
  var JST_OFFSET_MS = 9 * 60 * 60 * 1000;
  var CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

  /* GASでは同じプロジェクトの FeedbackCore.gs、Node（テスト）では require で読む。 */
  function core() {
    return typeof FeedbackCore !== 'undefined' ? FeedbackCore : require('./feedback-core.js');
  }

  function toNumber(value) {
    if (value === '' || value === null || value === undefined) return null;
    var n = Number(value);
    return isFinite(n) ? n : null;
  }

  function toDate(value) {
    if (value instanceof Date) return isNaN(value.getTime()) ? null : value;
    if (typeof value === 'string' && value) {
      var d = new Date(value);
      return isNaN(d.getTime()) ? null : d;
    }
    return null;
  }

  /* Spreadsheetが数式防止に付けた先頭の ' を表示用に外す（GASのgetValuesは通常外して返すが、念のため）。 */
  function unescapeCell(value) {
    var text = value === null || value === undefined ? '' : String(value);
    return text.charAt(0) === "'" && /^[=+\-@\t\r]/.test(text.slice(1)) ? text.slice(1) : text;
  }

  /* ヘッダ＋データ行（getValuesの2次元配列）→ レコード配列。行番号（2始まり）も持つ。 */
  function parseRows(header, rows) {
    var C = core();
    var index = {};
    header.forEach(function (name, i) { index[name] = i; });
    function cell(row, name) { return index[name] === undefined ? '' : row[index[name]]; }
    return rows.map(function (row, i) {
      var q2 = {};
      var q3 = {};
      C.Q2_ITEMS.forEach(function (item) { q2[item.id] = String(cell(row, 'q2_' + item.id) || ''); });
      C.Q3_ITEMS.forEach(function (item) { q3[item.id] = String(cell(row, 'q3_' + item.id) || ''); });
      var issues = String(cell(row, 'q5_issues') || '').split(',').map(function (s) { return s.trim(); }).filter(function (s) { return s; });
      return {
        rowNumber: i + 2,
        responseId: String(cell(row, 'response_id') || ''),
        receivedAt: toDate(cell(row, 'received_at')),
        brand: String(cell(row, 'brand') || ''),
        isTest: String(cell(row, 'is_test')) === '1',
        q1: toNumber(cell(row, 'q1_overall')),
        q2: q2,
        q3: q3,
        q4: String(cell(row, 'q4_staff_contact') || ''),
        q4Rating: toNumber(cell(row, 'q4_staff_rating')),
        q5: issues,
        q6: String(cell(row, 'q6_reuse') || ''),
        comment: unescapeCell(cell(row, 'comment')).trim(),
        status: String(cell(row, 'status') || '').trim(),
        memo: unescapeCell(cell(row, 'memo')),
        notifyFailed: String(cell(row, 'notify_failed')) === '1'
      };
    });
  }

  function hasProblem(record) {
    var flagged = record.q5.some(function (id) {
      return core().ISSUE_OPTIONS.some(function (o) { return o.id === id && o.notify; });
    });
    return flagged || record.comment !== '';
  }

  /* filter: { brand:'all'|brandId, period:'30'|'90'|'all', scope:'production'|'test', status:'all'|ステータス, problem:'all'|'yes'|'no' } */
  function normalizeFilter(filter) {
    var f = filter && typeof filter === 'object' ? filter : {};
    return {
      brand: core().isBrand(f.brand) ? f.brand : 'all',
      period: Object.prototype.hasOwnProperty.call(PERIOD_DAYS, f.period) ? f.period : '30',
      scope: f.scope === 'test' ? 'test' : 'production',
      status: STATUS_OPTIONS.indexOf(f.status) !== -1 ? f.status : 'all',
      problem: f.problem === 'yes' || f.problem === 'no' ? f.problem : 'all'
    };
  }

  /* 概要・問題分析の対象（ブランド・期間・本番/テスト）。 */
  function selectRecords(records, filter, now) {
    var f = normalizeFilter(filter);
    var days = PERIOD_DAYS[f.period];
    return records.filter(function (r) {
      if (!r.responseId) return false;
      if (f.scope === 'test' ? !r.isTest : r.isTest) return false;
      if (f.brand !== 'all' && r.brand !== f.brand) return false;
      if (days) {
        if (!r.receivedAt) return false;
        if (now.getTime() - r.receivedAt.getTime() > days * DAY_MS) return false;
      }
      return true;
    });
  }

  function round1(n) { return Math.round(n * 10) / 10; }

  function buildSummary(records) {
    var C = core();
    var rated = records.filter(function (r) { return r.q1 >= 1 && r.q1 <= 5; });
    var distribution = [1, 2, 3, 4, 5].map(function (score) {
      return { score: score, count: rated.filter(function (r) { return r.q1 === score; }).length };
    });
    var reuse = C.REUSE_OPTIONS.map(function (o) {
      return { id: o.id, label: o.label, count: records.filter(function (r) { return r.q6 === o.id; }).length };
    });
    var statusCounts = STATUS_OPTIONS.map(function (s) {
      return { status: s, count: records.filter(function (r) { return r.status === s; }).length };
    });
    var total = rated.reduce(function (sum, r) { return sum + r.q1; }, 0);
    return {
      count: records.length,
      averageRating: rated.length ? round1(total / rated.length) : null,
      ratingDistribution: distribution,
      reuse: reuse,
      lowRatingCount: rated.filter(function (r) { return r.q1 <= LOW_RATING_MAX; }).length,
      openCount: records.filter(function (r) { return r.status === '未対応'; }).length,
      statusCounts: statusCounts,
      notifyFailedCount: records.filter(function (r) { return r.notifyFailed; }).length
    };
  }

  function buildIssueAnalysis(records) {
    var C = core();
    function itemStats(group, item) {
      var counts = { ok: 0, minor: 0, trouble: 0, na: 0, unanswered: 0 };
      records.forEach(function (r) {
        var v = r[group][item.id];
        if (v === 'ok' || v === 'minor' || v === 'trouble' || v === 'na') counts[v]++;
        else counts.unanswered++;
      });
      var denominator = counts.ok + counts.minor + counts.trouble;
      var problems = counts.minor + counts.trouble;
      return {
        group: group,
        id: item.id,
        label: item.label,
        counts: counts,
        denominator: denominator,
        problemCount: problems,
        problemRate: denominator ? Math.round((problems / denominator) * 1000) / 10 : null
      };
    }
    var items = C.Q2_ITEMS.map(function (item) { return itemStats('q2', item); })
      .concat(C.Q3_ITEMS.map(function (item) { return itemStats('q3', item); }));
    var categories = C.ISSUE_OPTIONS.filter(function (o) { return o.notify; }).map(function (o) {
      return { id: o.id, label: o.label, count: records.filter(function (r) { return r.q5.indexOf(o.id) !== -1; }).length };
    });
    return {
      count: records.length,
      items: items,
      categories: categories,
      noIssueCount: records.filter(function (r) { return r.q5.indexOf('none') !== -1; }).length,
      q5AnsweredCount: records.filter(function (r) { return r.q5.length > 0; }).length
    };
  }

  function formatJstDate(date) {
    if (!date) return '';
    var jst = new Date(date.getTime() + JST_OFFSET_MS);
    function pad(n) { return (n < 10 ? '0' : '') + n; }
    return jst.getUTCFullYear() + '/' + pad(jst.getUTCMonth() + 1) + '/' + pad(jst.getUTCDate()) + ' ' + pad(jst.getUTCHours()) + ':' + pad(jst.getUTCMinutes());
  }

  /* 個別回答の全設問（展開表示用）。ラベルだけを返す。 */
  function answerDetails(r) {
    var C = core();
    var lines = [{ label: C.QUESTIONS.q1.label, value: r.q1 === null ? '未回答' : r.q1 + ' / 5' }];
    C.Q2_ITEMS.forEach(function (item) { lines.push({ label: 'Q2. ' + item.label, value: C.optionLabel(C.CONDITION_OPTIONS, r.q2[item.id]) || '未回答' }); });
    C.Q3_ITEMS.forEach(function (item) { lines.push({ label: 'Q3. ' + item.label, value: C.optionLabel(C.CONDITION_OPTIONS, r.q3[item.id]) || '未回答' }); });
    lines.push({ label: C.QUESTIONS.q4.label, value: C.optionLabel(C.STAFF_OPTIONS, r.q4) || '未回答' });
    if (r.q4 === 'yes') lines.push({ label: 'スタッフ対応の評価', value: r.q4Rating === null ? '未回答' : r.q4Rating + ' / 5' });
    lines.push({ label: 'Q5. 気になった点', value: issueLabels(r).join('、') || '未回答' });
    lines.push({ label: C.QUESTIONS.q6.label, value: C.optionLabel(C.REUSE_OPTIONS, r.q6) || '未回答' });
    return lines;
  }

  function issueLabels(r) {
    return core().ISSUE_OPTIONS.filter(function (o) { return r.q5.indexOf(o.id) !== -1; }).map(function (o) { return o.label; });
  }

  function toCard(r) {
    var brand = core().getBrand(r.brand);
    return {
      responseId: r.responseId,
      brand: r.brand,
      brandName: brand ? brand.name : r.brand,
      receivedAt: formatJstDate(r.receivedAt),
      rating: r.q1,
      issues: issueLabels(r),
      comment: r.comment,
      hasProblem: hasProblem(r),
      notifyFailed: r.notifyFailed,
      isTest: r.isTest,
      status: r.status,
      memo: r.memo,
      details: answerDetails(r)
    };
  }

  /* ご意見・対応の一覧。未対応→対応中→その他、同順位は新しい順。 */
  function buildCards(records, filter) {
    var f = normalizeFilter(filter);
    var list = records.filter(function (r) {
      if (f.status !== 'all' && r.status !== f.status) return false;
      if (f.problem === 'yes' && !hasProblem(r)) return false;
      if (f.problem === 'no' && hasProblem(r)) return false;
      return true;
    });
    list.sort(function (a, b) {
      var pa = STATUS_PRIORITY.hasOwnProperty(a.status) ? STATUS_PRIORITY[a.status] : 2;
      var pb = STATUS_PRIORITY.hasOwnProperty(b.status) ? STATUS_PRIORITY[b.status] : 2;
      if (pa !== pb) return pa - pb;
      return (b.receivedAt ? b.receivedAt.getTime() : 0) - (a.receivedAt ? a.receivedAt.getTime() : 0);
    });
    return { total: list.length, cards: list.slice(0, CARD_LIMIT).map(toCard), limited: list.length > CARD_LIMIT };
  }

  function buildDashboard(records, filter, now) {
    var f = normalizeFilter(filter);
    var selected = selectRecords(records, f, now);
    return {
      filter: f,
      summary: buildSummary(selected),
      issues: buildIssueAnalysis(selected),
      list: buildCards(selected, f)
    };
  }

  /*
   * 対応更新の入力検証。{ responseId, brand, status, memo } → { ok, value } / { ok:false, code }
   * memo は制御文字を除き、200字（コードポイント）まで。
   */
  function validateStatusUpdate(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, code: 'INVALID_PAYLOAD' };
    var allowed = ['responseId', 'brand', 'status', 'memo'];
    if (Object.keys(input).some(function (k) { return allowed.indexOf(k) === -1; })) return { ok: false, code: 'UNKNOWN_FIELD' };
    if (typeof input.responseId !== 'string' || !/^[A-Za-z0-9-]{8,64}$/.test(input.responseId)) return { ok: false, code: 'INVALID_RESPONSE_ID' };
    if (!core().isBrand(input.brand)) return { ok: false, code: 'INVALID_BRAND' };
    if (STATUS_OPTIONS.indexOf(input.status) === -1) return { ok: false, code: 'INVALID_STATUS' };
    var memo = input.memo === undefined || input.memo === null ? '' : input.memo;
    if (typeof memo !== 'string') return { ok: false, code: 'INVALID_MEMO' };
    memo = memo.replace(/\r\n?/g, '\n').replace(CONTROL_CHARS, '').trim();
    if (core().charCount(memo) > MEMO_MAX_CHARS) return { ok: false, code: 'MEMO_TOO_LONG' };
    return { ok: true, value: { responseId: input.responseId, brand: input.brand, status: input.status, memo: memo } };
  }

  return {
    STATUS_OPTIONS: STATUS_OPTIONS,
    MEMO_MAX_CHARS: MEMO_MAX_CHARS,
    LOW_RATING_MAX: LOW_RATING_MAX,
    CARD_LIMIT: CARD_LIMIT,
    parseRows: parseRows,
    hasProblem: hasProblem,
    normalizeFilter: normalizeFilter,
    selectRecords: selectRecords,
    buildSummary: buildSummary,
    buildIssueAnalysis: buildIssueAnalysis,
    buildCards: buildCards,
    buildDashboard: buildDashboard,
    toCard: toCard,
    formatJstDate: formatJstDate,
    validateStatusUpdate: validateStatusUpdate
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = FeedbackAnalytics;

/*
 * scripts/feedback-core.js — 3ブランド利用後アンケート（Issue #835 第1段階）のDOM非依存コア。
 *
 * ブラウザ（scripts/feedback-app.js）とGAS（gas/feedback/）の両方が、このファイルそのものを読み込む
 * （GASへは scripts/prepare-feedback-gas-project.js が FeedbackCore.gs としてコピーする）。
 * 設問・選択肢・入力検証・保存行への変換・要確認（通知）判定はここだけに書く。
 *
 * 既存の /survey/・/mens/survey/（survey-core.js / survey-schema.json / gas/survey/）とは完全に別物で、
 * 互いのファイル・設定・Spreadsheetを参照しない。
 *
 * 回答（answers）の形:
 *   q1: 1〜5 の整数（必須）
 *   q2: { website, booking, mail_timing, mail_clarity }   各値は CONDITION_OPTIONS のid（任意）
 *   q3: { location, lighting, aircon, equipment, cleanup } 同上
 *   q4: 'yes' | 'no' | 'no_answer'（任意）
 *   q4_rating: 1〜5（任意。q4 === 'yes' のときだけ受け付ける。それ以外で値があれば拒否）
 *   q5: 問題カテゴリidの配列（任意。'none' は他と排他）
 *   q6: REUSE_OPTIONS のid（必須）
 *   comment: 自由記述（任意・500字以内）
 */
'use strict';

var FeedbackCore = (function () {
  var FORM_VERSION = 1;
  var COMMENT_MAX_CHARS = 500;
  var TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
  var CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
  var FORMULA_TRIGGER = /^[=+\-@\t\r]/;

  /* ブランド別の表示名・戻り先。ここ以外でブランドを増やさない（サーバーもこの一覧で検証する）。 */
  var BRANDS = {
    snb: {
      id: 'snb',
      name: 'Studio Nagoya Base',
      backUrl: 'https://nagoya-base.github.io/Studio-nagoya-base/',
      backLabel: 'Studio Nagoya Base に戻る'
    },
    mens: {
      id: 'mens',
      name: 'SNB mens',
      backUrl: 'https://nagoya-base.github.io/Studio-nagoya-base/mens/',
      backLabel: 'SNB mens に戻る'
    },
    'studio-x': {
      id: 'studio-x',
      name: 'Studio X',
      backUrl: 'https://nagoya-base.github.io/Studio-nagoya-base/studio-x/',
      backLabel: 'Studio X に戻る'
    }
  };

  var CONDITION_OPTIONS = [
    { id: 'ok', label: '問題なかった' },
    { id: 'minor', label: '少し気になった' },
    { id: 'trouble', label: '困った' },
    { id: 'na', label: '該当なし・利用していない' }
  ];

  var Q2_ITEMS = [
    { id: 'website', label: 'ホームページの見やすさ' },
    { id: 'booking', label: '予約のしやすさ' },
    { id: 'mail_timing', label: '案内メールのタイミング' },
    { id: 'mail_clarity', label: '案内メールのわかりやすさ' }
  ];

  var Q3_ITEMS = [
    { id: 'location', label: '場所の見つけやすさ' },
    { id: 'lighting', label: '照明の操作' },
    { id: 'aircon', label: 'エアコンの操作' },
    { id: 'equipment', label: '備品の探しやすさ' },
    { id: 'cleanup', label: '後片付けのわかりやすさ' }
  ];

  var STAFF_OPTIONS = [
    { id: 'yes', label: 'はい' },
    { id: 'no', label: 'いいえ' },
    { id: 'no_answer', label: '回答しない' }
  ];

  /* Q5。notify:true のカテゴリを1つ以上選ぶと「要確認」（status=未対応・通知対象）。 */
  var ISSUE_OPTIONS = [
    { id: 'supplies', label: '消耗品不足', notify: true },
    { id: 'damage', label: '備品の破損・故障', notify: true },
    { id: 'cleanliness', label: '清掃・衛生面', notify: true },
    { id: 'other', label: 'その他改善してほしいこと', notify: true },
    { id: 'none', label: '特になし', exclusive: true }
  ];

  var REUSE_OPTIONS = [
    { id: 'definitely', label: 'ぜひ利用したい' },
    { id: 'maybe', label: '機会があれば利用したい' },
    { id: 'not_now', label: '今のところ利用したいと思わない' }
  ];

  var QUESTIONS = {
    q1: { label: 'Q1. 今回のご利用の総合満足度を教えてください', required: true, low: '不満', high: '満足' },
    q2: { label: 'Q2. 予約・事前のご案内について', hint: '気になった点があれば教えてください（任意）' },
    q3: { label: 'Q3. 現地でのご利用について', hint: '気になった点があれば教えてください（任意）' },
    q4: { label: 'Q4. スタッフの対応を受けましたか', hint: '任意' },
    q4_rating: { label: 'スタッフの対応はいかがでしたか（任意）', low: '不満', high: '満足' },
    q5: { label: 'Q5. 気になった点があれば選んでください（複数選択可）', hint: '任意' },
    comment: {
      label: '気になった点・ご感想など',
      hint: '任意・500字以内。お名前・連絡先などの個人情報は書かないでください。いただいた内容はオーナーが確認します。'
    },
    q6: { label: 'Q6. また利用したいと思いますか', required: true }
  };

  var STATUS_OPEN = '未対応';
  var STATUS_NONE = '対応不要';

  /* 保存列（順序固定）。予約ID・氏名・メール・トークンの列は持たない。 */
  var COLUMNS = ['response_id', 'received_at', 'brand', 'is_test', 'form_version', 'q1_overall']
    .concat(Q2_ITEMS.map(function (i) { return 'q2_' + i.id; }))
    .concat(Q3_ITEMS.map(function (i) { return 'q3_' + i.id; }))
    .concat(['q4_staff_contact', 'q4_staff_rating', 'q5_issues', 'q6_reuse', 'comment', 'status', 'memo', 'notify_failed']);

  var ALLOWED_ANSWER_KEYS = ['q1', 'q2', 'q3', 'q4', 'q4_rating', 'q5', 'q6', 'comment'];

  function hasOwn(object, key) { return Object.prototype.hasOwnProperty.call(object, key); }
  function ids(options) { return options.map(function (o) { return o.id; }); }
  function isPlainObject(value) { return !!value && typeof value === 'object' && !Array.isArray(value); }
  function isEmpty(value) { return value === undefined || value === null || value === ''; }

  function isBrand(value) { return typeof value === 'string' && hasOwn(BRANDS, value); }
  function getBrand(value) { return isBrand(value) ? BRANDS[value] : null; }

  /* 文字数はコードポイント単位（絵文字1文字=1字）。ブラウザ・GASで同じ数え方をする。 */
  function charCount(text) { return Array.from(String(text)).length; }

  function cleanComment(value) {
    return String(value).replace(/\r\n?/g, '\n').replace(CONTROL_CHARS, '').trim();
  }

  function isScale(value) { return typeof value === 'number' && value % 1 === 0 && value >= 1 && value <= 5; }

  /*
   * 入力の検証と正規化。クライアントの値は信用せず、未知のキー・選択肢外・型違い・
   * 表示条件外の値（Q4「はい」以外での評価）・排他違反・文字数超過はすべて拒否する。
   * 戻り値: { ok:true, answers } / { ok:false, errors:[{field, code}] }（入力値そのものは返さない）。
   */
  function validateAnswers(input) {
    var errors = [];
    function fail(field, code) { errors.push({ field: field, code: code }); }
    if (!isPlainObject(input)) return { ok: false, errors: [{ field: 'answers', code: 'INVALID_TYPE' }] };

    Object.keys(input).forEach(function (key) {
      if (ALLOWED_ANSWER_KEYS.indexOf(key) === -1) fail('answers', 'UNKNOWN_FIELD');
    });

    var out = { q1: '', q2: {}, q3: {}, q4: '', q4_rating: '', q5: [], q6: '', comment: '' };

    if (isEmpty(input.q1)) fail('q1', 'REQUIRED');
    else if (!isScale(input.q1)) fail('q1', 'INVALID_OPTION');
    else out.q1 = input.q1;

    [['q2', Q2_ITEMS], ['q3', Q3_ITEMS]].forEach(function (pair) {
      var field = pair[0];
      var value = input[field];
      if (isEmpty(value)) return;
      if (!isPlainObject(value)) { fail(field, 'INVALID_TYPE'); return; }
      var itemIds = ids(pair[1]);
      Object.keys(value).forEach(function (itemId) {
        if (itemIds.indexOf(itemId) === -1) { fail(field, 'UNKNOWN_FIELD'); return; }
        var choice = value[itemId];
        if (isEmpty(choice)) return;
        if (ids(CONDITION_OPTIONS).indexOf(choice) === -1) { fail(field, 'INVALID_OPTION'); return; }
        out[field][itemId] = choice;
      });
    });

    if (!isEmpty(input.q4)) {
      if (ids(STAFF_OPTIONS).indexOf(input.q4) === -1) fail('q4', 'INVALID_OPTION');
      else out.q4 = input.q4;
    }
    if (!isEmpty(input.q4_rating)) {
      if (out.q4 !== 'yes') fail('q4_rating', 'HIDDEN_VALUE');
      else if (!isScale(input.q4_rating)) fail('q4_rating', 'INVALID_OPTION');
      else out.q4_rating = input.q4_rating;
    }

    if (!isEmpty(input.q5)) {
      if (!Array.isArray(input.q5)) fail('q5', 'INVALID_TYPE');
      else {
        var seen = {};
        input.q5.forEach(function (id) {
          if (ids(ISSUE_OPTIONS).indexOf(id) === -1) { fail('q5', 'INVALID_OPTION'); return; }
          if (seen[id]) { fail('q5', 'DUPLICATE_OPTION'); return; }
          seen[id] = true;
        });
        if (seen.none && Object.keys(seen).length > 1) fail('q5', 'EXCLUSIVE_CONFLICT');
        /* 表示順に並べ直して保存する */
        out.q5 = ids(ISSUE_OPTIONS).filter(function (id) { return seen[id]; });
      }
    }

    if (isEmpty(input.q6)) fail('q6', 'REQUIRED');
    else if (ids(REUSE_OPTIONS).indexOf(input.q6) === -1) fail('q6', 'INVALID_OPTION');
    else out.q6 = input.q6;

    if (!isEmpty(input.comment)) {
      if (typeof input.comment !== 'string') fail('comment', 'INVALID_TYPE');
      else {
        var text = cleanComment(input.comment);
        if (charCount(text) > COMMENT_MAX_CHARS) fail('comment', 'TOO_LONG');
        else out.comment = text;
      }
    }

    return errors.length ? { ok: false, errors: errors } : { ok: true, answers: out };
  }

  /* 要確認（status=未対応・通知対象）か：Q5で「特になし」以外を1つ以上選択、または自由記述あり。 */
  function needsAttention(answers) {
    var flagged = (answers.q5 || []).some(function (id) {
      return ISSUE_OPTIONS.some(function (o) { return o.id === id && o.notify; });
    });
    return flagged || String(answers.comment || '').trim() !== '';
  }

  function issueLabels(answers) {
    return ISSUE_OPTIONS.filter(function (o) { return (answers.q5 || []).indexOf(o.id) !== -1; })
      .map(function (o) { return o.label; });
  }

  function optionLabel(options, id) {
    for (var i = 0; i < options.length; i++) if (options[i].id === id) return options[i].label;
    return '';
  }

  /* Spreadsheetが数式として解釈しないよう、先頭が = + - @ 等なら ' を付ける。 */
  function escapeCell(value) {
    var text = String(value);
    return FORMULA_TRIGGER.test(text) ? "'" + text : text;
  }

  /* 保存行（COLUMNS順）。meta: { responseId, receivedAt(ISO), brand, isTest } */
  function buildRow(answers, meta) {
    var row = {
      response_id: meta.responseId,
      received_at: meta.receivedAt,
      brand: meta.brand,
      is_test: meta.isTest ? 1 : 0,
      form_version: FORM_VERSION,
      q1_overall: answers.q1,
      q4_staff_contact: answers.q4,
      q4_staff_rating: answers.q4_rating,
      q5_issues: answers.q5.join(','),
      q6_reuse: answers.q6,
      comment: escapeCell(answers.comment),
      status: needsAttention(answers) ? STATUS_OPEN : STATUS_NONE,
      memo: '',
      notify_failed: ''
    };
    Q2_ITEMS.forEach(function (i) { row['q2_' + i.id] = answers.q2[i.id] || ''; });
    Q3_ITEMS.forEach(function (i) { row['q3_' + i.id] = answers.q3[i.id] || ''; });
    return COLUMNS.map(function (c) { return row[c]; });
  }

  function isValidTokenFormat(value) { return typeof value === 'string' && TOKEN_PATTERN.test(value); }

  /*
   * ページのURLからブランド・テストモード・トークンを決める（ブラウザ専用だがDOM非依存）。
   * - ブランドはパス /feedback/<brand>/ からのみ決める（クエリ等では変えられない）。
   * - テストモードはクエリが厳密に ?test=1 のときだけ（既存 /survey/ と同じ規則）。
   * - トークンは #t=<token> のフラグメントだけから読む（サーバー・リファラへ送られない）。
   */
  function parseLocation(pathname, search, hash) {
    var match = /\/feedback\/([a-z-]+)\/(?:index\.html)?$/.exec(String(pathname || ''));
    var brand = match && isBrand(match[1]) ? match[1] : null;
    var token = '';
    var tokenMatch = /^#t=([^&]*)$/.exec(String(hash || ''));
    if (tokenMatch) token = tokenMatch[1];
    return { brand: brand, isTest: search === '?test=1', token: token };
  }

  return {
    FORM_VERSION: FORM_VERSION,
    COMMENT_MAX_CHARS: COMMENT_MAX_CHARS,
    BRANDS: BRANDS,
    CONDITION_OPTIONS: CONDITION_OPTIONS,
    Q2_ITEMS: Q2_ITEMS,
    Q3_ITEMS: Q3_ITEMS,
    STAFF_OPTIONS: STAFF_OPTIONS,
    ISSUE_OPTIONS: ISSUE_OPTIONS,
    REUSE_OPTIONS: REUSE_OPTIONS,
    QUESTIONS: QUESTIONS,
    COLUMNS: COLUMNS,
    STATUS_OPEN: STATUS_OPEN,
    STATUS_NONE: STATUS_NONE,
    isBrand: isBrand,
    getBrand: getBrand,
    charCount: charCount,
    validateAnswers: validateAnswers,
    needsAttention: needsAttention,
    issueLabels: issueLabels,
    optionLabel: optionLabel,
    buildRow: buildRow,
    isValidTokenFormat: isValidTokenFormat,
    parseLocation: parseLocation
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = FeedbackCore;

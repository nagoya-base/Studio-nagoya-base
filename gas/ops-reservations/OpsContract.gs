/*
 * OpsContract.gs — 運営アプリ段階1（Issue #936 / 親 #935）の共通契約。
 *
 * 予約ID・サービス区分・日時（JST）・取得状態の定義の正本。後続モジュール（段階2以降）は
 * ここを参照して拡張する。このプロジェクトは「読み取り専用」であり、スプレッドシートへの
 * 書き込み・予約の確定/変更/取消・外部送信は一切持たない（appsscriptのスコープも
 * spreadsheets.readonly のみ）。
 */
'use strict';

var OpsContract = (function () {
  /* 画面・APIで使うサービス区分。Communityは別台帳（snb-communityリポジトリ側）で、
     Bookingsシートには含まれないため段階1では「未接続」。 */
  var SERVICES = [
    { id: 'snb', label: 'SNB', sourceBrand: 'snb', connected: true },
    { id: 'studio_x', label: 'Studio X', sourceBrand: 'studio_x', connected: true },
    { id: 'snb_mens', label: 'SNB Mens', sourceBrand: 'mens', connected: true },
    { id: 'snb_community', label: 'SNB Community', sourceBrand: null, connected: false }
  ];
  var UNCLASSIFIED = { id: 'unclassified', label: '未分類', sourceBrand: null, connected: true };

  var STATUS_LABELS = {
    PENDING: '仮予約',
    CONFIRMED: '確定',
    CANCELLED: 'キャンセル',
    EXPIRED: '失効'
  };

  var JST_OFFSET_MS = 9 * 60 * 60 * 1000;
  var DAY_MS = 24 * 60 * 60 * 1000;
  var DEFAULT_RANGE_DAYS = 30;

  function pad2_(n) { return (n < 10 ? '0' : '') + n; }

  function isDate_(value) {
    return !!value && typeof value.getTime === 'function' && !isNaN(value.getTime());
  }

  /* JST（UTC+9。夏時間なし）の日付部品。端末・実行環境のタイムゾーンに依存しない。 */
  function jstParts(ms) {
    var d = new Date(ms + JST_OFFSET_MS);
    return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(), hh: d.getUTCHours(), mm: d.getUTCMinutes() };
  }

  function formatJstDate(ms) {
    var p = jstParts(ms);
    return p.y + '-' + pad2_(p.m) + '-' + pad2_(p.d);
  }

  function formatJstDateTime(ms) {
    var p = jstParts(ms);
    return formatJstDate(ms) + ' ' + pad2_(p.hh) + ':' + pad2_(p.mm);
  }

  /* 'YYYY-MM-DD'（実在する暦日のみ）→ その日のJST 0:00のエポックms。不正はnull。 */
  function parseJstDate(text) {
    if (typeof text !== 'string') return null;
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text.trim());
    if (!m) return null;
    var y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
    var utc = Date.UTC(y, mo - 1, d);
    var check = new Date(utc);
    if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) return null;
    return utc - JST_OFFSET_MS;
  }

  /* 'HH:mm' → 分（0〜1439）。不正はnull。 */
  function parseClock(text) {
    if (typeof text !== 'string') return null;
    var m = /^(\d{1,2}):(\d{2})$/.exec(text.trim());
    if (!m) return null;
    var hh = Number(m[1]), mm = Number(m[2]);
    if (hh > 23 || mm > 59) return null;
    return hh * 60 + mm;
  }

  function addDays(dateText, days) {
    var ms = parseJstDate(dateText);
    return ms === null ? null : formatJstDate(ms + days * DAY_MS);
  }

  /* 元データのbrand値 → サービス定義。未知値は「未分類」（既存サービスへ丸めない）。 */
  function serviceForBrand(brand) {
    var key = typeof brand === 'string' ? brand.trim() : '';
    for (var i = 0; i < SERVICES.length; i++) {
      if (SERVICES[i].sourceBrand && SERVICES[i].sourceBrand === key) return SERVICES[i];
    }
    return UNCLASSIFIED;
  }

  function serviceById(id) {
    for (var i = 0; i < SERVICES.length; i++) if (SERVICES[i].id === id) return SERVICES[i];
    return id === UNCLASSIFIED.id ? UNCLASSIFIED : null;
  }

  return {
    SERVICES: SERVICES,
    UNCLASSIFIED: UNCLASSIFIED,
    STATUS_LABELS: STATUS_LABELS,
    DEFAULT_RANGE_DAYS: DEFAULT_RANGE_DAYS,
    DAY_MS: DAY_MS,
    isDate: isDate_,
    formatJstDate: formatJstDate,
    formatJstDateTime: formatJstDateTime,
    parseJstDate: parseJstDate,
    parseClock: parseClock,
    addDays: addDays,
    serviceForBrand: serviceForBrand,
    serviceById: serviceById
  };
})();

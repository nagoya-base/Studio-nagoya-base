/**
 * 予約台帳（Bookings）の読取（Issue #754）— 独立GAS用。純粋ロジック＋最小列の選択。
 *
 * 読む列は鍵連携に必要な最小限のみ（氏名・メール・電話・目的・人数は読まない）。
 * 台帳の列構成が想定と違う（必須列が無い）場合は LEDGER_SCHEMA_INVALID として照合を止める
 * （revision 列の移行前に動かさない）。AccessKeySnapshot.build が参照する Booking.isCardPaymentMethod は
 * 予約GASのモジュールを持ち込まないため、同じ判定を最小の shim で提供する（値の一致はテストで固定）。
 */
var Booking = (typeof Booking !== 'undefined') ? Booking : {
  isCardPaymentMethod: function (paymentMethod) { return String(paymentMethod || '').trim() === 'オンラインクレジットカード'; }
};

var AccessLedgerReader = (function () {
  'use strict';

  var SHEET_NAME = 'Bookings';
  var REQUIRED_COLUMNS = [
    'bookingId', 'startAt', 'endAt', 'brand', 'status', 'paymentMethod', 'paymentStatus', 'paymentConfirmedAt',
    'confirmedAt', 'expiredAt', 'feeSettlementState', 'feeRecoveryRequiredAt', 'paymentRecoveryRequiredAt', 'revision'
  ];
  var JST_OFFSET_MS = 9 * 3600 * 1000;

  function jstDay(ms) {
    var d = new Date(ms + JST_OFFSET_MS);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  }

  function toMs(v) {
    if (v && typeof v.getTime === 'function') { var t = v.getTime(); return isNaN(t) ? null : t; }
    if (typeof v === 'string' && v.trim() !== '') { var p = Date.parse(v); return isNaN(p) ? null : p; }
    return null;
  }

  /** 必須列がヘッダーにすべて存在するか。 */
  function checkHeaders(headerRow) {
    var missing = REQUIRED_COLUMNS.filter(function (c) { return headerRow.indexOf(c) === -1; });
    return missing.length ? { ok: false, error: 'LEDGER_SCHEMA_INVALID', missing: missing } : { ok: true };
  }

  /**
   * 列ごとの値（columns[name] = 配列、行順）から、通常の照合対象を選ぶ。
   * 対象 = ① 利用日(JST)が当日・翌日のSNB予約 ∪ ② trackedIds（鍵操作記録が残る予約。利用日を問わない）。
   * 時刻が読めない行はSNBの可能性を捨てず候補に含め、AccessKeySnapshot が TIME_INVALID で止める。
   */
  function select(columns, nowMs, trackedIds) {
    var ids = columns.bookingId || [];
    var tracked = {};
    (trackedIds || []).forEach(function (id) { tracked[String(id)] = true; });
    var today = jstDay(nowMs);
    var tomorrow = today + 24 * 3600 * 1000;
    var out = [];
    for (var i = 0; i < ids.length; i++) {
      var id = String(ids[i] === undefined || ids[i] === null ? '' : ids[i]);
      if (!id) continue;
      var rec = {};
      REQUIRED_COLUMNS.forEach(function (c) { rec[c] = (columns[c] || [])[i]; });
      var inTracked = !!tracked[id];
      var ms = toMs(rec.startAt);
      var isSnb = String(rec.brand || '') === 'snb' || String(rec.brand || '') === '';
      var inWindow = false;
      if (isSnb) {
        if (ms === null) inWindow = true;
        else { var d = jstDay(ms); inWindow = d === today || d === tomorrow; }
      }
      if (inTracked || inWindow) out.push(rec);
    }
    return out;
  }

  /**
   * シート本体から読む（GAS専用）。ヘッダー行で列を解決し、必須列だけを列単位で読む。
   * deps.sheet: SpreadsheetApp のシート。失敗は { ok:false } で返し、例外を呼出側へ漏らさない。
   */
  function readFromSheet(sheet, nowMs, trackedIds) {
    try {
      var lastCol = sheet.getLastColumn();
      var lastRow = sheet.getLastRow();
      if (lastCol < 1) return { ok: false, error: 'LEDGER_SCHEMA_INVALID' };
      var header = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(String);
      var chk = checkHeaders(header);
      if (!chk.ok) return { ok: false, error: chk.error };
      if (lastRow < 2) return { ok: true, records: [] };
      var columns = {};
      REQUIRED_COLUMNS.forEach(function (c) {
        var col = header.indexOf(c) + 1;
        columns[c] = sheet.getRange(2, col, lastRow - 1, 1).getValues().map(function (r) { return r[0]; });
      });
      return { ok: true, records: select(columns, nowMs, trackedIds) };
    } catch (e) {
      return { ok: false, error: 'LEDGER_READ_FAILED' };
    }
  }

  return { SHEET_NAME: SHEET_NAME, REQUIRED_COLUMNS: REQUIRED_COLUMNS.slice(), checkHeaders: checkHeaders, select: select, readFromSheet: readFromSheet };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = AccessLedgerReader;
}

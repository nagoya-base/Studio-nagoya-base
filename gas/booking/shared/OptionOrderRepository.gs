/*
 * OptionOrderRepository.gs — 予約オプション注文の台帳（Issue #423）。
 *
 * 既存のBookings台帳には列を足さず、別シート`OptionOrders`（注文単位）と
 * `OptionEligibility`（有料レンタル機材のセルフレンタル許可（Admin付与）。管理者が機材コード単位で付与）を使う。
 * 理由: Bookingsの列追加は本番ヘッダーの手動追記が必要になり、既存の予約・Stripe
 * 決済経路（Bookings列に強く依存）へ影響し得るため。オプション情報が無い既存予約は
 * そもそもOptionOrdersに行が無いだけで、そのまま動作する（後方互換）。
 *
 * 親キーは既存のbookingId（予約IDの生成方式は変更しない）。注文ごとにoptionOrderId
 * （OPT-XXXXXXXX）を持つ。optionOrderIdは決済・履歴管理用で、予約の同一性は常に
 * bookingIdで維持する。
 *
 * このファイルはSpreadsheetの読み書きだけを担当し、Lockの取得は呼び出し側
 * （OptionOrderService）の責務。更新は1行を1回のRange.setValuesで書き換える
 * （途中状態を残さないため）。
 */
'use strict';

var OptionOrderRepository = (function () {
  var ORDERS_SHEET_ = 'OptionOrders';
  var ELIGIBILITY_SHEET_ = 'OptionEligibility';

  var HEADERS_ = [
    'optionOrderId',
    'bookingId',
    'brand',
    'category',
    'source',
    'itemsJson',
    'amountJpy',
    'currency',
    'approvalStatus',
    'paymentStatus',
    'status',
    'customerEmail',
    'createdAt',
    'updatedAt',
    'approvedAt',
    'declinedAt',
    'declineReason',
    'paymentAttemptId',
    'checkoutRequestJson',
    'stripeCheckoutSessionId',
    'stripePaymentIntentId',
    'stripeAmount',
    'stripeCurrency',
    'paidAt',
    'lastStripeEventId',
    'decisionMailSentAt',
    'confirmedMailSentAt',
    'paymentRecoveryRequiredAt',
    'paymentRecoveryReason'
  ];

  var ELIGIBILITY_HEADERS_ = ['email', 'optionCode', 'grantedAt', 'note'];

  function getSpreadsheet_() {
    return SpreadsheetApp.openById(BookingConfig.getSpreadsheetId());
  }

  function ensureSheet_(name, headers) {
    var spreadsheet = getSpreadsheet_();
    var sheet = spreadsheet.getSheetByName(name);
    if (!sheet) sheet = spreadsheet.insertSheet(name);
    if (sheet.getLastRow() < 1) sheet.appendRow(headers);
    return sheet;
  }

  function parseItems_(json) {
    if (!json) return [];
    try {
      var parsed = JSON.parse(json);
      return Array.isArray(parsed) ? parsed.filter(function (v) { return typeof v === 'string'; }) : [];
    } catch (e) {
      return [];
    }
  }

  function rowToRecord_(row) {
    var record = {};
    HEADERS_.forEach(function (header, index) { record[header] = row[index]; });
    record.items = parseItems_(record.itemsJson);
    return record;
  }

  /*
   * 管理者入力（不承認の理由・資格付与のメモ）など自由入力の文字列が`=`・`+`・`-`・`@`で
   * 始まると、Sheetsが数式として評価してしまう（数式インジェクション）。先頭にアポストロフィを
   * 付けて文字列として保存する。読み出しで消えるため値は変わらない。
   */
  function safeCell_(value) {
    if (typeof value === 'string' && /^[=+\-@\t\r]/.test(value)) return "'" + value;
    return value;
  }

  function recordToRow_(record) {
    var source = Object.assign({}, record);
    if (Array.isArray(source.items)) source.itemsJson = JSON.stringify(source.items);
    return HEADERS_.map(function (header) {
      return source[header] !== undefined && source[header] !== null ? safeCell_(source[header]) : '';
    });
  }

  function normalizeEmail(email) {
    return String(email || '').trim().toLowerCase();
  }

  function listAll() {
    var sheet = ensureSheet_(ORDERS_SHEET_, HEADERS_);
    var values = sheet.getDataRange().getValues();
    var result = [];
    for (var i = 1; i < values.length; i++) {
      result.push({ rowNumber: i + 1, record: rowToRecord_(values[i]) });
    }
    return result;
  }

  function listByBookingId(bookingId) {
    return listAll().filter(function (row) { return row.record.bookingId === bookingId; });
  }

  function findByOptionOrderId(optionOrderId) {
    var rows = listAll();
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].record.optionOrderId === optionOrderId) return rows[i];
    }
    return null;
  }

  function appendOrders(records) {
    var sheet = ensureSheet_(ORDERS_SHEET_, HEADERS_);
    records.forEach(function (record) { sheet.appendRow(recordToRow_(record)); });
  }

  /* 1行を1回のsetValuesで更新する。fields: HEADERS_のキー（またはitems）。存在しないキーは例外。 */
  function updateOrder(optionOrderId, fields) {
    var found = findByOptionOrderId(optionOrderId);
    if (!found) return null;
    var next = Object.assign({}, found.record);
    Object.keys(fields).forEach(function (key) {
      if (key !== 'items' && HEADERS_.indexOf(key) === -1) {
        throw new Error('OptionOrders: 未知の列です: ' + key);
      }
      next[key] = fields[key];
    });
    next.updatedAt = fields.updatedAt !== undefined ? fields.updatedAt : new Date();
    var sheet = ensureSheet_(ORDERS_SHEET_, HEADERS_);
    sheet.getRange(found.rowNumber, 1, 1, HEADERS_.length).setValues([recordToRow_(next)]);
    var updated = Object.assign({}, next);
    updated.items = parseItems_(recordToRow_(next)[HEADERS_.indexOf('itemsJson')]);
    return { rowNumber: found.rowNumber, record: updated };
  }

  /* ---- OptionEligibility（管理者が自動判定できない既存利用者を許可する） ---- */

  function listEligibilityGrants() {
    var sheet = ensureSheet_(ELIGIBILITY_SHEET_, ELIGIBILITY_HEADERS_);
    var values = sheet.getDataRange().getValues();
    var result = [];
    for (var i = 1; i < values.length; i++) {
      result.push({ email: values[i][0], optionCode: values[i][1], grantedAt: values[i][2], note: values[i][3] });
    }
    return result;
  }

  function hasEligibilityGrant(email, optionCode) {
    var target = normalizeEmail(email);
    if (!target) return false;
    return listEligibilityGrants().some(function (g) {
      return normalizeEmail(g.email) === target && g.optionCode === optionCode;
    });
  }

  /* 許可の取り消し（該当する許可行を空にする。履歴の行数は変えない）。取り消した件数を返す。 */
  function removeEligibilityGrant(email, optionCode) {
    var target = normalizeEmail(email);
    if (!target) return 0;
    var sheet = ensureSheet_(ELIGIBILITY_SHEET_, ELIGIBILITY_HEADERS_);
    var values = sheet.getDataRange().getValues();
    var count = 0;
    for (var i = 1; i < values.length; i++) {
      if (normalizeEmail(values[i][0]) === target && values[i][1] === optionCode) {
        sheet.getRange(i + 1, 1, 1, ELIGIBILITY_HEADERS_.length).setValues([['', '', values[i][2], '取り消し済み']]);
        count++;
      }
    }
    return count;
  }

  function addEligibilityGrant(email, optionCode, note, now) {
    var sheet = ensureSheet_(ELIGIBILITY_SHEET_, ELIGIBILITY_HEADERS_);
    sheet.appendRow([safeCell_(normalizeEmail(email)), optionCode, now || new Date(), safeCell_(String(note || '').slice(0, 200))]);
  }

  return {
    HEADERS: HEADERS_,
    ELIGIBILITY_HEADERS: ELIGIBILITY_HEADERS_,
    normalizeEmail: normalizeEmail,
    listAll: listAll,
    listByBookingId: listByBookingId,
    findByOptionOrderId: findByOptionOrderId,
    appendOrders: appendOrders,
    updateOrder: updateOrder,
    listEligibilityGrants: listEligibilityGrants,
    hasEligibilityGrant: hasEligibilityGrant,
    addEligibilityGrant: addEligibilityGrant,
    removeEligibilityGrant: removeEligibilityGrant
  };
})();

/*
 * SpreadsheetRepository.gs — 予約台帳（Issue #268）のSpreadsheet読み書き。
 *
 * Script Propertiesの SPREADSHEET_ID で指定した専用Spreadsheet内に
 * 「Bookings」シートを作成・使用する（存在しなければ自動作成しヘッダー行を書く）。
 *
 * 列構成は固定（Issue #268 v1仕様 + 監査用カラム）。列を増やす場合はHEADERS_と
 * README.mdの両方を更新すること。
 */
'use strict';

var SpreadsheetRepository = (function () {
  var SHEET_NAME_ = 'Bookings';

  /*
   * 列を追加する場合は必ずこの配列の末尾へ追記すること（Issue #270のcustomerType追加時の方針）。
   * rowToRecord_は行の配列インデックスをこのHEADERS_の並び順で読むため、途中に挿入すると
   * 既存行（過去にappendBookingした実際のセルの並び）の列がずれて誤読される。末尾追記であれば、
   * 既存行はcustomerType列が空（undefined→rowToRecord_で''相当）になるだけで、他の列は
   * これまでどおり正しく読める。
   */
  var HEADERS_ = [
    'bookingId',
    'createdAt',
    'date',
    'startAt',
    'endAt',
    'brand',
    'name',
    'email',
    'phone',
    'people',
    'purpose',
    'paymentMethod',
    'status',
    'calendarEventId',
    'source',
    'note',
    'confirmedAt',
    'expiredAt',
    'cancelledAt',
    'updatedAt',
    'customerType',
    /*
     * ここから先はIssue #271（予約通知メール自動送信）で追加した列。
     * HEADERS_の並びどおり末尾へ追記する方針はcustomerType追加時（Issue #270）と同じ。
     */
    'pendingMailSentAt',
    'confirmedMailSentAt',
    'cancelMailSentAt',
    'reminderSentAt',
    'accessGuideSentAt',
    'lastMailErrorAt',
    'lastMailErrorType',
    'lastMailErrorMessage'
  ];

  function getSpreadsheet_() {
    return SpreadsheetApp.openById(BookingConfig.getSpreadsheetId());
  }

  /* シートが存在しない、またはヘッダー行が未設定の場合はヘッダー行を書く（冪等）。 */
  function ensureBookingsSheet_() {
    var spreadsheet = getSpreadsheet_();
    var sheet = spreadsheet.getSheetByName(SHEET_NAME_);
    if (!sheet) {
      sheet = spreadsheet.insertSheet(SHEET_NAME_);
    }
    if (sheet.getLastRow() < 1) {
      sheet.appendRow(HEADERS_);
    }
    return sheet;
  }

  function rowToRecord_(row) {
    var record = {};
    HEADERS_.forEach(function (header, index) {
      record[header] = row[index];
    });
    return record;
  }

  function recordToRow_(record) {
    return HEADERS_.map(function (header) {
      return record[header] !== undefined && record[header] !== null ? record[header] : '';
    });
  }

  /* record: HEADERS_のキーを持つオブジェクト（未指定のフィールドは空文字で埋める）。 */
  function appendBooking(record) {
    var sheet = ensureBookingsSheet_();
    sheet.appendRow(recordToRow_(record));
  }

  /* 戻り値: { rowNumber, record } または見つからない場合はnull。
     rowNumberは1始まり・ヘッダー行込みのSpreadsheet実際の行番号（getRange等にそのまま使える）。 */
  function findRowByBookingId(bookingId) {
    var sheet = ensureBookingsSheet_();
    var values = sheet.getDataRange().getValues();
    for (var i = 1; i < values.length; i++) {
      if (values[i][0] === bookingId) {
        return { rowNumber: i + 1, record: rowToRecord_(values[i]) };
      }
    }
    return null;
  }

  /* status===PENDINGの全行を返す（expirePendingBookings用）。件数が多くなる想定は
     Phase 1ではないため、全行取得→フィルタというシンプルな実装にしている。 */
  function getAllPendingBookings() {
    var sheet = ensureBookingsSheet_();
    var values = sheet.getDataRange().getValues();
    var result = [];
    for (var i = 1; i < values.length; i++) {
      var record = rowToRecord_(values[i]);
      if (record.status === 'PENDING') {
        result.push({ rowNumber: i + 1, record: record });
      }
    }
    return result;
  }

  /* status===CONFIRMEDかつdate===dateStringの全行を返す（前日リマインド抽出用。Issue #271）。
     reminderSentAt等の判定はBookingMailer側の責務とし、ここではstatus/dateのみで絞り込む。 */
  function getConfirmedBookingsForDate(dateString) {
    var sheet = ensureBookingsSheet_();
    var values = sheet.getDataRange().getValues();
    var result = [];
    for (var i = 1; i < values.length; i++) {
      var record = rowToRecord_(values[i]);
      if (record.status === 'CONFIRMED' && record.date === dateString) {
        result.push({ rowNumber: i + 1, record: record });
      }
    }
    return result;
  }

  /*
   * fields: { [HEADERS_のいずれか]: value } の部分更新。statusセルの直接編集を
   * 正式運用にしないため、statusを含む更新は必ずこの関数（＝confirmBooking /
   * expirePendingBookings）経由でのみ行う。
   * bookingIdが見つからない場合は例外を投げる。
   */
  function updateBookingFields(bookingId, fields) {
    var found = findRowByBookingId(bookingId);
    if (!found) {
      throw new Error('bookingIdが見つかりません: ' + bookingId);
    }
    var sheet = ensureBookingsSheet_();
    Object.keys(fields).forEach(function (key) {
      var columnIndex = HEADERS_.indexOf(key);
      if (columnIndex === -1) {
        throw new Error('未知のbookingフィールドです: ' + key);
      }
      sheet.getRange(found.rowNumber, columnIndex + 1, 1, 1).setValues([[fields[key]]]);
    });
    return found.rowNumber;
  }

  /*
   * bookingIdの行全体を1回のsetValuesで更新する（Issue #272 PRレビュー対応）。
   * updateBookingFieldsはfieldsのキーごとに個別のgetRange().setValues()を順番に
   * 実行するため、複数フィールドを同時に更新する途中で例外が起きると部分更新
   * （例: statusだけCANCELLEDになりcancelledAtが空のまま）になり得る。呼び出し元が
   * 複数フィールドを必ず一貫して更新したい場合（cancelBookingAdminのstatus/
   * cancelledAt/updatedAt等）は、この関数で行全体を1回のSpreadsheet書き込みに
   * まとめること。bookingIdが見つからない・未知のフィールド名の場合の挙動は
   * updateBookingFieldsと同じ（例外を投げる）。
   */
  function updateBookingFieldsAtomic(bookingId, fields) {
    var found = findRowByBookingId(bookingId);
    if (!found) {
      throw new Error('bookingIdが見つかりません: ' + bookingId);
    }

    var updatedRecord = {};
    HEADERS_.forEach(function (header) {
      updatedRecord[header] = found.record[header];
    });
    Object.keys(fields).forEach(function (key) {
      if (HEADERS_.indexOf(key) === -1) {
        throw new Error('未知のbookingフィールドです: ' + key);
      }
      updatedRecord[key] = fields[key];
    });

    var sheet = ensureBookingsSheet_();
    sheet.getRange(found.rowNumber, 1, 1, HEADERS_.length).setValues([recordToRow_(updatedRecord)]);
    return found.rowNumber;
  }

  return {
    HEADERS: HEADERS_,
    appendBooking: appendBooking,
    findRowByBookingId: findRowByBookingId,
    getAllPendingBookings: getAllPendingBookings,
    getConfirmedBookingsForDate: getConfirmedBookingsForDate,
    updateBookingFields: updateBookingFields,
    updateBookingFieldsAtomic: updateBookingFieldsAtomic
  };
})();

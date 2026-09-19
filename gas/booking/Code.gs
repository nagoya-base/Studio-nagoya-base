/*
 * Code.gs — 自社予約システム Web App エントリポイント（Issue #266: getAvailability / Issue #268: createBooking）。
 *
 * doGet: getAvailability（読み取り専用の空き判定）のみ。Issue #266のまま変更していない。
 * doPost: createBooking（Issue #268で追加）。個人情報を書き込むAPIのため、GETではなく
 *   POST専用にしている（GETクエリパラメータや閲覧履歴にPIIが残る事故を避けるため）。
 *
 * デプロイ設定（README.md参照）:
 *   Execute as: Me
 *   Who has access: Anyone
 *
 * フロントエンドはCalendar ID・Spreadsheet IDを一切知らない。Script Propertiesで管理し、
 * getAvailabilityのレスポンスにもcreateBookingのレスポンスにも、他の予約のイベント詳細・
 * PIIを一切含めない（createBookingは呼び出した本人が送った内容の要約のみを返す）。
 */
'use strict';

function doGet(e) {
  var params = (e && e.parameter) || {};
  return jsonOutput_(handleGetAvailability_(params));
}

function doPost(e) {
  return jsonOutput_(handleCreateBooking_(e));
}

/* e.postData.contentsをJSONとしてパースし、BookingRepository.createBookingへ渡す。
   createBooking内部・依存先で想定外の例外が発生した場合も、スタックトレースや内部エラー
   文言を外部レスポンスへ出さず、汎用のINTERNAL_ERRORとして返す（詳細はLoggerへのみ残す）。 */
function handleCreateBooking_(e) {
  var payload;
  try {
    payload = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (parseError) {
    return { success: false, error: { code: 'INVALID_JSON', message: 'リクエストの形式が正しくありません。' } };
  }

  try {
    return BookingRepository.createBooking(payload);
  } catch (unexpectedError) {
    Logger.log('createBooking unexpected error: ' + (unexpectedError && unexpectedError.message));
    return {
      success: false,
      error: { code: 'INTERNAL_ERROR', message: '予約処理中にエラーが発生しました。しばらくしてから再度お試しください。' }
    };
  }
}

/* params: { date, durationMinutes, brand }（すべて文字列。GASのdoGetクエリパラメータのため） */
function handleGetAvailability_(params) {
  var config = BookingConfig.getAvailabilityConfig();

  var request = {
    date: params.date,
    durationMinutes: parseDurationParam_(params.durationMinutes),
    brand: params.brand || null
  };

  var validationError = BookingAvailability.validateInput(request.date, request.durationMinutes, config);
  if (validationError) {
    return { success: false, error: validationError };
  }

  var calendarId = BookingConfig.getCalendarId();
  var busyIntervals = CalendarRepository.getBusyIntervalsForDate(calendarId, request.date, config.timezone);

  return BookingAvailability.getAvailability(request, busyIntervals, config);
}

/* 公開Web APIのため、"120abc"や"120.9"のような部分一致をparseIntで緩く受理しない。
   文字列全体が先頭0を持たない正の整数のときだけ数値化し、それ以外はNaNにする
   （Availability.gs側のバリデーションに判定を委ねる。マージ前レビュー指摘対応）。 */
var POSITIVE_INTEGER_PATTERN_ = /^[1-9]\d*$/;

function parseDurationParam_(value) {
  if (typeof value !== 'string' || !POSITIVE_INTEGER_PATTERN_.test(value)) return NaN;
  return parseInt(value, 10);
}

function jsonOutput_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

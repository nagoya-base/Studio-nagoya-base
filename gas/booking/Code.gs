/*
 * Code.gs — 自社予約システム Web App エントリポイント（Issue #266）。
 *
 * このIssueで実装するのはgetAvailability（読み取り専用の空き判定）のみ。
 * 以下は明示的に非対象（Issue #266の「非対象」節）：
 * - createBooking（予約作成）
 * - 利用者情報の入力・保存
 * - 料金計算 / 会員判定 / キャンセル / 決済
 *
 * デプロイ設定（README.md参照）:
 *   Execute as: Me
 *   Who has access: Anyone
 *
 * フロントエンドはCalendar IDを一切知らない。Script Propertiesで管理し、
 * レスポンスにもイベントの詳細・PIIを含めない（date / durationMinutes / brand /
 * bookableStartTimes / errorのみを返す）。
 */
'use strict';

function doGet(e) {
  var params = (e && e.parameter) || {};
  return jsonOutput_(handleGetAvailability_(params));
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

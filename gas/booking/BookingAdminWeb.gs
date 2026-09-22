/*
 * BookingAdminWeb.gs — 個人用Booking Admin Web UI（Issue #305）。
 *
 * 「1人で使うBooking Adminを、スマホから確定・キャンセルしやすくする最低限のUI」が目的。
 * 新しい予約管理ロジックは一切作らず、既存の正式関数（confirmBooking(bookingId) /
 * cancelBookingAdmin(bookingId)。いずれもBookingAdmin.gs）とSpreadsheetRepository.gsの
 * 読み取り関数をそのまま呼ぶ薄いラッパーのみを置く。statusセルの直接編集・独自の
 * Calendar/Sheets/Mail/Recovery処理は一切持たない。
 *
 * 【重要・デプロイ先について】このファイルはBookingAdmin.gs等と同じBooking Admin
 * プロジェクト（`SPREADSHEET_ID`のSpreadsheetへコンテナバインド）へデプロイする。
 * 公開Booking Web Appプロジェクト（Code.gs）には一切追加しない。
 *
 * 【Web Appとしてのデプロイについて】Booking Adminプロジェクトは、従来「Spreadsheetの
 * UI拡張＋時間主導トリガー」としてのみ使い、Web Appとしてはデプロイしていなかった
 * （README「管理メニュー用GASプロジェクト（Booking Admin）のセットアップ」参照）。
 * このIssueでは、同一プロジェクトに`doGet()`を追加し、あわせてWeb Appとしてもデプロイする
 * （Execute as: Me / Who has access: Only myself。管理者本人のみアクセス可能）。
 * container-boundスクリプトはonOpen単純トリガーとWeb Appエントリポイントを同一プロジェクト内で
 * 共存させられるため、この変更によって「予約管理」カスタムメニューやPENDING TTL失効の
 * 時間主導トリガーの動作は変わらない。
 *
 * 【LockServiceについて】adminConfirmBooking/adminCancelBookingは、いずれもBookingAdmin.gsの
 * confirmBooking(bookingId)/cancelBookingAdmin(bookingId)をそのまま呼ぶ。
 * LockService.getScriptLock()はスクリプトプロジェクト単位の排他であり、呼び出し元が
 * onOpenメニューだろうとWeb App（doGet/google.script.run）だろうと同じLockを取得するため、
 * expirePendingBookingsとの排他は今までどおり保たれる（Web App化によってLock設計は
 * 変わらない）。
 *
 * このファイルはHtmlService/SpreadsheetApp.openByIdに依存するため、GAS実行環境でのみ
 * 動作する。node --testではdoGet以外（getAdminBookings/getAdminBookingDetail/
 * adminConfirmBooking/adminCancelBooking）をSpreadsheetApp等のスタブ経由で検証する。
 *
 * 【日時の扱いについて】Bookingsシートのstartat/endAt等はSpreadsheet上のDate値だが、
 * google.script.runをまたいでDateオブジェクトをそのまま返すと、クライアント側での扱いが
 * 実行環境依存になりやすい。ここでは既存のBookingAvailability.formatDateInTimezone/
 * formatTimeInTimezone（Availability.gs。他の管理者向け表示・メール本文でも使っている
 * 既存の純粋関数）を再利用し、Web UIへ渡す前に必ずAsia/Tokyo（Script Propertiesの
 * TIMEZONE）基準の文字列へ正規化する。新しい日時ロジックは追加していない。
 */
'use strict';

/* Web Appエントリポイント。BookingAdminPage.html（同一プロジェクトへ配布するHTMLファイル）を
   そのまま返すだけで、業務ロジックはここに一切持たない。 */
function doGet() {
  return HtmlService.createHtmlOutputFromFile('BookingAdminPage')
    .setTitle('Booking Admin')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/* Booking.gs/BookingRepository.gs等と同じduck-typingでDateかどうかを判定する。 */
function isAdminWebDateLike_(value) {
  return !!value && typeof value.getTime === 'function' && !isNaN(value.getTime());
}

/* Date値のみ'HH:mm'へ変換する。Date以外（''や既存の文字列）はそのまま返す。 */
function formatAdminTime_(value, timezone) {
  if (!isAdminWebDateLike_(value)) return value === undefined || value === null ? '' : value;
  return BookingAvailability.formatTimeInTimezone(value, timezone) || '';
}

/*
 * Date値のみ'YYYY-MM-DD'へ変換する。Date以外（''や既存の文字列）はそのまま返す。
 * Bookingsシートの`date`列は本来文字列として保存しているが、Google Sheets側の
 * セル書式・入力補完によって日付らしい文字列がDate値として保存・読み込まれる場合が
 * あるため、`record.date`もstartAt/endAt等と同じくduck-typingでDateかどうかを確認し、
 * Web UIへは必ず'YYYY-MM-DD'の文字列として返す。
 */
function formatAdminDate_(value, timezone) {
  if (!isAdminWebDateLike_(value)) return value === undefined || value === null ? '' : value;
  return BookingAvailability.formatDateInTimezone(value, timezone) || '';
}

/* Date値のみ'YYYY-MM-DD HH:mm'へ変換する。Date以外（''や既存の文字列）はそのまま返す。 */
function formatAdminDateTime_(value, timezone) {
  if (!isAdminWebDateLike_(value)) return value === undefined || value === null ? '' : value;
  var datePart = BookingAvailability.formatDateInTimezone(value, timezone);
  var timePart = BookingAvailability.formatTimeInTimezone(value, timezone);
  return datePart && timePart ? datePart + ' ' + timePart : '';
}

/*
 * 一覧取得（Issue #305「読み取り」節どおり、全件取得→UI側で今日/今後/すべてを絞り込む）。
 * 個人管理用途で件数が小規模な前提のため、専用の検索API・ページネーションは作らない。
 *
 * 「今日」判定を端末のtimezoneに依存させないため、サーバー側（Asia/Tokyo基準）で
 * 計算した`todayJst`を一覧と一緒に返す。クライアント側はこの文字列とbooking.date
 * （既にJST基準の'YYYY-MM-DD'）を単純比較するだけで、端末のtimezone設定に関わらず
 * 常に正しく「今日/今後」を判定できる。
 *
 * PIIを一般公開しないため、一覧カードの表示に不要なフィールド（email/phone/note/
 * mail SentAt系/lastMailError系等）はここでは返さない。それらは詳細取得
 * （getAdminBookingDetail）でのみ返す。
 *
 * createdAtは一覧の「予約順」ソート（クライアント側でcreatedAt降順に並べ替える）のために
 * 返す。カード表示には使わない（BookingAdminPage.html参照）。他のDate値と同じく
 * google.script.run越しにDateオブジェクトをそのまま渡さず、formatAdminDateTime_で
 * Web UI用の比較可能な文字列（'YYYY-MM-DD HH:mm'）へ正規化してから返す。
 */
function getAdminBookings() {
  var timezone = BookingConfig.getAvailabilityConfig().timezone;
  var todayJst = BookingAvailability.formatDateInTimezone(new Date(), timezone);
  var bookings = SpreadsheetRepository.getAllBookings().map(function (item) {
    var record = item.record;
    return {
      bookingId: record.bookingId,
      createdAt: formatAdminDateTime_(record.createdAt, timezone),
      date: formatAdminDate_(record.date, timezone),
      startAt: formatAdminTime_(record.startAt, timezone),
      endAt: formatAdminTime_(record.endAt, timezone),
      brand: record.brand,
      name: record.name,
      people: record.people,
      customerType: record.customerType,
      purpose: record.purpose,
      paymentMethod: record.paymentMethod,
      status: record.status
    };
  });
  return { todayJst: todayJst, bookings: bookings };
}

/*
 * 詳細取得。Bookingsの当該行の値を編集はしないが、Date値はWeb UI用の文字列へ正規化して
 * 返す（google.script.run越しにDateオブジェクトをそのまま渡さない）。lastMailError*の
 * 詳細（エラー内容・種別・日時）はWeb UIへは出さず、`hasMailError`（あり/なし）のみ返す
 * （障害調査はSpreadsheetを直接確認する運用のまま）。
 */
function getAdminBookingDetail(bookingId) {
  var found = SpreadsheetRepository.findRowByBookingId(bookingId);
  if (!found) {
    return { success: false, error: { code: 'NOT_FOUND', message: 'bookingIdが見つかりません: ' + bookingId } };
  }
  var timezone = BookingConfig.getAvailabilityConfig().timezone;
  var record = found.record;
  return {
    success: true,
    booking: {
      bookingId: record.bookingId,
      date: formatAdminDate_(record.date, timezone),
      startAt: formatAdminDateTime_(record.startAt, timezone),
      endAt: formatAdminDateTime_(record.endAt, timezone),
      brand: record.brand,
      status: record.status,
      name: record.name,
      email: record.email,
      phone: record.phone,
      people: record.people,
      customerType: record.customerType,
      purpose: record.purpose,
      paymentMethod: record.paymentMethod,
      source: record.source,
      note: record.note,
      pendingMailSentAt: formatAdminDateTime_(record.pendingMailSentAt, timezone),
      confirmedMailSentAt: formatAdminDateTime_(record.confirmedMailSentAt, timezone),
      cancelMailSentAt: formatAdminDateTime_(record.cancelMailSentAt, timezone),
      reminderSentAt: formatAdminDateTime_(record.reminderSentAt, timezone),
      accessGuideSentAt: formatAdminDateTime_(record.accessGuideSentAt, timezone),
      hasMailError: !!record.lastMailErrorAt
    }
  };
}

/* 確定。既存の正式関数confirmBooking(bookingId)（BookingAdmin.gs）へそのまま委譲する。
   業務ロジックはコピーしない。 */
function adminConfirmBooking(bookingId) {
  return confirmBooking(bookingId);
}

/* キャンセル。既存の正式関数cancelBookingAdmin(bookingId)（BookingAdmin.gs）へそのまま
   委譲する。業務ロジックはコピーしない。実行前の確認ダイアログはHTML側（クライアント）で行う。 */
function adminCancelBooking(bookingId) {
  return cancelBookingAdmin(bookingId);
}

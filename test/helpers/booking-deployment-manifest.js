/*
 * gas/booking/README.md「GASプロジェクトへのデプロイ対象ファイル」表と同期させる、
 * 実際に配布する.gsファイル名の一覧（テスト専用。このファイル自体はGASへ配布しない）。
 *
 * BOOKING_ADMIN_FILESは、Booking Admin（SPREADSHEET_IDのSpreadsheetへコンテナバインド）
 * プロジェクトへ実際にコピーするファイルの一覧そのもの（vmへ読み込む順＝依存順）。
 * test/booking-admin-deployment.test.jsが、この一覧「だけ」をvm実行して既存PENDINGメール
 * 再送・PENDING TTL失効がReferenceErrorなく動くことを検証する（Issue #273回帰テスト）。
 *
 * .gsファイルを追加・削除した場合は、この一覧とREADME.mdの表の両方を更新すること。
 * この「両方を更新すること」というルール自体がドリフトしていないかは、
 * test/booking-deployment-manifest-sync.test.jsがREADME.mdの表を直接パースして機械的に検証する
 * （PR #288レビュー対応）。両リストとも`appsscript.json`は含めない（.gsファイルではなく、
 * README.mdの表ではWeb App列にのみ✓が付く行として別管理されているため。sync検証側でも
 * 比較対象から明示的に除外している）。
 */
'use strict';

var BOOKING_ADMIN_FILES = [
  'Config.gs',
  'CalendarRepository.gs',
  'Availability.gs',
  'Booking.gs',
  'SpreadsheetRepository.gs',
  'RecoveryRepository.gs',
  'BookingMailTemplates.gs',
  'BookingMailer.gs',
  'BookingRepository.gs',
  'BookingAdmin.gs',
  'BookingAdminWeb.gs',
  'BookingTriggers.gs',
  'BookingReminderTriggers.gs',
  'BookingReminderDiagnostics.gs',
  /*
   * Issue #344追記（料金差額の自動計算。PR #345レビュー対応）で追加。JapaneseHolidays.gs・
   * BookingPricing.gs（いずれもIssue #342/#346でBooking Web App専用として追加された既存
   * ファイル）を、BookingReschedule.gsの日程変更フェーズでも同じ料金表・祝日判定ロジックを
   * 再利用するためBooking Adminにも追加した（料金表の二重管理を避ける。下記
   * BOOKING_WEB_APP_FILESの注記も参照）。FeeCalculator.gsはこの2ファイルにのみ依存する
   * 純粋関数群、FeeSettlementRepository.gsは精算の冪等性台帳（FeeSettlementsシート）。
   */
  'JapaneseHolidays.gs',
  'BookingPricing.gs',
  'FeeCalculator.gs',
  'FeeSettlementRepository.gs',
  'BookingReschedule.gs'
];

/* Code.gs/RateLimiter.gs/AdminNotifier.gsはcreateBooking専用のためBooking Adminには
   含めない（Booking AdminはcreateBookingを一切呼ばない。README.mdの表を参照）。
   JapaneseHolidays.gs（Issue #346）・BookingPricing.gs（Issue #342）はBooking Web App専用
   ではなくなった（Issue #344追記でBooking Adminにも追加。上記BOOKING_ADMIN_FILESの
   注記を参照）。Web App側では引き続きcreateBooking（BookingPricing経由で料金計算）が
   必要なため、両ファイルともこの一覧にも残す。 */
var BOOKING_WEB_APP_FILES = [
  'Config.gs',
  'CalendarRepository.gs',
  'Availability.gs',
  'Booking.gs',
  'JapaneseHolidays.gs',
  'BookingPricing.gs',
  'RateLimiter.gs',
  'SpreadsheetRepository.gs',
  'RecoveryRepository.gs',
  'BookingRepository.gs',
  'AdminNotifier.gs',
  'BookingMailTemplates.gs',
  'BookingMailer.gs',
  'Code.gs'
];

module.exports = {
  BOOKING_ADMIN_FILES: BOOKING_ADMIN_FILES,
  BOOKING_WEB_APP_FILES: BOOKING_WEB_APP_FILES
};

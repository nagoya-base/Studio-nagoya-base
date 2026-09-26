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
  /*
   * Issue #341 PR-A（Stripe API即時決済移行）で追加。CardPayment.gsはBooking.gsの
   * PAYMENT_STATUS/getEffectivePriceAmountに依存する純粋ロジックのため、Booking.gsの
   * 直後・SpreadsheetRepository.gsより前に置く（依存順）。
   */
  'CardPayment.gs',
  /*
   * Issue #341 PR-B（Checkout Session発行・仮押さえ）で追加。expirePendingBookings
   * （このAdminプロジェクトの時間主導トリガー）がcheckout_pendingの仮押さえ失効確認で
   * StripeGateway.retrieveCheckoutSessionを呼ぶため、Booking Adminにも必要。
   */
  'StripeGateway.gs',
  /*
   * Issue #341 PR-C（署名検証Webhook受信基盤・自動確定・イベント冪等性）で追加。
   * StripeWebhookAuth.gs（中継基盤からの呼び出し認証。Utilities依存のみ）・
   * StripeEventRepository.gs（イベント処理台帳。BookingConfigのみに依存）はいずれも
   * BookingRepository.gsより前に置く（依存順）。StripeWebhookHandler.gsは
   * BookingRepository.applyPaymentStateUpdate/confirmBookingを呼ぶためBookingRepository.gs
   * より後に置く。BookingWebhook.gs（doPostエントリポイント）は他のBooking Admin用
   * .gsファイルと同じく最後に置く。いずれもBooking Web Appプロジェクトには追加しない
   * （StripeWebhookHandler.gsファイル冒頭コメント「デプロイ先について」参照。
   * confirmBooking/expirePendingBookingsとLockServiceを共有する必要があるため）。
   */
  'StripeWebhookAuth.gs',
  'StripeEventRepository.gs',
  'SpreadsheetRepository.gs',
  'RecoveryRepository.gs',
  'BookingMailTemplates.gs',
  'BookingMailer.gs',
  'BookingRepository.gs',
  'StripeWebhookHandler.gs',
  'BookingAdmin.gs',
  'BookingAdminWeb.gs',
  'BookingWebhook.gs',
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
  'CardPayment.gs',
  /* Issue #341 PR-B: BookingRepository.beginCardCheckoutがStripeGateway.
     createCheckoutSession/retrieveCheckoutSessionを呼ぶため必要。 */
  'StripeGateway.gs',
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

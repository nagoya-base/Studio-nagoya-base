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

/*
 * BOOKING_WEBHOOK_FILESは、Issue #341 PR-C（レビュー対応・1回目で新設）の
 * **独立した**Booking Webhookプロジェクトへ実際にコピーするファイルの一覧。
 * confirmBooking/expirePendingBookings（Booking Admin）とは別のスクリプトプロジェクトの
 * ため、LockService.getScriptLock()は共有されない（StripeWebhookHandler.gs冒頭コメント
 * 「失効処理（expirePendingBookings）との競合について」参照）。
 *
 * 意図的に含めないファイル: `BookingAdmin.gs`/`BookingAdminWeb.gs`/`BookingTriggers.gs`/
 * `BookingReminderTriggers.gs`/`BookingReminderDiagnostics.gs`（管理者専用UI・トリガー。
 * `doGet`や`getAdminBookings`/`adminConfirmBooking`/`adminCancelBooking`等の管理者向け
 * サーバー関数を一切含めないことで、このプロジェクトの「Anyone」公開デプロイから
 * 管理者機能へ到達できない構成を保証する。`test/booking-webhook-deployment.test.js`で
 * 検証）、`Code.gs`/`RateLimiter.gs`/`AdminNotifier.gs`（Booking Web App専用の
 * createBooking関連）、`JapaneseHolidays.gs`/`BookingPricing.gs`/`FeeCalculator.gs`/
 * `FeeSettlementRepository.gs`/`BookingReschedule.gs`（日程変更精算専用。Webhook処理は
 * 一切関与しない）。
 */
var BOOKING_WEBHOOK_FILES = [
  'Config.gs',
  'CalendarRepository.gs',
  'Availability.gs',
  'Booking.gs',
  'CardPayment.gs',
  'StripeGateway.gs',
  'StripeWebhookAuth.gs',
  'StripeEventRepository.gs',
  'SpreadsheetRepository.gs',
  'RecoveryRepository.gs',
  'BookingMailTemplates.gs',
  'BookingMailer.gs',
  'BookingRepository.gs',
  /* BookingRepository.applyPaymentStateUpdate/confirmBookingを呼ぶため、それらより後に置く
     （依存順）。 */
  'StripeWebhookHandler.gs',
  'BookingWebhookEndpoint.gs'
];

module.exports = {
  BOOKING_ADMIN_FILES: BOOKING_ADMIN_FILES,
  BOOKING_WEB_APP_FILES: BOOKING_WEB_APP_FILES,
  BOOKING_WEBHOOK_FILES: BOOKING_WEBHOOK_FILES
};

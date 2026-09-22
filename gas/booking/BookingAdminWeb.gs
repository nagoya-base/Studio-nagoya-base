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
 */
'use strict';

/* Web Appエントリポイント。BookingAdmin.html（同一プロジェクトへ配布するHTMLファイル）を
   そのまま返すだけで、業務ロジックはここに一切持たない。 */
function doGet() {
  return HtmlService.createHtmlOutputFromFile('BookingAdmin')
    .setTitle('Booking Admin')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/*
 * 一覧取得（Issue #305「読み取り」節どおり、全件取得→UI側で今日/今後/すべてを絞り込む）。
 * 個人管理用途で件数が小規模な前提のため、専用の検索API・ページネーションは作らない。
 *
 * PIIを一般公開しないため、一覧カードの表示に不要なフィールド（email/phone/note/
 * mail SentAt系/lastMailError系等）はここでは返さない。それらは詳細取得
 * （getAdminBookingDetail）でのみ返す。
 */
function getAdminBookings() {
  return SpreadsheetRepository.getAllBookings().map(function (item) {
    var record = item.record;
    return {
      bookingId: record.bookingId,
      date: record.date,
      startAt: record.startAt,
      endAt: record.endAt,
      brand: record.brand,
      name: record.name,
      people: record.people,
      customerType: record.customerType,
      purpose: record.purpose,
      paymentMethod: record.paymentMethod,
      status: record.status
    };
  });
}

/* 詳細取得。Bookingsの当該行をそのまま返す（値そのものは一切加工・編集しない）。 */
function getAdminBookingDetail(bookingId) {
  var found = SpreadsheetRepository.findRowByBookingId(bookingId);
  if (!found) {
    return { success: false, error: { code: 'NOT_FOUND', message: 'bookingIdが見つかりません: ' + bookingId } };
  }
  return { success: true, booking: found.record };
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

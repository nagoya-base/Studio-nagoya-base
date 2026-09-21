/*
 * scripts/booking-config.js — 共通予約UI（Issue #269）が呼び出すGAS Web AppのURL設定。
 *
 * 3ブランド（SNB / SNB mens / Studio X）とも、この同じWeb App（gas/booking/）の
 * getAvailability（GET） / createBooking（POST）を呼ぶ。ブランド別に別のWeb App・
 * 別のCalendarを用意することはしない。
 *
 * このファイルは全ブランドの予約ページから共通で読み込まれる、接続先を切り替える
 * ための唯一の場所。
 *
 * #273 Stage B ロールバック実地確認: 本番Booking Web Appは既に稼働済みで、既存
 * `/exec` URLも確認済みだが、ロールバック実地確認のため一時的にBASE_URLを空にし、
 * 共通予約UI（/booking/ /mens/booking/ /studio-x/booking/）を停止状態にしている。
 * backend側の本番GASプロジェクト自体は停止・削除していない。ロールフォワード
 * （新UIへの復帰）時には、既存の本番`/exec` URLへBASE_URLを戻す。
 */
window.BookingApiConfig = {
  /* ロールバック中は空のまま。共通予約UIはAPI未接続として案内を表示し、
     getAvailability/createBookingを呼ばない（誤って空文字へfetchしない安全策）。 */
  BASE_URL: ''
};

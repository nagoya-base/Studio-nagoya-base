/*
 * scripts/booking-config.js — 共通予約UI（Issue #269）が呼び出すGAS Web AppのURL設定。
 *
 * 3ブランド（SNB / SNB mens / Studio X）とも、この同じWeb App（gas/booking/）の
 * getAvailability（GET） / createBooking（POST）を呼ぶ。ブランド別に別のWeb App・
 * 別のCalendarを用意することはしない。
 *
 * このファイルは全ブランドの予約ページから共通で読み込まれる、接続先を切り替える
 * ための唯一の場所。#269時点ではBooking Web Appの本番デプロイをまだ行っていないため、
 * BASE_URLはプレースホルダのままにしてある（本番デプロイ・URL差し替えは#273の責務。
 * gas/booking/README.md「デプロイ後の接続手順」参照）。
 */
window.BookingApiConfig = {
  /* デプロイ後のBooking Web App URL（例: https://script.google.com/macros/s/XXXX/exec）
     に差し替えること。空のままだと共通予約UIはAPI未接続として案内を表示し、
     getAvailability/createBookingを呼ばない（誤って空文字へfetchしない安全策）。 */
  BASE_URL: ''
};

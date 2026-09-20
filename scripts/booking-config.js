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
 * #273 Stage A: BASE_URLには、Issue #267の実環境確認コメント
 * （https://github.com/nagoya-base/Studio-nagoya-base/issues/267#issuecomment-5738576390）
 * に記録済みの、既存Booking Web Appプロジェクト（studio_nagoya_base_booking。
 * Execute as: Me / Access: Anyone）の本番`/exec` URLを設定している。新規デプロイは
 * 行っていない。ただしこのGASプロジェクトへ#268〜#272のコード（createBooking・
 * confirmBooking・キャンセル・通知メール等）を反映するのはStage Bの責務であり
 * （gas/booking/README.md「デプロイ後の接続手順」参照）、本PRの時点では未反映の
 * 可能性がある。mainへマージ・GitHub Pagesへ反映されるまでは実際のAPI呼び出しは
 * 発生しない。
 */
window.BookingApiConfig = {
  BASE_URL: 'https://script.google.com/macros/s/AKfycby9Tso_3ksDjMZhoKIFr6KR_JA6XlDufLB8Twmo-BEBbAzzzdWfLSAIF7iP3D2a0EkXnA/exec'
};

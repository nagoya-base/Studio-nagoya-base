/*
 * BookingWindow.gs — 予約可能期間（Issue #480）の正本。
 *
 * 予約作成日時（Asia/Tokyo）の暦日を基準に、利用日までの予約可能期間を分ける。
 *   - 一般利用者: 30日先まで（境界日を含む）
 *   - actual SNB MEMBER: 90日先まで（予約作成時点の当月actual membershipで判定。呼び出し側の責務）
 *   - 管理者: 上限なし（認証済みのサーバー側経路のみ。公開フォームの入力メールでは判定しない）
 *
 * Availability（日別・月間）とcreateBookingは必ずこのファイルの関数で判定する（別実装を持たない）。
 * 日付は'YYYY-MM-DD'文字列（辞書順＝日付順）で扱い、UTC日付演算でタイムゾーン差の影響を受けない。
 * フロント（scripts/booking-logic.js）はAPI応答のgeneralMaxDate/memberMaxDateを使い、日数は再実装しない。
 */
'use strict';

var BookingWindow = (function () {
  var GENERAL_DAYS = 30;
  var MEMBER_DAYS = 90;

  var TIER = { GENERAL: 'GENERAL', MEMBER: 'MEMBER', ADMIN: 'ADMIN' };

  function parseDate_(dateString) {
    var match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateString || ''));
    if (!match) return null;
    var ms = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
    var d = new Date(ms);
    // 2/30等の不正日付は弾く
    if (d.getUTCFullYear() !== Number(match[1]) || d.getUTCMonth() !== Number(match[2]) - 1 || d.getUTCDate() !== Number(match[3])) return null;
    return ms;
  }

  function pad2_(n) {
    return n < 10 ? '0' + n : String(n);
  }

  /* 'YYYY-MM-DD'にdays日加えた'YYYY-MM-DD'。不正入力は''。 */
  function addDays(dateString, days) {
    var ms = parseDate_(dateString);
    if (ms === null || !Number.isFinite(days)) return '';
    var d = new Date(ms + days * 86400000);
    return d.getUTCFullYear() + '-' + pad2_(d.getUTCMonth() + 1) + '-' + pad2_(d.getUTCDate());
  }

  /* 一般30日枠の最終日（境界日を含む）。 */
  function generalMaxDate(todayString) {
    return addDays(todayString, GENERAL_DAYS);
  }

  /* 会員90日枠の最終日（境界日を含む）。 */
  function memberMaxDate(todayString) {
    return addDays(todayString, MEMBER_DAYS);
  }

  /* 階級ごとの最終日。管理者は上限なし（null）。不正入力は''。 */
  function maxDateForTier(todayString, tier) {
    if (tier === TIER.ADMIN) return null;
    return tier === TIER.MEMBER ? memberMaxDate(todayString) : generalMaxDate(todayString);
  }

  /*
   * 利用日がどの枠に収まるか。
   *   'GENERAL'      一般30日以内（誰でも予約可）
   *   'MEMBER_ONLY'  31〜90日先（actual SNB MEMBERのみ）
   *   'OUT_OF_RANGE' 90日超（管理者以外は予約不可）
   *   'INVALID'      日付不正
   * 過去日の判定は呼び出し側（既存の過去日チェック）の責務で、ここでは扱わない。
   */
  var BAND = { GENERAL: 'GENERAL', MEMBER_ONLY: 'MEMBER_ONLY', OUT_OF_RANGE: 'OUT_OF_RANGE', INVALID: 'INVALID' };

  function classifyDate(dateString, todayString) {
    var general = generalMaxDate(todayString);
    var member = memberMaxDate(todayString);
    if (!general || !member || parseDate_(dateString) === null) return BAND.INVALID;
    if (dateString <= general) return BAND.GENERAL;
    if (dateString <= member) return BAND.MEMBER_ONLY;
    return BAND.OUT_OF_RANGE;
  }

  /*
   * 管理者判定（認証済みの本人メール × allowlist）。
   * activeUserEmailはSession.getActiveUser().getEmail()等、サーバー側で本人性を確認できた値だけを渡すこと。
   * 公開フォームの予約メールアドレスを渡してはならない。allowlist未設定・メール空は常にfalse（fail-closed）。
   */
  function isAdminEmail(activeUserEmail, allowlist) {
    var email = String(activeUserEmail || '').trim().toLowerCase();
    if (!email || !Array.isArray(allowlist)) return false;
    return allowlist.some(function (item) { return String(item || '').trim().toLowerCase() === email; });
  }

  return {
    GENERAL_DAYS: GENERAL_DAYS,
    MEMBER_DAYS: MEMBER_DAYS,
    TIER: TIER,
    BAND: BAND,
    addDays: addDays,
    generalMaxDate: generalMaxDate,
    memberMaxDate: memberMaxDate,
    maxDateForTier: maxDateForTier,
    classifyDate: classifyDate,
    isAdminEmail: isAdminEmail
  };
})();

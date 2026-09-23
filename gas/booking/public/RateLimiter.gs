/*
 * RateLimiter.gs — createBooking（Issue #268）のabuse/rate limit確認。
 *
 * CacheService.getScriptCache()にスライディングウィンドウ用のタイムスタンプ配列を
 * JSON文字列として保存する。GAS実行環境で複数の同時リクエストを厳密に直列化する
 * ものではない（そこはLockServiceの責務）が、createBooking処理順の「2. abuse/rate
 * limit確認」はLock取得前に行うため、多少の競合はあり得る前提で「概ね閾値を超えたら
 * 拒否する」ゆるい防御として設計している（CacheServiceはGAS実行環境で現実的に動く
 * 数少ない共有ストレージであり、PropertiesServiceよりQuota・レイテンシの面で
 * 高頻度カウンタ用途に適している）。
 *
 * 3種類のウィンドウを同じ仕組みでチェックする:
 * - 同一メールアドレス: 既定10分3件
 * - 全体: 既定1分20件
 * - 同一内容の連投抑止: 既定2分以内の完全一致（email+date+startTime+durationMinutes）を1件のみ許可
 *
 * 閾値はBookingConfig.getRateLimitConfig()（Script Properties）で変更できる。
 */
'use strict';

var RateLimiter = (function () {
  var CACHE_MAX_EXPIRATION_SECONDS_ = 21600; /* CacheServiceの上限（6時間） */
  var CACHE_MIN_EXPIRATION_SECONDS_ = 60;

  function readTimestamps_(cache, key) {
    var raw = cache.get(key);
    if (!raw) return [];
    try {
      var parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
      return [];
    }
  }

  function pruneExpired_(timestamps, windowMillis, now) {
    return timestamps.filter(function (ts) { return typeof ts === 'number' && now - ts < windowMillis; });
  }

  function expirationSecondsFor_(windowMinutes) {
    var seconds = windowMinutes * 60;
    return Math.max(CACHE_MIN_EXPIRATION_SECONDS_, Math.min(CACHE_MAX_EXPIRATION_SECONDS_, seconds));
  }

  /*
   * key単位でwindowMinutes以内の記録件数がmaxCount未満なら許可し、今回の試行時刻(now)を記録する。
   * 既にmaxCountに達している場合は拒否し、記録はしない(それ以上ウィンドウを引き延ばさない)。
   */
  function checkWindow_(cache, key, windowMinutes, maxCount, now) {
    var windowMillis = windowMinutes * 60000;
    var timestamps = pruneExpired_(readTimestamps_(cache, key), windowMillis, now);
    var allowed = timestamps.length < maxCount;
    if (allowed) {
      timestamps.push(now);
    }
    cache.put(key, JSON.stringify(timestamps), expirationSecondsFor_(windowMinutes));
    return allowed;
  }

  function buildFingerprint_(input) {
    return [
      String(input.email || '').trim().toLowerCase(),
      input.date,
      input.startTime,
      input.durationMinutes
    ].join('|');
  }

  /*
   * input: Booking.validateCreateBookingInputのnormalized（email/date/startTime/durationMinutes必須）
   * config: BookingConfig.getRateLimitConfig()の戻り値
   * now: Date.now()相当（テスト容易性のため引数で受け取る。省略時は現在時刻）
   *
   * 戻り値: { allowed: true } または { allowed: false, reason: 'DUPLICATE_SUBMISSION' | 'EMAIL_RATE_LIMIT' | 'GLOBAL_RATE_LIMIT' }
   * 判定順は「同一内容の連投」→「同一メール」→「全体」。どれか一つでも引っかかれば即座に拒否する。
   */
  function evaluate(input, config, now) {
    now = typeof now === 'number' ? now : Date.now();
    var cache = CacheService.getScriptCache();

    var emailKey = 'booking_rl_email_' + String(input.email || '').trim().toLowerCase();
    var globalKey = 'booking_rl_global';
    var dupKey = 'booking_rl_dup_' + buildFingerprint_(input);

    if (!checkWindow_(cache, dupKey, config.duplicateWindowMinutes, 1, now)) {
      return { allowed: false, reason: 'DUPLICATE_SUBMISSION' };
    }
    if (!checkWindow_(cache, emailKey, config.emailWindowMinutes, config.emailCount, now)) {
      return { allowed: false, reason: 'EMAIL_RATE_LIMIT' };
    }
    if (!checkWindow_(cache, globalKey, config.globalWindowMinutes, config.globalCount, now)) {
      return { allowed: false, reason: 'GLOBAL_RATE_LIMIT' };
    }
    return { allowed: true };
  }

  return {
    evaluate: evaluate,
    buildFingerprint_: buildFingerprint_
  };
})();

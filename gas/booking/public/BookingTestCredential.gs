/*
 * BookingTestCredential.gs — V2（メールOTP会員確認）を2026/12/1より前に試すための「テスト資格」（Issue #559）。Booking Web App専用。
 *
 * 公開Booking Web AppはANYONE_ANONYMOUS / USER_DEPLOYINGのため管理者のログインセッションに依存できない。そのため権限者が
 * **GASエディタから手動実行する発行関数**（issueBookingTestLink）で、HMAC署名・有効期限・用途・ランダムID付きの資格を発行する。
 * 通常の公開API（doGet / doPost）からは発行も失効もできない（このファイルのトップレベル関数はエディタ実行専用で、doGet / doPostから呼ばない）。
 *
 * - 署名鍵: Script Property BOOKING_TEST_CREDENTIAL_KEY（32文字以上のランダム文字列）。ソース・ログ・Issue・PRへ出さない。
 *   Booking Admin側には置かない・Adminは資格を検証しない。
 * - 許可メール: Script Property BOOKING_TEST_ALLOWED_EMAILS（カンマ・空白・改行区切り）。資格はこの中の1アドレスに拘束して発行する。
 *   資格にメールアドレスそのものは含めない（鍵付きHMACのタグだけ）。**メールアドレスの入力だけではTESTに入れない**
 *   （署名・用途・期限・失効状態・許可メールとの一致をすべてサーバーが検証する）。
 * - 期限: 発行時にBookingPricing.GENERATION_V2_START_MS（2026/12/1 0:00 JST）を超えない範囲へ丸める。最大7日。
 * - 失効: BOOKING_TEST_REVOKED_IDS（資格IDのカンマ区切り。revokeBookingTestCredentialで追記）または署名鍵のローテーション（全資格が即失効）。
 * - 配送: 発行した資格は、拘束先の許可メールアドレス宛にテスト用リンク（URLフラグメント #bt=...）としてメール送信する。
 *   フラグメントはサーバーへ送られず、予約ページが直ちにURLから除去する。関数の戻り値・ログには資格そのものを出さない。
 * - 資格は会員資格の代用にもOTP確認済み証明の代用にもならない。TESTでもOTP・確認済み証明・メール拘束・actual membershipは通常のV2と同じ。
 */
'use strict';

var BookingTestCredential = (function () {
  var KEY_PROPERTY = 'BOOKING_TEST_CREDENTIAL_KEY';
  var ALLOWED_EMAILS_PROPERTY = 'BOOKING_TEST_ALLOWED_EMAILS';
  var REVOKED_IDS_PROPERTY = 'BOOKING_TEST_REVOKED_IDS';
  var VERSION = 't1';
  var PURPOSE = 'snb-booking-test-v2';
  var MIN_KEY_LENGTH_ = 32;
  var DEFAULT_TTL_MINUTES_ = 480;
  var MAX_TTL_MINUTES_ = 7 * 24 * 60;
  var JST_OFFSET_MS_ = 9 * 60 * 60 * 1000;
  var SITE_BASE_URL_ = 'https://nagoya-base.github.io/Studio-nagoya-base';
  var TOKEN_PATTERN_ = /^t1\.([0-9a-f]{16})\.(\d{10})\.(\d{10})\.([0-9a-f]{32})\.([0-9a-f]{64})$/;
  var ID_PATTERN_ = /^[0-9a-f]{16}$/;

  function isDateLike_(value) {
    return !!value && typeof value.getTime === 'function' && !isNaN(value.getTime());
  }

  function readProperty_(name) {
    try {
      var value = PropertiesService.getScriptProperties().getProperty(name);
      return typeof value === 'string' ? value : '';
    } catch (error) {
      return '';
    }
  }

  function getKey_() {
    var key = readProperty_(KEY_PROPERTY);
    return key.length >= MIN_KEY_LENGTH_ ? key : null;
  }

  function toHex_(bytes) {
    return bytes.map(function (b) { var v = (b < 0 ? b + 256 : b).toString(16); return v.length < 2 ? '0' + v : v; }).join('');
  }

  function hmac_(value, key) {
    return toHex_(Utilities.computeHmacSha256Signature(String(value), key, Utilities.Charset.UTF_8));
  }

  function safeEquals_(a, b) {
    var left = String(a);
    var right = String(b);
    if (left.length !== right.length) return false;
    var diff = 0;
    for (var i = 0; i < left.length; i++) diff |= left.charCodeAt(i) ^ right.charCodeAt(i);
    return diff === 0;
  }

  function normalizeEmail_(email) {
    return MembershipRules.normalizeEmail(email);
  }

  function splitList_(value) {
    return String(value || '').split(/[\s,;]+/).filter(function (item) { return item !== ''; });
  }

  function allowedEmails_() {
    return splitList_(readProperty_(ALLOWED_EMAILS_PROPERTY)).map(normalizeEmail_).filter(function (email) {
      return MembershipRules.isValidEmail(email);
    });
  }

  function revokedIds_() {
    return splitList_(readProperty_(REVOKED_IDS_PROPERTY));
  }

  function emailTag_(key, email) {
    return hmac_('email\n' + email, key).substring(0, 32);
  }

  function signBody_(key, body) {
    return hmac_(PURPOSE + '\n' + body, key);
  }

  function randomId_() {
    var hex = (Utilities.getUuid() + Utilities.getUuid()).replace(/[^0-9a-f]/g, '');
    while (hex.length < 16) hex += '0';
    return hex.substring(0, 16);
  }

  function pad10_(seconds) {
    var text = String(seconds);
    while (text.length < 10) text = '0' + text;
    return text;
  }

  /*
   * 資格の検証。token: クライアントが送った文字列、email: 予約メール、now: サーバー時刻。
   * 戻り値: { ok:true, id } | { ok:false, reason }。reasonは監査用の固定識別子（クライアントへは返さず、INVALIDとだけ伝える）。
   * 署名・用途（署名対象に含む）・期限・失効状態・許可メールとの一致を、この順にすべて検証する。
   */
  function verify(token, email, now) {
    now = isDateLike_(now) ? now : new Date();
    var match = typeof token === 'string' ? TOKEN_PATTERN_.exec(token) : null;
    if (!match) return { ok: false, reason: 'FORMAT' };
    var key = getKey_();
    if (!key) return { ok: false, reason: 'NOT_CONFIGURED' };
    var id = match[1];
    var body = VERSION + '.' + id + '.' + match[2] + '.' + match[3] + '.' + match[4];
    if (!safeEquals_(match[5], signBody_(key, body))) return { ok: false, reason: 'SIGNATURE' };
    var nowSeconds = Math.floor(now.getTime() / 1000);
    if (nowSeconds >= Number(match[3]) || now.getTime() >= BookingPricing.GENERATION_V2_START_MS) return { ok: false, reason: 'EXPIRED' };
    if (revokedIds_().indexOf(id) !== -1) return { ok: false, reason: 'REVOKED' };
    var normalized = normalizeEmail_(email);
    if (!normalized || !MembershipRules.isValidEmail(normalized)) return { ok: false, reason: 'EMAIL_MISMATCH' };
    if (allowedEmails_().indexOf(normalized) === -1) return { ok: false, reason: 'EMAIL_NOT_ALLOWED' };
    if (!safeEquals_(match[4], emailTag_(key, normalized))) return { ok: false, reason: 'EMAIL_MISMATCH' };
    return { ok: true, id: id };
  }

  /*
   * 資格を発行する（エディタ実行用のissueBookingTestLinkからだけ呼ぶ）。戻り値の token は呼び出し元が配送にだけ使い、ログへ出さない。
   * 失敗は例外（メッセージに機密情報を含めない）。
   */
  function issue(email, ttlMinutes, now) {
    now = isDateLike_(now) ? now : new Date();
    var key = getKey_();
    if (!key) throw new Error(KEY_PROPERTY + ' が未設定、または' + MIN_KEY_LENGTH_ + '文字未満です。');
    var normalized = normalizeEmail_(email);
    if (!normalized || !MembershipRules.isValidEmail(normalized)) throw new Error('メールアドレスの形式が正しくありません。');
    if (allowedEmails_().indexOf(normalized) === -1) throw new Error('このメールアドレスは ' + ALLOWED_EMAILS_PROPERTY + ' に登録されていません。');
    var boundary = BookingPricing.GENERATION_V2_START_MS;
    if (now.getTime() >= boundary) throw new Error('2026/12/1 0:00 JST以降はテスト資格を発行できません。');
    var ttl = ttlMinutes === undefined || ttlMinutes === null || ttlMinutes === '' ? DEFAULT_TTL_MINUTES_ : Number(ttlMinutes);
    if (!Number.isInteger(ttl) || ttl < 1 || ttl > MAX_TTL_MINUTES_) throw new Error('有効分数は1〜' + MAX_TTL_MINUTES_ + 'の整数で指定してください。');
    var expiresMs = Math.min(now.getTime() + ttl * 60000, boundary);
    var id = randomId_();
    var body = VERSION + '.' + id + '.' + pad10_(Math.floor(now.getTime() / 1000)) + '.' + pad10_(Math.floor(expiresMs / 1000)) + '.' + emailTag_(key, normalized);
    return { id: id, token: body + '.' + signBody_(key, body), expiresAt: new Date(expiresMs) };
  }

  function revoke(id) {
    var value = typeof id === 'string' ? id.trim() : '';
    if (!ID_PATTERN_.test(value)) throw new Error('資格IDの形式が正しくありません（16桁の小文字16進）。');
    var ids = revokedIds_();
    if (ids.indexOf(value) === -1) ids.push(value);
    PropertiesService.getScriptProperties().setProperty(REVOKED_IDS_PROPERTY, ids.join(','));
    return ids.length;
  }

  function jstText_(date) {
    return new Date(date.getTime() + JST_OFFSET_MS_).toISOString().substring(0, 16).replace('T', ' ') + ' JST';
  }

  /* 拘束先の許可メールアドレス宛に、3つの予約ページ（SNB・mens・英語版）のテスト用リンクをメール送信する。本文以外に資格を出さない。 */
  function sendLinks(email, token, expiresAt) {
    var reserve = BookingMemberVerification.MAIL_QUOTA_RESERVE;
    var quota;
    try {
      quota = MailApp.getRemainingDailyQuota();
    } catch (error) {
      quota = 0;
    }
    if (!(quota > reserve)) throw new Error('メール送信の残枠が不足しているため送信しません。');
    var fragment = '#bt=' + token;
    var mailConfig = BookingConfig.getMailConfig();
    var message = {
      to: normalizeEmail_(email),
      subject: '【Studio Nagoya Base】予約フォームのテスト用リンク（V2確認）',
      body: '2026/12/1より前に、会員確認コード（メールOTP）を使うV2の予約フォームを試すためのリンクです。\n\n' +
        '有効期限：' + jstText_(expiresAt) + '\n\n' +
        'SNB：' + SITE_BASE_URL_ + '/booking/' + fragment + '\n' +
        'SNB mens：' + SITE_BASE_URL_ + '/mens/booking/' + fragment + '\n' +
        'English：' + SITE_BASE_URL_ + '/booking/en.html' + fragment + '\n\n' +
        '・このリンクを開いたブラウザのこのタブだけで有効です。他の方に転送しないでください。\n' +
        '・予約フォームには、このメールアドレスを入力してください（他のメールアドレスでは使えません）。\n' +
        '・テストで作成した予約は本番の予約・通知・カレンダー・決済に反映されます。READMEの手順に従い、識別と取消を行ってください。\n' +
        '・心当たりがない場合は、このメールを破棄してください。'
    };
    if (mailConfig.displayName) message.name = mailConfig.displayName;
    if (mailConfig.replyTo) message.replyTo = mailConfig.replyTo;
    MailApp.sendEmail(message);
  }

  return {
    KEY_PROPERTY: KEY_PROPERTY,
    ALLOWED_EMAILS_PROPERTY: ALLOWED_EMAILS_PROPERTY,
    REVOKED_IDS_PROPERTY: REVOKED_IDS_PROPERTY,
    PURPOSE: PURPOSE,
    MAX_TTL_MINUTES: MAX_TTL_MINUTES_,
    verify: verify,
    issue: issue,
    revoke: revoke,
    sendLinks: sendLinks
  };
})();

/*
 * 以下はGASエディタから権限者が手動実行する関数（doGet / doPostからは呼ばない。公開APIから発行・失効はできない）。
 * 戻り値・ログに資格そのもの・メールアドレス・署名鍵を出さない。
 */

/* テスト資格を発行し、拘束先の許可メールアドレス宛にテスト用リンクを送る。email: 許可メール、ttlMinutes: 省略時480分（最大7日。12/1 0:00 JSTで打ち切り）。 */
function issueBookingTestLink(email, ttlMinutes) {
  var issued = BookingTestCredential.issue(email, ttlMinutes);
  BookingTestCredential.sendLinks(email, issued.token, issued.expiresAt);
  Logger.log('BookingTestCredential: 発行しました id=' + issued.id + ' expiresAt=' + issued.expiresAt.toISOString());
  return { credentialId: issued.id, expiresAt: issued.expiresAt.toISOString() };
}

/* 資格IDを失効リストへ追記する（全資格を一括で無効にするには署名鍵BOOKING_TEST_CREDENTIAL_KEYを差し替える）。 */
function revokeBookingTestCredential(credentialId) {
  var count = BookingTestCredential.revoke(credentialId);
  Logger.log('BookingTestCredential: 失効しました id=' + credentialId + ' revokedCount=' + count);
  return count;
}

/*
 * GASエディタの「実行」ボタンは関数に引数を渡せないため、上の2関数を引数なしで実行できるエントリポイント。
 * 値はWeb AppのScript Propertiesから読む（メールアドレス・資格ID以外の機密は読まない・出さない）。
 * - issueBookingTestLinkFromSettings: BOOKING_TEST_ISSUE_EMAIL（許可メール。BOOKING_TEST_ALLOWED_EMAILSに登録済みであること）と
 *   任意のBOOKING_TEST_ISSUE_TTL_MINUTES（省略時480分）を読んで発行・メール送信する。
 * - revokeBookingTestCredentialFromSettings: BOOKING_TEST_REVOKE_ID（発行時ログのid=の値）を読んで失効し、成功したらその値を削除する。
 */
function issueBookingTestLinkFromSettings() {
  var properties = PropertiesService.getScriptProperties();
  var email = properties.getProperty('BOOKING_TEST_ISSUE_EMAIL');
  if (!email) throw new Error('BOOKING_TEST_ISSUE_EMAIL が未設定です。');
  var ttl = properties.getProperty('BOOKING_TEST_ISSUE_TTL_MINUTES');
  return issueBookingTestLink(email, ttl ? Number(ttl) : undefined);
}

function revokeBookingTestCredentialFromSettings() {
  var properties = PropertiesService.getScriptProperties();
  var id = properties.getProperty('BOOKING_TEST_REVOKE_ID');
  if (!id) throw new Error('BOOKING_TEST_REVOKE_ID が未設定です。');
  var count = revokeBookingTestCredential(id.trim());
  properties.deleteProperty('BOOKING_TEST_REVOKE_ID');
  return count;
}

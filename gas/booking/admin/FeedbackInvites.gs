/*
 * FeedbackInvites.gs — 利用終了2時間後の「利用後アンケート」案内メール（Issue #834 第3段階）。
 *
 * 【デプロイ先】Booking Admin（`SPREADSHEET_ID`のSpreadsheetへコンテナバインド）専用。公開Web App・Webhookへは配らない。
 * 予約確定・失効・取消・日程変更・Webhook処理と同じ LockService.getScriptLock() で、予約1件ずつ直列化する。
 *
 * 【初期OFF】Script Property `FEEDBACK_INVITE_MODE` が `on` のときだけ送る。`dry_run` は対象の抽出と件数・理由の
 * ログだけ（メールもシートも変えない）。未設定・それ以外は何もしない（Spreadsheetも読まない）。
 * 回答側の `FEEDBACK_NOTIFY`（要確認回答の管理者通知。別プロジェクト）とは無関係のスイッチ。
 *
 * 【過去予約へ遡及しない】`FEEDBACK_INVITE_START_AT`（タイムゾーン付きISO日時。ONにする時刻を入れる）より前に
 * 終了した予約には送らない。未設定なら1通も送らない。さらに「終了2時間後」から LATE_WINDOW_HOURS を過ぎた予約にも
 * 送らない（トリガー停止明けの一斉送信を防ぐ）。
 *
 * 【対象】SNB / mens / Studio X の直接予約（source が各ブランドの予約フォーム値）で、送信直前に再読込した最新の
 * 台帳が次をすべて満たすもの。CONFIRMED・確定時刻あり・決済ゲート（Booking.evaluateAccessGate）OK・返金なし・
 * 延長の追加料金が未了でない・要復旧なし・終了時刻（日程変更・延長後の最新 endAt）＋2時間を過ぎた。
 *
 * 【重複防止】Booking Spreadsheetの `FeedbackInvites` シート（予約1件1行。列は HEADERS）。ロック内で
 * 「行が無いことを確認 → SENDING 行を追記 → 送信 → SENT へ更新」。行が1つでもある予約へは自動送信しない。
 * 送信後の状態更新に失敗した行は SENDING のまま残り（結果不明）、自動では再送しない。送信失敗は FAILED。
 * いずれも手動確認のうえ sendFeedbackInviteFromProperty で1件ずつ再送できる（README参照）。
 * このシートにはメールアドレス・氏名・トークンを書かない（予約ID・状態・日時・エラーコードだけ）。
 *
 * 【180日で削除】予約IDで予約台帳と突合できる送信履歴のため、Bookings の個人情報と同じ通常保存期間（180日）で行ごと削除する
 * （purgeExpiredFeedbackInvites。毎日のトリガー。FEEDBACK_INVITE_MODE と無関係に動く）。起算点は行の endAt・claimedAt・
 * sentAt・updatedAt のうち最も遅い日時。送信と同じ Booking Admin のスクリプトロック内で読み直してから下の行から削除するので、
 * 同時送信と行番号がずれない。#680（PersonalDataRetention.gs）はこのシートを読み書きしないため競合しない。
 * 削除後も同じ予約へ再送されない: 180日経った予約は回答リンクの期限（終了＋14日）を過ぎており、自動送信・手動送信の
 * どちらも LINK_EXPIRED で止まる（自動送信はさらに開始日時と48時間の送信窓でも止まる）。
 *
 * 【予約・決済・解錠を変えない】Bookings / Recovery / 鍵関連のシートへは一切書かない。メール失敗時も同じ。
 *
 * 【トークン】FeedbackTokenCore.gs（回答用GASと同じファイル）で予約ごとに発行し、フォームURLの `#t=` 以降に置く。
 * 有効期限は利用終了から14日。秘密鍵は `FEEDBACK_TOKEN_SECRET`（回答用GASと同じ値）。ログ・シートへは出さない。
 */
'use strict';

var FeedbackInvites = (function () {
  var SHEET_NAME = 'FeedbackInvites';
  var HEADERS = ['bookingId', 'brand', 'state', 'endAt', 'expiresAt', 'claimedAt', 'sentAt', 'errorCode', 'updatedAt'];
  var STATE = { SENDING: 'SENDING', SENT: 'SENT', FAILED: 'FAILED' };
  var MODE = { OFF: 'off', DRY_RUN: 'dry_run', ON: 'on' };

  var HOUR_MS = 60 * 60 * 1000;
  var SEND_DELAY_MS = 2 * HOUR_MS;
  var LATE_WINDOW_HOURS = 48;
  var MAX_SENDS_PER_RUN = 20;
  var MAX_RUN_MS = 4 * 60 * 1000;
  var MAIL_QUOTA_RESERVE = 50;
  var LOCK_TIMEOUT_MS = 10000;
  var DRY_RUN_LIST_LIMIT = 50;
  var RETENTION_DAYS = 180;
  var RETENTION_MS = RETENTION_DAYS * 24 * HOUR_MS;
  var PURGE_MAX_ROWS = 2000;

  /* 直接予約の source（scripts/booking-logic.js のブランド定義と同じ値）。これ以外（外部予約・管理者入力など）は送らない。 */
  var DIRECT_SOURCES = { snb: 'snb-booking-app', mens: 'mens-booking-app', studio_x: 'studio-x-booking-app' };
  var CHARGE_PENDING_STATES = ['PENDING_CHARGE', 'PENDING_DECISION'];

  function isDate_(v) {
    return !!v && typeof v.getTime === 'function' && !isNaN(v.getTime());
  }

  function toMillis_(v) {
    if (isDate_(v)) return v.getTime();
    if (typeof v === 'string' && v.trim() !== '') {
      var ms = Date.parse(v);
      return isNaN(ms) ? null : ms;
    }
    return null;
  }

  function hasValue_(v) {
    return v !== '' && v !== null && v !== undefined;
  }

  /* ===== 設定 ===== */

  /* 開始日時はタイムゾーン（Z または ±HH:MM）付きのISO形式だけを受け付ける（解釈違いで過去へ遡らないため）。 */
  var START_AT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;

  function readSettings() {
    var props = PropertiesService.getScriptProperties();
    var rawMode = String(props.getProperty('FEEDBACK_INVITE_MODE') || '').trim().toLowerCase();
    var mode = rawMode === MODE.ON ? MODE.ON : rawMode === MODE.DRY_RUN ? MODE.DRY_RUN : MODE.OFF;
    var rawStart = String(props.getProperty('FEEDBACK_INVITE_START_AT') || '').trim();
    var startAtMs = START_AT_PATTERN.test(rawStart) ? Date.parse(rawStart) : NaN;
    return {
      mode: mode,
      startAtMs: isNaN(startAtMs) ? null : startAtMs,
      startAtConfigured: rawStart !== '',
      secret: String(props.getProperty('FEEDBACK_TOKEN_SECRET') || '').trim()
    };
  }

  /* 送信に必要な設定の不足（値は返さない）。 */
  function configProblems_(settings) {
    var problems = [];
    if (settings.startAtMs === null) problems.push(settings.startAtConfigured ? 'START_AT_INVALID' : 'START_AT_NOT_SET');
    if (!FeedbackTokenCore.isUsableSecret(settings.secret)) problems.push('TOKEN_SECRET_NOT_SET');
    var mail = BookingConfig.getMailConfig();
    if (!mail.displayName || !mail.replyTo || !mail.contactEmail) problems.push('MAIL_CONFIG_INCOMPLETE');
    return problems;
  }

  /* ===== 対象判定（純粋。最新の台帳レコードに対して呼ぶ） ===== */

  /*
   * 戻り値: { eligible:true, feedbackBrand, endMs, expiresAtMs } / { eligible:false, reason }
   * options.ignoreSchedule: 手動送信（START_AT と送信期限の窓を見ない）。終了2時間後の条件は常に守る。
   */
  function evaluate(record, nowMs, settings, options) {
    var r = record || {};
    var opts = options || {};
    var brand = String(r.brand || '');
    if (!Object.prototype.hasOwnProperty.call(DIRECT_SOURCES, brand)) return { eligible: false, reason: 'BRAND_NOT_TARGET' };
    if (String(r.source || '') !== DIRECT_SOURCES[brand]) return { eligible: false, reason: 'NOT_DIRECT_BOOKING' };
    if (r.status !== Booking.STATUS.CONFIRMED) return { eligible: false, reason: 'NOT_CONFIRMED' };
    if (!hasValue_(r.confirmedAt)) return { eligible: false, reason: 'PAYMENT_UNVERIFIED' };
    if (hasValue_(r.refundDecision) || hasValue_(r.refundRequestedAt) || hasValue_(r.refundedAt)) {
      return { eligible: false, reason: 'REFUND_STARTED' };
    }
    if (!Booking.evaluateAccessGate(r).ok) return { eligible: false, reason: 'PAYMENT_NOT_SETTLED' };
    if (CHARGE_PENDING_STATES.indexOf(String(r.feeSettlementState || '')) !== -1) return { eligible: false, reason: 'EXTENSION_CHARGE_PENDING' };
    if (hasValue_(r.feeRecoveryRequiredAt) || hasValue_(r.paymentRecoveryRequiredAt)) return { eligible: false, reason: 'RECOVERY_REQUIRED' };

    var startMs = toMillis_(r.startAt);
    var endMs = toMillis_(r.endAt);
    if (endMs === null || startMs === null || startMs >= endMs) return { eligible: false, reason: 'END_INVALID' };
    if (!Booking.isValidEmail(String(r.email || '').trim())) return { eligible: false, reason: 'EMAIL_MISSING' };
    if (!(nowMs >= endMs + SEND_DELAY_MS)) return { eligible: false, reason: 'NOT_YET' };

    var expiresAtMs = FeedbackTokenCore.expiresAtForEnd(endMs);
    if (!(nowMs < expiresAtMs)) return { eligible: false, reason: 'LINK_EXPIRED' };
    if (!opts.ignoreSchedule) {
      if (settings.startAtMs === null) return { eligible: false, reason: 'START_AT_NOT_SET' };
      if (endMs < settings.startAtMs) return { eligible: false, reason: 'BEFORE_START_AT' };
      if (nowMs > endMs + SEND_DELAY_MS + LATE_WINDOW_HOURS * HOUR_MS) return { eligible: false, reason: 'TOO_LATE' };
    }
    return { eligible: true, feedbackBrand: FeedbackTokenCore.toFeedbackBrand(brand), endMs: endMs, expiresAtMs: expiresAtMs };
  }

  /* ===== メール文面 ===== */

  /*
   * 件名・本文の冒頭（受信一覧のプレビュー）に、利用目的・予約日時・予約ID・金額・トークンを出さない。
   * 回答リンクは本文の中ほどに置く。氏名も載せない（転送・プレビューで第三者に見えても差し支えない文面にする）。
   */
  function buildMail(record, url, mailConfig) {
    var brandLabel = Booking.getBrandLabel(record.brand);
    var profile = Booking.getBrandProfile(record.brand);
    var lines = [
      'このたびは ' + brandLabel + ' をご利用いただき、ありがとうございました。',
      '',
      '今後のサービス改善のため、ご利用後アンケートへのご協力をお願いいたします。',
      '・回答は任意です（所要時間は約2〜3分です）。',
      '・回答の有無や内容が、今後のご予約・ご利用に影響することはありません。',
      '・お名前やメールアドレスの入力は不要です。',
      '',
      '▼ アンケートに回答する（ご利用後14日間有効）',
      url,
      '',
      'このリンクはご利用1回ごとの専用リンクです。回答は1回まで、転送や共有はお控えください。',
      '',
      '※このメールは送信専用です。ご不明な点は下記までお問い合わせください。'
    ];
    if (mailConfig.contactEmail) lines.push('お問い合わせ: ' + mailConfig.contactEmail);
    lines.push('', '--', profile.signature, profile.siteUrl);
    return {
      subject: '【' + brandLabel + '】ご利用ありがとうございました（アンケートのお願い）',
      body: lines.join('\n') + '\n'
    };
  }

  /* ===== FeedbackInvites シート ===== */

  function openSpreadsheet_() {
    return SpreadsheetApp.openById(BookingConfig.getSpreadsheetId());
  }

  function headerMatches_(sheet) {
    if (sheet.getLastRow() < 1) return false;
    var header = sheet.getRange(1, 1, 1, HEADERS.length).getValues()[0];
    return HEADERS.every(function (h, i) { return header[i] === h; });
  }

  /* { sheet } / { error }。シートは自動作成しない（setupFeedbackInvites で作る）。 */
  function openSheet_() {
    var sheet;
    try {
      sheet = openSpreadsheet_().getSheetByName(SHEET_NAME);
    } catch (openError) {
      return { error: 'SPREADSHEET_UNAVAILABLE' };
    }
    if (!sheet) return { error: 'FEEDBACK_INVITES_NOT_INITIALIZED' };
    if (!headerMatches_(sheet)) return { error: 'FEEDBACK_INVITES_SCHEMA_MISMATCH' };
    return { sheet: sheet };
  }

  function readRows_(sheet) {
    var last = sheet.getLastRow();
    if (last < 2) return [];
    return sheet.getRange(2, 1, last - 1, HEADERS.length).getValues().map(function (row, i) {
      var o = { rowNumber: i + 2 };
      HEADERS.forEach(function (h, j) { o[h] = row[j]; });
      return o;
    });
  }

  function findRow_(sheet, bookingId) {
    var rows = readRows_(sheet);
    for (var i = 0; i < rows.length; i++) if (String(rows[i].bookingId) === String(bookingId)) return rows[i];
    return null;
  }

  function setupSheet() {
    var spreadsheet = openSpreadsheet_();
    var sheet = spreadsheet.getSheetByName(SHEET_NAME);
    if (!sheet) sheet = spreadsheet.insertSheet(SHEET_NAME);
    if (sheet.getLastRow() < 1) {
      sheet.appendRow(HEADERS);
      return 'FEEDBACK_INVITES_CREATED';
    }
    if (!headerMatches_(sheet)) throw new Error('setupFeedbackInvites: FEEDBACK_INVITES_SCHEMA_MISMATCH');
    return 'FEEDBACK_INVITES_ALREADY_READY';
  }

  /* 同じ行の state 以降をまとめて書く（1回の setValues）。 */
  function writeState_(sheet, rowNumber, state, sentAt, errorCode, now) {
    var col = HEADERS.indexOf('state') + 1;
    var current = sheet.getRange(rowNumber, 1, 1, HEADERS.length).getValues()[0];
    var row = current.slice();
    row[HEADERS.indexOf('state')] = state;
    row[HEADERS.indexOf('sentAt')] = sentAt || '';
    row[HEADERS.indexOf('errorCode')] = errorCode || '';
    row[HEADERS.indexOf('updatedAt')] = now;
    sheet.getRange(rowNumber, col, 1, HEADERS.length - col + 1).setValues([row.slice(col - 1)]);
  }

  /* ===== 送信（ロック内で1件） ===== */

  function hmacHex_(key, message) {
    return FeedbackTokenCore.bytesToHex(Utilities.computeHmacSha256Signature(message, key, Utilities.Charset.UTF_8));
  }

  function flush_() {
    if (typeof SpreadsheetApp.flush === 'function') SpreadsheetApp.flush();
  }

  /*
   * 1件の送信。ロック取得 → 最新レコード再読込 → 再判定 → FeedbackInvites 確認 → SENDING 追記 → 送信 → SENT。
   * options.manual: 手動送信（START_AT と送信期限の窓を見ない）。
   * options.confirmNotDelivered: 手動送信で、既存の FAILED / SENDING 行を「届いていないことを確認済み」として再送する。
   * 戻り値: { outcome: 'SENT'|'SKIPPED'|'FAILED'|'SENT_UNRECORDED', reason? }
   */
  function sendOne_(bookingId, settings, now, options) {
    var opts = options || {};
    var lock = LockService.getScriptLock();
    if (!lock.tryLock(LOCK_TIMEOUT_MS)) return { outcome: 'SKIPPED', reason: 'LOCK_TIMEOUT' };
    try {
      var found = SpreadsheetRepository.findRowByBookingId(bookingId);
      if (!found) return { outcome: 'SKIPPED', reason: 'NOT_FOUND' };
      var record = found.record;
      var decision = evaluate(record, now.getTime(), settings, { ignoreSchedule: !!opts.manual });
      if (!decision.eligible) return { outcome: 'SKIPPED', reason: decision.reason };

      var opened = openSheet_();
      if (opened.error) return { outcome: 'SKIPPED', reason: opened.error };
      var sheet = opened.sheet;
      var existing = findRow_(sheet, bookingId);
      if (existing) {
        var retryable = existing.state === STATE.FAILED || existing.state === STATE.SENDING;
        if (!(opts.manual && opts.confirmNotDelivered && retryable)) {
          return { outcome: 'SKIPPED', reason: existing.state === STATE.SENT ? 'ALREADY_SENT' : 'ALREADY_ATTEMPTED' };
        }
      }

      var issued = FeedbackTokenCore.issue({
        secret: settings.secret,
        bookingId: String(record.bookingId),
        brand: decision.feedbackBrand,
        expiresAtMs: decision.expiresAtMs
      }, hmacHex_);
      var mailConfig = BookingConfig.getMailConfig();
      var mail = buildMail(record, FeedbackTokenCore.formUrl(decision.feedbackBrand, issued.token), mailConfig);

      /* 送信前に「送信中」を記録する（この行がある限り、並列実行・再実行・再試行のどれも自動では送らない）。 */
      var rowNumber;
      try {
        if (existing) {
          rowNumber = existing.rowNumber;
          writeState_(sheet, rowNumber, STATE.SENDING, '', '', now);
        } else {
          sheet.appendRow([
            String(record.bookingId), String(record.brand), STATE.SENDING, new Date(decision.endMs),
            new Date(issued.expiresAtMs), now, '', '', now
          ]);
          flush_();
          /* 追記した行を予約IDで探し直す（appendRow は行番号を返さないため）。見つからなければ送らない。 */
          var claimed = findRow_(sheet, bookingId);
          if (!claimed || claimed.state !== STATE.SENDING) return { outcome: 'SKIPPED', reason: 'CLAIM_FAILED' };
          rowNumber = claimed.rowNumber;
        }
        flush_();
      } catch (claimError) {
        return { outcome: 'SKIPPED', reason: 'CLAIM_FAILED' };
      }

      try {
        MailApp.sendEmail({
          to: String(record.email).trim(),
          subject: mail.subject,
          body: mail.body,
          name: mailConfig.displayName,
          replyTo: mailConfig.replyTo
        });
      } catch (sendError) {
        try {
          writeState_(sheet, rowNumber, STATE.FAILED, '', 'MAIL_SEND_FAILED', now);
        } catch (markError) {
          /* SENDING のまま残る（結果不明として自動再送しない）。 */
        }
        return { outcome: 'FAILED', reason: 'MAIL_SEND_FAILED' };
      }

      try {
        writeState_(sheet, rowNumber, STATE.SENT, now, '', now);
      } catch (recordError) {
        return { outcome: 'SENT_UNRECORDED', reason: 'STATE_UPDATE_FAILED' };
      }
      return { outcome: 'SENT' };
    } finally {
      lock.releaseLock();
    }
  }

  /* ===== バッチ ===== */

  function newSummary_(mode, dryRun) {
    return {
      mode: mode, dryRun: dryRun, status: 'OK', problems: [],
      scanned: 0, eligible: 0, alreadyHandled: 0, sent: 0, failed: 0, sentUnrecorded: 0,
      reasons: {}, wouldSend: [], truncated: false
    };
  }

  function countReason_(summary, reason) {
    summary.reasons[reason] = (summary.reasons[reason] || 0) + 1;
  }

  /*
   * options.dryRun: true なら抽出と件数だけ（メール・シートを変えない）。
   * 戻り値の summary とログには件数・理由コード・（dry-runのみ）送信予定の予約IDだけを出す。
   */
  function run(now, options) {
    var current = isDate_(now) ? now : new Date();
    var opts = options || {};
    var settings = readSettings();
    var dryRun = !!opts.dryRun || settings.mode === MODE.DRY_RUN;
    var summary = newSummary_(settings.mode, dryRun);
    if (!dryRun && settings.mode !== MODE.ON) {
      summary.status = 'OFF';
      return summary;
    }

    summary.problems = configProblems_(settings);
    var opened = openSheet_();
    if (opened.error) summary.problems.push(opened.error);
    if (!dryRun && summary.problems.length) {
      summary.status = 'CONFIG_INCOMPLETE';
      return summary;
    }

    var handled = {};
    if (opened.sheet) readRows_(opened.sheet).forEach(function (row) { handled[String(row.bookingId)] = row.state; });

    var candidates = [];
    SpreadsheetRepository.getAllBookings().forEach(function (item) {
      var record = item.record;
      summary.scanned++;
      var decision = evaluate(record, current.getTime(), settings);
      if (!decision.eligible) {
        countReason_(summary, decision.reason);
        return;
      }
      if (Object.prototype.hasOwnProperty.call(handled, String(record.bookingId))) {
        summary.alreadyHandled++;
        return;
      }
      summary.eligible++;
      candidates.push(String(record.bookingId));
    });

    if (dryRun) {
      summary.wouldSend = candidates.slice(0, DRY_RUN_LIST_LIMIT);
      summary.truncated = candidates.length > DRY_RUN_LIST_LIMIT;
      return summary;
    }

    var startedAt = Date.now();
    for (var i = 0; i < candidates.length; i++) {
      if (summary.sent + summary.failed + summary.sentUnrecorded >= MAX_SENDS_PER_RUN || Date.now() - startedAt > MAX_RUN_MS) {
        summary.status = 'TRUNCATED';
        break;
      }
      if (MailApp.getRemainingDailyQuota() <= MAIL_QUOTA_RESERVE) {
        summary.status = 'MAIL_QUOTA_RESERVED';
        break;
      }
      var result;
      try {
        result = sendOne_(candidates[i], settings, current, {});
      } catch (unexpected) {
        result = { outcome: 'FAILED', reason: 'UNEXPECTED_ERROR' };
      }
      if (result.outcome === 'SENT') summary.sent++;
      else if (result.outcome === 'FAILED') { summary.failed++; countReason_(summary, result.reason); }
      else if (result.outcome === 'SENT_UNRECORDED') { summary.sentUnrecorded++; countReason_(summary, result.reason); }
      else countReason_(summary, result.reason);
    }
    return summary;
  }

  /* 手動送信（1件）。モードがOFFでも送れる（実予約でのE2E確認・失敗の復旧用）。 */
  function sendManually(bookingId, options) {
    var opts = options || {};
    var current = isDate_(opts.now) ? opts.now : new Date();
    var settings = readSettings();
    if (!bookingId) return { outcome: 'SKIPPED', reason: 'INVALID_BOOKING_ID' };
    if (!FeedbackTokenCore.isUsableSecret(settings.secret)) return { outcome: 'SKIPPED', reason: 'TOKEN_SECRET_NOT_SET' };
    var mail = BookingConfig.getMailConfig();
    if (!mail.displayName || !mail.replyTo || !mail.contactEmail) return { outcome: 'SKIPPED', reason: 'MAIL_CONFIG_INCOMPLETE' };
    return sendOne_(String(bookingId), settings, current, { manual: true, confirmNotDelivered: opts.confirmNotDelivered === true });
  }

  /* ===== 180日経過した送信履歴の削除 ===== */

  /* 行の保存期間の起算点（endAt・claimedAt・sentAt・updatedAt の最も遅い日時）。endAt が読めない行は判定しない（null）。 */
  function retentionBaseMs_(row) {
    var endMs = toMillis_(row.endAt);
    if (endMs === null) return null;
    var base = endMs;
    ['claimedAt', 'sentAt', 'updatedAt'].forEach(function (key) {
      var ms = toMillis_(row[key]);
      if (ms !== null && ms > base) base = ms;
    });
    return base;
  }

  /*
   * 起算点から180日以上たった行を削除する。options.dryRun なら件数だけ（削除しない）。
   * 送信と同じスクリプトロックを取り、ロック内で読み直した行だけを、下の行から1行ずつ削除する。
   * 日時が読めない行は削除しない（undecidable として件数だけ返す）。1回あたり最大 PURGE_MAX_ROWS 行。
   * 戻り値・ログは件数だけ（予約ID・行内容は出さない）。
   */
  function purge(now, options) {
    var current = isDate_(now) ? now : new Date();
    var opts = options || {};
    var result = { status: 'OK', dryRun: !!opts.dryRun, scanned: 0, expired: 0, deleted: 0, retained: 0, undecidable: 0, truncated: false };
    var lock = LockService.getScriptLock();
    if (!lock.tryLock(LOCK_TIMEOUT_MS)) {
      result.status = 'LOCK_TIMEOUT';
      return result;
    }
    try {
      var opened = openSheet_();
      if (opened.error) {
        result.status = opened.error;
        return result;
      }
      var rows = readRows_(opened.sheet);
      var targets = [];
      rows.forEach(function (row) {
        result.scanned++;
        var base = retentionBaseMs_(row);
        if (base === null) result.undecidable++;
        else if (current.getTime() - base >= RETENTION_MS) targets.push(row.rowNumber);
        else result.retained++;
      });
      result.expired = targets.length;
      if (opts.dryRun) return result;
      targets.sort(function (a, b) { return b - a; });
      for (var i = 0; i < targets.length; i++) {
        if (result.deleted >= PURGE_MAX_ROWS) {
          result.truncated = true;
          result.status = 'TRUNCATED';
          break;
        }
        opened.sheet.deleteRows(targets[i], 1);
        result.deleted++;
      }
      return result;
    } catch (purgeError) {
      result.status = 'PARTIAL_FAILURE';
      return result;
    } finally {
      lock.releaseLock();
    }
  }

  /* 1件の状態（個人情報なし）。 */
  function getState(bookingId) {
    var opened = openSheet_();
    if (opened.error) return { error: opened.error };
    var row = findRow_(opened.sheet, bookingId);
    if (!row) return { bookingId: String(bookingId), state: 'NONE' };
    return {
      bookingId: String(row.bookingId), brand: row.brand, state: row.state, endAt: row.endAt, expiresAt: row.expiresAt,
      claimedAt: row.claimedAt, sentAt: row.sentAt, errorCode: row.errorCode, updatedAt: row.updatedAt
    };
  }

  return {
    SHEET_NAME: SHEET_NAME,
    HEADERS: HEADERS.slice(),
    STATE: STATE,
    MODE: MODE,
    DIRECT_SOURCES: DIRECT_SOURCES,
    SEND_DELAY_MS: SEND_DELAY_MS,
    LATE_WINDOW_HOURS: LATE_WINDOW_HOURS,
    MAX_SENDS_PER_RUN: MAX_SENDS_PER_RUN,
    RETENTION_DAYS: RETENTION_DAYS,
    purge: purge,
    readSettings: readSettings,
    evaluate: evaluate,
    buildMail: buildMail,
    setupSheet: setupSheet,
    run: run,
    sendManually: sendManually,
    getState: getState
  };
})();

/* ===== GASエディタ・トリガーから呼ぶ入口（README「Issue #834」節） ===== */

function feedbackInviteLog_(label, summary) {
  Logger.log(label + ': ' + JSON.stringify(summary));
  return summary;
}

/* FeedbackInvites シートを作る（冪等。既存シートのヘッダーが違えば止まる）。 */
function setupFeedbackInvites() {
  var result = FeedbackInvites.setupSheet();
  Logger.log('setupFeedbackInvites: ' + result);
  return result;
}

/* 時間主導トリガーのハンドラ。FEEDBACK_INVITE_MODE が on のときだけ送る（dry_run は件数ログだけ・off は何もしない）。 */
function sendFeedbackInvites(now) {
  return feedbackInviteLog_('sendFeedbackInvites', FeedbackInvites.run(now, {}));
}

/* モードにかかわらず、送信せずに対象件数・除外理由・送信予定の予約IDを確認する。 */
function dryRunFeedbackInvites(now) {
  return feedbackInviteLog_('dryRunFeedbackInvites', FeedbackInvites.run(now, { dryRun: true }));
}

/*
 * 毎日のトリガーのハンドラ。送信履歴（FeedbackInvites）のうち180日を過ぎた行を削除する。
 * FEEDBACK_INVITE_MODE と無関係に動く（自動送信を止めても履歴は180日で消える）。失敗は例外にして実行履歴へ残す。
 */
function purgeExpiredFeedbackInvites(now) {
  var result = feedbackInviteLog_('purgeExpiredFeedbackInvites', FeedbackInvites.purge(now, {}));
  if (result.status !== 'OK' && result.status !== 'TRUNCATED' && result.status !== 'FEEDBACK_INVITES_NOT_INITIALIZED') {
    throw new Error('purgeExpiredFeedbackInvites: ' + result.status);
  }
  return result;
}

/* 削除せずに、180日を過ぎた行の件数だけを確認する。 */
function dryRunFeedbackInvitePurge(now) {
  return feedbackInviteLog_('dryRunFeedbackInvitePurge', FeedbackInvites.purge(now, { dryRun: true }));
}

function createFeedbackInviteTriggerOnce_(functionName, configure) {
  var existing = ScriptApp.getProjectTriggers().filter(function (trigger) {
    return trigger.getHandlerFunction() === functionName;
  });
  if (existing.length > 0) {
    Logger.log('トリガーは既に存在します: ' + functionName);
    return existing[0];
  }
  return configure(ScriptApp.newTrigger(functionName).timeBased()).create();
}

/* 毎日4時台に purgeExpiredFeedbackInvites を実行するトリガーを作る（既にあれば作らない）。setupFeedbackInvites の直後に実行する。 */
function createFeedbackInvitePurgeTrigger() {
  return createFeedbackInviteTriggerOnce_('purgeExpiredFeedbackInvites', function (builder) { return builder.everyDays(1).atHour(4); });
}

/*
 * 15分おきに sendFeedbackInvites を実行するトリガーを作る（既にあれば作らない）。作ってもモードがOFFなら何も送らない。
 * 180日削除のトリガーが無ければ一緒に作る（送信だけが動いて履歴が残り続けることを防ぐ）。
 */
function createFeedbackInviteTrigger() {
  createFeedbackInvitePurgeTrigger();
  return createFeedbackInviteTriggerOnce_('sendFeedbackInvites', function (builder) { return builder.everyMinutes(15); });
}

/*
 * 1件の手動送信（GASエディタの実行ボタン用。引数は Script Properties から読む）。
 *   FEEDBACK_INVITE_MANUAL_BOOKING_ID: 予約ID（必須）
 *   FEEDBACK_INVITE_MANUAL_CONFIRM_NOT_DELIVERED: 'yes' のときだけ、FAILED / SENDING の行を再送する
 *     （Gmailの送信済みトレイ等で、届いていないことを確認してから設定する）。
 * 実行後、2つのプロパティは結果にかかわらず削除する（同じ再送を繰り返さないため）。SENT の予約へは送らない。
 */
function sendFeedbackInviteFromProperty() {
  var props = PropertiesService.getScriptProperties();
  var bookingId = String(props.getProperty('FEEDBACK_INVITE_MANUAL_BOOKING_ID') || '').trim();
  var confirm = String(props.getProperty('FEEDBACK_INVITE_MANUAL_CONFIRM_NOT_DELIVERED') || '').trim() === 'yes';
  props.deleteProperty('FEEDBACK_INVITE_MANUAL_BOOKING_ID');
  props.deleteProperty('FEEDBACK_INVITE_MANUAL_CONFIRM_NOT_DELIVERED');
  var result = FeedbackInvites.sendManually(bookingId, { confirmNotDelivered: confirm });
  return feedbackInviteLog_('sendFeedbackInviteFromProperty', result);
}

/* 1件の送信状態（GASエディタ用。予約IDは FEEDBACK_INVITE_MANUAL_BOOKING_ID から読み、削除しない）。 */
function getFeedbackInviteStateFromProperty() {
  var bookingId = String(PropertiesService.getScriptProperties().getProperty('FEEDBACK_INVITE_MANUAL_BOOKING_ID') || '').trim();
  return feedbackInviteLog_('getFeedbackInviteStateFromProperty', FeedbackInvites.getState(bookingId));
}

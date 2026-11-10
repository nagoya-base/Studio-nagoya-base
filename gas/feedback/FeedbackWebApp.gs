/*
 * FeedbackWebApp.gs — 3ブランド利用後アンケート（Issue #835 第1段階）の公開Web App。
 *
 * デプロイ設定: Execute as: Me / Who has access: Anyone（匿名・ログイン不要）。
 * Booking・既存 /survey/ の GAS とは別プロジェクト（関数・Script Properties・Spreadsheetを共有しない）。
 *
 * - doGet : 死活確認のみ（設定値・Spreadsheet IDを返さない）。
 * - doPost: ?action=submit（既定）で回答保存、?action=verify でトークンの事前確認（台帳は変更しない）。
 *   本文はJSON文字列（Content-Type: text/plain;charset=utf-8。CORSプリフライト回避）。
 *
 * payload: { brand, test, token, answers }
 *   - brand: 'snb' | 'mens' | 'studio-x'（ページのパスから決めた値。一覧外は拒否）
 *   - test : 厳密に 1 のときだけテスト回答。サーバーが is_test=1 を確定し、トークンは一切扱わない
 *            （本番トークンが一緒に送られても検証・消費しない）。通知は送らない。
 *   - token: 本番回答用。Booking Admin が利用終了2時間後の案内メールで発行したもの（Issue #834）。
 *            FEEDBACK_TOKEN_SECRET が未設定なら FeedbackTokens が常に拒否し、本番回答は保存できない。
 * テストでも入力検証・500字上限・rate limit は通常どおり行う。
 */
'use strict';

var FEEDBACK_MAX_BODY_CHARS = 8000;
var FEEDBACK_DEFAULT_RATE_LIMIT_PER_MINUTE = 30;
var FEEDBACK_LOCK_WAIT_MS = 10000;
var FEEDBACK_JST_OFFSET_MS = 9 * 60 * 60 * 1000;

function doGet() {
  return feedbackJsonOutput_({ success: true, service: 'studio-nagoya-base-post-use-feedback' });
}

function doPost(e) {
  var action = (e && e.parameter && e.parameter.action) || 'submit';
  var body = (e && e.postData && e.postData.contents) || '';
  return feedbackJsonOutput_(handleFeedbackRequest_(action, body, new Date()));
}

function feedbackJsonOutput_(object) {
  return ContentService.createTextOutput(JSON.stringify(object)).setMimeType(ContentService.MimeType.JSON);
}

function feedbackError_(code, fields) {
  var error = { code: code };
  if (fields) error.fields = fields;
  return { success: false, error: error };
}

/*
 * 全体のリクエスト数/分の上限（CacheServiceの簡易カウンタ）。テスト回答・verify も同じ枠で数える。
 * 読み取り→判定→書き込みをスクリプトロック内で行い、同時リクエストで上限を超えないようにする
 * （ロックは回答保存の前に必ず解放する）。ロックを取れないほど混んでいるときは受け付けない（fail closed）。
 */
var FEEDBACK_RATE_LIMIT_LOCK_WAIT_MS = 3000;

function feedbackWithinRateLimit_(now) {
  var limit = parseInt(PropertiesService.getScriptProperties().getProperty('FEEDBACK_RATE_LIMIT_PER_MINUTE'), 10);
  if (!(limit > 0)) limit = FEEDBACK_DEFAULT_RATE_LIMIT_PER_MINUTE;
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(FEEDBACK_RATE_LIMIT_LOCK_WAIT_MS)) return false;
  try {
    var cache = CacheService.getScriptCache();
    var key = 'feedback_rl_' + Math.floor(now.getTime() / 60000);
    var count = parseInt(cache.get(key), 10) || 0;
    if (count >= limit) return false;
    cache.put(key, String(count + 1), 120);
    return true;
  } finally {
    lock.releaseLock();
  }
}

function handleFeedbackRequest_(action, body, now) {
  if (action !== 'submit' && action !== 'verify') return feedbackError_('UNKNOWN_ACTION');
  if (typeof body !== 'string' || body.length > FEEDBACK_MAX_BODY_CHARS) return feedbackError_('PAYLOAD_TOO_LARGE');
  if (!feedbackWithinRateLimit_(now)) return feedbackError_('RATE_LIMITED');
  var payload;
  try {
    payload = JSON.parse(body || '{}');
  } catch (parseError) {
    return feedbackError_('INVALID_JSON');
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return feedbackError_('INVALID_PAYLOAD');
  if (!FeedbackCore.isBrand(payload.brand)) return feedbackError_('INVALID_BRAND');
  var isTest = payload.test === 1;

  try {
    if (action === 'verify') return handleFeedbackVerify_(payload, isTest, now);
    return handleFeedbackSubmit_(payload, isTest, now);
  } catch (unexpected) {
    /* 例外messageに入力値やトークンが混ざり得るため、外部へは汎用コードだけを返し、ログも種類名のみ。 */
    Logger.log('feedback ' + action + ' failed: ' + String((unexpected && unexpected.name) || 'Error').slice(0, 40));
    return feedbackError_('INTERNAL_ERROR');
  }
}

function feedbackTokenError_(result) {
  var code = result && result.code;
  return feedbackError_(FEEDBACK_TOKEN_ERROR_CODES.indexOf(code) !== -1 ? code : 'TOKEN_INVALID');
}

/* 回答画面を出す前の確認。テストはトークンを見ずに許可する。台帳は変更しない。 */
function handleFeedbackVerify_(payload, isTest, now) {
  if (isTest) return { success: true, test: true };
  if (!payload.token) return feedbackError_('TOKEN_MISSING');
  if (!FeedbackCore.isValidTokenFormat(payload.token)) return feedbackError_('TOKEN_INVALID');
  var verified = FeedbackTokens.verify(payload.token, payload.brand, now);
  if (!verified || verified.ok !== true) return feedbackTokenError_(verified);
  return { success: true };
}

function handleFeedbackSubmit_(payload, isTest, now) {
  var validated = FeedbackCore.validateAnswers(payload.answers);
  if (!validated.ok) return feedbackError_('VALIDATION_FAILED', validated.errors);
  if (!isTest) {
    if (!payload.token) return feedbackError_('TOKEN_MISSING');
    if (!FeedbackCore.isValidTokenFormat(payload.token)) return feedbackError_('TOKEN_INVALID');
  }

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(FEEDBACK_LOCK_WAIT_MS)) return feedbackError_('BUSY');
  var saved;
  var meta = {
    responseId: Utilities.getUuid(),
    receivedAt: now.toISOString(),
    brand: payload.brand,
    isTest: isTest
  };
  try {
    var opened = FeedbackRepository.openResponses();
    if (opened.error) {
      Logger.log('feedback storage unavailable: ' + opened.error);
      return feedbackError_('STORAGE_UNAVAILABLE');
    }
    if (!isTest) {
      /* 「未使用か確認 → 使用済みにする → 保存（失敗したら未使用へ戻す）」をロック内で行う。 */
      var verified = FeedbackTokens.verify(payload.token, payload.brand, now);
      if (!verified || verified.ok !== true) return feedbackTokenError_(verified);
      var consumed = FeedbackTokens.consume(payload.token, payload.brand, now);
      if (!consumed || consumed.ok !== true) return feedbackTokenError_(consumed);
    }
    saved = FeedbackRepository.appendRow(opened.sheet, FeedbackCore.buildRow(validated.answers, meta));
    if (!saved.success) {
      if (!isTest) FeedbackTokens.release(payload.token, payload.brand);
      return feedbackError_('STORAGE_UNAVAILABLE');
    }
  } finally {
    lock.releaseLock();
  }

  /* 通知は保存成功後・本番回答だけ（要確認の有無は問わない。#879）。失敗しても回答は維持し notify_failed に記録する。 */
  if (!isTest && feedbackNotifyAdmin_(validated.answers, meta) === 'failed') {
    try {
      FeedbackRepository.markNotifyFailed(meta.responseId, saved.rowNumber);
    } catch (markError) {
      Logger.log('feedback notify_failed mark failed');
    }
  }
  return { success: true };
}

/* ===== 管理者通知 ===== */

function feedbackFormatJst_(date) {
  var jst = new Date(date.getTime() + FEEDBACK_JST_OFFSET_MS);
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  return jst.getUTCFullYear() + '/' + pad(jst.getUTCMonth() + 1) + '/' + pad(jst.getUTCDate()) + ' ' +
    pad(jst.getUTCHours()) + ':' + pad(jst.getUTCMinutes()) + ' JST';
}

/*
 * 件名はブランドだけが分かる中立的な表現（#879）。問題の有無・予約情報・回答内容は件名に載せない。
 */
function feedbackNotificationSubject_(brand) {
  return '【利用後アンケート】新しい回答が届きました（' + FeedbackCore.getBrand(brand).name + '）';
}

var FEEDBACK_NOTIFY_UNANSWERED = '未回答';
var FEEDBACK_NOTIFY_NOT_APPLICABLE = '対象外';

function feedbackScaleText_(value, question) {
  if (!(typeof value === 'number' && value >= 1 && value <= 5)) return FEEDBACK_NOTIFY_UNANSWERED;
  return value + ' / 5（1=' + question.low + '〜5=' + question.high + '）';
}

function feedbackOptionText_(options, id) {
  if (!id) return FEEDBACK_NOTIFY_UNANSWERED;
  return FeedbackCore.optionLabel(options, id) || FEEDBACK_NOTIFY_UNANSWERED;
}

/*
 * プレーンテキスト本文（#879）。全設問を設問順・日本語ラベルで省略せず並べる。
 * 未回答の任意項目は「未回答」、Q4で「はい」以外のときの評価は「対象外」、自由記述の空欄は「記入なし」。
 * 予約者情報・トークン・Spreadsheet IDは載せない。自由記述は本文の文字列としてだけ扱う（件名・ヘッダに入れない）。
 */
function feedbackBuildNotificationBody_(answers, meta, isDummy) {
  var Q = FeedbackCore.QUESTIONS;
  var q2 = answers.q2 || {};
  var q3 = answers.q3 || {};
  var lines = [];
  if (isDummy) lines.push('[TEST] これは sendTestNotification による確認用のダミー通知です。回答は保存されていません。', '');
  lines.push('利用後アンケートに新しい回答が届きました。', '');
  lines.push('ブランド: ' + FeedbackCore.getBrand(meta.brand).name);
  lines.push('受信日時: ' + feedbackFormatJst_(new Date(meta.receivedAt)));
  lines.push('回答ID: ' + meta.responseId);
  lines.push('');

  lines.push('■ Q1 総合満足度: ' + feedbackScaleText_(answers.q1, Q.q1), '');

  lines.push('■ Q2 予約・事前のご案内');
  FeedbackCore.Q2_ITEMS.forEach(function (item) {
    lines.push('・' + item.label + ': ' + feedbackOptionText_(FeedbackCore.CONDITION_OPTIONS, q2[item.id]));
  });
  lines.push('');

  lines.push('■ Q3 現地でのご利用');
  FeedbackCore.Q3_ITEMS.forEach(function (item) {
    lines.push('・' + item.label + ': ' + feedbackOptionText_(FeedbackCore.CONDITION_OPTIONS, q3[item.id]));
  });
  lines.push('');

  lines.push('■ Q4 スタッフの対応');
  lines.push('・対応を受けたか: ' + feedbackOptionText_(FeedbackCore.STAFF_OPTIONS, answers.q4));
  lines.push('・スタッフ対応の評価: ' +
    (answers.q4 === 'yes' ? feedbackScaleText_(answers.q4_rating, Q.q4_rating) : FEEDBACK_NOTIFY_NOT_APPLICABLE));
  lines.push('');

  var issues = FeedbackCore.issueLabels(answers);
  lines.push('■ Q5 気になった点: ' + (issues.length ? issues.join('、') : FEEDBACK_NOTIFY_UNANSWERED), '');

  lines.push('■ 気になった点・ご感想など（自由記述）');
  lines.push(answers.comment ? String(answers.comment) : '記入なし');
  lines.push('');

  lines.push('■ Q6 また利用したいか: ' + feedbackOptionText_(FeedbackCore.REUSE_OPTIONS, answers.q6), '');

  /* 管理画面の初期status（#835の判定）は通知の有無と独立。問題のない回答を「要確認」と書かない。 */
  lines.push('管理画面の初期状態: ' + (FeedbackCore.needsAttention(answers)
    ? FeedbackCore.STATUS_OPEN + '（Q5の指摘または自由記述あり）'
    : FeedbackCore.STATUS_NONE));
  lines.push('対応状況は管理画面（回答Spreadsheetの status / memo 列）で管理してください。');
  return lines.join('\n') + '\n';
}

/*
 * 戻り値: 'off' | 'sent' | 'failed'
 * #879: 要確認かどうかに関わらず、保存に成功した本番回答はすべて通知する（1件につき最大1通・再送なし）。
 */
function feedbackNotifyAdmin_(answers, meta) {
  try {
    var props = PropertiesService.getScriptProperties();
    if (String(props.getProperty('FEEDBACK_NOTIFY') || '').trim() !== 'on') return 'off';
    var to = String(props.getProperty('FEEDBACK_NOTIFY_EMAIL') || '').trim();
    if (!to) {
      Logger.log('feedback notify failed: notification address not configured');
      return 'failed';
    }
    MailApp.sendEmail(to, feedbackNotificationSubject_(meta.brand), feedbackBuildNotificationBody_(answers, meta, false));
    return 'sent';
  } catch (mailError) {
    /* 例外messageは宛先を含み得るため、種類名だけを記録する。 */
    Logger.log('feedback notify failed: ' + String((mailError && mailError.name) || 'Error').slice(0, 40));
    return 'failed';
  }
}

/*
 * 通知経路の確認用。GASエディタから手動実行する（doGet/doPost からは呼べない）。
 * FEEDBACK_NOTIFY が off でも、設定済みの FEEDBACK_NOTIFY_EMAIL へ [TEST] 付きのダミー通知を1通送る。
 * Spreadsheet・rate limit・トークンには触れない。
 * 戻り値（ログにも出す）: 'sent' / 'skipped: invalid brand' / 'skipped: notification address not configured' / 'failed: <例外名>'
 */
function sendTestNotification(brand) {
  var result;
  try {
    if (!FeedbackCore.isBrand(brand)) {
      result = 'skipped: invalid brand';
    } else {
      var to = String(PropertiesService.getScriptProperties().getProperty('FEEDBACK_NOTIFY_EMAIL') || '').trim();
      if (!to) {
        result = 'skipped: notification address not configured';
      } else {
        /* 全設問通知形式（#879）の確認用。正常・気になる・該当なし・未回答・自由記述が1通で見えるダミー。 */
        var answers = {
          q1: 3,
          q2: { website: 'ok', booking: 'ok', mail_timing: 'minor' },
          q3: { location: 'ok', lighting: 'trouble', aircon: 'na', equipment: 'ok' },
          q4: 'yes',
          q4_rating: 4,
          q5: ['supplies', 'other'],
          q6: 'maybe',
          comment: '（ダミー）通知の確認用サンプル文です。'
        };
        var meta = { responseId: 'test-notification', receivedAt: new Date().toISOString(), brand: brand };
        MailApp.sendEmail(to, '[TEST] ' + feedbackNotificationSubject_(brand), feedbackBuildNotificationBody_(answers, meta, true));
        result = 'sent';
      }
    }
  } catch (mailError) {
    result = 'failed: ' + String((mailError && mailError.name) || 'Error').slice(0, 40);
  }
  Logger.log('feedback test notification (' + (FeedbackCore.isBrand(brand) ? brand : 'invalid') + '): ' + result);
  return result;
}

/* GASエディタの実行ボタンは引数を渡せないため、ブランドごとの入口を用意する。 */
function sendTestNotificationSnb() { return sendTestNotification('snb'); }
function sendTestNotificationMens() { return sendTestNotification('mens'); }
function sendTestNotificationStudioX() { return sendTestNotification('studio-x'); }

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
 *   - token: 本番回答用。第1段階では FeedbackTokens が常に拒否するため本番回答は保存できない。
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

/* 全体のリクエスト数/分の上限（CacheServiceの簡易カウンタ）。テスト回答も同じ枠で数える。 */
function feedbackWithinRateLimit_(now) {
  var limit = parseInt(PropertiesService.getScriptProperties().getProperty('FEEDBACK_RATE_LIMIT_PER_MINUTE'), 10);
  if (!(limit > 0)) limit = FEEDBACK_DEFAULT_RATE_LIMIT_PER_MINUTE;
  var cache = CacheService.getScriptCache();
  var key = 'feedback_rl_' + Math.floor(now.getTime() / 60000);
  var count = parseInt(cache.get(key), 10) || 0;
  if (count >= limit) return false;
  cache.put(key, String(count + 1), 120);
  return true;
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

  /* 通知は保存成功後・本番回答だけ。失敗しても回答は維持し notify_failed に記録する。 */
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

function feedbackNotificationSubject_(brand) {
  return '【利用後アンケート】確認が必要な回答があります（' + FeedbackCore.getBrand(brand).name + '）';
}

/* プレーンテキスト本文。予約者情報・トークン・Spreadsheet IDは載せない。 */
function feedbackBuildNotificationBody_(answers, meta, isDummy) {
  var lines = [];
  if (isDummy) lines.push('[TEST] これは sendTestNotification による確認用のダミー通知です。回答は保存されていません。', '');
  lines.push('利用後アンケートに、確認が必要な回答がありました。', '');
  lines.push('ブランド: ' + FeedbackCore.getBrand(meta.brand).name);
  lines.push('受信日時: ' + feedbackFormatJst_(new Date(meta.receivedAt)));
  lines.push('回答ID: ' + meta.responseId);
  lines.push('総合満足度: ' + answers.q1 + ' / 5');
  var issues = FeedbackCore.issueLabels(answers);
  lines.push('気になる点: ' + (issues.length ? issues.join('、') : '（選択なし）'));
  var concerns = [];
  [[FeedbackCore.Q2_ITEMS, answers.q2], [FeedbackCore.Q3_ITEMS, answers.q3]].forEach(function (pair) {
    pair[0].forEach(function (item) {
      var value = pair[1][item.id];
      if (value === 'minor' || value === 'trouble') {
        concerns.push(item.label + '（' + FeedbackCore.optionLabel(FeedbackCore.CONDITION_OPTIONS, value) + '）');
      }
    });
  });
  if (concerns.length) lines.push('予約・現地で気になった項目: ' + concerns.join('、'));
  lines.push('', '気になった点・ご感想など:', answers.comment ? answers.comment : '（記入なし）', '');
  lines.push('対応状況は回答Spreadsheetの status / memo 列で管理してください。');
  return lines.join('\n') + '\n';
}

/* 戻り値: 'off' | 'not_needed' | 'sent' | 'failed' */
function feedbackNotifyAdmin_(answers, meta) {
  try {
    if (!FeedbackCore.needsAttention(answers)) return 'not_needed';
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
        var answers = { q1: 3, q2: { mail_timing: 'minor' }, q3: { lighting: 'trouble' }, q4: '', q4_rating: '', q5: ['supplies', 'other'], q6: 'maybe', comment: '（ダミー）通知の確認用サンプル文です。' };
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

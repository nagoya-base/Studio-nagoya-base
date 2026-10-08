/*
 * SurveyWebApp.gs — 一般公開アンケートWeb Appのエントリポイント（Issue #374）。
 *
 * デプロイ設定: Execute as: Me / Who has access: Anyone（匿名・ログイン不要）。
 * Xアプリ内ブラウザでGoogleログインを要求させないため、必ず「全員（匿名を含む）」で公開する。
 *
 * - doGet : 死活確認のみ（schema・Spreadsheet ID・設定値を一切返さない）。
 * - doPost: ?action=submit（既定）で回答保存、?action=event でステップ到達イベント保存。
 *   本文はJSON文字列（Content-Type: text/plain;charset=utf-8。CORSプリフライト回避は
 *   scripts/booking-app.js と同じ方針）。
 *
 * クライアントの送信値は信用せず、SurveyCore.validateSubmission でschemaに基づき再検証する
 * （表示条件外の値の破棄・排他・必須・上限・schema外フィールドの無視・18歳未満の拒否）。
 * 重複回答防止（Issue #381）: 通常回答は同じrespondent_hashの本番回答が既にあれば DUPLICATE_RESPONSE で拒否する。
 * payloadの is_test=1（画面の ?test=1）は重複判定を行わず is_test=1 で保存する（本番集計からは除外）。
 * is_test は認証ではなく、検証・年齢制限・rate limitは通常と同じ。
 * 管理者機能（集計・自由記述の閲覧）はこのプロジェクトに一切含めない。
 */
'use strict';

var SURVEY_MAX_BODY_CHARS = 20000;
var SURVEY_DEFAULT_RATE_LIMIT_PER_MINUTE = 120;

function doGet() {
  return surveyJsonOutput_({ success: true, service: 'studio-nagoya-base-survey' });
}

function doPost(e) {
  var action = (e && e.parameter && e.parameter.action) || 'submit';
  var body = (e && e.postData && e.postData.contents) || '';
  return surveyJsonOutput_(handleSurveyRequest_(action, body, new Date()));
}

function surveyJsonOutput_(object) {
  return ContentService.createTextOutput(JSON.stringify(object)).setMimeType(ContentService.MimeType.JSON);
}

function surveyError_(code, fields) {
  var error = { code: code };
  if (fields) error.fields = fields;
  return { success: false, error: error };
}

/* 全体のリクエスト数/分の上限（CacheServiceの簡易カウンタ）。超過時は保存しない。 */
function surveyWithinRateLimit_(now) {
  var limit = parseInt(PropertiesService.getScriptProperties().getProperty('SURVEY_RATE_LIMIT_PER_MINUTE'), 10);
  if (!(limit > 0)) limit = SURVEY_DEFAULT_RATE_LIMIT_PER_MINUTE;
  var cache = CacheService.getScriptCache();
  var key = 'survey_rl_' + Math.floor(now.getTime() / 60000);
  var count = parseInt(cache.get(key), 10) || 0;
  if (count >= limit) return false;
  cache.put(key, String(count + 1), 120);
  return true;
}

function handleSurveyRequest_(action, body, now) {
  if (action !== 'submit' && action !== 'event') return surveyError_('UNKNOWN_ACTION');
  if (typeof body !== 'string' || body.length > SURVEY_MAX_BODY_CHARS) return surveyError_('PAYLOAD_TOO_LARGE');
  var payload;
  try {
    payload = JSON.parse(body || '{}');
  } catch (parseError) {
    return surveyError_('INVALID_JSON');
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return surveyError_('INVALID_PAYLOAD');
  if (payload.schema_version !== SURVEY_SCHEMA.version) return surveyError_('SCHEMA_VERSION_MISMATCH');
  if (!surveyWithinRateLimit_(now)) return surveyError_('RATE_LIMITED');

  try {
    if (action === 'event') return handleSurveyEvent_(payload, now);
    return handleSurveySubmit_(payload, now);
  } catch (unexpected) {
    /* 例外messageに入力値や設定値が混ざり得るため、外部へは汎用コードだけを返す。 */
    Logger.log('survey ' + action + ' failed: ' + String(unexpected && unexpected.message).slice(0, 80));
    return surveyError_('INTERNAL_ERROR');
  }
}

function handleSurveySubmit_(payload, now) {
  var result = SurveyCore.validateSubmission(SURVEY_SCHEMA, payload);
  if (!result.ok) {
    if (result.errors.some(function (e) { return e.code === 'AGE_NOT_ELIGIBLE'; })) {
      return surveyError_('AGE_NOT_ELIGIBLE');
    }
    return surveyError_('VALIDATION_FAILED', result.errors);
  }
  var saved = SurveyRepository.appendResponse(result.record, now);
  if (!saved.success) return surveyError_(saved.error.code);
  return { success: true };
}

/* ステップ到達イベント。step_idはschemaのステップIDのみ受け付け、個人情報は受け取らない。 */
function handleSurveyEvent_(payload, now) {
  if (!SurveyCore.isValidRespondentHash(payload.respondent_hash)) return surveyError_('INVALID_RESPONDENT');
  var known = SURVEY_SCHEMA.steps.some(function (step) { return step.id === payload.step_id; });
  if (!known) return surveyError_('INVALID_STEP');
  var saved = SurveyRepository.appendEvent(payload.respondent_hash, payload.step_id, now, SurveyCore.normalizeTestFlag(payload.is_test) === 1);
  if (!saved.success) return surveyError_(saved.error.code);
  return { success: true };
}

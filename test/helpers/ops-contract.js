/*
 * 運営アプリ段階1の共通接続契約（docs/ops-reservations-936.md §6）の検証関数。
 * バックエンドの実応答とフロントのモック応答の両方を、同じ関数で検証する。
 */
'use strict';

var fs = require('fs');
var path = require('path');
var vm = require('vm');

var DIR = path.join(__dirname, '..', '..', 'gas', 'ops-reservations');
var sandbox = {};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(DIR, 'OpsContract.gs'), 'utf8'), sandbox);
var ERROR_CODES = Array.from(sandbox.OpsContract.ERROR_CODES);

var ISO_JST = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+09:00$/;
var DATE = /^\d{4}-\d{2}-\d{2}$/;
var PHASES = ['upcoming', 'in_progress', 'ended', 'unknown'];
var LIST_ITEM_KEYS = ['bookingId', 'date', 'endAt', 'name', 'people', 'phase', 'service', 'serviceLabel', 'startAt', 'status', 'statusLabel'];

function check(cond, message, problems) { if (!cond) problems.push(message); }

function validateError(res) {
  var problems = [];
  check(res && res.ok === false, 'ok:false', problems);
  check(res && res.error && ERROR_CODES.indexOf(res.error.code) !== -1, 'error.code が固定コード: ' + (res && res.error && res.error.code), problems);
  check(res && res.error && typeof res.error.message === 'string' && res.error.message.length > 0, 'error.message', problems);
  check(Object.keys(res || {}).sort().join() === 'error,ok', 'エラー応答は ok と error だけ', problems);
  var d = res && res.error && res.error.diagnostic;
  if (d !== undefined) {
    check(d && /^(?:(?:META|HEADER|DATA|CLIENT)\/)?[A-Z][A-Z0-9_]{1,40}(?:\/\d{3})?$/.test(d.code), '診断コードは固定形式: ' + (d && d.code), problems);
    check(d && typeof d.advice === 'string' && d.advice.length > 0, '診断の対応案', problems);
    check(res.error.code === 'FETCH_FAILED', '診断は FETCH_FAILED にだけ付く', problems);
  }
  return problems;
}

function validateItem(item, problems) {
  check(Object.keys(item).sort().join() === LIST_ITEM_KEYS.join(), '一覧項目のキーが契約どおり: ' + Object.keys(item).sort().join(), problems);
  check(DATE.test(item.date), '利用日は日付のみ', problems);
  check(ISO_JST.test(item.startAt), 'startAt はタイムゾーン付きISO', problems);
  check(item.endAt === null || ISO_JST.test(item.endAt), 'endAt はタイムゾーン付きISOまたはnull', problems);
  check(PHASES.indexOf(item.phase) !== -1, 'phase', problems);
  check(item.people === null || typeof item.people === 'number', 'people は数値またはnull（0と未入力を区別）', problems);
}

function validateList(res) {
  if (res && res.ok === false) return validateError(res);
  var problems = [];
  check(res && res.ok === true, 'ok:true', problems);
  check(res.contractVersion === 1, 'contractVersion', problems);
  check(ISO_JST.test(res.fetchedAt), 'fetchedAt はタイムゾーン付きISO', problems);
  check(DATE.test(res.todayJst), 'todayJst', problems);
  check(res.complete === true, 'complete', problems);
  check(res.applied && DATE.test(res.applied.from) && DATE.test(res.applied.to) && /^(asc|desc)$/.test(res.applied.order), 'applied', problems);
  check(res.counts && ['sheetRows', 'valid', 'matched', 'issues'].every(function (k) { return typeof res.counts[k] === 'number'; }), 'counts', problems);
  check(Array.isArray(res.serviceStates) && res.serviceStates.every(function (s) { return ['connected', 'no_data', 'not_connected'].indexOf(s.state) !== -1; }), 'serviceStates', problems);
  check(typeof res.notConnectedSelected === 'boolean', 'notConnectedSelected', problems);
  check(Array.isArray(res.items), 'items', problems);
  (res.items || []).forEach(function (i) { validateItem(i, problems); });
  check(Array.isArray(res.issues) && res.issues.every(function (i) { return typeof i.row === 'number' && /^(error|warning)$/.test(i.severity) && Array.isArray(i.reasons); }), 'issues', problems);
  return problems;
}

function validateDetail(res) {
  if (res && res.ok === false) return validateError(res);
  var problems = [];
  check(res && res.ok === true && res.contractVersion === 1 && ISO_JST.test(res.fetchedAt), 'detail 共通項目', problems);
  var r = res.reservation || {};
  var base = Object.assign({}, r);
  ['brandRaw', 'statusRaw', 'customerType', 'purpose', 'paymentMethod', 'paymentStatus', 'planCode', 'effectivePriceAmount', 'priceOverridden', 'largeParty', 'source', 'createdAt', 'updatedAt', 'confirmedAt', 'cancelledAt', 'expiredAt', 'accessGuideMail', 'confirmedMail'].forEach(function (k) {
    check(Object.prototype.hasOwnProperty.call(r, k), '詳細の許可項目 ' + k, problems);
    delete base[k];
  });
  validateItem(base, problems);
  ['createdAt', 'updatedAt', 'confirmedAt', 'cancelledAt', 'expiredAt'].forEach(function (k) {
    check(r[k] === null || ISO_JST.test(r[k]), k + ' はタイムゾーン付きISOまたはnull', problems);
  });
  ['accessGuideMail', 'confirmedMail'].forEach(function (k) {
    var m = r[k] || {};
    check(Object.keys(m).sort().join() === 'at,state', k + ' は状態と日時のみ（宛先・本文・エラー文を含めない）', problems);
    check(/^(recorded|none|invalid|column_missing)$/.test(m.state), k + ' の状態', problems);
    check(m.state === 'recorded' ? ISO_JST.test(m.at) : m.at === null, k + ' の日時は記録ありのときだけ', problems);
  });
  return problems;
}

/* 鍵・案内の状況（#942）の応答の形。実バックエンドとモックの両方を同じ関数で検証する。 */
var VERDICT_CODES = ['NOT_CONNECTED', 'FETCH_FAILED', 'UNVERIFIABLE', 'NO_HISTORY', 'NOT_ISSUED_CONFIRMED', 'NEEDS_REVIEW', 'MISMATCH', 'ISSUE_PENDING', 'ISSUE_UNCONFIRMED', 'GUIDE_NOT_SENT',
  'ISSUED_GUIDED', 'ISSUED_GUIDE_UNKNOWN', 'REVOKE_UNCONFIRMED', 'REVOKED_CONFIRMED'];
var KEY_VIEW_KEYS = ['connection', 'consistency', 'failure', 'jobs', 'lifecycle', 'notes', 'opCount', 'ops', 'reasons', 'truncated', 'verdict'];
var KEY_OP_KEYS = ['current', 'deliveryLabel', 'kindLabel', 'rev', 'stateLabel', 'updatedAt', 'validFrom', 'validTo'];

function validateKeyStatus(res) {
  if (res && res.ok === false) return validateError(res);
  var problems = [];
  check(res && res.ok === true && res.contractVersion === 1 && ISO_JST.test(res.fetchedAt) && typeof res.bookingId === 'string', 'key_status 共通項目', problems);
  var v = (res && res.keyStatus) || {};
  var keys = Object.keys(v).sort();
  var allowed = KEY_VIEW_KEYS.slice();
  check(keys.every(function (k) { return allowed.indexOf(k) !== -1; }) && KEY_VIEW_KEYS.every(function (k) { return keys.indexOf(k) !== -1; }), 'keyStatus のキーが許可リスト: ' + keys.join(), problems);
  check(v.verdict && VERDICT_CODES.indexOf(v.verdict.code) !== -1 && /^(ok|info|warn|ng)$/.test(v.verdict.tone) && typeof v.verdict.label === 'string', 'verdict', problems);
  check(v.lifecycle === null || (v.lifecycle && /^(ok|info|warn|ng)$/.test(v.lifecycle.tone) && typeof v.lifecycle.label === 'string' && typeof v.lifecycle.code === 'string' && typeof v.lifecycle.alert === 'boolean' && Object.keys(v.lifecycle).sort().join() === 'alert,code,label,tone'), 'lifecycle', problems);
  check(Array.isArray(v.reasons) && v.reasons.every(function (r) { return typeof r.code === 'string' && typeof r.text === 'string'; }), 'reasons', problems);
  check(/^(CONNECTED|NOT_CONNECTED|FETCH_FAILED|UNSUPPORTED)$/.test(v.connection), 'connection', problems);
  check(Array.isArray(v.ops) && v.ops.every(function (o) {
    return Object.keys(o).sort().join() === KEY_OP_KEYS.join() && (o.validFrom === null || ISO_JST.test(o.validFrom)) && (o.validTo === null || ISO_JST.test(o.validTo)) && (o.updatedAt === null || ISO_JST.test(o.updatedAt));
  }), 'ops の形（許可リスト）', problems);
  check(Array.isArray(v.jobs) && v.jobs.every(function (j) { return typeof j.label === 'string' && (j.ageMinutes === null || typeof j.ageMinutes === 'number'); }), 'jobs', problems);
  return problems;
}

module.exports = { validateKeyStatus: validateKeyStatus, validateList: validateList, validateDetail: validateDetail, validateError: validateError, ERROR_CODES: ERROR_CODES };

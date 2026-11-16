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
  ['brandRaw', 'statusRaw', 'customerType', 'purpose', 'paymentMethod', 'paymentStatus', 'planCode', 'effectivePriceAmount', 'priceOverridden', 'largeParty', 'source', 'createdAt', 'updatedAt', 'confirmedAt', 'cancelledAt', 'expiredAt'].forEach(function (k) {
    check(Object.prototype.hasOwnProperty.call(r, k), '詳細の許可項目 ' + k, problems);
    delete base[k];
  });
  validateItem(base, problems);
  ['createdAt', 'updatedAt', 'confirmedAt', 'cancelledAt', 'expiredAt'].forEach(function (k) {
    check(r[k] === null || ISO_JST.test(r[k]), k + ' はタイムゾーン付きISOまたはnull', problems);
  });
  return problems;
}

module.exports = { validateList: validateList, validateDetail: validateDetail, validateError: validateError, ERROR_CODES: ERROR_CODES };

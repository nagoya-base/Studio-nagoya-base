'use strict';

/*
 * 対象取り違え防止（Issue #671レビュー）。migration対象Spreadsheet IDのSHA-256を、本番GASの
 * Script Property SPREADSHEET_ID から独立に求めた指紋と照合する。GitHub ActionsはGASのScript
 * Propertiesを読めないため、「別経路で転記した2つの値が一致すること」を機械的に要求する。
 * 指紋は不可逆なハッシュで、ID自体は復元できない。
 */
var crypto = require('crypto');
var MigrationError = require('./bookings-migration').MigrationError;

function spreadsheetFingerprint(spreadsheetId) {
  return crypto.createHash('sha256').update(String(spreadsheetId).trim(), 'utf8').digest('hex');
}

/* 指紋が未設定・形式不正・不一致ならfail closed（Sheets APIへ接続する前に呼ぶ）。 */
function assertSpreadsheetFingerprint(spreadsheetId, expectedFingerprint) {
  var expected = String(expectedFingerprint || '').trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(expected)) throw new MigrationError('SPREADSHEET_FINGERPRINT_MISMATCH');
  var actual = Buffer.from(spreadsheetFingerprint(spreadsheetId), 'hex');
  if (!crypto.timingSafeEqual(actual, Buffer.from(expected, 'hex'))) {
    throw new MigrationError('SPREADSHEET_FINGERPRINT_MISMATCH');
  }
}

module.exports = { spreadsheetFingerprint: spreadsheetFingerprint, assertSpreadsheetFingerprint: assertSpreadsheetFingerprint };

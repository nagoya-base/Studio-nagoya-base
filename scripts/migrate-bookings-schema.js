#!/usr/bin/env node
'use strict';

/*
 * Bookingsシートのschema migration CLI（Issue #671）。
 *
 *   node scripts/migrate-bookings-schema.js migrate   不足列を末尾へ追加（冪等）
 *   node scripts/migrate-bookings-schema.js verify    読み取り専用。ヘッダーが正本と完全一致か確認
 *
 * 認証情報は環境変数（GitHub Secret）から受け取る。標準出力・標準エラーには固定メッセージのみ出す。
 *   BOOKING_SHEETS_SERVICE_ACCOUNT_JSON  Sheets API専用サービスアカウントのJSON鍵
 *   BOOKING_SPREADSHEET_ID               本番Spreadsheet ID
 *   BOOKING_SPREADSHEET_ID_SHA256        本番GASのScript Property SPREADSHEET_IDから独立に求めた指紋（取り違え防止）
 */
var loadBookingsSchema = require('./lib/bookings-schema').loadBookingsSchema;
var migration = require('./lib/bookings-migration');
var assertSpreadsheetFingerprint = require('./lib/spreadsheet-fingerprint').assertSpreadsheetFingerprint;
var createSheetsClient = require('./lib/sheets-api-client').createSheetsClient;

async function run(mode, env, deps) {
  deps = deps || {};
  var out = deps.stdout || process.stdout;
  var err = deps.stderr || process.stderr;
  try {
    if (mode !== 'migrate' && mode !== 'verify') throw new migration.MigrationError('SHEETS_API_ERROR');
    if (!env.BOOKING_SHEETS_SERVICE_ACCOUNT_JSON || !env.BOOKING_SPREADSHEET_ID) {
      throw new migration.MigrationError('CREDENTIAL_INVALID');
    }
    assertSpreadsheetFingerprint(env.BOOKING_SPREADSHEET_ID, env.BOOKING_SPREADSHEET_ID_SHA256);
    var schema = deps.schema || loadBookingsSchema();
    var client = deps.client || createSheetsClient({
      serviceAccountJson: env.BOOKING_SHEETS_SERVICE_ACCOUNT_JSON,
      spreadsheetId: env.BOOKING_SPREADSHEET_ID,
      fetchImpl: deps.fetchImpl
    });
    if (mode === 'verify') {
      await migration.verifyBookingsSchema(client, schema);
      out.write('Bookings schema matches the expected header\n');
    } else {
      var result = await migration.migrateBookingsSchema(client, schema);
      out.write(result.added === 0
        ? 'Bookings schema is up to date (no changes)\n'
        : 'Bookings schema migrated: appended ' + result.added + ' column(s)\n');
    }
    return 0;
  } catch (error) {
    var code = error instanceof migration.MigrationError ? error.code : 'SHEETS_API_ERROR';
    err.write('Bookings schema ' + (mode === 'verify' ? 'verification' : 'migration') + ' failed: ' + code + '\n');
    return 1;
  }
}

if (require.main === module) {
  run(process.argv[2], process.env).then(function (status) { process.exitCode = status; });
}

module.exports = { run: run };

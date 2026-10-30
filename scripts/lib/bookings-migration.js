'use strict';

/*
 * Bookingsシートのschema migration（Issue #671）。
 *
 * GitHub Actionsから本番デプロイ前に、`Bookings`シートの1行目（ヘッダー行）だけを読み、
 * 正本（BookingsSchema.gs）に対して不足している列を末尾へ追加する。
 *
 * 守ること:
 * - 対象はBookingsシートのみ。1行目以外（予約行）は読まない・書かない。
 * - 既存列の削除・並べ替え・途中挿入・上書きはしない。末尾追加のみ。冪等。
 * - 矛盾があれば何も書かず固定コードで失敗する（fail closed）。自動で「修復」しない。
 * - エラーに含めるのは固定コードのみ。API応答本文・セル値・IDは載せない。
 */

var MIGRATION_ERRORS = {
  SHEET_NOT_FOUND: 'The Bookings sheet could not be found in the configured spreadsheet',
  HEADER_ROW_EMPTY: 'The Bookings sheet has no header row',
  HEADER_MISMATCH: 'The existing Bookings header conflicts with the expected schema',
  ACCESS_DENIED: 'The migration credential cannot access the spreadsheet',
  SPREADSHEET_NOT_FOUND_OR_INACCESSIBLE: 'The spreadsheet was not found or is not shared with the migration account',
  AUTHENTICATION_FAILED: 'The migration credential was rejected',
  TRANSIENT_API_OR_NETWORK_ERROR: 'The Sheets API was temporarily unavailable',
  SHEETS_API_ERROR: 'The Sheets API request failed',
  SPREADSHEET_FINGERPRINT_MISMATCH: 'The configured spreadsheet does not match the registered production spreadsheet fingerprint',
  CREDENTIAL_INVALID: 'The migration credential is not configured correctly',
  POST_WRITE_VERIFICATION_FAILED: 'The Bookings header did not match the expected schema after the update'
};

function MigrationError(code) {
  this.name = 'MigrationError';
  this.code = MIGRATION_ERRORS[code] ? code : 'SHEETS_API_ERROR';
  this.message = MIGRATION_ERRORS[this.code];
}
MigrationError.prototype = Object.create(Error.prototype);
MigrationError.prototype.constructor = MigrationError;

function trimTrailingEmpty(row) {
  var end = row.length;
  while (end > 0 && (row[end - 1] === '' || row[end - 1] === null || row[end - 1] === undefined)) end--;
  return row.slice(0, end);
}

/* ヘッダー行の比較用正規化。セルは文字列として扱う（数値等が入っていれば文字列化して不一致になる）。 */
function normalizeRow(row) {
  return trimTrailingEmpty((row || []).map(function (cell) {
    return cell === null || cell === undefined ? '' : String(cell);
  }));
}

/*
 * 既存ヘッダーと正本を比較し、末尾へ追加すべき列を返す。
 * 既存ヘッダーが正本の先頭部分と完全一致している場合のみ成功する。
 * 順序違い・途中欠落・不明列・正本より長い（シートが先行している）場合はHEADER_MISMATCH。
 */
function planMigration(actualRow, expectedHeaders) {
  var actual = normalizeRow(actualRow);
  if (actual.length === 0) throw new MigrationError('HEADER_ROW_EMPTY');
  if (actual.length > expectedHeaders.length) throw new MigrationError('HEADER_MISMATCH');
  for (var i = 0; i < actual.length; i++) {
    if (actual[i] !== expectedHeaders[i]) throw new MigrationError('HEADER_MISMATCH');
  }
  return { startIndex: actual.length, missing: expectedHeaders.slice(actual.length) };
}

/*
 * client: { getSheetInfo(name) -> null | {sheetId, columnCount}, readHeaderRow(name) -> any[],
 *           ensureColumnCount(sheetId, count), writeHeaderCells(name, startIndex, values) }
 * 戻り値: { added: number }
 */
async function migrateBookingsSchema(client, schema) {
  var info = await client.getSheetInfo(schema.sheetName);
  if (!info) throw new MigrationError('SHEET_NOT_FOUND');

  var plan = planMigration(await client.readHeaderRow(schema.sheetName), schema.headers);
  if (plan.missing.length === 0) return { added: 0 };

  /* グリッドの列数が足りない場合のみ列数を広げる（セルの値は変えない）。 */
  if (info.columnCount < schema.headers.length) {
    await client.ensureColumnCount(info.sheetId, schema.headers.length);
  }
  await client.writeHeaderCells(schema.sheetName, plan.startIndex, plan.missing);

  var after = normalizeRow(await client.readHeaderRow(schema.sheetName));
  if (after.length !== schema.headers.length || after.some(function (cell, index) { return cell !== schema.headers[index]; })) {
    throw new MigrationError('POST_WRITE_VERIFICATION_FAILED');
  }
  return { added: plan.missing.length };
}

/* 読み取り専用。ヘッダーが正本と完全一致していなければ失敗する（デプロイ後のpost-check用）。 */
async function verifyBookingsSchema(client, schema) {
  var info = await client.getSheetInfo(schema.sheetName);
  if (!info) throw new MigrationError('SHEET_NOT_FOUND');
  var actual = normalizeRow(await client.readHeaderRow(schema.sheetName));
  if (actual.length === 0) throw new MigrationError('HEADER_ROW_EMPTY');
  if (actual.length !== schema.headers.length || actual.some(function (cell, index) { return cell !== schema.headers[index]; })) {
    throw new MigrationError('HEADER_MISMATCH');
  }
  return { ok: true };
}

module.exports = {
  MigrationError: MigrationError,
  MIGRATION_ERRORS: MIGRATION_ERRORS,
  planMigration: planMigration,
  migrateBookingsSchema: migrateBookingsSchema,
  verifyBookingsSchema: verifyBookingsSchema,
  normalizeRow: normalizeRow
};

'use strict';
/*
 * Issue #671: Bookingsシートのschema migration（GitHub Actions → Sheets API）の回帰テスト。
 * 実Spreadsheetには触れず、メモリ上のシート群とfetchスタブを使う。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { loadBookingsSchema } = require('../scripts/lib/bookings-schema');
const {
  MigrationError, planMigration, migrateBookingsSchema, verifyBookingsSchema
} = require('../scripts/lib/bookings-migration');
const { createSheetsClient, columnLetters } = require('../scripts/lib/sheets-api-client');
const cli = require('../scripts/migrate-bookings-schema');
const { spreadsheetFingerprint, assertSpreadsheetFingerprint } = require('../scripts/lib/spreadsheet-fingerprint');
const { spawnSync } = require('node:child_process');
const { loadBookingSandbox } = require('./helpers/gas-sandbox');

const schema = loadBookingsSchema();
const H = schema.headers;
const BOOKER = 'secret-booker@example.test';

/* メモリ上のSpreadsheet。sheets[name] = { id, columnCount, rows: any[][] } */
function fakeBook(sheets) {
  const book = { sheets, log: [], failOn: null, corruptAfterWrite: false };
  const byName = (name) => book.sheets[name];
  book.client = {
    async getSheetInfo(name) {
      if (book.failOn === 'info') throw new MigrationError('TRANSIENT_API_OR_NETWORK_ERROR');
      const s = byName(name);
      return s ? { sheetId: s.id, columnCount: s.columnCount } : null;
    },
    async readHeaderRow(name) {
      book.log.push('read:' + name + ':1');
      if (book.failOn === 'read') throw new MigrationError('ACCESS_DENIED');
      return (byName(name).rows[0] || []).slice();
    },
    async ensureColumnCount(sheetId, count) {
      book.log.push('columns');
      const s = Object.values(book.sheets).find((x) => x.id === sheetId);
      s.columnCount = count;
    },
    async writeHeaderCells(name, start, values) {
      book.log.push('write:' + name + ':' + start);
      if (book.failOn === 'write') throw new MigrationError('SHEETS_API_ERROR');
      const row = byName(name).rows[0];
      values.forEach((v, i) => { row[start + i] = book.corruptAfterWrite ? v + 'x' : v; });
    }
  };
  return book;
}
const bookingsSheet = (header, extraRows) => ({
  id: 7, columnCount: Math.max(header.length, 26),
  rows: [header.slice()].concat(extraRows || [])
});
const snapshotRows = (book, name) => JSON.stringify(book.sheets[name].rows.slice(1));

test('schema is loaded from the single BookingsSchema.gs source and matches the GAS runtime', () => {
  const sandbox = loadBookingSandbox(['BookingsSchema.gs', 'SpreadsheetRepository.gs']);
  assert.deepEqual(Array.from(sandbox.SpreadsheetRepository.HEADERS), H);
  assert.equal(schema.sheetName, 'Bookings');
  assert.equal(new Set(H).size, H.length);
  assert.equal(H[0], 'bookingId');
  const repoSource = fs.readFileSync(path.join(__dirname, '..', 'gas/booking/shared/SpreadsheetRepository.gs'), 'utf8');
  assert.doesNotMatch(repoSource, /'largePartyPaymentDueAt'/, 'headers must not be duplicated in SpreadsheetRepository.gs');
});

test('all expected columns present -> no-op success, nothing written', async () => {
  const book = fakeBook({ Bookings: bookingsSheet(H) });
  assert.deepEqual(await migrateBookingsSchema(book.client, schema), { added: 0 });
  assert.equal(book.log.some((l) => l.startsWith('write') || l === 'columns'), false);
});

test('one missing trailing column -> exactly that column is appended', async () => {
  const book = fakeBook({ Bookings: bookingsSheet(H.slice(0, -1)) });
  assert.deepEqual(await migrateBookingsSchema(book.client, schema), { added: 1 });
  assert.deepEqual(book.sheets.Bookings.rows[0], H);
});

test('multiple missing columns are appended in canonical order; legacy planCode-era header migrates', async () => {
  const from = H.indexOf('planCode') + 1;
  const book = fakeBook({ Bookings: bookingsSheet(H.slice(0, from)) });
  const result = await migrateBookingsSchema(book.client, schema);
  assert.equal(result.added, H.length - from);
  assert.deepEqual(book.sheets.Bookings.rows[0], H);
  assert.deepEqual(H.slice(from, from + 3), ['supportServices', 'supportRoomAmount', 'supportStaffAmount']);
});

test('re-running the migration is a no-op (idempotent)', async () => {
  const book = fakeBook({ Bookings: bookingsSheet(H.slice(0, 30)) });
  assert.equal((await migrateBookingsSchema(book.client, schema)).added, H.length - 30);
  const before = JSON.stringify(book.sheets);
  book.log.length = 0;
  assert.deepEqual(await migrateBookingsSchema(book.client, schema), { added: 0 });
  assert.equal(JSON.stringify(book.sheets), before);
  assert.equal(book.log.some((l) => l.startsWith('write')), false);
});

test('missing column in the middle, reordered columns and unknown middle columns all fail closed without writing', async () => {
  const missingMiddle = H.filter((h) => h !== 'phone').slice(0, 40);
  const reordered = H.slice(0, 40); [reordered[3], reordered[4]] = [reordered[4], reordered[3]];
  const unknownMiddle = H.slice(0, 40); unknownMiddle.splice(10, 0, 'mystery');
  const tooLong = H.concat(['extraFromNewerSheet']);
  const renamed = H.slice(0, 40); renamed[5] = 'Brand';
  for (const header of [missingMiddle, reordered, unknownMiddle, tooLong, renamed]) {
    const book = fakeBook({ Bookings: bookingsSheet(header, [[BOOKER]]) });
    const before = JSON.stringify(book.sheets);
    await assert.rejects(migrateBookingsSchema(book.client, schema), (e) => e.code === 'HEADER_MISMATCH');
    assert.equal(JSON.stringify(book.sheets), before);
    assert.equal(book.log.some((l) => l.startsWith('write') || l === 'columns'), false);
  }
});

test('missing Bookings sheet or empty header row fails closed', async () => {
  const noSheet = fakeBook({ Other: bookingsSheet(H) });
  await assert.rejects(migrateBookingsSchema(noSheet.client, schema), (e) => e.code === 'SHEET_NOT_FOUND');
  const empty = fakeBook({ Bookings: { id: 1, columnCount: 5, rows: [[]] } });
  await assert.rejects(migrateBookingsSchema(empty.client, schema), (e) => e.code === 'HEADER_ROW_EMPTY');
});

test('existing booking rows and other sheets are never modified; only header cells are written', async () => {
  const rows = [['b-1', BOOKER, 'x', 123], ['b-2', 'someone@example.test']];
  const book = fakeBook({
    Bookings: bookingsSheet(H.slice(0, 50), rows),
    Recovery: { id: 2, columnCount: 3, rows: [['a', 'b'], ['c', 'd']] },
    BookingMemberVerifications: { id: 3, columnCount: 3, rows: [['k'], ['v']] }
  });
  const others = snapshotRows(book, 'Recovery') + snapshotRows(book, 'BookingMemberVerifications');
  const bookingRows = snapshotRows(book, 'Bookings');
  await migrateBookingsSchema(book.client, schema);
  assert.equal(snapshotRows(book, 'Bookings'), bookingRows);
  assert.equal(snapshotRows(book, 'Recovery') + snapshotRows(book, 'BookingMemberVerifications'), others);
  assert.deepEqual(book.log.filter((l) => l.startsWith('write')), ['write:Bookings:50']);
  assert.equal(book.log.every((l) => !l.startsWith('read') || l.endsWith(':1')), true);
});

test('grid is widened only when the sheet has too few columns', async () => {
  const narrow = fakeBook({ Bookings: Object.assign(bookingsSheet(H.slice(0, 50)), { columnCount: 50 }) });
  await migrateBookingsSchema(narrow.client, schema);
  assert.equal(narrow.log.includes('columns'), true);
  assert.equal(narrow.sheets.Bookings.columnCount, H.length);
  const wide = fakeBook({ Bookings: Object.assign(bookingsSheet(H.slice(0, 50)), { columnCount: 200 }) });
  await migrateBookingsSchema(wide.client, schema);
  assert.equal(wide.log.includes('columns'), false);
});

test('API failures and post-write mismatches fail closed with fixed codes', async () => {
  for (const [failOn, code] of [['info', 'TRANSIENT_API_OR_NETWORK_ERROR'], ['read', 'ACCESS_DENIED'], ['write', 'SHEETS_API_ERROR']]) {
    const book = fakeBook({ Bookings: bookingsSheet(H.slice(0, 50)) });
    book.failOn = failOn;
    await assert.rejects(migrateBookingsSchema(book.client, schema), (e) => e instanceof MigrationError && e.code === code);
  }
  const corrupt = fakeBook({ Bookings: bookingsSheet(H.slice(0, 50)) });
  corrupt.corruptAfterWrite = true;
  await assert.rejects(migrateBookingsSchema(corrupt.client, schema), (e) => e.code === 'POST_WRITE_VERIFICATION_FAILED');
});

test('verify is read-only and requires an exact match', async () => {
  const ok = fakeBook({ Bookings: bookingsSheet(H) });
  assert.deepEqual(await verifyBookingsSchema(ok.client, schema), { ok: true });
  const behind = fakeBook({ Bookings: bookingsSheet(H.slice(0, -1)) });
  await assert.rejects(verifyBookingsSchema(behind.client, schema), (e) => e.code === 'HEADER_MISMATCH');
  assert.equal(behind.log.some((l) => l.startsWith('write')), false);
});

test('planMigration treats trailing blank header cells as absent', () => {
  assert.deepEqual(planMigration(['bookingId', 'createdAt', '', null], H).startIndex, 2);
});

/* ---- Sheets API HTTP client ---- */
const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const serviceAccountJson = JSON.stringify({
  client_email: 'migrator@example-project.iam.gserviceaccount.com',
  private_key: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }),
  token_uri: 'https://oauth2.googleapis.com/token'
});
const SPREADSHEET_ID = 'SPREADSHEETID_dummy_0123456789';

function fakeFetch(handler) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url: String(url), init: init || {} });
    const r = handler(String(url), init || {});
    return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body };
  };
  fn.calls = calls;
  return fn;
}

test('Sheets client: JWT auth, metadata/header reads and header-only writes', async () => {
  const fetchImpl = fakeFetch((url, init) => {
    if (url === 'https://oauth2.googleapis.com/token') return { status: 200, body: { access_token: 'tok-1' } };
    if (url.includes('?fields=')) return { status: 200, body: { sheets: [
      { properties: { sheetId: 5, title: 'Recovery', gridProperties: { columnCount: 9 } } },
      { properties: { sheetId: 7, title: 'Bookings', gridProperties: { columnCount: 40 } } }] } };
    if (init.method === 'PUT') return { status: 200, body: {} };
    return { status: 200, body: { values: [['bookingId', 'createdAt']] } };
  });
  const client = createSheetsClient({ serviceAccountJson, spreadsheetId: SPREADSHEET_ID, fetchImpl });
  assert.deepEqual(await client.getSheetInfo('Bookings'), { sheetId: 7, columnCount: 40 });
  assert.equal(await client.getSheetInfo('Nope'), null);
  assert.deepEqual(await client.readHeaderRow('Bookings'), ['bookingId', 'createdAt']);
  await client.writeHeaderCells('Bookings', 27, ['a', 'b']);
  const token = fetchImpl.calls[0];
  assert.match(token.init.body, /grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer/);
  assert.equal(fetchImpl.calls.filter((c) => c.url.includes('oauth2')).length, 1, 'token is cached');
  assert.match(decodeURIComponent(fetchImpl.calls[3].url), /values\/'Bookings'!1:1\?valueRenderOption=UNFORMATTED_VALUE/);
  const putCall = fetchImpl.calls.find((c) => c.init.method === 'PUT');
  assert.match(decodeURIComponent(putCall.url), /values\/'Bookings'!AB1:AC1\?valueInputOption=RAW/);
  assert.equal(putCall.init.headers.Authorization, 'Bearer tok-1');
  assert.deepEqual(JSON.parse(putCall.init.body).values, [['a', 'b']]);
});

test('columnLetters converts zero-based indexes to A1 letters', () => {
  assert.deepEqual([0, 25, 26, 51, 52, 701, 702].map(columnLetters), ['A', 'Z', 'AA', 'AZ', 'BA', 'ZZ', 'AAA']);
});

test('Sheets client maps HTTP/network/credential failures to fixed codes without leaking details', async () => {
  const leak = 'leak-' + BOOKER + SPREADSHEET_ID;
  for (const [status, code] of [[401, 'AUTHENTICATION_FAILED'], [403, 'ACCESS_DENIED'], [404, 'SPREADSHEET_NOT_FOUND_OR_INACCESSIBLE'],
    [429, 'TRANSIENT_API_OR_NETWORK_ERROR'], [503, 'TRANSIENT_API_OR_NETWORK_ERROR'], [400, 'SHEETS_API_ERROR']]) {
    const fetchImpl = fakeFetch((url) => url.includes('oauth2') ? { status: 200, body: { access_token: 't' } } : { status, body: { error: leak } });
    const client = createSheetsClient({ serviceAccountJson, spreadsheetId: SPREADSHEET_ID, fetchImpl });
    await assert.rejects(client.getSheetInfo('Bookings'), (e) => e.code === code && !e.message.includes(leak) && !JSON.stringify(e).includes(SPREADSHEET_ID));
  }
  const netFail = createSheetsClient({ serviceAccountJson, spreadsheetId: SPREADSHEET_ID, fetchImpl: async () => { throw new Error(leak); } });
  await assert.rejects(netFail.getSheetInfo('Bookings'), (e) => e.code === 'TRANSIENT_API_OR_NETWORK_ERROR' && !e.message.includes(leak));
  const denied = createSheetsClient({ serviceAccountJson, spreadsheetId: SPREADSHEET_ID, fetchImpl: fakeFetch(() => ({ status: 400, body: {} })) });
  await assert.rejects(denied.getSheetInfo('Bookings'), (e) => e.code === 'AUTHENTICATION_FAILED');
  for (const bad of ['not json ' + leak, '{}', JSON.stringify({ client_email: 'a', private_key: 'b', token_uri: 'https://evil.example/token' })]) {
    assert.throws(() => createSheetsClient({ serviceAccountJson: bad, spreadsheetId: SPREADSHEET_ID }), (e) => e.code === 'CREDENTIAL_INVALID' && !e.message.includes('leak'));
  }
  assert.throws(() => createSheetsClient({ serviceAccountJson, spreadsheetId: 'x' }), (e) => e.code === 'CREDENTIAL_INVALID');
});

/* ---- CLI ---- */
function sink() { return { text: '', write(t) { this.text += t; } }; }

test('CLI prints only fixed messages on success and failure', async () => {
  const env = { BOOKING_SHEETS_SERVICE_ACCOUNT_JSON: serviceAccountJson, BOOKING_SPREADSHEET_ID: SPREADSHEET_ID, BOOKING_SPREADSHEET_ID_SHA256: spreadsheetFingerprint(SPREADSHEET_ID) };
  const book = fakeBook({ Bookings: bookingsSheet(H.slice(0, -2), [[BOOKER]]) });
  let out = sink(); let err = sink();
  assert.equal(await cli.run('migrate', env, { client: book.client, stdout: out, stderr: err }), 0);
  assert.equal(out.text, 'Bookings schema migrated: appended 2 column(s)\n');
  out = sink();
  assert.equal(await cli.run('migrate', env, { client: book.client, stdout: out, stderr: err }), 0);
  assert.equal(out.text, 'Bookings schema is up to date (no changes)\n');
  out = sink();
  assert.equal(await cli.run('verify', env, { client: book.client, stdout: out, stderr: err }), 0);
  assert.equal(out.text, 'Bookings schema matches the expected header\n');

  const bad = fakeBook({ Bookings: bookingsSheet(['bookingId', BOOKER]) });
  out = sink(); err = sink();
  assert.equal(await cli.run('migrate', env, { client: bad.client, stdout: out, stderr: err }), 1);
  assert.equal(err.text, 'Bookings schema migration failed: HEADER_MISMATCH\n');
  assert.equal((out.text + err.text).includes(BOOKER), false);
  err = sink();
  assert.equal(await cli.run('verify', env, { client: bad.client, stdout: sink(), stderr: err }), 1);
  assert.equal(err.text, 'Bookings schema verification failed: HEADER_MISMATCH\n');
  err = sink();
  assert.equal(await cli.run('migrate', {}, { stdout: sink(), stderr: err }), 1);
  assert.equal(err.text, 'Bookings schema migration failed: CREDENTIAL_INVALID\n');
  err = sink();
  assert.equal(await cli.run('bogus', env, { stdout: sink(), stderr: err }), 1);
});

test('spreadsheet fingerprint mismatch or absence fails closed before any API access', async () => {
  const other = spreadsheetFingerprint('ANOTHER_SPREADSHEET_dummy_9876');
  for (const bad of [other, '', undefined, 'not-a-hash']) {
    const env = { BOOKING_SHEETS_SERVICE_ACCOUNT_JSON: serviceAccountJson, BOOKING_SPREADSHEET_ID: SPREADSHEET_ID, BOOKING_SPREADSHEET_ID_SHA256: bad };
    for (const mode of ['migrate', 'verify']) {
      const book = fakeBook({ Bookings: bookingsSheet(H.slice(0, -1)) });
      const err = sink();
      assert.equal(await cli.run(mode, env, { client: book.client, stdout: sink(), stderr: err }), 1);
      assert.match(err.text, /failed: SPREADSHEET_FINGERPRINT_MISMATCH\n$/);
      assert.deepEqual(book.log, [], 'no sheet access happens');
      assert.equal(err.text.includes(SPREADSHEET_ID) || err.text.includes(other), false);
    }
  }
  assert.doesNotThrow(() => assertSpreadsheetFingerprint(SPREADSHEET_ID + '\n', spreadsheetFingerprint(SPREADSHEET_ID).toUpperCase()));
});

test('fingerprint tool reads the ID from stdin and prints only the SHA-256', () => {
  const tool = path.join(__dirname, '..', 'scripts/booking-spreadsheet-fingerprint.js');
  const ok = spawnSync('node', [tool], { input: SPREADSHEET_ID + '\n', encoding: 'utf8' });
  assert.equal(ok.status, 0);
  assert.equal(ok.stdout, spreadsheetFingerprint(SPREADSHEET_ID) + '\n');
  assert.equal(ok.stdout.includes(SPREADSHEET_ID), false);
  const empty = spawnSync('node', [tool], { input: '', encoding: 'utf8' });
  assert.equal(empty.status, 1);
  assert.equal(empty.stdout, '');
});

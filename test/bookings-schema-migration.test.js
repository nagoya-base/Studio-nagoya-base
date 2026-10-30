'use strict';
/*
 * Issue #673: 管理者がApps Scriptエディタから実行する migrateBookingsSchema（admin/BookingsSchemaMigration.gs）の回帰テスト。
 * 実Spreadsheetには触れず、メモリ上のシート群を使う。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadBookingSandbox } = require('./helpers/gas-sandbox');
const manifest = require('./helpers/booking-deployment-manifest');

const BOOKER = 'secret-booker@example.test';
const SPREADSHEET_ID = 'spreadsheet-id-dummy';

/* メモリ上のSpreadsheet。sheets[name] = { maxColumns, rows: any[][] }。書込みはすべてwritesに記録する。 */
function fakeBook(sheets, options) {
  const opts = options || {};
  const book = { sheets, writes: [], logs: [], locked: false, released: false };
  const sheetApi = (name) => {
    const s = sheets[name];
    if (!s) return null;
    return {
      getLastColumn: () => s.rows.reduce((max, row) => {
        let last = row.length;
        while (last > 0 && (row[last - 1] === '' || row[last - 1] === undefined)) last--;
        return Math.max(max, last);
      }, 0),
      getMaxColumns: () => s.maxColumns,
      insertColumnsAfter(after, count) {
        if (opts.failOn === 'insert') throw new Error('insert failed ' + SPREADSHEET_ID);
        assert.equal(after, s.maxColumns);
        book.writes.push({ sheet: name, kind: 'columns', count });
        s.maxColumns += count;
      },
      getRange(row, col, numRows, numCols) {
        return {
          getValues: () => {
            if (opts.failOn === 'read') throw new Error('read failed ' + SPREADSHEET_ID);
            const out = [];
            for (let r = 0; r < numRows; r++) {
              const line = [];
              for (let c = 0; c < numCols; c++) {
                const v = (s.rows[row - 1 + r] || [])[col - 1 + c];
                line.push(v === undefined ? '' : v);
              }
              out.push(line);
            }
            return out;
          },
          setValues(values) {
            if (opts.failOn === 'write') throw new Error('write failed ' + SPREADSHEET_ID);
            assert.equal(numRows, 1);
            assert.equal(row, 1, 'only the header row may be written');
            book.writes.push({ sheet: name, kind: 'cells', row, col, values: Array.from(values[0]) });
            values[0].forEach((v, i) => {
              s.rows[0][col - 1 + i] = opts.corruptAfterWrite ? v + 'x' : v;
            });
          }
        };
      }
    };
  };
  book.spreadsheet = { getSheetByName: sheetApi };
  return book;
}

function sandboxFor(book, extra) {
  const sandbox = loadBookingSandbox(['BookingsSchema.gs', 'Config.gs', 'BookingsSchemaMigration.gs'], Object.assign({
    SpreadsheetApp: { openById: () => book.spreadsheet },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => (k === 'SPREADSHEET_ID' ? SPREADSHEET_ID : null) }) },
    LockService: { getScriptLock: () => ({
      tryLock: () => { book.locked = true; return !(extra && extra.lockBusy); },
      releaseLock: () => { book.released = true; }
    }) },
    Logger: { log: (m) => book.logs.push(String(m)) }
  }, extra && extra.globals));
  return sandbox;
}

const schemaOf = () => Array.from(loadBookingSandbox(['BookingsSchema.gs']).BookingsSchema.HEADERS);
const H = schemaOf();
const bookingsSheet = (header, extraRows) => ({ maxColumns: H.length, rows: [header.slice()].concat(extraRows || []) });
const dataRows = () => [
  ['B-1', '2026-10-30', BOOKER, 'CONFIRMED'],
  ['B-2', '2026-10-31', BOOKER, 'PENDING']
];
const snapshot = (book, name) => JSON.stringify(book.sheets[name].rows.slice(1));
const run = (book, extra) => sandboxFor(book, extra).migrateBookingsSchema();
const failure = (book, extra) => {
  try { run(book, extra); } catch (e) { return e; }
  assert.fail('expected migrateBookingsSchema to fail');
};

test('exactly matching header -> no-op success with a fixed log line', () => {
  const book = fakeBook({ Bookings: bookingsSheet(H, dataRows()) });
  const result = run(book);
  assert.equal(result.added, 0);
  assert.deepEqual(book.writes, []);
  assert.deepEqual(book.logs, ['BOOKINGS_SCHEMA_ALREADY_CURRENT']);
  assert.equal(book.released, true);
});

test('one missing trailing column -> exactly that column is appended', () => {
  const book = fakeBook({ Bookings: bookingsSheet(H.slice(0, -1), dataRows()) });
  const result = run(book);
  assert.equal(result.added, 1);
  assert.deepEqual(book.writes, [{ sheet: 'Bookings', kind: 'cells', row: 1, col: H.length, values: [H[H.length - 1]] }]);
  assert.deepEqual(book.sheets.Bookings.rows[0], H);
  assert.deepEqual(book.logs, ['BOOKINGS_SCHEMA_MIGRATION_OK: added=1']);
});

test('planCode-era header migrates the 13 trailing columns in canonical order (#669 / #670)', () => {
  const planIndex = H.indexOf('planCode');
  const book = fakeBook({ Bookings: bookingsSheet(H.slice(0, planIndex + 1), dataRows()) });
  const result = run(book);
  assert.equal(result.added, 13);
  assert.deepEqual(book.sheets.Bookings.rows[0], H);
  assert.deepEqual(H.slice(planIndex + 1), [
    'supportServices', 'supportRoomAmount', 'supportStaffAmount', 'supportApprovedAt', 'supportPaymentDueAt',
    'supportApprovalMailSentAt', 'supportEquipment', 'supportEquipmentAmount', 'largeParty', 'partySurcharge',
    'largePartyApprovalStatus', 'largePartyApprovedAt', 'largePartyPaymentDueAt'
  ]);
  assert.equal(book.writes.length, 1);
  assert.equal(book.writes[0].col, planIndex + 2);
  assert.deepEqual(book.logs, ['BOOKINGS_SCHEMA_MIGRATION_OK: added=13']);
});

test('re-running after a migration is a no-op', () => {
  const book = fakeBook({ Bookings: bookingsSheet(H.slice(0, -3), dataRows()) });
  assert.equal(run(book).added, 3);
  const writesAfterFirst = book.writes.length;
  assert.equal(run(book).added, 0);
  assert.equal(book.writes.length, writesAfterFirst);
});

test('fails closed without writing: missing middle column, reordered, unknown middle/trailing column, longer than schema', () => {
  const missingMiddle = H.slice(0, 10).concat(H.slice(11, 30));
  const reordered = H.slice(0, 5).concat([H[6], H[5]], H.slice(7, 30));
  const unknownMiddle = H.slice(0, 8).concat(['unknownColumn'], H.slice(8, 30));
  const unknownTrailing = H.slice(0, 30).concat(['unknownColumn']);
  const longer = H.concat(['futureColumn']);
  const cases = { missingMiddle, reordered, unknownMiddle, unknownTrailing, longer };
  for (const [label, header] of Object.entries(cases)) {
    const book = fakeBook({ Bookings: bookingsSheet(header, dataRows()), Other: { maxColumns: 3, rows: [['x']] } });
    const before = JSON.stringify(book.sheets);
    const error = failure(book);
    assert.match(error.message, /^BOOKINGS_SCHEMA_MIGRATION_FAILED: (HEADER_MISMATCH|HEADER_LONGER_THAN_SCHEMA)$/, label);
    assert.deepEqual(book.writes, [], label);
    assert.equal(JSON.stringify(book.sheets), before, label);
  }
});

test('missing Bookings sheet or empty header row fails closed', () => {
  const noSheet = fakeBook({ Other: { maxColumns: 3, rows: [['x']] } });
  assert.match(failure(noSheet).message, /SHEET_NOT_FOUND$/);
  assert.deepEqual(noSheet.writes, []);
  const emptyHeader = fakeBook({ Bookings: { maxColumns: 26, rows: [[], ['B-1', BOOKER]] } });
  assert.match(failure(emptyHeader).message, /HEADER_ROW_EMPTY$/);
  assert.deepEqual(emptyHeader.writes, []);
});

test('only header cells of Bookings are written: booking rows and other sheets are unchanged', () => {
  const other = { maxColumns: 4, rows: [['bookingId', 'x'], ['O-1', BOOKER]] };
  const recovery = { maxColumns: 4, rows: [['k', 'v'], ['r', BOOKER]] };
  const book = fakeBook({ Bookings: bookingsSheet(H.slice(0, 40), dataRows()), BookingMemberVerifications: other, Recovery: recovery });
  const rowsBefore = snapshot(book, 'Bookings');
  const othersBefore = JSON.stringify([other, recovery]);
  run(book);
  assert.equal(snapshot(book, 'Bookings'), rowsBefore);
  assert.equal(JSON.stringify([other, recovery]), othersBefore);
  assert.ok(book.writes.every((w) => w.sheet === 'Bookings' && (w.kind === 'columns' || w.row === 1)));
});

test('the grid is widened only when it has too few columns, by exactly the shortfall', () => {
  const narrow = bookingsSheet(H.slice(0, -2), dataRows());
  narrow.maxColumns = H.length - 2;
  const book = fakeBook({ Bookings: narrow });
  run(book);
  assert.deepEqual(book.writes[0], { sheet: 'Bookings', kind: 'columns', count: 2 });
  assert.equal(book.sheets.Bookings.maxColumns, H.length);

  const wide = fakeBook({ Bookings: bookingsSheet(H.slice(0, -2), dataRows()) });
  run(wide);
  assert.equal(wide.writes.some((w) => w.kind === 'columns'), false);
});

test('post-write mismatch and Spreadsheet access/write failures fail closed with fixed, sanitized output', () => {
  const corrupt = fakeBook({ Bookings: bookingsSheet(H.slice(0, -2), dataRows()) }, { corruptAfterWrite: true });
  assert.match(failure(corrupt).message, /POST_WRITE_VERIFICATION_FAILED$/);

  for (const failOn of ['read', 'write', 'insert']) {
    const narrow = bookingsSheet(H.slice(0, -2), dataRows());
    if (failOn === 'insert') narrow.maxColumns = H.length - 2;
    const book = fakeBook({ Bookings: narrow }, { failOn });
    const error = failure(book);
    assert.equal(error.message, 'BOOKINGS_SCHEMA_MIGRATION_FAILED: ACCESS_OR_WRITE_FAILED', failOn);
    assert.equal(book.released, true);
  }

  const openFails = fakeBook({ Bookings: bookingsSheet(H) });
  const error = failure(openFails, { globals: { SpreadsheetApp: { openById: () => { throw new Error('No access to ' + SPREADSHEET_ID); } } } });
  assert.equal(error.message, 'BOOKINGS_SCHEMA_MIGRATION_FAILED: ACCESS_OR_WRITE_FAILED');
  assert.doesNotMatch(openFails.logs.join('\n') + error.message, new RegExp(SPREADSHEET_ID));

  const busy = fakeBook({ Bookings: bookingsSheet(H.slice(0, -1)) });
  assert.match(failure(busy, { lockBusy: true }).message, /LOCK_UNAVAILABLE$/);
  assert.deepEqual(busy.writes, []);
});

test('logs contain only fixed text and counts: no booking values, IDs or tokens', () => {
  const book = fakeBook({ Bookings: bookingsSheet(H.slice(0, -2), dataRows()) });
  run(book);
  const failing = fakeBook({ Bookings: bookingsSheet(H.slice(0, 10).concat(['unknown']), dataRows()) });
  failure(failing);
  for (const line of book.logs.concat(failing.logs)) {
    assert.match(line, /^BOOKINGS_SCHEMA_(MIGRATION_OK: added=\d+|ALREADY_CURRENT|MIGRATION_FAILED: [A-Z_]+)$/);
  }
});

test('plan treats trailing blank header cells as absent and is the only place deciding the append range', () => {
  const sandbox = loadBookingSandbox(['BookingsSchema.gs', 'BookingsSchemaMigration.gs']);
  const plan = sandbox.BookingsSchemaMigration.plan(H.slice(0, 5).concat(['', '']), H);
  assert.equal(plan.startIndex, 5);
  assert.deepEqual(Array.from(plan.missing), H.slice(5));
});

test('headers are not duplicated: the migration reads BookingsSchema.gs only', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'gas/booking/admin/BookingsSchemaMigration.gs'), 'utf8');
  assert.doesNotMatch(source, /'bookingId'|'planCode'|'largePartyPaymentDueAt'|'supportServices'/);
  assert.match(source, /BookingsSchema\.HEADERS/);
  const repo = fs.readFileSync(path.join(__dirname, '..', 'gas/booking/shared/SpreadsheetRepository.gs'), 'utf8');
  assert.match(repo, /BookingsSchema\.HEADERS/);
  assert.doesNotMatch(repo, /'largePartyPaymentDueAt'/);
});

test('migrateBookingsSchema is selectable in the editor (no trailing underscore) and ships to Booking Admin only', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'gas/booking/admin/BookingsSchemaMigration.gs'), 'utf8');
  assert.match(source, /^function migrateBookingsSchema\(\) \{/m);
  assert.doesNotMatch(source, /function migrateBookingsSchema_/);
  assert.ok(manifest.BOOKING_ADMIN_FILES.includes('BookingsSchemaMigration.gs'));
  assert.ok(!manifest.BOOKING_WEB_APP_FILES.includes('BookingsSchemaMigration.gs'));
  assert.ok(!manifest.BOOKING_WEBHOOK_FILES.includes('BookingsSchemaMigration.gs'));
  assert.ok(fs.existsSync(path.join(__dirname, '..', 'gas/booking/admin/BookingsSchemaMigration.gs')));
  assert.ok(!fs.existsSync(path.join(__dirname, '..', 'gas/booking/shared/BookingsSchemaMigration.gs')));
});

test('no Sheets API / service-account / fingerprint tooling remains from Issue #671', () => {
  const root = path.join(__dirname, '..');
  for (const gone of ['scripts/migrate-bookings-schema.js', 'scripts/lib', 'scripts/booking-spreadsheet-fingerprint.js']) {
    assert.equal(fs.existsSync(path.join(root, gone)), false, gone);
  }
});

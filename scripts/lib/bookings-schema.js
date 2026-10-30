'use strict';

/*
 * Bookingsシートのヘッダー定義（唯一の正本: gas/booking/shared/BookingsSchema.gs, Issue #671）を
 * 読み出す。GASソースを正規表現で解析してHEADERS_を推測することはせず、配布するファイルそのものを
 * vmで実行して値を得る（GAS実行時とmigrationが必ず同じ定義を参照する）。
 */
var fs = require('fs');
var path = require('path');
var vm = require('vm');

var SCHEMA_FILE = path.join(__dirname, '..', '..', 'gas', 'booking', 'shared', 'BookingsSchema.gs');

function loadBookingsSchema(schemaFile) {
  var file = schemaFile || SCHEMA_FILE;
  var context = vm.createContext({});
  vm.runInContext(fs.readFileSync(file, 'utf8') + '\nthis.__schema = BookingsSchema;', context, { filename: file });
  var schema = context.__schema;
  var headers = schema && Array.isArray(schema.HEADERS) ? Array.from(schema.HEADERS) : null;
  var sheetName = schema && typeof schema.SHEET_NAME === 'string' ? schema.SHEET_NAME : '';

  if (!sheetName || !headers || headers.length === 0 ||
      headers.some(function (header) { return typeof header !== 'string' || header === ''; }) ||
      new Set(headers).size !== headers.length) {
    throw new Error('BookingsSchema.gs is not a valid schema definition');
  }
  return { sheetName: sheetName, headers: headers };
}

module.exports = { loadBookingsSchema: loadBookingsSchema, SCHEMA_FILE: SCHEMA_FILE };

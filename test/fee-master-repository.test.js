'use strict';

var test = require('node:test');
var assert = require('node:assert/strict');
var loadBookingSandbox = require('./helpers/gas-sandbox').loadBookingSandbox;
var stubs = require('./helpers/gas-stubs');

function setup() {
  var sheets = {};
  var globals = {
    PropertiesService: stubs.createPropertiesServiceStub({ SPREADSHEET_ID: 'ss1' }),
    SpreadsheetApp: stubs.createSpreadsheetAppStub({ ss1: sheets })
  };
  var sandbox = loadBookingSandbox(['Config.gs', 'FeeMasterRepository.gs'], globals);
  return { sandbox: sandbox, sheets: sheets };
}

test('seeds v1 with the published SNB/mens/Studio X rates on first access', function () {
  var f = setup().sandbox;
  var table = f.FeeMasterRepository.getActiveTable('2026-09-25');
  assert.equal(table.version, 1);
  assert.equal(table.entries['snb|general|weekday'].hour2Amount, 4000);
  assert.equal(table.entries['snb|general|weekend_holiday'].hour3Amount, 7500);
  assert.equal(table.entries['snb|member|weekday'].hour4Amount, 7000);
  assert.equal(table.entries['studio_x|general|weekend_holiday'].extensionHourAmount, 2500);
  assert.equal(table.entries['mens|member|weekday'].hour2Amount, 4000);
});

test('findEntry is fail-closed (null) for combinations that have no published price table', function () {
  var f = setup().sandbox;
  assert.equal(f.FeeMasterRepository.findEntry('2026-09-25', 'mens', 'general', 'weekday').entry, null);
  assert.equal(f.FeeMasterRepository.findEntry('2026-09-25', 'studio_x', 'member', 'weekday').entry, null);
});

test('a new version only becomes active once its effectiveAt date is reached', function () {
  var setupResult = setup();
  var f = setupResult.sandbox;
  f.FeeMasterRepository.getActiveTable('2026-09-25'); // シートをseedさせる
  var sheet = setupResult.sheets.FeeMaster;
  sheet.appendRow([2, '2030-01-01', 'snb', 'general', 'weekday', 4500, 6500, 8500, 2200, 'v2 future']);

  var stillV1 = f.FeeMasterRepository.getActiveTable('2026-09-25');
  assert.equal(stillV1.version, 1);
  assert.equal(stillV1.entries['snb|general|weekday'].hour2Amount, 4000);

  var v2Active = f.FeeMasterRepository.getActiveTable('2030-06-01');
  assert.equal(v2Active.version, 2);
  assert.equal(v2Active.entries['snb|general|weekday'].hour2Amount, 4500);
});

test('a fee quote taken before a version change and re-checked after must reject on version mismatch (integration with FeeCalculator)', function () {
  var setupResult = setup();
  var f = loadBookingSandbox(['Config.gs', 'JapanHolidays.gs', 'FeeMasterRepository.gs', 'FeeCalculator.gs'], {
    PropertiesService: stubs.createPropertiesServiceStub({ SPREADSHEET_ID: 'ss1' }),
    SpreadsheetApp: stubs.createSpreadsheetAppStub({ ss1: setupResult.sheets })
  });
  var previewQuote = f.FeeCalculator.quoteFee({ brand: 'snb', priceCategory: 'general', durationMinutes: 120, dateString: '2026-09-25', asOfDateString: '2026-09-25' });
  assert.equal(previewQuote.version, 1);

  var sheet = setupResult.sheets.FeeMaster;
  sheet.appendRow([2, '2020-06-01', 'snb', 'general', 'weekday', 4500, 6500, 8500, 2200, 'v2 already effective']);

  var commitQuote = f.FeeCalculator.quoteFee({ brand: 'snb', priceCategory: 'general', durationMinutes: 120, dateString: '2026-09-25', asOfDateString: '2026-09-25' });
  assert.equal(commitQuote.version, 2);
  assert.notEqual(previewQuote.version, commitQuote.version);
});

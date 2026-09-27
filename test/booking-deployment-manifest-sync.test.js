/*
 * PR #288レビュー対応（Issue #273）。Issue #341 PR-Cレビュー対応・1回目でBooking Webhook
 * （3つ目の独立したGASプロジェクト）列を追加。
 *
 * gas/booking/README.md「GASプロジェクトへのデプロイ対象ファイル」表と
 * test/helpers/booking-deployment-manifest.js（BOOKING_ADMIN_FILES/BOOKING_WEB_APP_FILES/
 * BOOKING_WEBHOOK_FILES）は「同期させて運用する」という人手ルールのみで、実行系の
 * 回帰テスト（test/booking-admin-deployment.test.js等）はmanifest側しか読み込まないため、
 * 表側だけが更新漏れになっても（あるいはmanifest側だけが更新漏れになっても）テストは
 * 通ってしまっていた。今回のIssue #273の直接原因はまさにこの「表側の更新漏れ」だったため、
 * このファイルでREADME.mdの表を機械的にパースし、manifestと集合として一致することを検証する。
 *
 * `appsscript.json`は.gsファイルではなく、いずれのBOOKING_*_FILESも.gsファイル名のみを
 * 保持する設計のため、比較対象から明示的に除外する（NON_GS_FILES_EXCLUDED_FROM_COMPARISON
 * 参照。表側にappsscript.jsonの行自体は残る）。
 */
'use strict';

var test = require('node:test');
var assert = require('node:assert');
var fs = require('fs');
var path = require('path');
var manifest = require('./helpers/booking-deployment-manifest');

var README_PATH = path.join(__dirname, '..', 'gas', 'booking', 'README.md');

/* .gsファイルではないため、BOOKING_*_FILESとの比較対象から明示的に除外するファイル名
   （README.mdの表には行として残る）。 */
var NON_GS_FILES_EXCLUDED_FROM_COMPARISON = ['appsscript.json'];

/*
 * README.mdの「GASプロジェクトへのデプロイ対象ファイル」表を読み取り、
 * { webApp: string[], admin: string[], webhook: string[] }（✓が付いている.gsファイル名。
 * NON_GS_FILES_EXCLUDED_FROM_COMPARISONは除く）を返す。表の見出し・区切り行・データ行が
 * 想定どおりに見つからない場合は、テストを無言でスキップさせず即座に失敗させる。
 */
function parseDeploymentTable(readmeText) {
  var lines = readmeText.split('\n');
  var headerIndex = lines.findIndex(function (line) {
    return (
      line.indexOf('Booking Web App（スタンドアロン）') !== -1 &&
      line.indexOf('Booking Admin（コンテナバインド）') !== -1 &&
      line.indexOf('Booking Webhook（スタンドアロン）') !== -1
    );
  });
  assert.ok(
    headerIndex !== -1,
    'README.mdに「GASプロジェクトへのデプロイ対象ファイル」表の見出し行（Web App/Admin/Webhookの3列）が見つからない（表の書式が変わった場合はこのパーサーも追従させること）'
  );
  assert.ok(
    /^\|\s*-+\s*\|/.test(lines[headerIndex + 1] || ''),
    '表の見出し直後にMarkdownの区切り行（| --- | :---: | :---: | :---: |）が見つからない'
  );

  var webApp = [];
  var admin = [];
  var webhook = [];
  var rowCount = 0;

  for (var i = headerIndex + 2; i < lines.length; i++) {
    var line = lines[i];
    if (line.indexOf('|') !== 0) break; /* パイプで始まらない行＝表の終わり */
    var cells = line.split('|').slice(1, -1).map(function (cell) { return cell.trim(); });
    if (cells.length < 4) break;
    rowCount++;

    var fileMatch = cells[0].match(/`([^`]+)`/);
    assert.ok(fileMatch, '表の行の1列目からバッククォートで囲まれたファイル名を読み取れない: ' + line);
    var fileName = fileMatch[1];

    if (NON_GS_FILES_EXCLUDED_FROM_COMPARISON.indexOf(fileName) !== -1) continue;

    if (cells[1].indexOf('✓') !== -1) webApp.push(fileName);
    if (cells[2].indexOf('✓') !== -1) admin.push(fileName);
    if (cells[3].indexOf('✓') !== -1) webhook.push(fileName);
  }

  assert.ok(rowCount > 0, 'README.mdの配布対象ファイル表からデータ行を1件も読み取れなかった（表の位置・書式を確認すること）');
  return { webApp: webApp, admin: admin, webhook: webhook };
}

function sortedUnique(list) {
  return Array.from(new Set(list)).sort();
}

test('README.mdの配布対象ファイル表: Booking Admin列が✓の.gsファイル集合がBOOKING_ADMIN_FILESと一致する（appsscript.jsonを除く）', function () {
  var table = parseDeploymentTable(fs.readFileSync(README_PATH, 'utf8'));

  assert.deepStrictEqual(
    sortedUnique(table.admin),
    sortedUnique(manifest.BOOKING_ADMIN_FILES),
    'README.mdの表でBooking Admin列が✓の.gsファイル集合と、test/helpers/booking-deployment-manifest.jsの' +
      'BOOKING_ADMIN_FILESが一致しない。.gsファイルを追加・削除した場合は両方を更新すること。'
  );
});

test('README.mdの配布対象ファイル表: Booking Web App列が✓の.gsファイル集合がBOOKING_WEB_APP_FILESと一致する（appsscript.jsonを除く）', function () {
  var table = parseDeploymentTable(fs.readFileSync(README_PATH, 'utf8'));

  assert.deepStrictEqual(
    sortedUnique(table.webApp),
    sortedUnique(manifest.BOOKING_WEB_APP_FILES),
    'README.mdの表でBooking Web App列が✓の.gsファイル集合と、test/helpers/booking-deployment-manifest.jsの' +
      'BOOKING_WEB_APP_FILESが一致しない。.gsファイルを追加・削除した場合は両方を更新すること。'
  );
});

test('README.mdの配布対象ファイル表: Booking Webhook列が✓の.gsファイル集合がBOOKING_WEBHOOK_FILESと一致する（appsscript.jsonを除く）', function () {
  var table = parseDeploymentTable(fs.readFileSync(README_PATH, 'utf8'));

  assert.deepStrictEqual(
    sortedUnique(table.webhook),
    sortedUnique(manifest.BOOKING_WEBHOOK_FILES),
    'README.mdの表でBooking Webhook列が✓の.gsファイル集合と、test/helpers/booking-deployment-manifest.jsの' +
      'BOOKING_WEBHOOK_FILESが一致しない。.gsファイルを追加・削除した場合は両方を更新すること。'
  );
});

test('README.mdの配布対象ファイル表: Booking Webhook列にBooking Admin専用の管理者向けファイルが含まれない', function () {
  var table = parseDeploymentTable(fs.readFileSync(README_PATH, 'utf8'));
  var adminOnlyFiles = ['BookingAdmin.gs', 'BookingAdminWeb.gs', 'BookingTriggers.gs', 'BookingReminderTriggers.gs', 'BookingReminderDiagnostics.gs'];

  adminOnlyFiles.forEach(function (fileName) {
    assert.ok(
      table.webhook.indexOf(fileName) === -1,
      'Booking Webhook列に管理者専用ファイル' + fileName + 'が含まれている。Webhookの公開デプロイから管理者UIへ到達できてしまうため、含めてはならない。'
    );
  });
});

test('README.mdの配布対象ファイル表・manifestのいずれにも同一ファイル名の重複行が無い', function () {
  var table = parseDeploymentTable(fs.readFileSync(README_PATH, 'utf8'));

  [
    ['README.mdの表（Booking Web App列）', table.webApp],
    ['README.mdの表（Booking Admin列）', table.admin],
    ['README.mdの表（Booking Webhook列）', table.webhook],
    ['BOOKING_WEB_APP_FILES', manifest.BOOKING_WEB_APP_FILES],
    ['BOOKING_ADMIN_FILES', manifest.BOOKING_ADMIN_FILES],
    ['BOOKING_WEBHOOK_FILES', manifest.BOOKING_WEBHOOK_FILES]
  ].forEach(function (pair) {
    var label = pair[0];
    var list = pair[1];
    assert.deepStrictEqual(list.slice().sort(), sortedUnique(list), label + 'に重複したファイル名がある');
  });
});

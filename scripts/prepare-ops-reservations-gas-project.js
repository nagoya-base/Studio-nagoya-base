#!/usr/bin/env node
'use strict';

/*
 * 運営アプリ（予約確認・Issue #936）専用GASの配布物を組み立てる。
 *
 *   node scripts/prepare-ops-reservations-gas-project.js <output-directory>
 *
 * 組み立てるだけ（clasp push・デプロイは行わない）。生成物はコミットしない。
 * - gas/ops-reservations/ の .gs と appsscript.json をそのまま配布対象にする。
 * - OpsPage.html は手編集しない生成物。正本（_ops-app/frontend/）から毎回その場で生成して配布物へ入れる。
 *   （コミット済みの OpsPage.html が正本と一致するかは build-ops-gas-page.js --check が別に検査する）
 * - 既存の予約・決済・鍵（Access）・Survey のGASは1ファイルも持ち込まない。
 */
var fs = require('fs');
var path = require('path');
var buildPage = require('./build-ops-gas-page.js');

var ROOT = path.resolve(__dirname, '..');
var SRC = path.join(ROOT, 'gas', 'ops-reservations');

/* 配布するファイル。GASは同一グローバルで読み込むためファイル順は関係しない（関数宣言のみ）。 */
var COPIED = [
  'OpsApi.gs', 'OpsAuth.gs', 'OpsContract.gs', 'OpsKeyFinal.gs', 'OpsKeyFinalStore.gs', 'OpsKeyStatus.gs', 'OpsNormalizer.gs', 'OpsQuery.gs', 'OpsRevenue.gs', 'OpsRevenueRecords.gs', 'OpsRevenueStore.gs', 'OpsSource.gs', 'OpsTasks.gs', 'OpsTasksStore.gs', 'appsscript.json'
];
var GENERATED = ['OpsPage.html'];

function fileNames() { return COPIED.concat(GENERATED); }

function prepareProject(outputDirectory) {
  var output = path.resolve(outputDirectory);
  fs.rmSync(output, { recursive: true, force: true });
  fs.mkdirSync(output, { recursive: true });
  COPIED.forEach(function (name) {
    fs.copyFileSync(path.join(SRC, name), path.join(output, name));
  });
  fs.writeFileSync(path.join(output, 'OpsPage.html'), buildPage.build());
  return output;
}

if (require.main === module) {
  var out = process.argv[2];
  if (!out) {
    console.error('Usage: prepare-ops-reservations-gas-project.js <output-directory>');
    process.exit(1);
  }
  prepareProject(out);
  console.log('prepared ' + fileNames().length + ' files (no deploy performed)');
}

module.exports = { COPIED: COPIED, GENERATED: GENERATED, fileNames: fileNames, prepareProject: prepareProject };

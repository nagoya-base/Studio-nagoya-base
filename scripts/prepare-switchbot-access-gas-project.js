#!/usr/bin/env node
'use strict';

/*
 * 独立GAS（鍵管理基盤・Issue #754）の配布物を組み立てる。
 *
 *   node scripts/prepare-switchbot-access-gas-project.js <output-directory>
 *
 * 組み立てるだけ。デプロイ（clasp push）・トリガー作成・Webhook登録・機能ONは行わない
 * （マージ・生成物の作成をデプロイ許可と扱わない。実施判断・日時・版・結果は別証跡）。
 * 予約GAS（gas/booking）全体は持ち込まず、鍵連携に必要な AccessKeySnapshot.gs のみ共有する。
 * 生成物はコミットしない（.gas-deploy/ など.gitignore済みの場所を使う）。
 */
var fs = require('fs');
var path = require('path');

var ROOT = path.resolve(__dirname, '..');

/* 出力名 → 元ファイル。GASは同一グローバルで読み込むため、依存順（先に使われる側）に並べる。 */
var FILES = [
  ['SwitchBotAccessCore.gs', 'gas/switchbot-access/SwitchBotAccessCore.gs'],
  ['AccessKeySnapshot.gs', 'gas/booking/shared/AccessKeySnapshot.gs'],
  ['AccessLedgerReader.gs', 'gas/switchbot-access/AccessLedgerReader.gs'],
  ['SwitchBotAccessInfra.gs', 'gas/switchbot-access/SwitchBotAccessInfra.gs'],
  ['SwitchBotAccessApp.gs', 'gas/switchbot-access/SwitchBotAccessApp.gs'],
  ['appsscript.json', 'gas/switchbot-access/appsscript.json']
];

function fileNames() { return FILES.map(function (e) { return e[0]; }); }

function prepareProject(outputDirectory) {
  var output = path.resolve(outputDirectory);
  fs.rmSync(output, { recursive: true, force: true });
  fs.mkdirSync(output, { recursive: true });
  FILES.forEach(function (entry) {
    fs.copyFileSync(path.join(ROOT, entry[1]), path.join(output, entry[0]));
  });
  return output;
}

if (require.main === module) {
  var out = process.argv[2];
  if (!out) {
    console.error('Usage: prepare-switchbot-access-gas-project.js <output-directory>');
    process.exit(1);
  }
  prepareProject(out);
  console.log('prepared ' + fileNames().length + ' files (no deploy performed)');
}

module.exports = { FILES: FILES, fileNames: fileNames, prepareProject: prepareProject };

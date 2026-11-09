#!/usr/bin/env node
'use strict';

/*
 * 利用後アンケートGASプロジェクト（Issue #835）の配布物を組み立てる。
 *
 *   node scripts/prepare-feedback-gas-project.js <output-directory>
 *
 * ブラウザと共有する scripts/feedback-core.js を FeedbackCore.gs としてコピーし、gas/feedback/ の
 * ファイルと合わせて出力する。生成物はコミットしない（.gas-deploy/ など .gitignore 済みの場所へ出す）。
 * 既存 /survey/ の配布物（prepare-survey-gas-project.js）とはファイルを共有しない。
 */
var fs = require('fs');
var path = require('path');

var ROOT = path.resolve(__dirname, '..');

/* 出力名 → 元ファイル。vmへ読み込む順（依存順）でもある。 */
var FILES = [
  ['FeedbackCore.gs', 'scripts/feedback-core.js'],
  /* Issue #834: 予約単位の回答リンクの署名・検証（Booking Admin と同じファイルを配る）。 */
  ['FeedbackTokenCore.gs', 'scripts/feedback-token-core.js'],
  ['FeedbackTokens.gs', 'gas/feedback/FeedbackTokens.gs'],
  ['FeedbackRepository.gs', 'gas/feedback/FeedbackRepository.gs'],
  ['FeedbackWebApp.gs', 'gas/feedback/FeedbackWebApp.gs'],
  ['appsscript.json', 'gas/feedback/appsscript.json']
];

function fileNames() { return FILES.map(function (entry) { return entry[0]; }); }

function prepareProject(outputDirectory) {
  var output = path.resolve(outputDirectory);
  fs.rmSync(output, { recursive: true, force: true });
  fs.mkdirSync(output, { recursive: true });
  FILES.forEach(function (entry) {
    fs.copyFileSync(path.join(ROOT, entry[1]), path.join(output, entry[0]));
  });
  return fileNames().sort();
}

if (require.main === module) {
  if (process.argv.length !== 3) {
    process.stderr.write('Usage: node scripts/prepare-feedback-gas-project.js <output-directory>\n');
    process.exit(1);
  }
  process.stdout.write(prepareProject(process.argv[2]).join('\n') + '\n');
}

module.exports = { prepareProject: prepareProject, fileNames: fileNames, FILES: FILES };

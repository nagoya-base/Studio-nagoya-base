#!/usr/bin/env node
'use strict';

/*
 * 利用後アンケート管理画面GASプロジェクト（Issue #849）の配布物を組み立てる。
 *
 *   node scripts/prepare-feedback-admin-gas-project.js <output-directory>
 *
 * 公開Web App（prepare-feedback-gas-project.js）とは別プロジェクト。回答受付（doPost）・通知は含めず、
 * 同じ回答Spreadsheetを読む FeedbackRepository.gs と、ブラウザと共有するコア・集計を一緒に配る。
 * 生成物はコミットしない（.gas-deploy/ など .gitignore 済みの場所へ出す）。
 */
var fs = require('fs');
var path = require('path');

var ROOT = path.resolve(__dirname, '..');

/* 出力名 → 元ファイル。vmへ読み込む順（依存順）でもある。 */
var FILES = [
  ['FeedbackCore.gs', 'scripts/feedback-core.js'],
  ['FeedbackAnalytics.gs', 'scripts/feedback-analytics.js'],
  ['FeedbackRepository.gs', 'gas/feedback/FeedbackRepository.gs'],
  ['FeedbackAdmin.gs', 'gas/feedback-admin/FeedbackAdmin.gs'],
  ['FeedbackMaintenance.gs', 'gas/feedback-admin/FeedbackMaintenance.gs'],
  ['FeedbackAdminPage.html', 'gas/feedback-admin/FeedbackAdminPage.html'],
  ['appsscript.json', 'gas/feedback-admin/appsscript.json']
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
    process.stderr.write('Usage: node scripts/prepare-feedback-admin-gas-project.js <output-directory>\n');
    process.exit(1);
  }
  process.stdout.write(prepareProject(process.argv[2]).join('\n') + '\n');
}

module.exports = { prepareProject: prepareProject, fileNames: fileNames, FILES: FILES };

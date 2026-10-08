#!/usr/bin/env node
'use strict';

/*
 * アンケートGASプロジェクト（Issue #374）の配布物を組み立てる。
 *
 *   node scripts/prepare-survey-gas-project.js <public|admin> <output-directory>
 *
 * 設問定義の正本は survey/survey-schema.json の1ファイルだけ。ここで SurveySchema.gs
 * （`var SURVEY_SCHEMA = {...};`）を生成し、ブラウザと共有する scripts/survey-core.js /
 * scripts/survey-analytics.js を SurveyCore.gs / SurveyAnalytics.gs としてコピーする。
 * 生成物はコミットしない（出力先は .gas-deploy/ など.gitignore済みの場所を使う）。
 */
var fs = require('fs');
var path = require('path');

var ROOT = path.resolve(__dirname, '..');

/* GASへ配布するファイル（出力名 → 元ファイル）。vmへ読み込む順（依存順）でもある。 */
var TARGETS = {
  public: [
    ['SurveyCore.gs', 'scripts/survey-core.js'],
    ['SurveySchema.gs', null],
    ['SurveyRepository.gs', 'gas/survey/shared/SurveyRepository.gs'],
    ['SurveyWebApp.gs', 'gas/survey/public/SurveyWebApp.gs'],
    ['appsscript.json', 'gas/survey/public/appsscript.json']
  ],
  admin: [
    ['SurveyCore.gs', 'scripts/survey-core.js'],
    ['SurveyAnalytics.gs', 'scripts/survey-analytics.js'],
    ['SurveySchema.gs', null],
    ['SurveyRepository.gs', 'gas/survey/shared/SurveyRepository.gs'],
    ['SurveyAdmin.gs', 'gas/survey/admin/SurveyAdmin.gs'],
    ['SurveyAdminPage.html', 'gas/survey/admin/SurveyAdminPage.html'],
    ['appsscript.json', 'gas/survey/admin/appsscript.json']
  ]
};

function loadSchemaText() {
  var text = fs.readFileSync(path.join(ROOT, 'survey', 'survey-schema.json'), 'utf8');
  JSON.parse(text); /* 壊れたJSONを配布しない */
  return text;
}

function buildSchemaGs() {
  return "'use strict';\n/* 自動生成: survey/survey-schema.json から scripts/prepare-survey-gas-project.js が出力。手で編集しない。 */\n" +
    'var SURVEY_SCHEMA = ' + JSON.stringify(JSON.parse(loadSchemaText())) + ';\n';
}

function fileNames(target) {
  if (!TARGETS[target]) throw new Error('Usage: prepare-survey-gas-project.js <public|admin> <output-directory>');
  return TARGETS[target].map(function (entry) { return entry[0]; });
}

function prepareProject(target, outputDirectory) {
  fileNames(target);
  var output = path.resolve(outputDirectory);
  fs.rmSync(output, { recursive: true, force: true });
  fs.mkdirSync(output, { recursive: true });
  TARGETS[target].forEach(function (entry) {
    var destination = path.join(output, entry[0]);
    if (entry[1] === null) fs.writeFileSync(destination, buildSchemaGs());
    else fs.copyFileSync(path.join(ROOT, entry[1]), destination);
  });
  return fileNames(target).sort();
}

if (require.main === module) {
  if (process.argv.length !== 4) {
    process.stderr.write('Usage: node scripts/prepare-survey-gas-project.js <public|admin> <output-directory>\n');
    process.exit(1);
  }
  process.stdout.write(prepareProject(process.argv[2], process.argv[3]).join('\n') + '\n');
}

module.exports = { prepareProject: prepareProject, fileNames: fileNames, buildSchemaGs: buildSchemaGs, TARGETS: TARGETS };

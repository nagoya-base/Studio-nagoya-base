/*
 * scripts/ 配下のDOM非依存フロントJS（booking-logic.js等）をvmで実行し、生成された
 * オブジェクトをそのままテストするためのヘルパー。test/helpers/gas-sandbox.jsと同じ方針
 * （ロジックを別途Node用に書き写すのではなく、実際にブラウザへ配信するファイルそのものを
 * 実行する）。
 */
'use strict';

var fs = require('fs');
var path = require('path');
var vm = require('vm');

var SCRIPTS_DIR = path.join(__dirname, '..', '..', 'scripts');

/*
 * files: 読み込む.jsファイル名の配列（この順にvm実行される。依存順に並べること）
 * globals: サンドボックスへ事前に注入するグローバル（window等のスタブ。省略可）
 */
function loadFrontendSandbox(files, globals) {
  var sandbox = {};
  Object.keys(globals || {}).forEach(function (key) {
    sandbox[key] = globals[key];
  });
  vm.createContext(sandbox);
  files.forEach(function (file) {
    var filePath = path.join(SCRIPTS_DIR, file);
    vm.runInContext(fs.readFileSync(filePath, 'utf8'), sandbox, { filename: filePath });
  });
  return sandbox;
}

module.exports = { loadFrontendSandbox: loadFrontendSandbox, SCRIPTS_DIR: SCRIPTS_DIR };

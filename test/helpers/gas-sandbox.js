/*
 * gas/booking/ の .gs ファイルをvmで実行し、生成された関数をそのままテストする
 * ためのヘルパー。ロジックを別途Node用に書き写すのではなく、実際にGASへ貼り付ける
 * ファイルそのものを実行することで、テストは通るがGAS実行時にReferenceError等で
 * 壊れるという事故を防ぐ（ataru-nagoyaのtest/helpers/extract-gs-object.js等と同じ方針）。
 */
'use strict';

var fs = require('fs');
var path = require('path');
var vm = require('vm');

var BOOKING_DIR = path.join(__dirname, '..', '..', 'gas', 'booking');

/* gas/booking/ 配下は shared/（Booking Web App・Booking Admin共通）・public/
   （Booking Web App固有）・admin/（Booking Admin固有）へ役割ごとに分かれている
   （GASプロジェクト自体はファイルをフラットに配置するため、テストからは
   ファイル名だけで参照し、どのサブディレクトリにあるかはここで解決する）。 */
var BOOKING_SUBDIRS = ['shared', 'public', 'admin'];

function resolveBookingFilePath(file) {
  for (var i = 0; i < BOOKING_SUBDIRS.length; i++) {
    var candidate = path.join(BOOKING_DIR, BOOKING_SUBDIRS[i], file);
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error('gas/booking/{shared,public,admin}のいずれにも見つからないファイル: ' + file);
}

/*
 * files: 読み込む.gsファイル名の配列（この順にvm実行される。依存順に並べること）
 * globals: サンドボックスへ事前に注入するグローバル（CalendarApp等のスタブ）
 */
function loadBookingSandbox(files, globals) {
  var sandbox = {};
  Object.keys(globals || {}).forEach(function (key) {
    sandbox[key] = globals[key];
  });
  vm.createContext(sandbox);
  files.forEach(function (file) {
    var filePath = resolveBookingFilePath(file);
    vm.runInContext(fs.readFileSync(filePath, 'utf8'), sandbox, { filename: filePath });
  });
  return sandbox;
}

module.exports = { loadBookingSandbox: loadBookingSandbox, BOOKING_DIR: BOOKING_DIR };

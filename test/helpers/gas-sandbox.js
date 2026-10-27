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

/* gas/booking/ 配下は shared/（複数プロジェクト共通）・public/（Booking Web App固有）・
   admin/（Booking Admin固有）・webhook/（Booking Webhook固有。Issue #341 PR-C
   レビュー対応・1回目で追加。管理者UIとは別の独立したプロジェクト）へ役割ごとに
   分かれている（GASプロジェクト自体はファイルをフラットに配置するため、テストからは
   ファイル名だけで参照し、どのサブディレクトリにあるかはここで解決する）。 */
var BOOKING_SUBDIRS = ['shared', 'public', 'admin', 'webhook'];

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
  /* Issue #480: 予約可能期間の正本（BookingWindow.gs）はAvailability.gsから呼ばれる。個別に読み込むテストが
     全て追記しなくて済むよう、Availability.gsを読む場合は先に読み込む（配布対象の網羅は
     booking-deployment-manifest-sync / booking-admin-deploymentテストが検証する）。 */
  if (files.indexOf('Availability.gs') !== -1 && files.indexOf('BookingWindow.gs') === -1) {
    files = ['BookingWindow.gs'].concat(files);
  }
  /* Issue #559: 料金世代の判定（BookingGenerationMode.gs）はBookingPricing.gsに依存する層で、BookingRepository.gs・Code.gsから呼ばれる。
     BookingPricing.gsを読むテストが全て追記しなくて済むよう、その直後に読み込む（配布対象の網羅はmanifest-sync / deploymentテストが検証する）。 */
  if (files.indexOf('BookingPricing.gs') !== -1 && files.indexOf('BookingGenerationMode.gs') === -1) {
    var pricingIndex = files.indexOf('BookingPricing.gs');
    files = files.slice(0, pricingIndex + 1).concat(['BookingGenerationMode.gs'], files.slice(pricingIndex + 1));
  }
  files.forEach(function (file) {
    var filePath = resolveBookingFilePath(file);
    vm.runInContext(fs.readFileSync(filePath, 'utf8'), sandbox, { filename: filePath });
  });
  return sandbox;
}

module.exports = { loadBookingSandbox: loadBookingSandbox, BOOKING_DIR: BOOKING_DIR };

#!/usr/bin/env node
'use strict';

/*
 * Studio X機材カタログの同期（Issue #423 追加要件）。
 *
 * _data/studio_x_equipment.json（機材ページとGASの唯一の正本）から
 * gas/booking/shared/EquipmentCatalog.gs を生成する。GASはJekyllの_dataを読めないため、
 * 生成物をリポジトリに置き、test/studio-x-equipment-catalog.test.jsが再生成結果との一致を
 * 検査する（片方だけ編集して料金が食い違う二重管理を防ぐ）。
 *
 *   node scripts/sync-studio-x-equipment.js          # 生成して書き込む
 *   node scripts/sync-studio-x-equipment.js --check  # 差分があれば終了コード1
 */
var fs = require('fs');
var path = require('path');

var ROOT = path.join(__dirname, '..');
var SOURCE = path.join(ROOT, '_data', 'studio_x_equipment.json');
var TARGET = path.join(ROOT, 'gas', 'booking', 'shared', 'EquipmentCatalog.gs');

function render() {
  var data = JSON.parse(fs.readFileSync(SOURCE, 'utf8'));
  var catalog = { rental: data.rental, freeSelf: data.freeSelf };
  return [
    '/*',
    ' * EquipmentCatalog.gs — Studio Xの有料レンタル機材・無料セルフ機材の料金/数量/在庫（Issue #423）。',
    ' *',
    ' * ★自動生成ファイル。直接編集しない。正本は _data/studio_x_equipment.json。',
    ' *   編集後は `node scripts/sync-studio-x-equipment.js` で再生成する（機材ページ',
    ' *   studio-x/equipment/ は同じJSONを直接読むため、料金が食い違わない）。',
    ' */',
    "'use strict';",
    '',
    'var StudioXEquipmentCatalog = ' + JSON.stringify(catalog, null, 2) + ';',
    ''
  ].join('\n');
}

if (require.main === module) {
  var next = render();
  if (process.argv.indexOf('--check') !== -1) {
    var current = fs.existsSync(TARGET) ? fs.readFileSync(TARGET, 'utf8') : '';
    if (current !== next) {
      console.error('EquipmentCatalog.gs が _data/studio_x_equipment.json と同期していません。scripts/sync-studio-x-equipment.js を実行してください。');
      process.exit(1);
    }
  } else {
    fs.writeFileSync(TARGET, next);
  }
}

module.exports = { render: render, SOURCE: SOURCE, TARGET: TARGET };

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

function read(rel) { return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8'); }
function textOf(html) { return html.replace(/<script[\s\S]*?<\/script>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' '); }

var top = read('studio-x/index.html');
var specs = /<section class="specs[\s\S]*?<\/section>/.exec(top)[0];
var equipment = textOf(read('studio-x/equipment/index.html') + read('_includes/equipment_catalog_ja.html') + read('_includes/equipment_beginner_ja.html') + read('_data/studio_x_worlds.yml') + read('_data/studio_x_equipment.json'));

test('#626 トップ #specs は代表設備6項目だけで、型番・台数・料金を持たない', function () {
  var labels = (specs.match(/<dt>([A-Z ]+)<\/dt>/g) || []).map(function (d) { return d.replace(/<\/?dt>/g, ''); });
  assert.deepStrictEqual(labels, ['BACKGROUND', 'LIGHTING', 'PROPS', 'CHECK', 'CHANGE', 'BRING IN']);
  assert.ok(!/円|×\d|Godox|COB|ソフトボックス|コマンダー/.test(textOf(specs)), '詳細仕様・料金はトップに置かない');
});

test('#626 #specs から「設備・機材の詳細を見る」でequipmentへ誘導し、GA4属性を維持', function () {
  var cta = /<a[^>]*href="equipment\/"[^>]*>[^<]*<\/a>/.exec(specs)[0];
  assert.ok(cta.indexOf('設備・機材の詳細を見る') !== -1);
  ['data-analytics-event="cta_click"', 'data-analytics-location="home_equipment"', 'data-analytics-type="equipment_page"', 'data-analytics-destination="studio_x_equipment_page"'].forEach(function (a) {
    assert.ok(cta.indexOf(a) !== -1, a);
  });
});

test('#626 トップの代表設備はすべて /studio-x/equipment/ 側（正本）で確認できる', function () {
  ['背景紙 ホワイト', '背景紙 ブラック', 'バイカラーパネルライト', 'レフ板 5-in-1', '天井フルカラーLED', '大型全身ミラー', 'ユニットバス', '木組みフレームのカーテン内', '学校机・椅子・教卓・黒板', '持ち込めます'].forEach(function (w) {
    assert.ok(equipment.indexOf(w) !== -1, '正本に無い: ' + w);
  });
});

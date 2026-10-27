/*
 * 日付クリック後もカレンダーを残し、その直下に開始時刻を表示するUX（Step1内エリア）の
 * HTML/CSS構造テスト。挙動（loading→一覧・古い応答の破棄等）はbooking-calendar-ui.test.jsで検証する。
 */
'use strict';

var test = require('node:test');
var assert = require('node:assert');
var fs = require('fs');
var path = require('path');

function read(rel) { return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8'); }

[['ja', '_includes/booking_app_ja.html', '予約できる時間を検索しています…', '利用時間と日付を指定すると、予約可能な開始時刻が表示されます。', '1. メール・日時を選択'],
 ['en', '_includes/booking_app_en.html', 'Searching available start times…', 'Select a duration and date to see available start times.', '1. Email &amp; Date']].forEach(function (c) {
  var html = read(c[1]);
  test(c[0] + ': Step1は「メールアドレス→希望時間帯→利用時間→利用区分→カレンダー→開始時刻→会員区分→料金→次へ」の順で、独立したStep2セクションは存在しない（Issue #532: メールはStep1の先頭で1回だけ入力）', function () {
    assert.ok(html.indexOf('id="ba-step-start-time"') === -1, '旧Step2セクションは無い');
    assert.ok(html.indexOf('id="ba-step-start-time-back"') === -1, '戻るボタンは不要');
    var step1End = html.indexOf('id="ba-step-details"');
    var step1Close = html.lastIndexOf('</section>', step1End);
    /* メールアドレス（Issue #532）はStep1の先頭にあり、Step2（利用者情報）には無い（再入力させない）。 */
    var emailPos = html.indexOf('id="ba-email"');
    assert.ok(emailPos > html.indexOf('id="ba-step-datetime"') && emailPos < html.indexOf('id="ba-time-band-choices"'), 'メールはStep1の先頭');
    assert.strictEqual(html.split('id="ba-email"').length - 1, 1, 'メール入力欄は1つだけ');
    assert.ok(html.slice(html.indexOf('id="ba-step-details"'), html.indexOf('id="ba-step-confirm"')).indexOf('type="email"') === -1, 'Step2にメール入力欄は無い');
    var order = ['id="ba-time-band-choices"', 'id="ba-duration"', 'id="ba-customer-type-choices"', 'id="ba-calendar-selected"',
      'id="ba-start-time-hint"', 'id="ba-start-time-area"', 'id="ba-member-field"', 'id="ba-price-box"', 'id="ba-step-start-time-next"']
      .map(function (key) { var i = html.indexOf(key); assert.ok(i !== -1, key); return i; });
    order.forEach(function (pos, n) { if (n) assert.ok(order[n - 1] < pos, 'DOM順: ' + n); });
    assert.ok(html.indexOf('id="ba-step-datetime"') < order[0] && order[order.length - 1] < step1Close, 'すべてStep1内');
    var area = order[5];
    var areaClose = html.indexOf('<fieldset', area);
    assert.ok(html.slice(area, areaClose).indexOf('ba-field') === -1, 'エリア内に入力欄は無い');
    assert.ok(html.slice(area, areaClose).indexOf('ba-step-start-time-next') === -1, '次へボタンはエリア外（料金の後ろ）');
    assert.ok(html.indexOf('ba-start-time-price-line') === -1 && html.indexOf('ba-start-time-price-note') === -1, '開始時刻側の料金DOMは無い');
    assert.strictEqual(html.split('id="ba-price-line"').length - 1, 1, '料金表示は1か所');
    assert.strictEqual(html.split('id="ba-price-note"').length - 1, 1, '料金注記も1か所');
    ['ba-start-time-loading', 'ba-start-time-grid', 'ba-start-time-empty', 'ba-start-time-error']
      .forEach(function (id) { var i = html.indexOf('id="' + id + '"'); assert.ok(i > area && i < areaClose, id); });
    assert.ok(html.indexOf(c[2]) !== -1, '検索中文言');
    var hint = html.slice(order[4], html.indexOf('</p>', order[4]));
    assert.ok(hint.indexOf(c[3]) !== -1 && hint.indexOf('hidden') === -1, '事前案内は初期表示で見える');
  });

  test(c[0] + ': 会員区分は「一般/会員」のラジオ（初期未選択）で、旧checkboxは無い。進捗は4段階でstart-timeを持たない', function () {
    var member = html.slice(html.indexOf('id="ba-member-field"'), html.indexOf('id="ba-price-box"'));
    assert.ok(/name="memberStatus" value="general"/.test(member) && /name="memberStatus" value="member"/.test(member));
    assert.ok(member.indexOf('checked') === -1, '初期は未選択');
    var step1 = html.slice(html.indexOf('id="ba-step-datetime"'), html.indexOf('id="ba-step-details"'))
      /* Issue #478: 会員限定の特典（2名ペアパック・シャワー）のcheckboxは旧「会員」自己申告checkboxとは別物。 */
      .replace(/<fieldset class="ba-fieldset" id="ba-benefits-field"[\s\S]*?<\/fieldset>/, '')
      /* Issue #546: 会員向け特典・先行予約のUI解除checkboxも会員自己申告checkboxとは別物（資格の正本にしない）。 */
      .replace(/<fieldset class="ba-fieldset" id="ba-member-unlock-field"[\s\S]*?<\/fieldset>/, '')
      /* Issue #488: イベント開催日限定プラン（Studio X）のcheckboxも会員自己申告checkboxとは別物。 */
      .replace(/<fieldset class="ba-fieldset" id="ba-event-plan-field"[\s\S]*?<\/fieldset>/, '');
    assert.ok(html.indexOf('id="ba-is-member"') === -1 && step1.indexOf('type="checkbox"') === -1, 'Step1に会員checkboxは無い');
    var progress = html.slice(html.indexOf('id="ba-progress"'), html.indexOf('</ol>'));
    assert.deepStrictEqual(progress.match(/data-step="[a-z-]+"/g), ['data-step="datetime"', 'data-step="details"', 'data-step="confirm"', 'data-step="complete"']);
    assert.ok(progress.indexOf(c[4]) !== -1, '最初の項目名');
  });
});

test('375px幅: 開始時刻グリッドは折り返し（auto-fill）で、横スクロールを生む固定幅を持たない', function () {
  var css = read('styles/booking.css');
  assert.ok(/\.ba-time-grid \{ grid-template-columns: repeat\(auto-fill, minmax\(76px, 1fr\)\); \}/.test(css));
  assert.ok(/\.ba-start-time-area \{[^}]*min-width: 0;/.test(css));
});

test('JS: 開始時刻側の料金DOM参照が無く、scrollは日付クリック経由の画面外判定に限定される', function () {
  var js = read('scripts/booking-app.js');
  assert.ok(js.indexOf('startTimePrice') === -1 && js.indexOf('ba-start-time-price') === -1);
  var calls = js.match(/\.scrollIntoView\(\{[^)]*\}\)/g) || [];
  assert.strictEqual(calls.length, 4, 'scrollIntoViewはgoToStep（start-time以外）・reveal（日付クリック時）・メール欄へのfocus（Issue #532）・会員確認欄への誘導（Issue #548）のみ');
  assert.ok(/scrollToStartTime: true/.test(js));
  var goTo = js.slice(js.indexOf('function goToStep'), js.indexOf('function setStepDisabled_'));
  assert.ok(goTo.indexOf('startTimeArea.scrollIntoView') === -1 && /stepName !== 'start-time'/.test(goTo), 'goToStepはstart-timeでスクロールしない');
});

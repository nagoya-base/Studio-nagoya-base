/*
 * 予約フォームHTML（_includes/booking_app_ja.html / booking_app_en.html）の
 * カレンダー初期状態（PR #365の追加修正）のテスト。
 * booking-app.js・空き状況APIの応答を待たず、HTMLだけでカレンダー骨格が見えることを検証する。
 */
'use strict';

var test = require('node:test');
var assert = require('node:assert');
var fs = require('node:fs');
var path = require('node:path');
var vm = require('node:vm');

function readInclude(locale) {
  return fs.readFileSync(path.join(__dirname, '..', '_includes', 'booking_app_' + locale + '.html'), 'utf8');
}

function tagOf(html, id) {
  var m = html.match(new RegExp('<[a-z]+[^>]*\\bid="' + id + '"[^>]*>'));
  assert.ok(m, id + 'が存在する');
  return m[0];
}

function createEl(tag) {
  var attrs = {};
  var el = {
    tagName: tag, children: [], disabled: false, textContent: '', className: '', type: '',
    appendChild: function (c) { el.children.push(c); },
    setAttribute: function (k, v) { attrs[k] = v; },
    getAttribute: function (k) { return Object.prototype.hasOwnProperty.call(attrs, k) ? attrs[k] : null; }
  };
  return el;
}

function runInlineSkeleton(html) {
  var m = html.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(m, '初期骨格のインラインscriptがある');
  var body = createEl('tbody');
  var label = createEl('span');
  var doc = {
    getElementById: function (id) {
      if (id === 'ba-calendar-grid-body') return body;
      if (id === 'ba-calendar-month-label') return label;
      return null;
    },
    createElement: createEl
  };
  vm.runInNewContext(m[1], { document: doc, Intl: Intl, Date: Date, parseInt: parseInt, String: String });
  return { body: body, label: label };
}

['ja', 'en'].forEach(function (locale) {
  test('[' + locale + '] 初期HTMLでカレンダー本体・読み込み表示は非表示ではなく、案内文は隠れている', function () {
    var html = readInclude(locale);
    assert.doesNotMatch(tagOf(html, 'ba-calendar-body'), /\bhidden\b/, 'カレンダー本体は初期から表示');
    assert.doesNotMatch(tagOf(html, 'ba-calendar-loading'), /\bhidden\b/, '確認中表示は初期から見える');
    assert.match(tagOf(html, 'ba-calendar-hint'), /\bhidden\b/, '未確定時の案内文は初期は隠す');
    assert.match(tagOf(html, 'ba-calendar-error'), /\bhidden\b/, 'エラーは初期は隠す');
  });

  test('[' + locale + '] 同期の初期骨格スクリプトが月表示と日付グリッド（全てdisabled・記号なし）を描画する', function () {
    var r = runInlineSkeleton(readInclude(locale));
    assert.ok(r.label.textContent.length > 0, '月表示がある');
    assert.ok(/\d{4}/.test(r.label.textContent));
    var buttons = [];
    r.body.children.forEach(function (tr) {
      assert.strictEqual(tr.children.length, 7, '1行は7列');
      tr.children.forEach(function (td) { td.children.forEach(function (b) { buttons.push(b); }); });
    });
    assert.ok(r.body.children.length >= 4 && r.body.children.length <= 6);
    assert.ok(buttons.length >= 28 && buttons.length <= 31);
    buttons.forEach(function (b) {
      assert.strictEqual(b.disabled, true, 'API応答前の日付は全てdisabled');
      assert.match(b.textContent, /^\d+$/, '◎○△×を表示しない');
      assert.match(b.className, /ba-cal-day--pending/);
    });
  });

  test('[' + locale + '] Step1の「予約できる時間を表示」ボタンは日付選択で自動遷移するため非表示（フォールバックとして要素は残す）', function () {
    var html = readInclude(locale);
    var m = html.match(/<div class="ba-actions"([^>]*)>\s*<button[^>]*id="ba-step-datetime-next"/);
    assert.ok(m, 'Step1ボタンがba-actions内に残っている');
    assert.match(m[1], /\bhidden\b/, '通常操作では見えない');
  });

  test('[' + locale + '] 骨格scriptは曜日ヘッダ・グリッド・確認中表示の後ろ（同じカレンダー内）に置かれる', function () {
    var html = readInclude(locale);
    assert.ok(html.indexOf('id="ba-calendar-grid-body"') < html.indexOf('<script>'));
    assert.ok(html.indexOf('id="ba-calendar-loading"') < html.indexOf('<script>'));
  });
});

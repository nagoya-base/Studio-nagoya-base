/*
 * 管理画面のスクリプト（gas/feedback-admin/FeedbackAdminPage.html。Issue #849）を最小DOMで実行し、
 * google.script.run を実際の管理者GAS関数（同じSpreadsheet）へつないで、画面操作の結果を検証する。
 * - 保存成功後は現在のフィルタのままダッシュボードを再取得し、カード・概要の件数・絞り込みがそろう
 * - 保存失敗時は編集内容を保持し、もう一度「保存」で再試行できる
 * - 古いフィルタ要求の応答は表示に反映しない
 * 見た目（スマホ幅・横スクロールなし）は実ブラウザ（Playwright）で別途確認している（PR本文参照）。
 */
'use strict';

var test = require('node:test');
var assert = require('node:assert');
var fs = require('fs');
var path = require('path');
var vm = require('vm');
var env = require('./helpers/feedback-env');
var dom = require('./helpers/fake-dom');

var OWNER = 'owner@example.com';
var NOW = new Date();
var HTML = fs.readFileSync(path.join(__dirname, '..', 'gas/feedback-admin/FeedbackAdminPage.html'), 'utf8');
var SCRIPT = /<script>([\s\S]*)<\/script>/.exec(HTML)[1];

function elementsFromHtml() {
  return {
    'f-brand': { tag: 'select', options: ['all'] },
    'f-period': { tag: 'select', options: ['30', '90', 'all'] },
    'f-test': { tag: 'input' },
    'tab-summary': { tag: 'button' }, 'tab-issues': { tag: 'button' }, 'tab-cards': { tag: 'button' },
    'panel-summary': { tag: 'section' }, 'panel-issues': { tag: 'section', hidden: true }, 'panel-cards': { tag: 'section', hidden: true },
    error: { tag: 'p' }, notice: { tag: 'p' }, 'test-note': { tag: 'p', hidden: true },
    'f-status': { tag: 'select', options: ['all'] },
    'f-problem': { tag: 'select', options: ['all', 'yes', 'no'] },
    cards: { tag: 'div' }
  };
}

function setup() {
  var spreadsheets = env.createSpreadsheets();
  var pub = env.loadFeedbackProject({ spreadsheets: spreadsheets });
  pub.run('setupFeedbackSpreadsheet()');
  pub.sandbox.__mock = { verify: function () { return { ok: true }; }, consume: function () { return { ok: true }; }, release: function () {} };
  pub.run('FeedbackTokens = __mock');
  var admin = env.loadFeedbackProject({ target: 'admin', spreadsheets: spreadsheets, activeEmail: OWNER, properties: { FEEDBACK_ADMIN_EMAILS: OWNER } });
  function submit(brand, answers) {
    var r = pub.call('submit', { brand: brand, token: 'tok_ABCDEFGHIJKLMNOP1234', answers: Object.assign({ q1: 4, q6: 'definitely' }, answers) }, NOW);
    assert.strictEqual(r.success, true);
  }

  /* google.script.run の代わり。呼び出しは非同期（queue）にし、flush() で順に処理する。 */
  var queue = [];
  var networkDown = false;
  function runner() {
    var ok = function () {};
    var ng = function () {};
    var api = {
      withSuccessHandler: function (fn) { ok = fn; return api; },
      withFailureHandler: function (fn) { ng = fn; return api; }
    };
    ['getFeedbackDashboard', 'updateFeedbackStatus'].forEach(function (name) {
      api[name] = function (arg) {
        queue.push(function () {
          if (networkDown) { ng(new Error('network')); return; }
          admin.sandbox.__arg = JSON.parse(JSON.stringify(arg));
          ok(JSON.parse(JSON.stringify(admin.run(name + '(__arg)'))));
        });
      };
    });
    return api;
  }
  var document = dom.createDocument(elementsFromHtml());
  var context = { document: document, google: { script: { get run() { return runner(); } } } };
  vm.createContext(context);
  return {
    pub: pub, admin: admin, submit: submit, document: document, queue: queue,
    start: function () { vm.runInContext(SCRIPT, context); },
    flush: function () { while (queue.length) queue.shift()(); },
    setNetworkDown: function (v) { networkDown = v; },
    $: function (id) { return document.byId[id]; },
    cards: function () { return document.byId.cards.findAll(function (n) { return n.tagName === 'article'; }); },
    tile: function (label) {
      var tiles = document.byId['panel-summary'].findAll(function (n) { return n.hasClass && n.hasClass('tile'); });
      var t = tiles.filter(function (n) { return n.textContent.indexOf(label) !== -1; })[0];
      return t ? Number(t.childNodes[0].textContent) : null;
    },
    change: function (id, value) { var el = document.byId[id]; if (id === 'f-test') el.checked = value; else el.value = value; el.dispatch('change'); }
  };
}

function cardParts(card) {
  return {
    select: card.findAll(function (n) { return n.tagName === 'select'; })[0],
    memo: card.findAll(function (n) { return n.tagName === 'textarea'; })[0],
    save: card.findAll(function (n) { return n.hasClass('save'); })[0],
    state: card.findAll(function (n) { return n.hasClass('state'); })[0],
    badge: card.findAll(function (n) { return n.hasClass('badge'); })[0]
  };
}

test('画面: 初回表示で概要・カードを描画し、ブランドと対応状況の選択肢を読み込む', function () {
  var p = setup();
  p.submit('snb', { q5: ['damage'] });
  p.submit('mens', { comment: '感想' });
  p.submit('studio-x', {});
  p.start();
  p.flush();
  assert.strictEqual(p.tile('回答数'), 3);
  assert.strictEqual(p.tile('未対応'), 2);
  assert.strictEqual(p.cards().length, 3);
  assert.deepStrictEqual(p.$('f-brand').childNodes.map(function (o) { return o.value; }), ['all', 'snb', 'mens', 'studio-x']);
  assert.deepStrictEqual(p.$('f-status').childNodes.map(function (o) { return o.value; }), ['all', '未対応', '対応中', '対応済み', '対応不要']);
});

test('保存成功: 現在のフィルタ（未対応）を保ったまま再取得し、カード一覧・概要の未対応件数・Spreadsheetがそろう', function () {
  var p = setup();
  p.submit('snb', { q5: ['damage'] });
  p.submit('mens', { comment: 'エアコンが効きにくい' });
  p.submit('studio-x', {});
  p.start();
  p.flush();
  p.change('f-status', '未対応');
  p.flush();
  assert.strictEqual(p.cards().length, 2);

  var card = p.cards()[0];
  var id = card.getAttribute('data-response-id');
  var parts = cardParts(card);
  parts.select.value = '対応済み';
  parts.memo.value = '業者に連絡済み';
  parts.save.click();
  assert.strictEqual(parts.state.textContent, '保存中…');
  assert.strictEqual(parts.save.disabled, true, '保存中は二重送信できない');
  p.flush();

  assert.strictEqual(p.$('f-status').value, '未対応', 'フィルタは保ったまま');
  assert.strictEqual(p.cards().length, 1, '対応済みにしたカードは「未対応」の一覧から外れる');
  assert.notStrictEqual(p.cards()[0].getAttribute('data-response-id'), id);
  assert.strictEqual(p.tile('未対応'), 1, '概要の未対応件数も更新される');
  assert.match(p.$('notice').textContent, /^保存しました（.+：対応済み）。表示を更新しました。$/);
  var row = p.pub.rows().filter(function (r) { return r.response_id === id; })[0];
  assert.strictEqual(row.status, '対応済み');
  assert.strictEqual(row.memo, '業者に連絡済み');

  p.change('f-status', '対応済み');
  p.flush();
  assert.strictEqual(p.cards().length, 1);
  assert.strictEqual(cardParts(p.cards()[0]).badge.textContent, '対応済み');
  assert.strictEqual(cardParts(p.cards()[0]).memo.value, '業者に連絡済み');
});

test('保存失敗: 編集内容を保持してエラーを表示し、もう一度「保存」で再試行できる（サーバーエラー・通信失敗）', function () {
  var p = setup();
  p.submit('snb', { comment: 'x' });
  p.start();
  p.flush();
  var sheet = p.pub.sheet('responses');
  var parts = cardParts(p.cards()[0]);
  parts.select.value = '対応中';
  parts.memo.value = '確認中';

  sheet._failAfterWrites = 0;
  parts.save.click();
  p.flush();
  assert.match(parts.state.textContent, /^保存できませんでした：.*再試行します。$/);
  assert.strictEqual(parts.save.disabled, false);
  assert.strictEqual(parts.select.value, '対応中', '選んだ状況は残る');
  assert.strictEqual(parts.memo.value, '確認中', '入力したメモは残る');
  assert.strictEqual(p.pub.rows()[0].status, '未対応', 'Spreadsheetは変わらない');
  assert.strictEqual(p.$('notice').textContent, '');

  p.setNetworkDown(true);
  parts.save.click();
  p.flush();
  assert.match(parts.state.textContent, /^通信に失敗しました。/);
  assert.strictEqual(parts.memo.value, '確認中');

  p.setNetworkDown(false);
  delete sheet._failAfterWrites;
  parts.save.click();
  p.flush();
  assert.strictEqual(p.pub.rows()[0].status, '対応中');
  assert.strictEqual(p.pub.rows()[0].memo, '確認中');
  assert.strictEqual(cardParts(p.cards()[0]).badge.textContent, '対応中', '再取得後のカードに反映');
});

test('保存後の再読込でも、他のカードの未保存の編集と、保存中に追加した編集は失われない', function () {
  var p = setup();
  p.submit('snb', { comment: 'A' });
  p.submit('mens', { comment: 'B' });
  p.start();
  p.flush();
  function byComment(text) {
    return p.cards().filter(function (c) { return c.textContent.indexOf('自由記述') === -1 && c.findAll(function (n) { return n.hasClass('comment'); })[0].textContent === text; })[0];
  }
  function dirtyNote(card) { return card.findAll(function (n) { return n.textContent === '未保存の変更があります。'; })[0]; }

  /* カードBを編集したまま保存しない */
  var b = cardParts(byComment('B'));
  b.select.value = '対応中'; b.select.dispatch('change');
  b.memo.value = 'B の下書き'; b.memo.dispatch('input');
  assert.strictEqual(dirtyNote(byComment('B')).hidden, false);

  /* カードAを保存し、保存中にさらにメモを書き足す */
  var a = cardParts(byComment('A'));
  a.select.value = '対応済み'; a.select.dispatch('change');
  a.memo.value = '1回目'; a.memo.dispatch('input');
  a.save.click();
  a.memo.value = '1回目＋追記'; a.memo.dispatch('input');
  p.flush();

  var b2 = cardParts(byComment('B'));
  assert.strictEqual(b2.select.value, '対応中', 'B の未保存の状況が残る');
  assert.strictEqual(b2.memo.value, 'B の下書き', 'B の未保存のメモが残る');
  assert.strictEqual(dirtyNote(byComment('B')).hidden, false);
  var a2 = cardParts(byComment('A'));
  assert.strictEqual(p.pub.rows()[0].memo, '1回目', '保存されたのは送信時点の内容');
  assert.strictEqual(a2.memo.value, '1回目＋追記', '保存中に追記した内容は下書きとして残る');
  assert.strictEqual(dirtyNote(byComment('A')).hidden, false);

  /* 追記を保存すると下書きは消える */
  a2.save.click();
  p.flush();
  assert.strictEqual(p.pub.rows()[0].memo, '1回目＋追記');
  assert.strictEqual(dirtyNote(byComment('A')).hidden, true);
  /* 元の値に戻すと未保存扱いではなくなる */
  var b3 = cardParts(byComment('B'));
  b3.select.value = '未対応'; b3.select.dispatch('change');
  b3.memo.value = ''; b3.memo.dispatch('input');
  assert.strictEqual(dirtyNote(byComment('B')).hidden, true);
});

test('フィルタを続けて変えたとき、古い要求の応答は表示に反映しない', function () {
  var p = setup();
  p.submit('snb', { comment: 'snbの回答' });
  p.submit('mens', { comment: 'mensの回答' });
  p.start();
  p.flush();
  p.change('f-brand', 'snb');
  p.change('f-brand', 'mens');
  /* mens の応答が先に届き、その後で古い snb の応答が届く */
  var snbResponse = p.queue.shift();
  p.queue.shift()();
  snbResponse();
  var cards = p.cards();
  assert.strictEqual(cards.length, 1);
  assert.match(cards[0].textContent, /SNB mens/);
  assert.match(cards[0].textContent, /mensの回答/);
});

test('テスト回答だけを表示: 既定では出さず、切り替えたときだけ表示する', function () {
  var p = setup();
  p.submit('snb', { comment: '本番' });
  var r = p.pub.call('submit', { brand: 'mens', test: 1, answers: { q1: 1, q6: 'not_now', comment: 'テスト' } }, NOW);
  assert.strictEqual(r.success, true);
  p.start();
  p.flush();
  assert.strictEqual(p.tile('回答数'), 1);
  assert.strictEqual(p.$('test-note').hidden, true);
  p.change('f-test', true);
  p.flush();
  assert.strictEqual(p.tile('回答数'), 1);
  assert.match(p.cards()[0].textContent, /テスト/);
  assert.strictEqual(p.$('test-note').hidden, false);
});

test('0件・権限なしの表示', function () {
  var p = setup();
  p.start();
  p.flush();
  assert.match(p.$('panel-summary').textContent, /この条件の回答はまだありません。/);
  assert.match(p.$('cards').textContent, /該当する回答はありません。/);

  var spreadsheets = env.createSpreadsheets();
  var denied = env.loadFeedbackProject({ target: 'admin', spreadsheets: spreadsheets, activeEmail: 'x@example.com', properties: { FEEDBACK_ADMIN_EMAILS: OWNER } });
  var document = dom.createDocument(elementsFromHtml());
  var called = [];
  var context = {
    document: document,
    google: { script: { get run() {
      var ok;
      var api = { withSuccessHandler: function (f) { ok = f; return api; }, withFailureHandler: function () { return api; },
        getFeedbackDashboard: function (arg) { denied.sandbox.__arg = arg; called.push(1); ok(JSON.parse(JSON.stringify(denied.run('getFeedbackDashboard(__arg)')))); } };
      return api;
    } } }
  };
  vm.createContext(context);
  vm.runInContext(SCRIPT, context);
  assert.strictEqual(called.length, 1);
  assert.strictEqual(document.byId.error.textContent, 'アクセス権限がありません。');
  assert.strictEqual(document.byId.cards.childNodes.length, 0);
});

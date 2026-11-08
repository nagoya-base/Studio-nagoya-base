/*
 * 利用後アンケート管理画面GAS（gas/feedback-admin/。Issue #849 第2段階）の検証。
 * prepare-feedback-admin-gas-project.js の配布物をvmで実行し、#835 の公開GASが保存した同じSpreadsheetを読む。
 * 受入3（同じ画面でstatus/memo更新・該当1行の対象列だけ）、受入4（未認証拒否・誤更新なし）、受入5（通知失敗の表示・退行なし）。
 */
'use strict';

var test = require('node:test');
var assert = require('node:assert');
var fs = require('fs');
var path = require('path');
var Core = require('../scripts/feedback-core.js');
var prepareAdmin = require('../scripts/prepare-feedback-admin-gas-project');
var env = require('./helpers/feedback-env');

var OWNER = 'owner@example.com';
var NOW = new Date('2026-11-08T03:00:00.000Z');

/* 公開GASで回答を保存し、同じSpreadsheetを管理者GASから読む。 */
function world(adminOptions, publicOptions) {
  var spreadsheets = env.createSpreadsheets();
  var pub = env.loadFeedbackProject(Object.assign({ spreadsheets: spreadsheets }, publicOptions || {}));
  pub.run('setupFeedbackSpreadsheet()');
  pub.sandbox.__mock = { verify: function () { return { ok: true }; }, consume: function () { return { ok: true }; }, release: function () {} };
  pub.run('FeedbackTokens = __mock');
  var admin = env.loadFeedbackProject(Object.assign({
    target: 'admin', spreadsheets: spreadsheets, activeEmail: OWNER, properties: { FEEDBACK_ADMIN_EMAILS: ' Owner@Example.com ' }
  }, adminOptions || {}));
  function submit(brand, answers, extra) {
    var payload = Object.assign({ brand: brand, answers: Object.assign({ q1: 4, q6: 'definitely' }, answers) }, extra || { token: 'tok_ABCDEFGHIJKLMNOP1234' });
    var result = pub.call('submit', payload, NOW);
    assert.strictEqual(result.success, true, JSON.stringify(result));
  }
  function dashboard(filter) {
    admin.sandbox.__filter = filter || {};
    return JSON.parse(JSON.stringify(admin.run('getFeedbackDashboard(__filter)')));
  }
  function update(input) {
    admin.sandbox.__update = input;
    return JSON.parse(JSON.stringify(admin.run('updateFeedbackStatus(__update)')));
  }
  return { pub: pub, admin: admin, submit: submit, dashboard: dashboard, update: update };
}

test('配布物: 管理者プロジェクトは回答受付・通知を含まず、アクセスしているユーザーとして自分のみで実行', function () {
  var names = prepareAdmin.fileNames();
  assert.deepStrictEqual(names, ['FeedbackCore.gs', 'FeedbackAnalytics.gs', 'FeedbackRepository.gs', 'FeedbackAdmin.gs', 'FeedbackMaintenance.gs', 'FeedbackAdminPage.html', 'appsscript.json']);
  assert.ok(names.indexOf('FeedbackWebApp.gs') === -1 && names.indexOf('FeedbackTokens.gs') === -1);
  var manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'gas/feedback-admin/appsscript.json'), 'utf8'));
  assert.strictEqual(manifest.webapp.access, 'MYSELF');
  assert.strictEqual(manifest.webapp.executeAs, 'USER_ACCESSING');
  assert.deepStrictEqual(manifest.oauthScopes, ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/userinfo.email', 'https://www.googleapis.com/auth/script.scriptapp']);
  var admin = fs.readFileSync(path.join(__dirname, '..', 'gas/feedback-admin/FeedbackAdmin.gs'), 'utf8');
  assert.ok(!/MailApp|doPost|SURVEY_|BOOKING/.test(admin));
});

test('受入4: 許可メール以外・未設定・メール取得不可は画面も閲覧APIも更新APIも拒否し、データを返さない', function () {
  [
    { activeEmail: 'someone@example.com' },
    { activeEmail: '' },
    { activeEmailThrows: true },
    { properties: { FEEDBACK_ADMIN_EMAILS: '' } }
  ].forEach(function (opts, i) {
    var w = world(opts);
    w.submit('snb', { q5: ['damage'], comment: '秘密の本文' });
    var page = w.admin.run('doGet()');
    assert.strictEqual(page.kind, 'text', 'case ' + i);
    assert.strictEqual(page.text, 'アクセス権限がありません。');
    var d = w.dashboard({ period: 'all' });
    assert.deepStrictEqual(d, { success: false, error: { code: 'FORBIDDEN' } });
    var id = w.pub.rows()[0].response_id;
    assert.deepStrictEqual(w.update({ responseId: id, brand: 'snb', status: '対応済み', memo: 'x' }), { success: false, error: { code: 'FORBIDDEN' } });
    assert.strictEqual(w.pub.rows()[0].status, '未対応', '更新されていない');
  });
});

test('許可された管理者は画面を開ける（大文字小文字・空白を無視）', function () {
  var w = world();
  var page = w.admin.run('doGet()');
  assert.strictEqual(page.kind, 'file');
  assert.strictEqual(page.name, 'FeedbackAdminPage');
});

test('受入1/2/5: #835で保存された3ブランドの回答を集計し、テストは既定で除外。通知失敗もカードに出る', function () {
  var w = world({}, { properties: { FEEDBACK_NOTIFY: 'on', FEEDBACK_NOTIFY_EMAIL: 'owner@example.com' }, mailFails: true });
  w.submit('snb', { q1: 5 });
  w.submit('mens', { q1: 2, q5: ['supplies'], comment: 'ペーパーが切れていました' });
  w.submit('studio-x', { q1: 3, q6: 'maybe' });
  w.submit('snb', { q1: 1, comment: 'テスト' }, { test: 1 });
  var d = w.dashboard({});
  assert.strictEqual(d.success, true);
  assert.strictEqual(d.summary.count, 3);
  assert.strictEqual(d.summary.averageRating, 3.3);
  assert.strictEqual(d.summary.openCount, 1);
  assert.strictEqual(d.summary.notifyFailedCount, 1);
  assert.deepStrictEqual(d.statusOptions, ['未対応', '対応中', '対応済み', '対応不要']);
  assert.deepStrictEqual(d.brands.map(function (b) { return b.id; }), ['snb', 'mens', 'studio-x']);
  var card = d.list.cards[0];
  assert.strictEqual(card.brandName, 'SNB mens');
  assert.strictEqual(card.comment, 'ペーパーが切れていました');
  assert.strictEqual(card.notifyFailed, true);
  assert.strictEqual(card.status, '未対応');
  assert.ok(JSON.stringify(d).indexOf('tok_') === -1, 'トークンは返さない（そもそも保存していない）');
  assert.strictEqual(w.dashboard({ brand: 'mens' }).summary.count, 1);
  var t = w.dashboard({ scope: 'test' });
  assert.strictEqual(t.summary.count, 1);
  assert.strictEqual(t.list.cards[0].isTest, true);
});

test('受入3: カードから status / memo を保存すると、該当1行の status・memo 列だけが更新される', function () {
  var w = world();
  w.submit('snb', { q5: ['damage'] });
  w.submit('mens', { comment: 'エアコンが効きにくい' });
  w.submit('studio-x', { q1: 5 });
  var sheet = w.pub.sheet('responses');
  var before = JSON.parse(JSON.stringify(sheet._rows));
  var target = w.pub.rows()[1];
  var result = w.update({ responseId: target.response_id, brand: 'mens', status: '対応中', memo: '業者に連絡済み' });
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.card.status, '対応中');
  assert.strictEqual(result.card.memo, '業者に連絡済み');
  assert.strictEqual(result.card.comment, 'エアコンが効きにくい');
  var after = sheet._rows;
  var statusCol = Core.COLUMNS.indexOf('status');
  var memoCol = Core.COLUMNS.indexOf('memo');
  after.forEach(function (r, i) {
    r.forEach(function (v, c) {
      if (i === 2 && (c === statusCol || c === memoCol)) return;
      assert.deepStrictEqual(v, before[i][c], 'row ' + i + ' col ' + Core.COLUMNS[c] + ' は変更されない');
    });
  });
  assert.strictEqual(after[2][statusCol], '対応中');
  assert.strictEqual(after[2][memoCol], '業者に連絡済み');
  assert.strictEqual(w.dashboard({ status: '対応中' }).list.total, 1, '再読込でも反映される');
});

test('受入4: 別ブランド・存在しない行・重複ID・不正なステータスや本文の上書きは更新しない', function () {
  var w = world();
  w.submit('snb', { comment: '元の本文' });
  var sheet = w.pub.sheet('responses');
  var id = w.pub.rows()[0].response_id;
  var snapshot = JSON.stringify(sheet._rows);
  assert.strictEqual(w.update({ responseId: id, brand: 'mens', status: '対応済み' }).error.code, 'BRAND_MISMATCH');
  assert.strictEqual(w.update({ responseId: '00000000-0000-0000-0000-000000000000', brand: 'snb', status: '対応済み' }).error.code, 'NOT_FOUND');
  assert.strictEqual(w.update({ responseId: id, brand: 'snb', status: '削除' }).error.code, 'INVALID_STATUS');
  assert.strictEqual(w.update({ responseId: id, brand: 'snb', status: '対応済み', comment: '書き換え' }).error.code, 'UNKNOWN_FIELD');
  assert.strictEqual(w.update({ responseId: id, brand: 'snb', status: '対応済み', memo: 'あ'.repeat(201) }).error.code, 'MEMO_TOO_LONG');
  assert.strictEqual(JSON.stringify(sheet._rows), snapshot);

  sheet._rows.push(sheet._rows[1].slice());
  var dupSnapshot = JSON.stringify(sheet._rows);
  assert.strictEqual(w.update({ responseId: id, brand: 'snb', status: '対応済み' }).error.code, 'DUPLICATE_RESPONSE_ID');
  assert.strictEqual(JSON.stringify(sheet._rows), dupSnapshot);
});

test('status と memo は1回の書き込みで更新する（途中で失敗しても片方だけ更新された状態にならない）', function () {
  var w = world();
  w.submit('snb', { comment: 'x' });
  w.submit('mens', { comment: 'y' });
  var sheet = w.pub.sheet('responses');
  var id = w.pub.rows()[1].response_id;
  sheet._writes.length = 0;
  assert.strictEqual(w.update({ responseId: id, brand: 'mens', status: '対応済み', memo: 'ok' }).success, true);
  assert.deepStrictEqual(sheet._writes, [{ row: 3, col: Core.COLUMNS.indexOf('status') + 1, numRows: 1, numCols: 2 }], 'status・memo の2セルだけを1回で書く');
  assert.strictEqual(Core.COLUMNS.indexOf('memo'), Core.COLUMNS.indexOf('status') + 1);

  /* 旧方式で問題になった「1回目（status）は成功し2回目（memo）で失敗」の状況：1回目の書き込みで失敗させても、どちらの列も変わらない */
  var before = JSON.stringify(sheet._rows);
  sheet._writes.length = 0;
  sheet._failAfterWrites = 0;
  var failed = w.update({ responseId: id, brand: 'mens', status: '対応中', memo: '途中で失敗' });
  assert.strictEqual(failed.error.code, 'INTERNAL_ERROR');
  assert.strictEqual(JSON.stringify(sheet._rows), before, 'status だけ更新されることはない');
  /* 1回目が成功した後に失敗する設定でも、更新は1回で終わるので成功し、両方そろって反映される */
  sheet._failAfterWrites = 1;
  assert.strictEqual(w.update({ responseId: id, brand: 'mens', status: '対応中', memo: '再試行' }).success, true);
  assert.strictEqual(w.pub.rows()[1].status, '対応中');
  assert.strictEqual(w.pub.rows()[1].memo, '再試行');
});

test('月次削除と対応更新は同じプロジェクトのロックで直列化し、削除で行がずれて別の回答へ書くことはない', function () {
  var w = world();
  var sheet = w.pub.sheet('responses');
  w.submit('snb', { comment: '古い回答' });
  w.submit('mens', { comment: '対象の回答' });
  w.submit('studio-x', { comment: '別の回答' });
  /* 1行目（snb）を保持期間切れにする */
  sheet._rows[1][Core.COLUMNS.indexOf('received_at')] = new Date(NOW.getTime() - 200 * 86400000).toISOString();
  var targetId = w.pub.rows()[1].response_id;
  var otherId = w.pub.rows()[2].response_id;

  /* 対応更新が行を特定した後、書き込む直前に月次削除が割り込もうとする */
  var purge = null;
  w.admin.sandbox.__now = NOW;
  sheet._beforeWrite = function () { purge = w.admin.run('purgeExpiredFeedbackResponses(__now)'); };
  var result = w.update({ responseId: targetId, brand: 'mens', status: '対応済み', memo: '対応した' });
  assert.strictEqual(result.success, true);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(purge)), { deleted: 0, skipped: true }, '更新中は削除がロックを取れず待つ（今回は見送り）');
  var byId = {};
  w.pub.rows().forEach(function (r) { byId[r.response_id] = r; });
  assert.strictEqual(byId[targetId].status, '対応済み');
  assert.strictEqual(byId[targetId].memo, '対応した');
  assert.strictEqual(byId[otherId].status, '未対応', '別ブランドの回答には書かない');
  assert.strictEqual(byId[otherId].memo, '');

  /* 次回の削除で保持期間切れの行が消え、更新内容はそのまま残る */
  assert.strictEqual(w.admin.run('purgeExpiredFeedbackResponses(__now)').deleted, 1);
  assert.deepStrictEqual(w.pub.rows().map(function (r) { return [r.response_id === targetId, r.status]; }), [[true, '対応済み'], [false, '未対応']]);
});

test('memo の数式は無害化して保存し、画面へは元の文字で返す', function () {
  var w = world();
  w.submit('snb', { comment: 'x' });
  var id = w.pub.rows()[0].response_id;
  var result = w.update({ responseId: id, brand: 'snb', status: '対応済み', memo: '=IMPORTXML("http://x")' });
  assert.strictEqual(result.card.memo, '=IMPORTXML("http://x")');
  assert.strictEqual(w.pub.rows()[0].memo, '\'=IMPORTXML("http://x")');
});

test('保存失敗・混雑・保存先未設定はエラーを返し、画面で再試行できる', function () {
  var busy = world({ lockFails: true });
  busy.submit('snb', { comment: 'x' });
  assert.strictEqual(busy.update({ responseId: busy.pub.rows()[0].response_id, brand: 'snb', status: '対応済み' }).error.code, 'BUSY');

  var failing = world();
  failing.submit('snb', { comment: 'x' });
  failing.pub.sheet('responses')._failWrites = true;
  assert.strictEqual(failing.update({ responseId: failing.pub.rows()[0].response_id, brand: 'snb', status: '対応済み' }).error.code, 'INTERNAL_ERROR');

  var none = env.loadFeedbackProject({ target: 'admin', spreadsheetId: null, activeEmail: OWNER, properties: { FEEDBACK_ADMIN_EMAILS: OWNER } });
  assert.strictEqual(JSON.parse(JSON.stringify(none.run('getFeedbackDashboard({})'))).error.code, 'STORAGE_UNAVAILABLE');
  assert.strictEqual(JSON.parse(JSON.stringify(none.run('updateFeedbackStatus({ responseId: "rid-00000001", brand: "snb", status: "対応済み" })'))).error.code, 'STORAGE_UNAVAILABLE');
});

test('受入5: 管理者が更新した status があっても、#835 の公開GASは保存・通知を続けられる（ヘッダ不変）', function () {
  var w = world({}, { properties: { FEEDBACK_NOTIFY: 'on', FEEDBACK_NOTIFY_EMAIL: 'owner@example.com' } });
  w.submit('snb', { comment: '1件目' });
  w.update({ responseId: w.pub.rows()[0].response_id, brand: 'snb', status: '対応済み', memo: 'ok' });
  w.submit('mens', { comment: '2件目' });
  assert.strictEqual(w.pub.rows().length, 2);
  assert.strictEqual(w.pub.mails.length, 2);
  assert.deepStrictEqual(w.pub.sheet('responses')._rows[0], Core.COLUMNS);
});

test('管理画面HTML: textContent 描画・google.script.run だけで通信・4ステータスとメモ・保存中/成功/失敗/再試行・スマホ幅', function () {
  var html = fs.readFileSync(path.join(__dirname, '..', 'gas/feedback-admin/FeedbackAdminPage.html'), 'utf8');
  assert.ok(!/innerHTML|insertAdjacentHTML|document\.write|eval\(/.test(html));
  assert.ok(!/fetch\(|XMLHttpRequest|googletagmanager|gtag\(/.test(html));
  assert.match(html, /\.updateFeedbackStatus\(\{ responseId: card\.responseId, brand: card\.brand, status: sent\.status, memo: sent\.memo \}\)/);
  assert.match(html, /\.getFeedbackDashboard\(filter\(\)\)/);
  /* 古いフィルタ要求の応答で新しい表示を上書きしない */
  assert.match(html, /var requestId = \+\+latestRequest;/);
  assert.equal((html.match(/if \(requestId !== latestRequest\) return;/g) || []).length, 2);
  /* 保存成功後はダッシュボードを読み直し、概要の件数・絞り込み・並び順をそろえる */
  assert.match(html, /status\.textContent = '保存しました。';[\s\S]{0,400}load\(\);/);
  ['保存中…', '保存しました。', '再試行', 'テスト回答だけを表示', '直近30日', '直近90日', '全期間', '概要', '問題分析', 'ご意見・対応', '全設問の回答を見る', '通知失敗'].forEach(function (w) {
    assert.ok(html.indexOf(w) !== -1, w);
  });
  assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1">/);
  assert.match(html, /overflow-wrap:anywhere/);
});

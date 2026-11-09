/*
 * Issue #834 第3段階の結合テスト: Booking Admin（FeedbackInvites.gs）が案内メールに載せたリンクを、
 * 回答用 公開Web App（gas/feedback/。prepare-feedback-gas-project.js の配布物そのもの）へ送る。
 * 両プロジェクトが共有するのは FEEDBACK_TOKEN_SECRET だけ（回答用GASは Booking の Spreadsheet を開かない）。
 *
 * 受入2（安全な回答リンク・14日期限）、3（1予約1回答・別予約は再回答可・並列／期限切れ／ブランド不一致／保存失敗）、
 * 4（?test=1 は本番の使用済み台帳に影響しない）。
 */
'use strict';

var test = require('node:test');
var assert = require('node:assert');
var loadBookingSandbox = require('./helpers/gas-sandbox').loadBookingSandbox;
var stubs = require('./helpers/gas-stubs');
var loadFeedbackProject = require('./helpers/feedback-env').loadFeedbackProject;

var SECRET = 'shared-feedback-secret-0123456789abcdefgh';
var HOUR = 3600 * 1000;
var END = new Date('2026-12-05T15:00:00+09:00');
var AFTER_2H = new Date(END.getTime() + 2 * HOUR);
var DAY = 24 * HOUR;

function plain(v) { return JSON.parse(JSON.stringify(v)); }

/* Booking Admin で予約を作り、案内メールを送って { brand, token } を返す。 */
function inviteLinks(bookings) {
  var sheets = {};
  var mailApp = stubs.createMailAppStub();
  var sandbox = loadBookingSandbox(
    ['Config.gs', 'Availability.gs', 'Booking.gs', 'SpreadsheetRepository.gs', 'FeedbackTokenCore.gs', 'FeedbackInvites.gs'],
    {
      PropertiesService: stubs.createPropertiesServiceStub({
        SPREADSHEET_ID: 'ss-booking',
        FEEDBACK_INVITE_MODE: 'on',
        FEEDBACK_INVITE_START_AT: '2026-12-01T00:00:00+09:00',
        FEEDBACK_TOKEN_SECRET: SECRET,
        BOOKING_MAIL_DISPLAY_NAME: 'Studio Nagoya Base',
        BOOKING_MAIL_REPLY_TO: 'noreply@example.com',
        BOOKING_CONTACT_EMAIL: 'contact@example.com'
      }),
      SpreadsheetApp: stubs.createSpreadsheetAppStub({ 'ss-booking': sheets }),
      LockService: stubs.createLockServiceStub(),
      MailApp: mailApp,
      Utilities: stubs.createUtilitiesStub(),
      Logger: stubs.createLoggerStub()
    }
  );
  sandbox.setupFeedbackInvites();
  bookings.forEach(function (b) {
    sandbox.SpreadsheetRepository.appendBooking(Object.assign({
      createdAt: new Date('2026-11-20T10:00:00+09:00'), date: '2026-12-05',
      startAt: new Date(END.getTime() - 3 * HOUR), endAt: END, name: '山田太郎', email: b.bookingId.toLowerCase() + '@example.com',
      purpose: '撮影', paymentMethod: '現金', status: 'CONFIRMED', confirmedAt: new Date('2026-11-20T11:00:00+09:00'), paymentStatus: 'not_started'
    }, b));
  });
  sandbox.sendFeedbackInvites(AFTER_2H);
  var links = {};
  mailApp._sentEmails.forEach(function (mail) {
    var m = /\/feedback\/([a-z-]+)\/#t=([0-9a-z]+)/.exec(mail.body);
    links[mail.to.split('@')[0].toUpperCase()] = { brand: m[1], token: m[2] };
  });
  return links;
}

function feedback(options) {
  var opts = options || {};
  var project = loadFeedbackProject({
    properties: Object.assign({ FEEDBACK_TOKEN_SECRET: SECRET }, opts.properties || {}),
    lockFails: opts.lockFails
  });
  if (opts.setup !== false) project.run('setupFeedbackSpreadsheet()');
  return project;
}

function submit(project, link, brand, now, extra) {
  return project.call('submit', Object.assign({ brand: brand || link.brand, token: link.token, answers: { q1: 4, q6: 'definitely' } }, extra || {}), now || new Date(AFTER_2H.getTime() + HOUR));
}

function ledger(project) {
  var sheet = project.sheet('token_uses');
  return sheet ? sheet._rows.slice(1) : null;
}

var BOOKINGS = [
  { bookingId: 'SNB-1', brand: 'snb', source: 'snb-booking-app' },
  { bookingId: 'SNB-2', brand: 'snb', source: 'snb-booking-app' },
  { bookingId: 'M-1', brand: 'mens', source: 'mens-booking-app' },
  { bookingId: 'SX-1', brand: 'studio_x', source: 'studio-x-booking-app' }
];
var LINKS = inviteLinks(BOOKINGS);

test('結合: 3ブランドのメールのリンクで本番回答が保存できる（is_test=0。回答行に予約ID・トークンを残さない）', function () {
  assert.deepStrictEqual(Object.keys(LINKS).sort(), ['M-1', 'SNB-1', 'SNB-2', 'SX-1']);
  var project = feedback();
  ['SNB-1', 'M-1', 'SX-1'].forEach(function (id) {
    assert.deepStrictEqual(project.call('verify', { brand: LINKS[id].brand, token: LINKS[id].token }, AFTER_2H), { success: true }, id + ' verify');
    assert.deepStrictEqual(submit(project, LINKS[id]), { success: true }, id);
  });
  var rows = project.rows();
  assert.deepStrictEqual(rows.map(function (r) { return [r.brand, r.is_test]; }), [['snb', 0], ['mens', 0], ['studio-x', 0]]);
  var flat = JSON.stringify(project.sheet('responses')._rows);
  Object.keys(LINKS).forEach(function (id) {
    assert.ok(flat.indexOf(LINKS[id].token) === -1 && flat.indexOf(id) === -1);
  });
  var used = ledger(project);
  assert.strictEqual(used.length, 3);
  used.forEach(function (row) {
    assert.match(row[0], /^tk_[0-9a-f]{24}$/, '台帳のキーは tokenId（予約IDではない）');
    assert.strictEqual(row.length, 2, '台帳に回答ID・回答日時を書かない');
  });
});

test('結合: 1予約1回答（2回目は TOKEN_USED）。同じ人の別予約のリンクなら再回答できる', function () {
  var project = feedback();
  assert.deepStrictEqual(submit(project, LINKS['SNB-1']), { success: true });
  assert.deepStrictEqual(submit(project, LINKS['SNB-1']), { success: false, error: { code: 'TOKEN_USED' } });
  assert.deepStrictEqual(project.call('verify', { brand: 'snb', token: LINKS['SNB-1'].token }, AFTER_2H), { success: false, error: { code: 'TOKEN_USED' } });
  assert.deepStrictEqual(submit(project, LINKS['SNB-2']), { success: true });
  assert.strictEqual(project.rows().length, 2);
});

test('結合: verify（回答画面を開く前の確認）は使用済みにしない', function () {
  var project = feedback();
  for (var i = 0; i < 3; i++) project.call('verify', { brand: 'mens', token: LINKS['M-1'].token }, AFTER_2H);
  assert.strictEqual(ledger(project).length, 0);
  assert.deepStrictEqual(submit(project, LINKS['M-1']), { success: true });
});

test('結合: ブランド不一致・改ざん・期限切れ（終了から14日）は保存を拒否し、台帳を変えない', function () {
  var project = feedback();
  assert.deepStrictEqual(submit(project, LINKS['SX-1'], 'snb'), { success: false, error: { code: 'TOKEN_BRAND_MISMATCH' } });
  var t = LINKS['SNB-1'].token;
  var tampered = { brand: 'snb', token: t.slice(0, 20) + (t[20] === 'a' ? 'b' : 'a') + t.slice(21) };
  assert.deepStrictEqual(submit(project, tampered), { success: false, error: { code: 'TOKEN_INVALID' } });
  var lastValid = new Date(END.getTime() + 14 * DAY - 1000);
  var expired = new Date(END.getTime() + 14 * DAY);
  assert.deepStrictEqual(submit(project, LINKS['M-1'], null, expired), { success: false, error: { code: 'TOKEN_EXPIRED' } });
  assert.strictEqual(project.rows().length, 0);
  assert.strictEqual(ledger(project).length, 0);
  assert.deepStrictEqual(submit(project, LINKS['M-1'], null, lastValid), { success: true }, '期限の1秒前までは受け付ける');
});

test('結合: 回答の保存に失敗したらトークンを使用済みにしない（STORAGE_UNAVAILABLE → 後で同じリンクで回答できる）', function () {
  var project = feedback();
  project.sheet('responses')._failWrites = true;
  assert.deepStrictEqual(submit(project, LINKS['SNB-1']), { success: false, error: { code: 'STORAGE_UNAVAILABLE' } });
  assert.strictEqual(ledger(project).length, 0, '消費を取り消している');
  project.sheet('responses')._failWrites = false;
  assert.deepStrictEqual(submit(project, LINKS['SNB-1']), { success: true });
  assert.strictEqual(ledger(project).length, 1);
});

test('結合: 使用済み台帳へ書けないときは回答も保存しない（どちらか片方だけにならない）', function () {
  var project = feedback();
  project.sheet('token_uses')._failWrites = true;
  assert.deepStrictEqual(submit(project, LINKS['SNB-1']), { success: false, error: { code: 'STORAGE_UNAVAILABLE' } });
  assert.strictEqual(project.rows().length, 0);
});

test('結合: 同時送信の再現（他の送信がロック中）は BUSY で、保存も消費もしない', function () {
  var project = feedback();
  /* 1回目のロック（レート制限）は取れ、2回目（回答保存）は他の送信が保持中で取れない */
  var calls = 0;
  project.sandbox.LockService = { getScriptLock: function () { return { tryLock: function () { calls++; return calls === 1; }, releaseLock: function () {} }; } };
  assert.deepStrictEqual(submit(project, LINKS['SNB-1']), { success: false, error: { code: 'BUSY' } });
  assert.strictEqual(project.rows().length, 0);
  assert.strictEqual(ledger(project).length, 0);
});

test('結合: 送信の直前に別の送信が同じリンクで保存を終えていたら、ロック内の再確認で TOKEN_USED（二重保存しない）', function () {
  var project = feedback();
  var other = feedback();
  /* 同じSpreadsheetを共有する2つ目の実行が、こちらのロック取得前に回答を終えた状態を作る */
  assert.deepStrictEqual(submit(other, LINKS['SX-1']), { success: true });
  project.sheet('token_uses')._rows.push(other.sheet('token_uses')._rows[1].slice());
  assert.deepStrictEqual(submit(project, LINKS['SX-1']), { success: false, error: { code: 'TOKEN_USED' } });
  assert.strictEqual(project.rows().length, 0);
});

test('受入4: ?test=1 は本番トークンを検証・消費せず、使用済み台帳に影響しない', function () {
  var project = feedback();
  assert.deepStrictEqual(project.call('submit', { brand: 'snb', test: 1, token: LINKS['SNB-1'].token, answers: { q1: 3, q6: 'maybe' } }, AFTER_2H), { success: true });
  assert.strictEqual(ledger(project).length, 0);
  assert.strictEqual(project.rows()[0].is_test, 1);
  assert.deepStrictEqual(submit(project, LINKS['SNB-1']), { success: true }, 'テスト後も本番リンクは未使用のまま');
});

test('秘密鍵が未設定・別の値なら本番回答は保存できない（TOKEN_NOT_CONNECTED / TOKEN_INVALID）', function () {
  var none = feedback({ properties: { FEEDBACK_TOKEN_SECRET: '' } });
  assert.deepStrictEqual(submit(none, LINKS['SNB-1']), { success: false, error: { code: 'TOKEN_NOT_CONNECTED' } });
  var other = feedback({ properties: { FEEDBACK_TOKEN_SECRET: 'another-secret-0123456789abcdefghijklmnop' } });
  assert.deepStrictEqual(submit(other, LINKS['SNB-1']), { success: false, error: { code: 'TOKEN_INVALID' } });
  assert.strictEqual(none.rows().length + other.rows().length, 0);
});

test('第1・2段階で初期化済みのSpreadsheet: token_uses が無い間は本番回答を止め、setup の再実行で追加される（既存の回答は不変）', function () {
  var project = feedback({ setup: false });
  project.run('setupFeedbackSpreadsheet()');
  /* 第2段階までの状態を再現: token_uses を外し、テスト回答を1件入れておく */
  var book = project.spreadsheets.books['ss-feedback'];
  delete book.sheets.token_uses;
  book.order.splice(book.order.indexOf('token_uses'), 1);
  project.call('submit', { brand: 'mens', test: 1, answers: { q1: 5, q6: 'definitely' } }, AFTER_2H);
  var before = JSON.stringify(project.sheet('responses')._rows);
  assert.deepStrictEqual(submit(project, LINKS['M-1']), { success: false, error: { code: 'STORAGE_UNAVAILABLE' } });
  assert.deepStrictEqual(project.call('verify', { brand: 'mens', token: LINKS['M-1'].token }, AFTER_2H), { success: false, error: { code: 'STORAGE_UNAVAILABLE' } });
  assert.strictEqual(project.run('setupFeedbackSpreadsheet()'), 'ok');
  assert.strictEqual(JSON.stringify(project.sheet('responses')._rows), before);
  assert.deepStrictEqual(project.sheet('token_uses')._rows, [['token_key', 'expires_at']]);
  assert.deepStrictEqual(submit(project, LINKS['M-1']), { success: true });
});

test('purgeExpiredFeedbackTokenUses: 期限から1日以上過ぎた記録だけを消す（消しても期限切れなので再回答できない）', function () {
  var project = feedback();
  submit(project, LINKS['SNB-1']);
  submit(project, LINKS['SNB-2']);
  project.sheet('token_uses')._rows[2][1] = new Date(AFTER_2H.getTime() + 30 * DAY).toISOString();
  project.sheet('token_uses')._rows.push(['tk_unreadable', 'not-a-date']);
  project.sandbox.__purgeNow = new Date(END.getTime() + 16 * DAY);
  assert.deepStrictEqual(plain(project.run('getFeedbackTokenLedgerStatus(__purgeNow)')), { status: 'OK', total: 3, purgeable: 1 });
  var result = plain(project.run('purgeExpiredFeedbackTokenUses(__purgeNow)'));
  assert.deepStrictEqual(result, { status: 'OK', deleted: 1 });
  assert.strictEqual(ledger(project).length, 2, '期限内・日時不明の行は残す');
  assert.deepStrictEqual(submit(project, LINKS['SNB-1'], null, project.sandbox.__purgeNow), { success: false, error: { code: 'TOKEN_EXPIRED' } });
  assert.deepStrictEqual(plain(project.run('getFeedbackTokenLedgerStatus(__purgeNow)')), { status: 'OK', total: 2, purgeable: 0 });
});

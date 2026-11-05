/*
 * Issue #752（PR-C）: 暗証番号案内メールの配送（別送・送信直前ゲート・結果不明・再案内・変更/取消との競合）のモックテスト。
 * MailApp・SwitchBot API・Spreadsheet はすべてフェイク。実利用者への送信は0件。完全deviceId・メール・暗証番号はダミー。
 */
'use strict';

var test = require('node:test');
var assert = require('node:assert');
var fs = require('fs');
var path = require('path');
var vm = require('vm');
var H = require('./helpers/switchbot-access-world');
var SheetsFake = require('./helpers/sheets-rest-fake');
var Reader = require('../gas/switchbot-access/AccessLedgerReader.gs');
var Infra = H.Infra, Core = H.Core, S = Core.STATE, D = Core.DLV;

var ROOT = path.resolve(__dirname, '..');
var PW8 = /(?:^|[^0-9])([0-9]{8})(?:[^0-9]|$)/;

function mailWorld(cfgOver) {
  return H.createWorld({ mail: true, cfg: Object.assign({ deliveryConfigured: true, delivery: H.DELIVERY_CFG }, cfgOver || {}) });
}
function ops(w) {
  return w.store.keys().filter(function (k) { return k.indexOf('OP_') === 0; }).map(function (k) { return JSON.parse(w.store.get(k)); });
}
function dlvOf(w, op) { var v = w.store.get('DLV_' + op.id); return v ? JSON.parse(v) : null; }
function at(w, iso) { w.nowMs = Date.parse(iso); }

/** 確定予約を発行確認済み(ISSUED_CONFIRMED)まで進める。現在時刻は前日13:10 JST 前後（配送開始の18:00前）。 */
function issue(w, rt, rec) {
  w.records = [rec || H.record()];
  rt.syncCycle(); w.advance(300);
  rt.syncCycle();
  var op = ops(w).filter(function (o) { return o.state === S.SENT_WAIT_WEBHOOK; })[0];
  assert.ok(op, '発行送信済み');
  w.advance(10);
  assert.strictEqual(rt.handleWebhook(H.webhook({ commandId: op.commandId, deviceMac: H.DEV }), H.TOKEN, H.TOKEN).accepted, true);
  w.advance(290);
  rt.syncCycle();
  var cur = ops(w).filter(function (o) { return o.id === op.id; })[0];
  assert.strictEqual(cur.state, S.ISSUED_CONFIRMED);
  return cur;
}
/** 台帳の変更を取り込む（静穏時間の観測→同期）。削除は keyList 読取で確認する世界にする。 */
function settle(w, rt) { w.deleteMode = 'noCommandId'; rt.syncCycle(); w.advance(300); rt.syncCycle(); }
/** 配送開始（利用前日18:00 JST）以降へ進める。 */
function open18(w) { at(w, '2030-01-10T18:00:00+09:00'); }

// ---------------------------------------------------------------- 基本経路・タイミング

test('配送: 発行反映確認後も前日18:00 JST前は送らず、18:00ちょうどから別メールで1通だけ送る', function () {
  var w = mailWorld(); var rt = w.runtime();
  var op = issue(w, rt);
  assert.strictEqual(rt.deliverCycle().held, 1, '18:00前は保留');
  at(w, '2030-01-10T17:59:59+09:00');
  assert.strictEqual(rt.deliverCycle().delivered, 0);
  assert.strictEqual(w.userMails.length, 0);
  open18(w);
  var r = rt.deliverCycle();
  assert.strictEqual(r.delivered, 1);
  assert.strictEqual(w.userMails.length, 1);
  var m = w.userMails[0];
  assert.strictEqual(m.to, 'guest@example.test');
  assert.strictEqual(m.name, 'Studio Nagoya Base');
  assert.ok(/入室用の暗証番号/.test(m.subject));
  assert.ok(m.body.indexOf(w.createdPasswords[0]) !== -1, '本文に発行したコードを含む');
  assert.ok(/予約確認メールとは別/.test(m.body));
  assert.strictEqual(dlvOf(w, op).state, D.DELIVERED);
  assert.strictEqual(w.mails.filter(function (x) { return PW8.test(x.body); }).length, 0, '管理者通知にコードを含めない');
  // 重複イベント・再実行・複数サイクルでも再送しない
  [1, 2, 3].forEach(function () { rt.deliverCycle(); w.advance(300); });
  assert.strictEqual(w.userMails.length, 1);
});

test('配送: 反映確認前(未確認/UNKNOWN/FAILED)は送らない。台帳が読めなければ送らない(fail closed)', function () {
  var w = mailWorld(); var rt = w.runtime();
  w.createMode = 'dropResponse'; // 応答を失う → UNKNOWN
  w.api.createKey = (function (orig) { return function (p) { orig(p); throw new Error('NET'); }; })(w.api.createKey);
  w.records = [H.record()];
  rt.syncCycle(); w.advance(300); rt.syncCycle();
  assert.strictEqual(ops(w)[0].state, S.UNKNOWN);
  open18(w);
  rt.deliverCycle();
  assert.strictEqual(w.userMails.length, 0);

  var w2 = mailWorld(); var rt2 = w2.runtime();
  issue(w2, rt2); open18(w2);
  w2.ledgerFail = 'LEDGER_READ_FAILED';
  var r = rt2.deliverCycle();
  assert.strictEqual(r.ok, false);
  assert.strictEqual(w2.userMails.length, 0);
  w2.ledgerFail = null;
  assert.strictEqual(rt2.deliverCycle().delivered, 1, '復旧後に送る');
});

test('配送: 利用終了後(期限切れ)・フラグOFF・配送未承認では送らない', function () {
  var w = mailWorld(); var rt = w.runtime();
  var op = issue(w, rt);
  at(w, '2030-01-11T12:20:00+09:00'); // 有効期限(12:15)後
  var r = rt.deliverCycle();
  assert.strictEqual(r.delivered, 0);
  assert.strictEqual(r.suppressed, 1);
  assert.strictEqual(w.userMails.length, 0);
  assert.strictEqual(dlvOf(w, op).state, D.SUPPRESSED);

  var w2 = mailWorld({ enabled: false }); var rt2 = w2.runtime();
  open18(w2);
  assert.strictEqual(rt2.deliverCycle().skipped, 'FLAG_OFF');
  assert.strictEqual(w2.ledgerCalls, 0);

  var w3 = H.createWorld({ mail: true, cfg: { delivery: H.DELIVERY_CFG } }); // deliveryConfigured 未設定
  var rt3 = w3.runtime(); issue(w3, rt3); open18(w3);
  assert.strictEqual(rt3.deliverCycle().skipped, 'DELIVERY_NOT_CONFIGURED');
  assert.strictEqual(w3.userMails.length, 0);
});

test('配送: 配送設定(差出人・問合せ案内)が無い／不正なら、deliveryConfigured でも送らず設定不正を止める', function () {
  var w = H.createWorld({ mail: true, cfg: { deliveryConfigured: true } });
  var rt = w.runtime(); issue(w, rt); open18(w);
  assert.strictEqual(rt.deliverCycle().skipped, 'DELIVERY_NOT_CONFIGURED');
  assert.strictEqual(w.userMails.length, 0);
  var bad = H.createWorld({ mail: true, cfg: { deliveryConfigured: true, delivery: { senderName: '', facilityLabel: 'x', inquiryNote: 'y' } } });
  var rb = bad.runtime(); bad.records = [H.record()];
  assert.strictEqual(rb.syncCycle().error, 'CONFIG_INVALID', '不正な配送設定は全ジョブを止める');
  assert.ok(Infra.validateConfig(Object.assign({}, bad.cfg)).errors.indexOf('DELIVERY_CONFIG_INVALID') !== -1);
  assert.strictEqual(Infra.deliverySettings({ delivery: Object.assign({}, H.DELIVERY_CFG, { replyTo: 'a b@x' }) }), null);
  assert.strictEqual(Infra.deliverySettings({ delivery: Object.assign({}, H.DELIVERY_CFG, { startHoursBeforeDay: 100 }) }), null);
});

test('配送: 別ブランド・対象外は発行されず、メールも送られない', function () {
  var w = mailWorld(); var rt = w.runtime();
  w.records = [H.record({ brand: 'other' })];
  rt.syncCycle(); w.advance(300); rt.syncCycle(); open18(w);
  rt.deliverCycle();
  assert.strictEqual(ops(w).length, 0);
  assert.strictEqual(w.userMails.length, 0);
});

// ---------------------------------------------------------------- 最新予約との競合（取消・変更・未決済・返金）

test('競合: 配送前に取消(revision増)された予約には送らない。配送は打ち切られ以後も送らない', function () {
  var w = mailWorld(); var rt = w.runtime();
  var op = issue(w, rt);
  w.records = [H.record({ status: 'CANCELLED', revision: 2 })]; // 同期前に取消
  open18(w);
  var r = rt.deliverCycle();
  assert.strictEqual(w.userMails.length, 0);
  assert.strictEqual(r.suppressed, 1);
  assert.strictEqual(dlvOf(w, op).state, D.SUPPRESSED);
  settle(w, rt); rt.deliverCycle();
  assert.strictEqual(w.userMails.length, 0);
  assert.ok(w.callCount('deleteKey') >= 1, '取消後は旧キーが削除に進む（予約側は巻き戻さない）');
});

test('競合: 変更で期間が変わった予約に旧コードは送らず、反映確認後に新コードを「変更案内」として別メールで送る', function () {
  var w = mailWorld(); var rt = w.runtime();
  var op1 = issue(w, rt);
  open18(w);
  assert.strictEqual(rt.deliverCycle().delivered, 1);
  var oldCode = w.createdPasswords[0];
  // 延長: 終了を12:00→14:00（revision増）。まだ同期前に配送が走っても旧コードは送らない
  w.records = [H.record({ endAt: H.jst('2030-01-11', '14:00'), revision: 2 })];
  w.deleteMode = 'noCommandId';
  w.advance(60);
  var mid = rt.deliverCycle();
  assert.strictEqual(mid.delivered, 0);
  assert.strictEqual(w.userMails.length, 1, '旧コードを再送しない');
  // 同期 → 旧キー削除 → 新キー発行 → 反映確認
  for (var i = 0; i < 6 && !ops(w).some(function (o) { return o.revision === 2 && o.state === S.ISSUED_CONFIRMED; }); i++) {
    w.advance(300); rt.syncCycle();
    var pend = ops(w).filter(function (o) { return o.revision === 2 && o.state === S.SENT_WAIT_WEBHOOK; })[0];
    if (pend) { w.advance(10); rt.handleWebhook(H.webhook({ commandId: pend.commandId }), H.TOKEN, H.TOKEN); w.advance(290); rt.syncCycle(); }
  }
  var op2 = ops(w).filter(function (o) { return o.revision === 2 && o.state === S.ISSUED_CONFIRMED; })[0];
  assert.ok(op2, '新revisionの発行確認済み');
  assert.notStrictEqual(op2.id, op1.id);
  assert.strictEqual(rt.deliverCycle().delivered, 1);
  assert.strictEqual(w.userMails.length, 2);
  var m2 = w.userMails[1];
  assert.ok(/変更のお知らせ/.test(m2.subject));
  assert.ok(/以前にお送りした暗証番号は使用できません/.test(m2.body), '旧キー削除確認済みなので旧番号の失効を案内');
  assert.ok(m2.body.indexOf(oldCode) === -1, '旧コードを本文に含めない');
  assert.ok(m2.body.indexOf(w.createdPasswords[1]) !== -1);
  assert.notStrictEqual(dlvOf(w, op1).deliveryId, dlvOf(w, op2).deliveryId, '配送IDは操作/revisionごとに別');
  assert.strictEqual(dlvOf(w, op2).kind, 'CHANGE');
  rt.deliverCycle();
  assert.strictEqual(w.userMails.length, 2, '同じ変更案内を重複送信しない');
});

test('競合: 配送待ち(再試行待ち)の旧コードは、変更・取消が入っても送らない', function () {
  var w = mailWorld(); var rt = w.runtime();
  var op = issue(w, rt);
  open18(w);
  w.recipients = {}; // 宛先を特定できない → 未送信確定で再試行待ち
  rt.deliverCycle();
  assert.strictEqual(dlvOf(w, op).state, D.NOT_SENT);
  assert.strictEqual(w.userMails.length, 0);
  // 取消される
  w.records = [H.record({ status: 'CANCELLED', revision: 2 })];
  w.recipients = { 'SNB-1': 'guest@example.test' };
  settle(w, rt);
  for (var i = 0; i < 4; i++) { w.advance(700); rt.syncCycle(); rt.deliverCycle(); }
  assert.strictEqual(w.userMails.length, 0, '取消後は旧コードを送らない');
});

test('競合: 未決済・承認取消(支払根拠なし)になった予約には、解消されるまで送らない', function () {
  var w = mailWorld(); var rt = w.runtime();
  issue(w, rt); open18(w);
  w.records = [H.record({ paymentConfirmedAt: '', paymentStatus: 'refunded' })];
  var r = rt.deliverCycle();
  assert.strictEqual(r.delivered, 0);
  assert.strictEqual(w.userMails.length, 0);
  w.records = [H.record()];
  assert.strictEqual(rt.deliverCycle().delivered, 1, '解消後は送る');
});

// ---------------------------------------------------------------- 宛先・送信前後の障害・結果不明

test('宛先: 特定できなければ送らず(未送信確定)、上限付きで再試行し、上限後は管理者へ引き継ぐ。予約/発行は巻き戻さない', function () {
  var w = mailWorld(); var rt = w.runtime();
  var op = issue(w, rt); open18(w);
  w.recipients = {};
  for (var i = 0; i < 6; i++) { rt.deliverCycle(); w.advance(700); }
  assert.strictEqual(w.userMails.length, 0);
  assert.strictEqual(w.userMailAttempts, 0, '宛先未解決では送信手段を呼ばない');
  var d = dlvOf(w, op);
  assert.strictEqual(d.state, D.NOT_SENT);
  assert.strictEqual(d.attempts, 3);
  assert.strictEqual(ops(w).filter(function (o) { return o.id === op.id; })[0].state, S.ISSUED_CONFIRMED, '予約・キーは巻き戻さない');
  var subjects = w.mails.map(function (m) { return m.subject; }).join('\n');
  assert.ok(/DELIVERY_RECIPIENT_UNRESOLVED/.test(subjects));
  assert.ok(/DELIVERY_RETRY_EXHAUSTED/.test(subjects));
  // 管理者が再送を許可 → 宛先が直った後に1通だけ送る
  w.recipients = { 'SNB-1': 'guest@example.test' };
  assert.strictEqual(rt.admin('resolveDelivery', { recId: op.id, decision: 'ALLOW_RESEND' }).ok, true);
  rt.deliverCycle();
  assert.strictEqual(w.userMails.length, 1);
  assert.strictEqual(dlvOf(w, op).seq, 2);
});

test('宛先: 台帳に同一予約が複数/メール形式が複数宛先の場合は特定できず送らない(誤配送防止)', function () {
  var w = mailWorld(); var rt = w.runtime();
  issue(w, rt); open18(w);
  w.recipients['SNB-1'] = 'a@example.test, b@example.test';
  rt.deliverCycle();
  assert.strictEqual(w.userMails.length, 0);
  w.recipients['SNB-1'] = 'a@example.test;b@example.test';
  w.advance(700); rt.deliverCycle();
  assert.strictEqual(w.userMails.length, 0);
  w.recipients['SNB-1'] = '山田 <a@example.test>';
  w.advance(700); rt.deliverCycle();
  assert.strictEqual(w.userMails.length, 0);
});

test('送信前の障害: 送信前の状態保存に失敗したらメールを送らない。送信が「未送信確定」で失敗したら上限付きで再試行', function () {
  var w = mailWorld(); var rt = w.runtime();
  var op = issue(w, rt); open18(w);
  w.storeFail = function (k, v) { return k.indexOf('DLV_') === 0 && /"state":"SENDING"/.test(v); };
  var r = rt.deliverCycle();
  assert.strictEqual(w.userMailAttempts, 0);
  assert.strictEqual(w.userMails.length, 0);
  assert.strictEqual(r.held, 1);
  w.storeFail = null;
  w.mailMode = 'notSent'; // 日次送信枠切れなど、送信していないと確定した失敗
  rt.deliverCycle();
  assert.strictEqual(dlvOf(w, op).state, D.NOT_SENT);
  assert.strictEqual(w.userMails.length, 0);
  w.mailMode = 'ok'; w.advance(700);
  assert.strictEqual(rt.deliverCycle().delivered, 1);
  assert.strictEqual(w.userMails.length, 1);
  assert.strictEqual(dlvOf(w, op).attempts, 2);
});

test('結果不明(送信成功→結果保存失敗): 無条件再送せず UNKNOWN にして管理者へ。何サイクル回っても1通のまま', function () {
  var w = mailWorld(); var rt = w.runtime();
  var op = issue(w, rt); open18(w);
  w.storeFail = function (k, v) { return k.indexOf('DLV_') === 0 && /"state":"DELIVERED"/.test(v); };
  rt.deliverCycle();
  assert.strictEqual(w.userMails.length, 1, '外部送信は済んでいる');
  assert.strictEqual(dlvOf(w, op).state, D.SENDING, '結果が記録できていない');
  w.storeFail = null;
  for (var i = 0; i < 4; i++) { w.advance(300); rt.deliverCycle(); }
  assert.strictEqual(w.userMails.length, 1, '再送しない');
  assert.strictEqual(dlvOf(w, op).state, D.UNKNOWN);
  assert.ok(w.mails.some(function (m) { return /DELIVERY_UNKNOWN/.test(m.subject); }), '管理者へ通知');
  assert.strictEqual(w.mails.filter(function (m) { return /DELIVERY_UNKNOWN/.test(m.subject); }).length, 1, '通知は重複しない');
});

test('結果不明(送信手段が曖昧な例外/応答喪失): UNKNOWN。管理者が「配送済み確認」すれば再送せず、「再送許可」なら配送ID(連番)を変えて1通だけ再送', function () {
  var w = mailWorld(); var rt = w.runtime();
  var op = issue(w, rt); open18(w);
  w.mailMode = 'throwUnknown';
  rt.deliverCycle();
  assert.strictEqual(dlvOf(w, op).state, D.UNKNOWN);
  w.mailMode = 'ok';
  for (var i = 0; i < 3; i++) { w.advance(700); rt.deliverCycle(); }
  assert.strictEqual(w.userMails.length, 0, '自動再送しない');
  var firstId = dlvOf(w, op).deliveryId;
  // 認可: 管理者以外は判断できない
  w.identity = { email: 'stranger@example.test' };
  assert.strictEqual(rt.admin('resolveDelivery', { recId: op.id, decision: 'ALLOW_RESEND' }).ok, false);
  w.identity = { email: 'owner@example.test' };
  assert.strictEqual(rt.admin('resolveDelivery', { recId: op.id, decision: 'BOGUS' }).error, 'DECISION_INVALID');
  assert.strictEqual(rt.admin('resolveDelivery', { recId: op.id, decision: 'ALLOW_RESEND' }).ok, true);
  rt.deliverCycle();
  assert.strictEqual(w.userMails.length, 1);
  var d = dlvOf(w, op);
  assert.strictEqual(d.state, D.DELIVERED);
  assert.notStrictEqual(d.deliveryId, firstId);
  assert.ok(w.props['ADMINLOG_' + Object.keys(w.props).filter(function (k) { return k.indexOf('ADMINLOG_') === 0; })[0].slice(9)].indexOf('ADMIN-1') !== -1, '監査にラベル');

  var w2 = mailWorld(); var rt2 = w2.runtime();
  var op2 = issue(w2, rt2); open18(w2);
  w2.mailMode = 'sendThenThrow';
  rt2.deliverCycle();
  assert.strictEqual(w2.userMails.length, 1);
  assert.strictEqual(dlvOf(w2, op2).state, D.UNKNOWN);
  w2.mailMode = 'ok';
  assert.strictEqual(rt2.admin('resolveDelivery', { recId: op2.id, decision: 'CONFIRM_DELIVERED' }).ok, true);
  rt2.deliverCycle(); w2.advance(700); rt2.deliverCycle();
  assert.strictEqual(w2.userMails.length, 1, '配送済み確認後は再送しない');
  assert.strictEqual(dlvOf(w2, op2).state, D.DELIVERED);
});

test('再案内: 配送済みでも未着の申出を管理者が確認すれば上限付きで再案内できる。GIVE_UPは以後メールしない', function () {
  var w = mailWorld(); var rt = w.runtime();
  var op = issue(w, rt); open18(w);
  rt.deliverCycle();
  assert.strictEqual(w.userMails.length, 1);
  assert.strictEqual(rt.admin('resolveDelivery', { recId: op.id, decision: 'CONFIRM_DELIVERED' }).ok, false, '配送済みに対しては不要');
  assert.strictEqual(rt.admin('resolveDelivery', { recId: op.id, decision: 'REGUIDE' }).ok, true);
  rt.deliverCycle();
  assert.strictEqual(w.userMails.length, 2);
  assert.strictEqual(w.userMails[1].body.indexOf(w.createdPasswords[0]) !== -1, true, '同じ有効コードを再案内');
  assert.strictEqual(rt.admin('resolveDelivery', { recId: op.id, decision: 'REGUIDE' }).ok, true);
  rt.deliverCycle();
  assert.strictEqual(w.userMails.length, 3);
  assert.strictEqual(rt.admin('resolveDelivery', { recId: op.id, decision: 'REGUIDE' }).error, 'REGUIDE_LIMIT');
  rt.deliverCycle(); rt.deliverCycle();
  assert.strictEqual(w.userMails.length, 3);

  var w2 = mailWorld(); var rt2 = w2.runtime();
  var op2 = issue(w2, rt2); open18(w2);
  w2.mailMode = 'throwUnknown'; rt2.deliverCycle(); w2.mailMode = 'ok';
  assert.strictEqual(rt2.admin('resolveDelivery', { recId: op2.id, decision: 'GIVE_UP' }).ok, true);
  rt2.deliverCycle(); w2.advance(700); rt2.deliverCycle();
  assert.strictEqual(w2.userMails.length, 0);
  assert.strictEqual(dlvOf(w2, op2).state, D.SUPPRESSED);
});

test('再案内の安全: 取消・旧revisionのキーに対しては管理者の再送許可でも送らない', function () {
  var w = mailWorld(); var rt = w.runtime();
  var op = issue(w, rt); open18(w);
  w.mailMode = 'throwUnknown'; rt.deliverCycle(); w.mailMode = 'ok';
  w.records = [H.record({ status: 'CANCELLED', revision: 2 })];
  settle(w, rt); // 取消 → 旧キー削除へ
  var res = rt.admin('resolveDelivery', { recId: op.id, decision: 'ALLOW_RESEND' });
  assert.strictEqual(res.ok, false);
  rt.deliverCycle();
  assert.strictEqual(w.userMails.length, 0);
});

// ---------------------------------------------------------------- 延長・変更の未達

test('延長: 新コードが未達/結果不明なら管理者へ別分類で通知し、利用可能とは案内しない（メールも送らない）', function () {
  var w = mailWorld(); var rt = w.runtime();
  issue(w, rt); open18(w);
  rt.deliverCycle(); // 初回は届いた
  w.records = [H.record({ endAt: H.jst('2030-01-11', '14:00'), revision: 2 })];
  w.deleteMode = 'noCommandId';
  for (var i = 0; i < 6 && !ops(w).some(function (o) { return o.revision === 2 && o.state === S.ISSUED_CONFIRMED; }); i++) {
    w.advance(300); rt.syncCycle();
    var pend = ops(w).filter(function (o) { return o.revision === 2 && o.state === S.SENT_WAIT_WEBHOOK; })[0];
    if (pend) { w.advance(10); rt.handleWebhook(H.webhook({ commandId: pend.commandId }), H.TOKEN, H.TOKEN); w.advance(290); rt.syncCycle(); }
  }
  w.mailMode = 'throwUnknown';
  rt.deliverCycle();
  var subjects = w.mails.map(function (m) { return m.subject; }).join('\n');
  assert.ok(/CHANGE_CODE_UNDELIVERED/.test(subjects));
  assert.ok(/DELIVERY_UNKNOWN/.test(subjects));
  var note = w.mails.filter(function (m) { return /CHANGE_CODE_UNDELIVERED/.test(m.subject); })[0].body;
  assert.ok(/「利用可能」と案内しない/.test(note));
  assert.ok(/代替入室/.test(note));
  assert.ok(!/キーボックス.*[0-9]{4}/.test(note), '保管場所や番号は通知に書かない');
  assert.ok(!PW8.test(note));
  assert.strictEqual(w.userMails.length, 1, '新コードは未達のまま追加送信しない');
});

// ---------------------------------------------------------------- 同時配送

test('同時配送: ロックを取得できない/並行実行でも二重送信しない', function () {
  var w = mailWorld(); var rt = w.runtime(); var rt2 = w.runtime();
  issue(w, rt); open18(w);
  var inner = null;
  w.mailHook = function () { inner = rt2.deliverCycle(); }; // 送信中に別インスタンスが配送を試みる
  rt.deliverCycle();
  assert.strictEqual(inner.error, 'LOCK_UNAVAILABLE');
  assert.strictEqual(w.userMails.length, 1);
  w.mailHook = null;
  rt2.deliverCycle(); rt.deliverCycle();
  assert.strictEqual(w.userMails.length, 1);
});

// ---------------------------------------------------------------- 秘密・文面

test('秘密: コードは利用者メールにだけ載り、状態・通知・監査・配送記録・予約確認系には出ない', function () {
  var w = mailWorld(); var rt = w.runtime();
  issue(w, rt); open18(w);
  rt.deliverCycle();
  var code = w.createdPasswords[0];
  var dump = JSON.stringify(w.props) + JSON.stringify(w.mails) + JSON.stringify(rt.admin('status', {})) + JSON.stringify(rt.admin('inventory', {}));
  assert.strictEqual(dump.indexOf(code), -1);
  assert.strictEqual(w.userMails.filter(function (m) { return m.body.indexOf(code) !== -1; }).length, 1);
  var body = w.userMails[0].body;
  assert.strictEqual(body.indexOf(H.DEV), -1, '完全な端末IDを載せない');
  assert.ok(!/キーボックス|バックアップ|物理キー|手動/.test(body), '代替入室の手段・保管場所は定型メールに載せない');
  var d = dlvOf(w, ops(w)[0]);
  assert.deepStrictEqual(Object.keys(d).filter(function (k) { return /code|pass|mail|to$|recipient/i.test(k); }), [], '配送記録は宛先・コードを持たない');
});

test('文面: 初回案内と変更案内の固定文面。不正なコードや時間ではメールを作らない', function () {
  var st = Infra.deliverySettings({ delivery: H.DELIVERY_CFG });
  var start = Core.jstToEpochSec('2030-01-11', '09:44'), end = Core.jstToEpochSec('2030-01-11', '12:15');
  var a = Infra.renderCodeMail({ code: '12345678', startSec: start, endSec: end, kind: 'INITIAL', bookingRef: 'SNB-1', settings: st });
  assert.ok(/2030年1月11日 9:44 〜 2030年1月11日 12:15/.test(a.body));
  assert.ok(/暗証番号: 12345678/.test(a.body));
  assert.ok(/予約番号 SNB-1/.test(a.body));
  assert.ok(!/変更/.test(a.subject));
  assert.ok(a.body.indexOf(H.DELIVERY_CFG.inquiryNote) !== -1);
  var c = Infra.renderCodeMail({ code: '12345678', startSec: start, endSec: end, kind: 'CHANGE', previousInvalidated: true, bookingRef: 'SNB-1', settings: st });
  assert.ok(/変更のお知らせ/.test(c.subject));
  assert.ok(/以前にお送りした暗証番号は使用できません/.test(c.body));
  var c2 = Infra.renderCodeMail({ code: '12345678', startSec: start, endSec: end, kind: 'CHANGE', previousInvalidated: false, bookingRef: 'SNB-1', settings: st });
  assert.ok(!/使用できません。本メール/.test(c2.body), '失効未確認のときは旧番号の失効を断言しない');
  ['abc', '12345', '123456789012345', null, undefined].forEach(function (bad) {
    var e = null; try { Infra.renderCodeMail({ code: bad, startSec: start, endSec: end, kind: 'INITIAL', settings: st }); } catch (x) { e = x; }
    assert.ok(e && e.notSent === true, String(bad));
  });
  var e2 = null; try { Infra.renderCodeMail({ code: '12345678', startSec: end, endSec: start, kind: 'INITIAL', settings: st }); } catch (x) { e2 = x; }
  assert.ok(e2 && e2.notSent === true);
  var injected = Infra.renderCodeMail({ code: '12345678', startSec: start, endSec: end, kind: 'INITIAL', bookingRef: 'SNB-1\nBcc: x@evil.test', settings: st });
  assert.ok(injected.body.indexOf('Bcc') === -1, '予約番号に改行等があれば載せない');
});

// ---------------------------------------------------------------- 台帳の宛先読取（送信時の1件のみ）

function fakeSheet(rows, headers) {
  var reads = [];
  var grid = [headers].concat(rows);
  return {
    reads: reads,
    getLastColumn: function () { return headers.length; },
    getLastRow: function () { return grid.length; },
    getRange: function (r, c, nr, nc) {
      return { getValues: function () {
        reads.push({ r: r, c: c, nr: nr, nc: nc });
        var out = [];
        for (var i = 0; i < nr; i++) { var line = []; for (var j = 0; j < nc; j++) line.push((grid[r - 1 + i] || [])[c - 1 + j]); out.push(line); }
        return out;
      } };
    }
  };
}

test('宛先読取: 一致した1行の email セルだけを読む。0件・複数件・列欠落・不正形式は ok:false', function () {
  var H1 = ['bookingId', 'name', 'email', 'phone'];
  var sh = fakeSheet([['B-1', 'PII', 'a@example.test', '090'], ['B-2', 'PII2', 'b@example.test', '080']], H1);
  var r = Reader.readRecipient(sh, 'B-2');
  assert.deepStrictEqual(r, { ok: true, to: 'b@example.test' });
  var dataReads = sh.reads.filter(function (x) { return x.r >= 2; });
  assert.ok(dataReads.every(function (x) { return x.nc === 1; }));
  assert.strictEqual(dataReads.filter(function (x) { return x.c === 3; }).length, 1, 'email は1セルだけ');
  assert.strictEqual(dataReads.filter(function (x) { return x.c === 3 && x.nr > 1; }).length, 0, 'email 列を一括で読まない');
  assert.strictEqual(Reader.readRecipient(sh, 'B-9').error, 'RECIPIENT_NOT_FOUND');
  assert.strictEqual(Reader.readRecipient(fakeSheet([['B-1', 'x', 'a@example.test', '']], H1.slice(0, 2)), 'B-1').error, 'RECIPIENT_COLUMN_MISSING');
  assert.strictEqual(Reader.readRecipient(fakeSheet([['B-1', 'x', 'a@example.test', ''], ['B-1', 'y', 'c@example.test', '']], H1), 'B-1').error, 'RECIPIENT_AMBIGUOUS');
  assert.strictEqual(Reader.readRecipient(fakeSheet([['B-1', 'x', 'a@example.test, c@example.test', '']], H1), 'B-1').error, 'RECIPIENT_INVALID');
  assert.strictEqual(Reader.readRecipient(fakeSheet([['B-1', 'x', '', '']], H1), 'B-1').error, 'RECIPIENT_INVALID');
  assert.strictEqual(Reader.readRecipient(fakeSheet([['B-1', 'x', 'a@example.test', '']], ['bookingId', 'email', 'email', 'x']), 'B-1').error, 'RECIPIENT_COLUMN_INVALID');
  assert.strictEqual(Reader.readRecipient({ getLastColumn: function () { throw new Error('boom a@example.test'); } }, 'B-1').ok, false);
  assert.ok(!JSON.stringify(Reader.readRecipient({ getLastColumn: function () { throw new Error('boom a@example.test'); } }, 'B-1')).match(/example/));
});

// ---------------------------------------------------------------- GASシェル（App.gs）: 利用者宛メール・宛先解決・非接続

function loadApp(env) {
  var ctx = vm.createContext({
    console: console, Date: Date, Math: Math, JSON: JSON,
    PropertiesService: { getScriptProperties: function () { return { getProperty: function (k) { return env.script[k] === undefined ? null : env.script[k]; } }; } },
    MailApp: {
      getRemainingDailyQuota: function () { return env.quota; },
      sendEmail: function (o) { env.sent.push(o); if (env.sendThrows) throw new Error('MAIL_SERVICE_ERROR'); }
    },
    UrlFetchApp: { fetch: function (url, options) { return env.sheets.fetch(url, options); } },
    ScriptApp: { getOAuthToken: function () { return 'dummy'; } },
    Utilities: { formatDate: function () { return '+0900'; } }
  });
  ['gas/switchbot-access/AccessLedgerReader.gs', 'gas/switchbot-access/SwitchBotAccessApp.gs'].forEach(function (f) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f });
  });
  return ctx;
}

test('GASシェル: 利用者宛メールは送信枠切れのみ未送信確定、それ以外の例外は結果不明。宛先は台帳から1件だけ読む', function () {
  var HEAD = Reader.REQUIRED_COLUMNS.concat(['name', 'email']);
  var rows = [
    { bookingId: 'SNB-1', startAt: new Date('2030-01-11T10:00:00+09:00'), endAt: new Date('2030-01-11T12:00:00+09:00'), brand: 'snb', status: 'CONFIRMED', revision: 1, name: 'PII', email: 'guest@example.test' },
    { bookingId: 'SNB-2', brand: 'snb', status: 'CONFIRMED', revision: 1, name: 'PII2', email: 'other@example.test' }
  ];
  var env = { script: { LEDGER_SPREADSHEET_ID: 'ss-test' }, quota: 5, sent: [], sheets: SheetsFake.create({ headers: HEAD, rows: rows }) };
  var ctx = loadApp(env);
  assert.deepStrictEqual(Object.assign({}, ctx.sba_resolveRecipient_('SNB-1')), { ok: true, to: 'guest@example.test' });
  assert.strictEqual(ctx.sba_resolveRecipient_('NOPE').ok, false);
  assert.ok(!JSON.stringify(ctx.sba_resolveRecipient_('NOPE')).match(/example/));
  assert.ok(env.sheets.state.readCols.filter(function (c) { return c === 'email'; }).length >= 1);
  ctx.sba_sendUserMail_({ to: 'guest@example.test', subject: 'S', body: 'B', name: 'N', replyTo: 'r@example.test' });
  assert.strictEqual(env.sent.length, 1);
  assert.strictEqual(env.sent[0].replyTo, 'r@example.test');
  assert.strictEqual(env.sent[0].noReply, undefined);
  ctx.sba_sendUserMail_({ to: 'guest@example.test', subject: 'S', body: 'B', name: 'N' });
  assert.strictEqual(env.sent[1].noReply, true);
  env.quota = 0;
  var e1 = null; try { ctx.sba_sendUserMail_({ to: 'a@example.test', subject: 'S', body: 'B', name: 'N' }); } catch (x) { e1 = x; }
  assert.ok(e1 && e1.notSent === true);
  assert.strictEqual(env.sent.length, 2, '枠切れでは送信手段を呼ばない');
  env.quota = 5; env.sendThrows = true;
  var e2 = null; try { ctx.sba_sendUserMail_({ to: 'a@example.test', subject: 'S', body: 'B', name: 'N' }); } catch (x) { e2 = x; }
  assert.ok(e2 && e2.notSent !== true, 'MailApp の例外は結果不明（自動再送しない）');
});

test('静的: 配送は運営承認まで非接続。トリガーは deliveryConfigured===true のときだけ。リポジトリに実宛先・実コードを置かない', function () {
  var app = fs.readFileSync(path.join(ROOT, 'gas/switchbot-access/SwitchBotAccessApp.gs'), 'utf8');
  assert.ok(/if \(cfg\.deliveryConfigured === true\) ScriptApp\.newTrigger\('accessDeliverJob'\)/.test(app));
  assert.ok(!/deliveryConfigured\s*[:=]\s*true/.test(app), '設定をコードで有効にしない');
  // 管理者通知(sendMail)と利用者宛(sendUserMail)は別の関数
  assert.ok(/sendMail: function \(subject, body\) \{ MailApp\.sendEmail\(cfg\.adminMailTo/.test(app));
  assert.ok(/sendUserMail: sba_sendUserMail_/.test(app));
  assert.ok(!/deliverCode:\s*null/.test(app));
  var infra = fs.readFileSync(path.join(ROOT, 'gas/switchbot-access/SwitchBotAccessInfra.gs'), 'utf8');
  assert.ok(/cfg\.deliveryConfigured !== true \|\| !deliveryReady\(\)/.test(infra));
  var m = JSON.parse(fs.readFileSync(path.join(ROOT, 'gas/switchbot-access/appsscript.json'), 'utf8'));
  assert.ok(m.oauthScopes.indexOf('https://www.googleapis.com/auth/spreadsheets.readonly') !== -1);
  assert.ok(m.oauthScopes.indexOf('https://www.googleapis.com/auth/spreadsheets') === -1, 'スコープを広げない');
});

test('ガーベジ回収: 配送記録は参照元OPがある間は保持し、OPが無くなれば回収する', function () {
  var w = mailWorld(); var rt = w.runtime();
  var op = issue(w, rt); open18(w); rt.deliverCycle();
  assert.ok(w.store.get('DLV_' + op.id));
  rt.sweepCycle();
  assert.ok(w.store.get('DLV_' + op.id), 'OP が残る間は保持');
  w.store.set('DLV_ORPHAN:1:****01FD:ISSUE#1', JSON.stringify({ state: 'DELIVERED' }));
  var res = rt.sweepCycle();
  assert.strictEqual(res.removed.DLV, 1);
  assert.strictEqual(w.store.get('DLV_ORPHAN:1:****01FD:ISSUE#1'), null);
});

// ---------------------------------------------------------------- Codex レビュー指摘（P2）の回帰

test('通知の取りこぼし防止: 再試行上限到達時に管理者メールが失敗しても、復旧後に通知だけ再試行する(利用者メールは再送しない)', function () {
  var w = mailWorld(); var rt = w.runtime();
  var op = issue(w, rt); open18(w);
  w.recipients = {};
  w.mailFail = true; // 管理者メール障害
  for (var i = 0; i < 6; i++) { rt.deliverCycle(); w.advance(700); }
  assert.strictEqual(w.mails.length, 0);
  assert.strictEqual(dlvOf(w, op).attempts, 3);
  w.mailFail = false;
  w.recipients = { 'SNB-1': 'guest@example.test' };
  rt.deliverCycle(); rt.deliverCycle();
  var subjects = w.mails.map(function (m) { return m.subject; }).join('\n');
  assert.ok(/DELIVERY_RETRY_EXHAUSTED/.test(subjects), '上限到達の通知が復旧後に届く');
  assert.ok(/DELIVERY_RECIPIENT_UNRESOLVED/.test(subjects));
  assert.strictEqual(w.userMails.length, 0, '利用者メールは自動再送しない');
  var n = w.mails.length;
  rt.deliverCycle(); rt.deliverCycle();
  assert.strictEqual(w.mails.length, n, '通知済みなら重複しない');
});

test('変更案内の判定: REGUIDE が未送信確定で失敗して NOT_SENT に戻っても、過去に届いた事実から新コードを変更案内として送り、未達なら CHANGE_CODE_UNDELIVERED', function () {
  var w = mailWorld(); var rt = w.runtime();
  var op1 = issue(w, rt); open18(w);
  rt.deliverCycle();
  assert.strictEqual(w.userMails.length, 1);
  rt.admin('resolveDelivery', { recId: op1.id, decision: 'REGUIDE' });
  w.mailMode = 'notSent'; rt.deliverCycle(); w.mailMode = 'ok';
  assert.strictEqual(dlvOf(w, op1).state, D.NOT_SENT);
  w.records = [H.record({ endAt: H.jst('2030-01-11', '14:00'), revision: 2 })];
  w.deleteMode = 'noCommandId';
  for (var i = 0; i < 6 && !ops(w).some(function (o) { return o.revision === 2 && o.state === S.ISSUED_CONFIRMED; }); i++) {
    w.advance(300); rt.syncCycle();
    var pend = ops(w).filter(function (o) { return o.revision === 2 && o.state === S.SENT_WAIT_WEBHOOK; })[0];
    if (pend) { w.advance(10); rt.handleWebhook(H.webhook({ commandId: pend.commandId }), H.TOKEN, H.TOKEN); w.advance(290); rt.syncCycle(); }
  }
  w.mailMode = 'notSent';
  rt.deliverCycle();
  var op2 = ops(w).filter(function (o) { return o.revision === 2 && o.state === S.ISSUED_CONFIRMED; })[0];
  assert.strictEqual(dlvOf(w, op2).kind, 'CHANGE');
  assert.ok(w.mails.some(function (m) { return /CHANGE_CODE_UNDELIVERED/.test(m.subject); }));
  w.mailMode = 'ok'; w.advance(700);
  rt.deliverCycle();
  var last = w.userMails[w.userMails.length - 1];
  assert.ok(/変更のお知らせ/.test(last.subject));
  assert.ok(/以前にお送りした暗証番号は使用できません/.test(last.body));
});

test('通知の取りこぼし防止(レビュー指摘): 変更コード未達の通知だけ失敗しても、復旧後に通知だけ追いつく(利用者メールは再送しない)', function () {
  var w = mailWorld(); var rt = w.runtime();
  var op1 = issue(w, rt); open18(w);
  rt.deliverCycle();
  assert.strictEqual(w.userMails.length, 1);
  w.records = [H.record({ endAt: H.jst('2030-01-11', '14:00'), revision: 2 })];
  w.deleteMode = 'noCommandId';
  for (var i = 0; i < 6 && !ops(w).some(function (o) { return o.revision === 2 && o.state === S.ISSUED_CONFIRMED; }); i++) {
    w.advance(300); rt.syncCycle();
    var pend = ops(w).filter(function (o) { return o.revision === 2 && o.state === S.SENT_WAIT_WEBHOOK; })[0];
    if (pend) { w.advance(10); rt.handleWebhook(H.webhook({ commandId: pend.commandId }), H.TOKEN, H.TOKEN); w.advance(290); rt.syncCycle(); }
  }
  w.mailMode = 'throwUnknown';
  w.mailFailIf = function (subject) { return /CHANGE_CODE_UNDELIVERED/.test(subject); }; // 後者の通知だけ一時失敗
  rt.deliverCycle();
  var op2 = ops(w).filter(function (o) { return o.revision === 2 && o.state === S.ISSUED_CONFIRMED; })[0];
  assert.strictEqual(dlvOf(w, op2).state, D.UNKNOWN);
  assert.ok(w.mails.some(function (m) { return /DELIVERY_UNKNOWN/.test(m.subject); }));
  assert.ok(!w.mails.some(function (m) { return /CHANGE_CODE_UNDELIVERED/.test(m.subject); }));
  w.mailFailIf = null; w.mailMode = 'ok';
  rt.deliverCycle();
  assert.ok(w.mails.some(function (m) { return /CHANGE_CODE_UNDELIVERED/.test(m.subject); }), '復旧後に追いつく');
  var n = w.mails.length, attempts = w.userMailAttempts;
  rt.deliverCycle(); rt.deliverCycle();
  assert.strictEqual(w.mails.length, n, '通知済みなら重複しない');
  assert.strictEqual(w.userMailAttempts, attempts, '利用者メールは再送しない');
  assert.strictEqual(w.userMails.length, 1);
  assert.ok(op1.id !== op2.id);
});

test('通知の取りこぼし防止(再レビュー指摘): 再試行上限到達で変更コード未達の通知だけ失敗しても、復旧後に通知だけ追いつく', function () {
  var w = mailWorld(); var rt = w.runtime();
  issue(w, rt); open18(w);
  rt.deliverCycle();
  w.records = [H.record({ endAt: H.jst('2030-01-11', '14:00'), revision: 2 })];
  w.deleteMode = 'noCommandId';
  for (var i = 0; i < 6 && !ops(w).some(function (o) { return o.revision === 2 && o.state === S.ISSUED_CONFIRMED; }); i++) {
    w.advance(300); rt.syncCycle();
    var pend = ops(w).filter(function (o) { return o.revision === 2 && o.state === S.SENT_WAIT_WEBHOOK; })[0];
    if (pend) { w.advance(10); rt.handleWebhook(H.webhook({ commandId: pend.commandId }), H.TOKEN, H.TOKEN); w.advance(290); rt.syncCycle(); }
  }
  w.mailMode = 'notSent'; // 3回とも未送信確定
  w.mailFailIf = function (subject) { return /CHANGE_CODE_UNDELIVERED/.test(subject); };
  for (var j = 0; j < 5; j++) { rt.deliverCycle(); w.advance(700); }
  var subjects = function () { return w.mails.map(function (m) { return m.subject; }).join('\n'); };
  assert.ok(/DELIVERY_RETRY_EXHAUSTED/.test(subjects()));
  assert.ok(!/CHANGE_CODE_UNDELIVERED/.test(subjects()));
  w.mailFailIf = null; w.mailMode = 'ok';
  var attempts = w.userMailAttempts, before = w.mails.length;
  rt.deliverCycle();
  assert.ok(/CHANGE_CODE_UNDELIVERED/.test(subjects()), '復旧後に追いつく');
  assert.strictEqual(w.mails.length, before + 1, '他の管理者通知は重複しない');
  rt.deliverCycle(); rt.deliverCycle();
  assert.strictEqual(w.mails.length, before + 1);
  assert.strictEqual(w.userMailAttempts, attempts, '利用者メールは再送しない');
  assert.strictEqual(w.userMails.length, 1);
});

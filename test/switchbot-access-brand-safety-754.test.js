/*
 * Issue #754 / #756 参照: brand（SNB／mens／studio_x／空）まわりの安全性の固定。実API・実機・実台帳には接続しない（フェイクのみ）。
 *
 *  B1 validateConfig: eligibleBrands に空文字・未知ブランド・非配列が混入した設定は拒否（未設定・正常値は許容）。拒否時は全ジョブが何も送らない
 *  B2 空brand×CONFIRMED は createKey=0／BOOKING_FROZEN 通知（誤発行しない）。mens／studio_x も発行しない
 *  B3 空brandで既に鍵が発行された記録がある場合の取消・削除・UNKNOWN・期限切れ・管理者回収（現行挙動の明示）
 *  B4 AccessLedgerReader.select: 空brandは照合候補に含むが SNB 認定ではない／mens・studio_x は候補に含まない
 *
 * B3 の注意（設計変更は提案のみ。本PRは現行挙動をテストで明示する）:
 *   空brand×CONFIRMED で既存キーがある場合、スナップショットが FREEZE するため自動削除は行われない（旧キーは自然失効まで残り、
 *   期限後に EXPIRED_KEY_REMAINS を管理者へ通知）。管理者の個別削除（accessAdminDelete）で回収できる。
 */
'use strict';

var test = require('node:test');
var assert = require('node:assert');
var fs = require('fs');
var path = require('path');
var vm = require('vm');
var H = require('./helpers/switchbot-access-world');
var Infra = require('../gas/switchbot-access/SwitchBotAccessInfra.gs');
var S = H.Core.STATE;

var SYNC_SEC = 300;

function validCfg(over) {
  return Object.assign({
    environment: 'production', allowedLast4: ['01FD'], keypads: [{ deviceId: 'DEVICE00000001FD' }],
    ledgerTarget: { facility: 'snb' }, adminMailTo: ['ops@example.test']
  }, over || {});
}

function cycle(w, rt, n) { for (var i = 0; i < n; i++) { w.advance(SYNC_SEC); rt.syncCycle(); } }
function ops(w) {
  return w.store.keys().filter(function (k) { return k.indexOf('OP_') === 0; }).map(function (k) { return JSON.parse(w.store.get(k)); });
}
function states(w) { return ops(w).map(function (o) { return o.state; }); }
function subjects(w) { return w.mails.map(function (m) { return m.subject; }); }
function has(w, re) { return subjects(w).some(function (s) { return re.test(s); }); }

/** 発行確認まで進めた世界（commandIdなし経路。#801 と同じ前提）。 */
function issuedWorld() {
  var w = H.createWorld({ mail: false });
  w.createMode = 'noCommandId';
  w.deleteMode = 'noCommandId';
  var rt = w.runtime();
  w.records = [H.record()];
  cycle(w, rt, 3);
  assert.deepStrictEqual(states(w), [S.ISSUED_CONFIRMED], '前提: SNB・CONFIRMEDで発行確認済み');
  assert.strictEqual(w.callCount('createKey'), 1);
  return { w: w, rt: rt };
}

// ================================================================ B1: validateConfig

test('B1: eligibleBrands が既知ブランドのみ（snb／mens／studio_x）なら有効。未設定・空配列も許容（コアが発行対象なしとして止める）', function () {
  assert.strictEqual(Infra.validateConfig(validCfg()).ok, true, '未設定（既存の本番設定と互換）');
  [['snb'], ['snb', 'mens'], ['snb', 'mens', 'studio_x'], []].forEach(function (v) {
    var r = Infra.validateConfig(validCfg({ eligibleBrands: v }));
    assert.strictEqual(r.ok, true, JSON.stringify(v));
    assert.deepStrictEqual(r.errors, []);
  });
});

test('B1: eligibleBrands に空文字・未知ブランド・表記ゆれ・非文字列・非配列が混入した設定は ELIGIBLE_BRANDS_INVALID で拒否', function () {
  var bad = [
    [''], ['snb', ''], ['unknown'], ['SNB'], [' snb'], ['snb '], ['studio-x'], ['snb', 'x'],
    [null], [undefined], [0], [false], [['snb']], [{ brand: 'snb' }],
    'snb', '', 0, null, {}, { 0: 'snb' }, true
  ];
  bad.forEach(function (v) {
    var r = Infra.validateConfig(validCfg({ eligibleBrands: v }));
    assert.strictEqual(r.ok, false, JSON.stringify(v));
    assert.ok(r.errors.indexOf('ELIGIBLE_BRANDS_INVALID') !== -1, JSON.stringify(v) + ' → ' + r.errors.join(','));
  });
});

test('B1: eligibleBrands の不備は他の設定エラーと独立に報告され、他のエラーを隠さない', function () {
  var r = Infra.validateConfig(validCfg({ eligibleBrands: [''], adminMailTo: [] }));
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.indexOf('ELIGIBLE_BRANDS_INVALID') !== -1 && r.errors.indexOf('ADMIN_MAIL_MISSING') !== -1);
});

test('B1: eligibleBrands に空文字が混入した設定では、全ジョブが CONFIG_INVALID で何も送らない（発行・削除・メールなし）', function () {
  ['', 'unknown'].forEach(function (bad) {
    var w = H.createWorld({ mail: false, cfg: { eligibleBrands: ['snb', bad] } });
    w.createMode = 'noCommandId';
    var rt = w.runtime();
    w.records = [H.record()];
    for (var i = 0; i < 3; i++) {
      w.advance(SYNC_SEC);
      var r = rt.syncCycle();
      assert.strictEqual(r.ok, false, JSON.stringify(bad));
      assert.strictEqual(r.error, 'CONFIG_INVALID');
    }
    [rt.sweepCycle(), rt.deliverCycle()].forEach(function (x) { assert.strictEqual(x.ok, false); });
    assert.strictEqual(w.callCount('createKey'), 0, '発行しない');
    assert.strictEqual(w.callCount('deleteKey'), 0, '削除しない');
    assert.strictEqual(ops(w).length, 0, '状態（OP）を作らない');
  });
});

test('B1: 正常な eligibleBrands=["snb"] では、これまでどおり SNB・CONFIRMED が発行される（回帰）', function () {
  var w = H.createWorld({ mail: false, cfg: { eligibleBrands: ['snb'] } });
  w.createMode = 'noCommandId';
  var rt = w.runtime();
  w.records = [H.record()];
  cycle(w, rt, 3);
  assert.strictEqual(w.callCount('createKey'), 1);
  assert.deepStrictEqual(states(w), [S.ISSUED_CONFIRMED]);
});

test('B1: 診断（設定検証）にも反映される。固定コードのみで、ブランド値そのものは出さない', function () {
  var r = Infra.validateConfig(validCfg({ eligibleBrands: ['SECRET-LIKE-VALUE'] }));
  assert.strictEqual(r.ok, false);
  assert.ok(JSON.stringify(r).indexOf('SECRET-LIKE-VALUE') === -1, '検証結果に値を含めない');
});

// ================================================================ B2: 空brand×CONFIRMED は発行しない

function blankWorld(brand, extra) {
  var w = H.createWorld({ mail: false });
  w.createMode = 'noCommandId';
  w.deleteMode = 'noCommandId';
  var rt = w.runtime();
  w.records = [H.record(Object.assign({ brand: brand }, extra || {}))];
  return { w: w, rt: rt };
}

test('B2: brand が空・CONFIRMED は createKey=0・deleteKey=0・BOOKING_FROZEN 通知。状態（OP）も作らない', function () {
  ['', undefined, null].forEach(function (brand) {
    var x = blankWorld(brand);
    cycle(x.w, x.rt, 6);
    assert.strictEqual(x.w.callCount('createKey'), 0, 'brand=' + JSON.stringify(brand));
    assert.strictEqual(x.w.callCount('deleteKey'), 0);
    assert.strictEqual(ops(x.w).length, 0);
    assert.ok(has(x.w, /BOOKING_FROZEN/), '管理者へ凍結通知');
    assert.strictEqual(x.w.mails.filter(function (m) { return /[0-9]{8}/.test(m.body); }).length, 0, '通知に暗証番号を載せない');
  });
});

test('B2: 凍結通知は周期ごとに増えない（同じ事象の重複抑止）', function () {
  var x = blankWorld('');
  cycle(x.w, x.rt, 2);
  var n = x.w.mails.length;
  assert.ok(n >= 1);
  cycle(x.w, x.rt, 12);
  assert.strictEqual(x.w.mails.length, n, '通知が増えない');
});

test('B2: mens／studio_x の CONFIRMED は SNB の鍵発行対象にならない（BRAND_NOT_TARGET。凍結もしない）', function () {
  ['mens', 'studio_x'].forEach(function (brand) {
    var x = blankWorld(brand);
    cycle(x.w, x.rt, 6);
    assert.strictEqual(x.w.callCount('createKey'), 0, brand);
    assert.strictEqual(x.w.callCount('deleteKey'), 0);
    assert.ok(!has(x.w, /BOOKING_FROZEN/), brand + ': 他ブランドは凍結ではなく対象外');
  });
});

test('B2: 空brandの行が、同じ台帳の正常なSNB予約の発行を妨げない（行ごとに独立）', function () {
  var w = H.createWorld({ mail: false });
  w.createMode = 'noCommandId';
  var rt = w.runtime();
  w.records = [H.record({ bookingId: 'SNB-BLANK', brand: '' }), H.record({ bookingId: 'SNB-OK', brand: 'snb' })];
  cycle(w, rt, 3);
  assert.strictEqual(w.callCount('createKey'), 1, '正常なSNB予約だけ発行');
  var issued = ops(w).filter(function (o) { return o.state === S.ISSUED_CONFIRMED; });
  assert.strictEqual(issued.length, 1);
  assert.ok(JSON.stringify(issued[0]).indexOf('SNB-BLANK') === -1, '空brandの予約はOPを持たない');
});

// ================================================================ B3: 空brandで既に鍵が発行された記録がある場合

test('B3-a: 発行済みの予約が空brand×取消に変わると、旧キーは削除確認まで進む（誤発行防止が安全回収を妨げない）', function () {
  var x = issuedWorld();
  x.w.records = [H.record({ brand: '', status: 'CANCELLED', revision: 2 })];
  cycle(x.w, x.rt, 8);
  assert.strictEqual(x.w.callCount('deleteKey'), 1, '旧キーを1回だけ削除');
  assert.deepStrictEqual(states(x.w), [S.DELETED_CONFIRMED]);
  assert.strictEqual(x.w.callCount('createKey'), 1, '再発行しない');
  assert.ok(!has(x.w, /BOOKING_FROZEN/), '取消は凍結しない（回収を優先）');
  cycle(x.w, x.rt, 6);
  assert.strictEqual(x.w.callCount('deleteKey'), 1, '再送しない');
});

test('B3-b: 発行済みの予約が mens／studio_x に変わると、旧SNBキーは削除確認まで進む（既存設計）', function () {
  ['mens', 'studio_x'].forEach(function (brand) {
    var x = issuedWorld();
    x.w.records = [H.record({ brand: brand, revision: 2 })];
    cycle(x.w, x.rt, 8);
    assert.strictEqual(x.w.callCount('deleteKey'), 1, brand);
    assert.deepStrictEqual(states(x.w), [S.DELETED_CONFIRMED], brand);
    assert.strictEqual(x.w.callCount('createKey'), 1, brand + ': 他ブランドへ新規発行しない');
  });
});

test('B3-c: 【現行挙動の明示】発行済みの予約が空brand×CONFIRMEDに変わると凍結され、自動削除も再発行もしない（旧キーは残る）', function () {
  var x = issuedWorld();
  x.w.records = [H.record({ brand: '', revision: 2 })];
  cycle(x.w, x.rt, 8);
  assert.strictEqual(x.w.callCount('deleteKey'), 0, '凍結中は自動削除しない');
  assert.strictEqual(x.w.callCount('createKey'), 1, '再発行しない');
  assert.deepStrictEqual(states(x.w), [S.ISSUED_CONFIRMED], '旧OPは保持（消さない）');
  assert.ok(has(x.w, /BOOKING_FROZEN/), '管理者へ凍結通知');
  assert.strictEqual(x.w.keys[H.DEV].filter(function (k) { return !/^USER-/.test(k.name); }).length, 1, '機器上の旧キーは自然失効まで残る');
});

test('B3-d: 凍結中の旧キーは、期限後に自動削除ON時は回収され(#829)、OFF時は EXPIRED_KEY_REMAINS で通知され管理者の個別削除（OFFでも）で回収できる', function () {
  // 自動削除（ACCESS_ENABLED=ON）: 期限後の sweep が運用キーだけを回収する
  var y = issuedWorld();
  y.w.records = [H.record({ brand: '', revision: 2 })];
  cycle(y.w, y.rt, 4);
  y.w.advance(24 * 3600);
  y.rt.sweepCycle();
  assert.strictEqual(y.w.callCount('deleteKey'), 1, '期限後は sweep が自動削除する');
  assert.deepStrictEqual(states(y.w), [S.DELETED_CONFIRMED]);
  assert.strictEqual(y.w.keys[H.DEV].filter(function (k) { return !/^USER-/.test(k.name); }).length, 0, '運用キーのみ回収');

  // OFF（ロールバック状態）: sweep は削除を送らず通知のみ。管理者の個別削除で回収できる
  var x = issuedWorld();
  x.w.records = [H.record({ brand: '', revision: 2 })];
  cycle(x.w, x.rt, 4);
  x.w.advance(24 * 3600);
  var off = x.w.runtime({ enabled: false });
  off.sweepCycle();
  off.sweepCycle();
  assert.deepStrictEqual(states(x.w), [S.EXPIRED]);
  assert.ok(has(x.w, /EXPIRED_KEY_REMAINS/), '残存を管理者へ通知');
  assert.strictEqual(x.w.callCount('deleteKey'), 0, 'OFF 中の sweep は削除を送らない');
  var rec = ops(x.w)[0];
  var r = off.admin('delete', { recId: rec.id });
  assert.strictEqual(r.ok, true, '管理者削除は空brandの凍結に妨げられない');
  assert.strictEqual(x.w.callCount('deleteKey'), 1);
  assert.strictEqual(x.w.keys[H.DEV].filter(function (k) { return !/^USER-/.test(k.name); }).length, 0, '運用キーは回収済み');
});

test('B3-e: 発行結果が UNKNOWN の予約が空brandに変わっても、自動で再送せず UNKNOWN のまま。管理者の確認で確定できる', function () {
  var w = H.createWorld({ mail: false }); // 既定の経路（commandIdあり）: Webhookが来なければ UNKNOWN
  var rt = w.runtime();
  w.records = [H.record()];
  cycle(w, rt, 4);
  var unknown = ops(w).filter(function (o) { return o.state === S.UNKNOWN; });
  assert.strictEqual(unknown.length, 1, '前提: UNKNOWN で停止');
  var created = w.callCount('createKey'), deleted = w.callCount('deleteKey');
  w.records = [H.record({ brand: '', revision: 2 })];
  cycle(w, rt, 12);
  assert.strictEqual(w.callCount('createKey'), created, '発行を再送しない');
  assert.strictEqual(w.callCount('deleteKey'), deleted, 'UNKNOWN を自動で削除へ進めない');
  assert.strictEqual(ops(w).filter(function (o) { return o.state === S.UNKNOWN; }).length, 1);
  // 管理者の読取専用の再照合は空brandの影響を受けない
  var res = rt.admin('reconcile', { recId: unknown[0].id });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(w.callCount('createKey'), created);
  assert.strictEqual(w.callCount('deleteKey'), deleted, '管理者の再照合も変更APIを送らない');
});

test('B3-f: 空brandの凍結中に、元のbrand（snb）へ戻されたら通常の同期に復帰する（凍結が永続しない。revisionが進むため新キーへ置換）', function () {
  var x = issuedWorld();
  x.w.records = [H.record({ brand: '', revision: 2 })];
  cycle(x.w, x.rt, 4);
  assert.strictEqual(x.w.callCount('deleteKey'), 0);
  x.w.records = [H.record({ brand: 'snb', revision: 3 })];
  cycle(x.w, x.rt, 8);
  // revision が進んでいるため、既存の設計どおり旧キーを削除してから新しいキーに置き換える（空brand由来の特別扱いではない）
  assert.strictEqual(x.w.callCount('deleteKey'), 1, '旧キーを1回だけ削除');
  assert.strictEqual(x.w.callCount('createKey'), 2, '置換の新キー1件のみ');
  var current = ops(x.w).filter(function (o) { return o.state === S.ISSUED_CONFIRMED; });
  assert.strictEqual(current.length, 1, '有効な運用キーは1件だけ');
  assert.strictEqual(x.w.keys[H.DEV].filter(function (k) { return !/^USER-/.test(k.name); }).length, 1, '機器上の運用キーは常に1件');
  cycle(x.w, x.rt, 6);
  assert.strictEqual(x.w.callCount('createKey'), 2, '以後は再発行しない');
  assert.strictEqual(x.w.callCount('deleteKey'), 1, '以後は再削除しない');
});

// ================================================================ B4: AccessLedgerReader.select

function loadReader() {
  var ctx = vm.createContext({ console: console, Date: Date, Math: Math, JSON: JSON });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../gas/booking/shared/AccessKeySnapshot.gs'), 'utf8'), ctx, { filename: 'AccessKeySnapshot.gs' });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../gas/switchbot-access/AccessLedgerReader.gs'), 'utf8'), ctx, { filename: 'AccessLedgerReader.gs' });
  return ctx.AccessLedgerReader;
}

test('B4: select は 既知の対象ブランド（snb/mens/studio_x）と空brand を照合候補に含む。未知ブランドは含めない（#824）', function () {
  var R = loadReader();
  var now = Date.parse('2030-01-10T13:00:00+09:00');
  var start = new Date('2030-01-11T10:00:00+09:00');
  function pick(brand) {
    var cols = { bookingId: ['B1'], startAt: [start], endAt: [new Date(start.getTime() + 7200000)], brand: [brand] };
    ['status', 'paymentMethod', 'paymentStatus', 'paymentConfirmedAt', 'confirmedAt', 'expiredAt', 'feeSettlementState', 'feeRecoveryRequiredAt', 'paymentRecoveryRequiredAt', 'revision']
      .forEach(function (c) { cols[c] = ['']; });
    return R.select(cols, now, []).length;
  }
  assert.strictEqual(pick('snb'), 1);
  assert.strictEqual(pick(''), 1, '空brandは候補（SNB認定ではない。下流で BRAND_UNKNOWN 凍結）');
  assert.strictEqual(pick('mens'), 1, '#824: Mens も当日・翌日の候補');
  assert.strictEqual(pick('studio_x'), 1, '#824: Studio X も当日・翌日の候補');
  assert.strictEqual(pick('unknown'), 0);
  assert.strictEqual(pick('studio-x'), 0, '表記ゆれの未知ブランドは候補にしない');
});

test('#824: 候補の正本 AccessKeySnapshot.TARGET_BRANDS は設定検証の既知ブランドと一致する', function () {
  var ctx = vm.createContext({ console: console, Date: Date, Math: Math, JSON: JSON });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../gas/booking/shared/AccessKeySnapshot.gs'), 'utf8'), ctx, { filename: 'AccessKeySnapshot.gs' });
  var target = Array.from(vm.runInContext('AccessKeySnapshot.TARGET_BRANDS', ctx));
  assert.deepStrictEqual(target, ['snb', 'mens', 'studio_x']);
  target.forEach(function (b) {
    assert.ok(Infra.validateConfig(validCfg({ eligibleBrands: [b] })).ok, b);
  });
  assert.ok(Infra.validateConfig(validCfg({ eligibleBrands: ['studio-x'] })).errors.indexOf('ELIGIBLE_BRANDS_INVALID') !== -1);
});

test('#824: select は当日・翌日以外の mens/studio_x を候補にせず、trackedIds 経路は維持する', function () {
  var R = loadReader();
  var now = Date.parse('2030-01-10T13:00:00+09:00');
  var far = new Date('2030-01-20T10:00:00+09:00');
  var cols = { bookingId: ['M1', 'X1'], startAt: [far, far], endAt: [far, far], brand: ['mens', 'studio_x'] };
  ['status', 'paymentMethod', 'paymentStatus', 'paymentConfirmedAt', 'confirmedAt', 'expiredAt', 'feeSettlementState', 'feeRecoveryRequiredAt', 'paymentRecoveryRequiredAt', 'revision']
    .forEach(function (c) { cols[c] = ['', '']; });
  assert.strictEqual(R.select(cols, now, []).length, 0);
  assert.deepStrictEqual(Array.from(R.select(cols, now, ['M1']).map(function (r) { return r.bookingId; })), ['M1']);
});

test('B4: select のコメントに「空brandは凍結/管理者確認のための候補で、SNB認定ではない」ことが明記されている', function () {
  var src = fs.readFileSync(path.join(__dirname, '../gas/switchbot-access/AccessLedgerReader.gs'), 'utf8');
  assert.ok(/空brandは「SNBと認定」ではない/.test(src));
  assert.ok(/BRAND_UNKNOWN/.test(src));
});

// ================================================================ P: 限定稼働の予約ID許可リスト（#757）

test('P1: validateConfig は pilotBookingIds を空でない文字列の配列のみ許容（未設定・空配列は可）', function () {
  [undefined, [], ['SNB-1'], ['SNB-1', 'SNB-2']].forEach(function (v) {
    assert.strictEqual(Infra.validateConfig(validCfg(v === undefined ? {} : { pilotBookingIds: v })).ok, true, JSON.stringify(v));
  });
  [[''], [1], [null], 'SNB-1', {}, null, [['SNB-1']]].forEach(function (v) {
    var r = Infra.validateConfig(validCfg({ pilotBookingIds: v }));
    assert.strictEqual(r.ok, false, JSON.stringify(v));
    assert.ok(r.errors.indexOf('PILOT_BOOKING_IDS_INVALID') !== -1);
  });
});

test('P2: 許可リスト外の予約は createKey=0・deleteKey=0・通知なし。リスト内の予約だけ発行される', function () {
  var w = H.createWorld({ mail: false, cfg: { pilotBookingIds: ['SNB-PILOT'] } });
  w.createMode = 'noCommandId';
  var rt = w.runtime();
  w.records = [H.record({ bookingId: 'SNB-REAL' }), H.record({ bookingId: 'SNB-PILOT' })];
  cycle(w, rt, 3);
  assert.strictEqual(w.callCount('createKey'), 1, '許可リストの1件だけ');
  assert.strictEqual(w.callCount('deleteKey'), 0);
  var issued = ops(w);
  assert.strictEqual(issued.length, 1);
  assert.ok(JSON.stringify(issued[0]).indexOf('SNB-REAL') === -1, 'リスト外の予約はOPを持たない');
  assert.ok(!has(w, /BOOKING_FROZEN/), 'リスト外は凍結通知にしない');
});

test('P3: 空配列は全予約を停止（createKey=0）', function () {
  var w = H.createWorld({ mail: false, cfg: { pilotBookingIds: [] } });
  var rt = w.runtime();
  w.records = [H.record()];
  cycle(w, rt, 3);
  assert.strictEqual(w.callCount('createKey'), 0);
});

test('P4: リスト外の支払未確認予約は凍結通知を出さない。リストに加えた後は追加の改訂なしで発行される', function () {
  var w = H.createWorld({ mail: false, cfg: { pilotBookingIds: [] } });
  w.createMode = 'noCommandId';
  var rt = w.runtime();
  w.records = [H.record({ bookingId: 'SNB-1' }), H.record({ bookingId: 'SNB-UNPAID', paymentStatus: 'checkout_pending' })];
  cycle(w, rt, 3);
  assert.strictEqual(w.callCount('createKey'), 0);
  assert.ok(!has(w, /BOOKING_FROZEN/), 'リスト外は凍結通知なし');
  w.cfg.pilotBookingIds = ['SNB-1'];
  w.rt = null;
  rt = w.runtime();
  cycle(w, rt, 3);
  assert.strictEqual(w.callCount('createKey'), 1, '追加の改訂なしで発行される');
});

test('P5: validateConfig（プリフライト）— limitedRollout=true は対象予約ID1件が必須。通常モードは未設定でも有効', function () {
  assert.strictEqual(Infra.validateConfig(validCfg()).ok, true, '通常モード');
  assert.strictEqual(Infra.validateConfig(validCfg({ limitedRollout: true, pilotBookingIds: ['SNB-1'] })).ok, true);
  [undefined, [], ['A', 'B'], 'SNB-1', null].forEach(function (v) {
    var r = Infra.validateConfig(validCfg(v === undefined ? { limitedRollout: true } : { limitedRollout: true, pilotBookingIds: v }));
    assert.strictEqual(r.ok, false, JSON.stringify(v));
    assert.ok(r.errors.indexOf('PILOT_REQUIRED') !== -1, JSON.stringify(v));
  });
  assert.ok(Infra.validateConfig(validCfg({ limitedRollout: 'yes' })).errors.indexOf('LIMITED_ROLLOUT_INVALID') !== -1);
});

test('P6: 限定稼働モードで対象IDを落とすと、全ジョブが何も送らない（createKey=0・CONFIG_INVALID）', function () {
  var w = H.createWorld({ mail: false, cfg: { limitedRollout: true } });
  w.createMode = 'noCommandId';
  var rt = w.runtime();
  w.records = [H.record()];
  cycle(w, rt, 3);
  assert.strictEqual(w.callCount('createKey'), 0, '設定欠落でも全件発行しない');
  assert.ok(has(w, /CONFIG_INVALID/));
});

// 通知・配送を有効にした世界での回帰（#757 レビュー）
function mailPilotWorld(cfg) {
  var w = H.createWorld({ mail: true, cfg: Object.assign({ deliveryConfigured: true, delivery: H.DELIVERY_CFG }, cfg) });
  w.createMode = 'noCommandId';
  w.recipients['SNB-PILOT'] = 'ops-test@example.test';
  return w;
}

test('P7: 通知・配送ON — 対象外の支払未確認予約は管理者凍結通知を出さず、対象内の予約は発行と案内メールが続く', function () {
  var w = mailPilotWorld({ limitedRollout: true, pilotBookingIds: ['SNB-PILOT'] });
  var rt = w.runtime();
  w.records = [H.record({ bookingId: 'SNB-UNPAID', paymentStatus: 'checkout_pending' }), H.record({ bookingId: 'SNB-PILOT' })];
  cycle(w, rt, 3);
  assert.ok(!has(w, /BOOKING_FROZEN/), '対象外は凍結通知なし（通知経路は有効）');
  assert.strictEqual(w.callCount('createKey'), 1, '対象内は発行');
  w.nowMs = Date.parse('2030-01-10T18:00:00+09:00');
  var d = rt.deliverCycle();
  assert.strictEqual(d.delivered, 1, '対象内には案内メール');
  assert.strictEqual(w.userMails.length, 1);
  assert.strictEqual(w.userMails[0].to, 'ops-test@example.test');
});

test('P8: 対照 — 同じ世界でも許可リストなしなら支払未確認予約は凍結通知を出す（P7が通知経路の有効性を検出できる根拠）', function () {
  var w = mailPilotWorld({});
  var rt = w.runtime();
  w.records = [H.record({ bookingId: 'SNB-UNPAID', paymentStatus: 'checkout_pending' })];
  cycle(w, rt, 3);
  assert.ok(has(w, /BOOKING_FROZEN/), '通知経路は動作している');
});

test('P9: 発行済み→リスト外（旧キー回収）→リストへ戻す、で追加の改訂なしに再発行される', function () {
  var w = H.createWorld({ mail: false, cfg: { pilotBookingIds: ['SNB-1'] } });
  w.createMode = 'noCommandId';
  w.deleteMode = 'noCommandId';
  var rt = w.runtime();
  w.records = [H.record({ bookingId: 'SNB-1' })];
  cycle(w, rt, 4);
  assert.strictEqual(w.callCount('createKey'), 1, '前提: 発行');
  w.cfg.pilotBookingIds = ['SNB-OTHER'];
  rt = w.runtime();
  cycle(w, rt, 6);
  assert.strictEqual(w.callCount('deleteKey'), 1, '除外で旧キーを回収');
  assert.strictEqual(w.callCount('createKey'), 1, '除外中は再発行しない');
  w.cfg.pilotBookingIds = ['SNB-1'];
  rt = w.runtime();
  cycle(w, rt, 6);
  assert.strictEqual(w.callCount('createKey'), 2, '戻したら改訂なしで再発行');
});

// ================================================================ #824: Mens／Studio X の自動鍵発行（3ブランド）

var THREE = ['snb', 'mens', 'studio_x'];
function threeBrandWorld(cfg, rec) {
  var DEVICE = H.DEV;
  var w = H.createWorld({ mail: false, cfg: Object.assign({
    eligibleBrands: THREE,
    keypads: [{ brand: 'snb', facility: 'main', deviceId: DEVICE }, { brand: 'mens', facility: 'main', deviceId: DEVICE }, { brand: 'studio_x', facility: 'main', deviceId: DEVICE }]
  }, cfg || {}) });
  w.createMode = 'noCommandId';
  w.deleteMode = 'noCommandId';
  var rt = w.runtime();
  w.records = [H.record(rec || {})];
  return { w: w, rt: rt };
}

test('#824: 正常な Mens／Studio X の確定予約は、3ブランド設定で鍵同期に届き発行される', function () {
  ['mens', 'studio_x'].forEach(function (brand) {
    var x = threeBrandWorld({}, { brand: brand });
    cycle(x.w, x.rt, 3);
    assert.strictEqual(x.w.callCount('createKey'), 1, brand);
    assert.deepStrictEqual(states(x.w), [S.ISSUED_CONFIRMED], brand);
  });
});

test('#824: 支払・承認が未確認の Mens／Studio X は SNB と同じく凍結し、発行しない', function () {
  ['snb', 'mens', 'studio_x'].forEach(function (brand) {
    var x = threeBrandWorld({}, { brand: brand, paymentMethod: '現金', paymentStatus: 'not_started', paymentConfirmedAt: '', confirmedAt: '' });
    cycle(x.w, x.rt, 3);
    assert.strictEqual(x.w.callCount('createKey'), 0, brand);
    assert.strictEqual(x.w.callCount('deleteKey'), 0, brand);
    assert.ok(has(x.w, /FROZEN/), brand + ': 管理者へ凍結通知');
  });
});

test('#824: 対象外・端末未対応は安全停止（eligibleBrandsがSNBのみ／mens用keypad無し／未知ブランド）', function () {
  var snbOnly = threeBrandWorld({ eligibleBrands: ['snb'] }, { brand: 'mens' });
  cycle(snbOnly.w, snbOnly.rt, 3);
  assert.strictEqual(snbOnly.w.callCount('createKey'), 0, '設定が拡大前なら Mens は発行しない（凍結もしない）');
  assert.ok(!has(snbOnly.w, /FROZEN/));
  var noPad = threeBrandWorld({ keypads: [{ brand: 'snb', facility: 'main', deviceId: H.DEV }] }, { brand: 'studio_x' });
  cycle(noPad.w, noPad.rt, 3);
  assert.strictEqual(noPad.w.callCount('createKey'), 0, 'studio_x の端末対応が無ければ発行しない（SNBの端末を流用しない）');
  var unknown = threeBrandWorld({}, { brand: 'studio-x' });
  cycle(unknown.w, unknown.rt, 3);
  assert.strictEqual(unknown.w.callCount('createKey'), 0, '未知ブランドは発行しない');
});

test('#824: eligibleBrands拡大前に候補へ入った Mens は「処理済み」にならず、拡大後の再起動で追加改訂なしに発行される', function () {
  var x = threeBrandWorld({ eligibleBrands: ['snb'] }, { brand: 'mens' });
  cycle(x.w, x.rt, 3);
  assert.strictEqual(x.w.callCount('createKey'), 0, '拡大前は発行しない');
  assert.strictEqual(ops(x.w).length, 0, '状態(OP)を作らない');
  assert.deepStrictEqual(x.w.store.keys().filter(function (k) { return k.indexOf('TRK') === 0; }), [], '追跡(処理済み)を書かない');
  x.w.cfg.eligibleBrands = THREE; /* 運営者が非公開で設定を拡大 */
  var rt2 = x.w.runtime();
  cycle(x.w, rt2, 3);
  assert.strictEqual(x.w.callCount('createKey'), 1, '拡大後に同じ予約(同revision)を発行');
});

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

test('B3-d: 凍結中の旧キーは、期限後に EXPIRED_KEY_REMAINS で管理者へ通知され、管理者の個別削除（OFFでも）で回収できる', function () {
  var x = issuedWorld();
  x.w.records = [H.record({ brand: '', revision: 2 })];
  cycle(x.w, x.rt, 4);
  x.w.advance(24 * 3600);
  x.rt.sweepCycle();
  x.rt.sweepCycle();
  assert.deepStrictEqual(states(x.w), [S.EXPIRED]);
  assert.ok(has(x.w, /EXPIRED_KEY_REMAINS/), '残存を管理者へ通知');
  assert.strictEqual(x.w.callCount('deleteKey'), 0, 'sweep は削除を送らない');

  // 管理者の個別削除はフラグOFF（ロールバック状態）でも使え、通常キーは変更しない
  var off = x.w.runtime({ enabled: false });
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
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../gas/switchbot-access/AccessLedgerReader.gs'), 'utf8'), ctx, { filename: 'AccessLedgerReader.gs' });
  return ctx.AccessLedgerReader;
}

test('B4: select は 空brand を照合候補に含む（凍結・管理者確認のため）。mens／studio_x／未知ブランドは候補に含めない', function () {
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
  assert.strictEqual(pick('mens'), 0);
  assert.strictEqual(pick('studio_x'), 0);
  assert.strictEqual(pick('unknown'), 0);
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

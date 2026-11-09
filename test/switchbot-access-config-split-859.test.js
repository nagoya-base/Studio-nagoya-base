/*
 * Issue #859: ACCESS_CONFIG の設定分離（split-v1）と本番設定ミス防止・診断強化のテスト。
 * 実GAS・実API・実秘密には接続しない。予約ID・deviceId・宛先はすべてテスト用ダミー。
 *
 * 契約（docs/switchbot-access-config-split-859.md）:
 *  - 正本は ACCESS_CONFIG_FORMAT で一箇所: 未設定=旧 ACCESS_CONFIG、'split-v1'=分割プロパティ。暗黙マージなし・混在は拒否。
 *  - 型・空・重複・未知ブランド・複数予約ID・端末不一致・決済語彙・猶予欠落は安全側（発行しない）で拒否。
 *  - 読込エラー時は enabled=false かつ validateConfig 失敗（fail-closed）。
 *  - 診断は読取のみで、予約ID・完全deviceId・宛先を出さない。
 */
'use strict';

var test = require('node:test');
var assert = require('node:assert');
var Infra = require('../gas/switchbot-access/SwitchBotAccessInfra.gs');
var Core = require('../gas/switchbot-access/SwitchBotAccessCore.gs');
var H = require('./helpers/switchbot-access-world');

var PILOT = 'PILOT-DUMMY-0001';
var DEV = H.DEV;

/** 旧 ACCESS_CONFIG（H.baseCfg と同じ内容。enabled は JSON に置かない）。 */
function legacyJson(over) {
  var c = H.baseCfg(Object.assign({ limitedRollout: true, pilotBookingIds: [PILOT] }, over || {}));
  delete c.enabled;
  return JSON.stringify(c);
}

/** 同じ内容を split-v1 で表現した Script Properties。 */
function splitProps(over) {
  var p = {
    ACCESS_CONFIG_FORMAT: 'split-v1',
    ACCESS_ENVIRONMENT: 'production',
    ACCESS_ENABLED: 'true',
    ACCESS_CORE_CONFIG: JSON.stringify({
      commercialUseApproved: true, eligiblePaymentStatuses: ['STRIPE_PAID', 'ADMIN_APPROVED'],
      ledgerTarget: { facility: 'main', room: null }, capacity: { stopAt: 80, officialLimit: 90 }, infra: {}
    }),
    ACCESS_DEVICES: JSON.stringify({ environment: 'production', allowedLast4: ['01FD'], keypads: [{ brand: 'snb', facility: 'main', deviceId: DEV }] }),
    ACCESS_DELIVERY: JSON.stringify({ adminMailTo: ['ops@example.test'], deliveryConfigured: false }),
    ACCESS_ELIGIBLE_BRANDS: '["snb"]',
    ACCESS_LIMITED_ROLLOUT: 'true',
    ACCESS_PILOT_BOOKING_IDS: JSON.stringify([PILOT]),
    ACCESS_GRACE_BEFORE_SEC: '960',
    ACCESS_GRACE_AFTER_SEC: '900'
  };
  Object.keys(over || {}).forEach(function (k) { if (over[k] === null) delete p[k]; else p[k] = over[k]; });
  return p;
}

function reader(props, opts) {
  opts = opts || {};
  return function (k) {
    if (opts.throwOn && opts.throwOn === k) throw new Error('READ_FAIL');
    return props[k] === undefined ? null : props[k];
  };
}

function load(props) { return Infra.loadConfig(reader(props)); }
function errorsOf(props) { return load(props).errors; }
function has(arr, code) { return arr.indexOf(code) !== -1; }

function booking(over) {
  return Object.assign({
    bookingId: PILOT, revision: 1, status: 'CONFIRMED', paymentStatus: 'STRIPE_PAID', brand: 'snb',
    facility: 'main', room: null, date: '2030-01-11', startTime: '10:00', endTime: '12:00'
  }, over || {});
}
var NOW = Math.floor(Date.parse('2030-01-10T13:00:00+09:00') / 1000);

// ---------- 正規ケース・旧形式の互換 ----------

test('旧形式（ACCESS_CONFIG_FORMAT 未設定）: 従来どおり ACCESS_CONFIG だけを読み、結果は変わらない', function () {
  var r = load({ ACCESS_CONFIG: legacyJson(), ACCESS_ENVIRONMENT: 'production', ACCESS_ENABLED: 'true' });
  assert.strictEqual(r.source, 'LEGACY');
  assert.deepStrictEqual(r.errors, []);
  assert.strictEqual(r.cfg.enabled, true);
  assert.strictEqual(r.cfg.configLoadErrors, undefined);
  assert.strictEqual(Infra.validateConfig(r.cfg).ok, true);
  // JSON の enabled は無視・環境名の二重チェックは維持
  var off = load({ ACCESS_CONFIG: legacyJson({ enabled: true }), ACCESS_ENVIRONMENT: 'production' });
  assert.strictEqual(off.cfg.enabled, false);
  var mis = load({ ACCESS_CONFIG: legacyJson(), ACCESS_ENVIRONMENT: 'verify', ACCESS_ENABLED: 'true' });
  assert.strictEqual(mis.cfg.environment, '__MISMATCH__');
  assert.strictEqual(Infra.validateConfig(mis.cfg).ok, false);
});

test('分割形式（split-v1）の正規1件限定: 旧形式と同じ有効設定になり、コアはパイロット予約だけを発行対象にする', function () {
  var s = load(splitProps());
  assert.strictEqual(s.source, 'SPLIT_V1');
  assert.deepStrictEqual(s.errors, []);
  var l = load({ ACCESS_CONFIG: legacyJson(), ACCESS_ENVIRONMENT: 'production', ACCESS_ENABLED: 'true' });
  var pick = ['environment', 'enabled', 'commercialUseApproved', 'eligiblePaymentStatuses', 'eligibleBrands', 'limitedRollout', 'pilotBookingIds',
    'graceBeforeSec', 'graceAfterSec', 'keypads', 'allowedLast4', 'ledgerTarget', 'adminMailTo', 'deliveryConfigured', 'capacity'];
  pick.forEach(function (k) { assert.deepStrictEqual(s.cfg[k], l.cfg[k], k); });
  assert.strictEqual(Infra.validateConfig(s.cfg).ok, true);
  var ok = Core.evaluateEligibility(booking(), s.cfg, NOW);
  assert.strictEqual(ok.eligible, true);
  assert.strictEqual(ok.deviceId, DEV);
  assert.strictEqual(Core.evaluateEligibility(booking({ bookingId: 'OTHER-0002' }), s.cfg, NOW).reason, 'NOT_PILOT_TARGET');
  assert.strictEqual(Infra.issuanceReadiness(s.cfg).state, 'READY');
});

test('分割形式の全件モード: ACCESS_LIMITED_ROLLOUT=false かつ予約ID未設定なら許可リストなし', function () {
  var s = load(splitProps({ ACCESS_LIMITED_ROLLOUT: 'false', ACCESS_PILOT_BOOKING_IDS: null }));
  assert.deepStrictEqual(s.errors, []);
  assert.strictEqual(s.cfg.limitedRollout, false);
  assert.strictEqual(s.cfg.pilotBookingIds, undefined);
  assert.strictEqual(Core.evaluateEligibility(booking({ bookingId: 'ANY-0003' }), s.cfg, NOW).eligible, true);
});

// ---------- 二重設定（旧・新の混在）----------

test('二重設定: 旧形式のまま分割プロパティが1つでも残る／分割形式で ACCESS_CONFIG が残る → CONFIG_SOURCE_MIXED で停止', function () {
  var legacyPlusSplit = load({ ACCESS_CONFIG: legacyJson(), ACCESS_ENVIRONMENT: 'production', ACCESS_ENABLED: 'true', ACCESS_ELIGIBLE_BRANDS: '["mens"]' });
  assert.ok(has(legacyPlusSplit.errors, 'CONFIG_SOURCE_MIXED'));
  assert.strictEqual(legacyPlusSplit.cfg.enabled, false, '読込エラー時は enabled=false');
  assert.deepStrictEqual(legacyPlusSplit.cfg.eligibleBrands, ['snb'], '暗黙マージしない（独立プロパティで上書きしない）');
  var v = Infra.validateConfig(legacyPlusSplit.cfg);
  assert.strictEqual(v.ok, false);
  assert.ok(has(v.errors, 'CONFIG_SOURCE_MIXED'));
  assert.strictEqual(Core.evaluateEligibility(booking(), legacyPlusSplit.cfg, NOW).reason, 'FLAG_OFF');

  var splitPlusLegacy = load(splitProps({ ACCESS_CONFIG: legacyJson() }));
  assert.ok(has(splitPlusLegacy.errors, 'CONFIG_SOURCE_MIXED'));
  assert.strictEqual(splitPlusLegacy.cfg.enabled, false);
});

test('二重管理の禁止: 分割JSONに高頻度設定（eligibleBrands 等）や enabled を入れると UNKNOWN_KEY', function () {
  var core = JSON.parse(splitProps().ACCESS_CORE_CONFIG);
  ['eligibleBrands', 'limitedRollout', 'pilotBookingIds', 'graceBeforeSec', 'enabled', 'keypads'].forEach(function (k) {
    var c = Object.assign({}, core); c[k] = k === 'enabled' || k === 'limitedRollout' ? true : (k === 'graceBeforeSec' ? 1 : ['snb']);
    assert.ok(has(errorsOf(splitProps({ ACCESS_CORE_CONFIG: JSON.stringify(c) })), 'CORE_CONFIG_UNKNOWN_KEY'), k);
  });
  var dev = JSON.parse(splitProps().ACCESS_DEVICES); dev.eligibleBrands = ['snb'];
  assert.ok(has(errorsOf(splitProps({ ACCESS_DEVICES: JSON.stringify(dev) })), 'DEVICES_CONFIG_UNKNOWN_KEY'));
  var dlv = JSON.parse(splitProps().ACCESS_DELIVERY); dlv.pilotBookingIds = [PILOT];
  assert.ok(has(errorsOf(splitProps({ ACCESS_DELIVERY: JSON.stringify(dlv) })), 'DELIVERY_CONFIG_UNKNOWN_KEY'));
});

test('形式指定が不正・読めない場合は推測しない（旧形式にも倒さない）', function () {
  assert.ok(has(errorsOf(splitProps({ ACCESS_CONFIG_FORMAT: 'split-v2' })), 'CONFIG_FORMAT_INVALID'));
  assert.ok(has(errorsOf(splitProps({ ACCESS_CONFIG_FORMAT: 'SPLIT-V1' })), 'CONFIG_FORMAT_INVALID'));
  var r = Infra.loadConfig(reader(splitProps(), { throwOn: 'ACCESS_CONFIG_FORMAT' }));
  assert.strictEqual(r.source, 'UNKNOWN');
  assert.ok(has(r.errors, 'CONFIG_FORMAT_UNREADABLE'));
  assert.strictEqual(r.cfg.enabled, false);
  // 個別プロパティの読取例外は MISSING に潰さない
  var u = Infra.loadConfig(reader(splitProps(), { throwOn: 'ACCESS_ELIGIBLE_BRANDS' }));
  assert.ok(has(u.errors, 'ELIGIBLE_BRANDS_UNREADABLE'));
});

// ---------- 欠落・無効型 ----------

test('欠落: 分割形式の必須プロパティ・必須キーが無ければ停止', function () {
  [['ACCESS_CORE_CONFIG', 'CORE_CONFIG_MISSING'], ['ACCESS_DEVICES', 'DEVICES_CONFIG_MISSING'], ['ACCESS_DELIVERY', 'DELIVERY_CONFIG_MISSING'],
    ['ACCESS_ELIGIBLE_BRANDS', 'ELIGIBLE_BRANDS_MISSING'], ['ACCESS_LIMITED_ROLLOUT', 'LIMITED_ROLLOUT_MISSING'],
    ['ACCESS_GRACE_BEFORE_SEC', 'GRACE_BEFORE_MISSING'], ['ACCESS_GRACE_AFTER_SEC', 'GRACE_AFTER_MISSING']].forEach(function (c) {
    var r = load(splitProps((function () { var o = {}; o[c[0]] = null; return o; })()));
    assert.ok(has(r.errors, c[1]), c[0] + ' → ' + r.errors.join(','));
    assert.strictEqual(r.cfg.enabled, false);
    assert.strictEqual(Infra.validateConfig(r.cfg).ok, false);
  });
  var core = JSON.parse(splitProps().ACCESS_CORE_CONFIG); delete core.commercialUseApproved;
  assert.ok(has(errorsOf(splitProps({ ACCESS_CORE_CONFIG: JSON.stringify(core) })), 'CORE_CONFIG_KEY_MISSING'));
  var dlv = { adminMailTo: ['ops@example.test'] };
  assert.ok(has(errorsOf(splitProps({ ACCESS_DELIVERY: JSON.stringify(dlv) })), 'DELIVERY_CONFIG_KEY_MISSING'));
});

test('無効型: 真偽値・配列・整数の構文を厳密に検査する', function () {
  ['TRUE', '1', 'yes', ' true', 'true '].forEach(function (v) {
    assert.ok(has(errorsOf(splitProps({ ACCESS_LIMITED_ROLLOUT: v })), 'LIMITED_ROLLOUT_INVALID'), v);
  });
  ['snb', '"snb"', '{"snb":1}', '[snb]'].forEach(function (v) {
    assert.ok(has(errorsOf(splitProps({ ACCESS_ELIGIBLE_BRANDS: v })), 'ELIGIBLE_BRANDS_PARSE_ERROR'), v);
  });
  assert.ok(has(errorsOf(splitProps({ ACCESS_ELIGIBLE_BRANDS: '[]' })), 'ELIGIBLE_BRANDS_EMPTY'));
  assert.ok(has(errorsOf(splitProps({ ACCESS_ELIGIBLE_BRANDS: '["snb","snb"]' })), 'ELIGIBLE_BRANDS_DUPLICATE'));
  assert.ok(has(errorsOf(splitProps({ ACCESS_ELIGIBLE_BRANDS: '[1]' })), 'ELIGIBLE_BRANDS_INVALID'));
  ['-1', '1.5', '01', '1e3', '86401', '', 'abc', ' 960'].forEach(function (v) {
    var e = errorsOf(splitProps({ ACCESS_GRACE_BEFORE_SEC: v }));
    assert.ok(has(e, v === '' ? 'GRACE_BEFORE_MISSING' : 'GRACE_BEFORE_INVALID'), JSON.stringify(v) + ' → ' + e.join(','));
  });
  assert.deepStrictEqual(errorsOf(splitProps({ ACCESS_GRACE_BEFORE_SEC: '0', ACCESS_GRACE_AFTER_SEC: '86400' })), []);
  var core = JSON.parse(splitProps().ACCESS_CORE_CONFIG); core.commercialUseApproved = 'true';
  assert.ok(has(errorsOf(splitProps({ ACCESS_CORE_CONFIG: JSON.stringify(core) })), 'COMMERCIAL_USE_INVALID'));
  assert.ok(has(errorsOf(splitProps({ ACCESS_CORE_CONFIG: '[1]' })), 'CORE_CONFIG_PARSE_ERROR'));
  assert.ok(has(errorsOf(splitProps({ ACCESS_DELIVERY: JSON.stringify({ adminMailTo: ['ops@example.test'], deliveryConfigured: 'false' }) })), 'DELIVERY_CONFIGURED_INVALID'));
  assert.ok(has(errorsOf(splitProps({ ACCESS_DELIVERY: JSON.stringify({ adminMailTo: ['ops@example.test'], deliveryConfigured: true }) })), 'DELIVERY_SETTINGS_MISSING'));
});

// ---------- 未知ブランド・予約ID ----------

test('未知ブランド: 予約GASが受け付けないブランドは拒否（空文字・大文字違いも）', function () {
  ['["SNB"]', '["men"]', '[""]', '["snb","studio-x"]'].forEach(function (v) {
    assert.ok(has(errorsOf(splitProps({ ACCESS_ELIGIBLE_BRANDS: v })), 'ELIGIBLE_BRANDS_INVALID'), v);
  });
  assert.deepStrictEqual(errorsOf(splitProps({
    ACCESS_ELIGIBLE_BRANDS: '["mens"]',
    ACCESS_DEVICES: JSON.stringify({ environment: 'production', allowedLast4: ['01FD'], keypads: [{ brand: 'mens', facility: 'main', deviceId: DEV }] })
  })), []);
});

test('限定モードは予約IDちょうど1件: 欠落・複数・空・重複・不正形式・限定OFFでの残置はすべて停止', function () {
  assert.ok(has(errorsOf(splitProps({ ACCESS_PILOT_BOOKING_IDS: null })), 'PILOT_REQUIRED'));
  assert.ok(has(errorsOf(splitProps({ ACCESS_PILOT_BOOKING_IDS: JSON.stringify([PILOT, 'PILOT-DUMMY-0002']) })), 'PILOT_BOOKING_IDS_NOT_SINGLE'));
  assert.ok(has(errorsOf(splitProps({ ACCESS_PILOT_BOOKING_IDS: '[]' })), 'PILOT_BOOKING_IDS_EMPTY'));
  assert.ok(has(errorsOf(splitProps({ ACCESS_PILOT_BOOKING_IDS: JSON.stringify([PILOT, PILOT]) })), 'PILOT_BOOKING_IDS_DUPLICATE'));
  [PILOT, '"' + PILOT + '"', '[1]', '[""]', '[" PILOT"]', '["a/b"]'].forEach(function (v) {
    var e = errorsOf(splitProps({ ACCESS_PILOT_BOOKING_IDS: v }));
    assert.ok(has(e, 'PILOT_BOOKING_IDS_PARSE_ERROR') || has(e, 'PILOT_BOOKING_IDS_INVALID'), v + ' → ' + e.join(','));
  });
  var stale = load(splitProps({ ACCESS_LIMITED_ROLLOUT: 'false' }));
  assert.ok(has(stale.errors, 'PILOT_WITHOUT_LIMITED_ROLLOUT'), '限定OFFで予約IDが残るのは曖昧なので拒否');
  assert.strictEqual(stale.cfg.enabled, false);
});

// ---------- 端末不一致 ----------

test('端末不一致: 許可外端末・未知ブランド・facility欠落・重複・余計なキーは停止。対応表に無い予約はコアが KEYPAD_NOT_CONFIGURED', function () {
  function devs(kps, last4) { return { ACCESS_DEVICES: JSON.stringify({ environment: 'production', allowedLast4: last4 || ['01FD'], keypads: kps }) }; }
  var notAllowed = load(splitProps(devs([{ brand: 'snb', facility: 'main', deviceId: H.DEV_VERIFY }])));
  assert.ok(has(Infra.validateConfig(notAllowed.cfg).errors, 'KEYPAD_NOT_ALLOWED_IN_ENV'));
  assert.ok(has(errorsOf(splitProps(devs([{ brand: 'SNB', facility: 'main', deviceId: DEV }]))), 'KEYPAD_BRAND_INVALID'));
  assert.ok(has(errorsOf(splitProps(devs([{ brand: 'snb', deviceId: DEV }]))), 'KEYPAD_FACILITY_INVALID'));
  assert.ok(has(errorsOf(splitProps(devs([{ brand: 'snb', facility: 'main', room: '', deviceId: DEV }]))), 'KEYPAD_ROOM_INVALID'));
  assert.ok(has(errorsOf(splitProps(devs([{ brand: 'snb', facility: 'main', deviceId: DEV }, { brand: 'snb', facility: 'main', deviceId: 'CCCCCCCCCCCC01FD' }]))), 'KEYPAD_DUPLICATE'));
  assert.ok(has(errorsOf(splitProps(devs([{ brand: 'snb', facility: 'main', deviceId: DEV, note: 'x' }]))), 'KEYPAD_ENTRY_INVALID'));
  // 環境名の二重チェック（ACCESS_DEVICES.environment と ACCESS_ENVIRONMENT）
  var envMis = load(splitProps({ ACCESS_DEVICES: JSON.stringify({ environment: 'verify', allowedLast4: ['01FD'], keypads: [{ brand: 'snb', facility: 'main', deviceId: DEV }] }) }));
  assert.strictEqual(envMis.cfg.environment, '__MISMATCH__');
  assert.strictEqual(Infra.validateConfig(envMis.cfg).ok, false);
  // 予約側の facility がずれていれば、コアは推測で別端末にフォールバックしない
  var ok = load(splitProps());
  assert.strictEqual(Core.evaluateEligibility(booking({ facility: 'annex' }), ok.cfg, NOW).reason, 'KEYPAD_NOT_CONFIGURED');
});

// ---------- 決済未承認・猶予欠落 ----------

test('決済未承認: 支払根拠の語彙は STRIPE_PAID / ADMIN_APPROVED のみ。台帳の生値・UNVERIFIED は設定できず、未承認の予約は発行しない', function () {
  function core(ps) { var c = JSON.parse(splitProps().ACCESS_CORE_CONFIG); c.eligiblePaymentStatuses = ps; return { ACCESS_CORE_CONFIG: JSON.stringify(c) }; }
  [['not_started'], ['UNVERIFIED'], ['paid'], [], ['STRIPE_PAID', 'STRIPE_PAID'], 'STRIPE_PAID'].forEach(function (ps) {
    assert.ok(has(errorsOf(splitProps(core(ps))), 'PAYMENT_STATUSES_INVALID'), JSON.stringify(ps));
  });
  var cfg = load(splitProps()).cfg;
  assert.strictEqual(Core.evaluateEligibility(booking({ paymentStatus: 'UNVERIFIED' }), cfg, NOW).reason, 'PAYMENT_NOT_ELIGIBLE');
  assert.strictEqual(Core.evaluateEligibility(booking({ paymentStatus: 'not_started' }), cfg, NOW).reason, 'PAYMENT_NOT_ELIGIBLE');
  assert.strictEqual(Core.evaluateEligibility(booking({ paymentStatus: 'ADMIN_APPROVED' }), cfg, NOW).eligible, true);
  var notApproved = JSON.parse(splitProps().ACCESS_CORE_CONFIG); notApproved.commercialUseApproved = false;
  var na = load(splitProps({ ACCESS_CORE_CONFIG: JSON.stringify(notApproved) }));
  assert.deepStrictEqual(na.errors, []);
  assert.strictEqual(Core.evaluateEligibility(booking(), na.cfg, NOW).reason, 'COMMERCIAL_USE_NOT_APPROVED');
  assert.ok(has(Infra.issuanceReadiness(na.cfg).problems, 'COMMERCIAL_USE_NOT_APPROVED'));
});

test('猶予欠落: 分割形式では起動拒否、旧形式でも診断で GRACE_NOT_CONFIGURED を示す', function () {
  var r = load(splitProps({ ACCESS_GRACE_AFTER_SEC: null }));
  assert.ok(has(r.errors, 'GRACE_AFTER_MISSING'));
  assert.strictEqual(Core.evaluateEligibility(booking(), Object.assign({}, r.cfg, { enabled: true }), NOW).reason, 'GRACE_NOT_CONFIGURED');
  var legacyNoGrace = JSON.parse(legacyJson()); delete legacyNoGrace.graceBeforeSec; delete legacyNoGrace.graceAfterSec;
  var l = load({ ACCESS_CONFIG: JSON.stringify(legacyNoGrace), ACCESS_ENVIRONMENT: 'production' });
  assert.strictEqual(Infra.validateConfig(l.cfg).ok, true, '旧形式の基本妥当性は従来どおり');
  assert.ok(has(Infra.issuanceReadiness(l.cfg).problems, 'GRACE_NOT_CONFIGURED'), '基本妥当性だけで発行可能と誤認させない');
});

// ---------- 発行前提の診断（2026-11-09 の未発行事象）----------

test('発行前提: 旧JSONに eligibleBrands が無い場合、VALID でも issuance は NOT_READY（独立プロパティは旧形式では読まない）', function () {
  var c = JSON.parse(legacyJson({ eligibleBrands: undefined })); delete c.eligibleBrands;
  var l = load({ ACCESS_CONFIG: JSON.stringify(c), ACCESS_ENVIRONMENT: 'production' });
  assert.strictEqual(Infra.validateConfig(l.cfg).ok, true);
  var iss = Infra.issuanceReadiness(l.cfg);
  assert.strictEqual(iss.state, 'NOT_READY');
  assert.ok(has(iss.problems, 'ELIGIBLE_BRANDS_MISSING'));
  // 対象ブランドに端末対応が無い／対象外ブランドの端末が残る
  var mismatch = Infra.issuanceReadiness(load(splitProps({ ACCESS_ELIGIBLE_BRANDS: '["mens"]' })).cfg);
  assert.ok(has(mismatch.problems, 'KEYPAD_MISSING_FOR_BRAND'));
  assert.ok(!has(mismatch.problems, 'KEYPAD_FOR_NON_TARGET_BRAND'), '対象外ブランドの端末は problems にしない');
  assert.ok(has(mismatch.warnings, 'KEYPAD_FOR_NON_TARGET_BRAND'), '非ブロッキング警告として示す');
  // 出力は件数・固定コードのみ（予約ID・完全deviceId・宛先を含まない）
  var dump = JSON.stringify(Infra.issuanceReadiness(load(splitProps()).cfg));
  [PILOT, DEV, 'ops@example.test'].forEach(function (w) { assert.ok(dump.indexOf(w) === -1, 'leak ' + w); });
});

// ---------- 読取専用診断（readOnlyDiagnostics）----------

function diagDeps(script) {
  var writes = 0;
  return {
    deps: {
      identity: function () { return { email: 'owner@example.test', effectiveEmail: 'owner@example.test' }; },
      adminActors: { 'owner@example.test': 'ADMIN-1' },
      accessFlag: function () { return script.ACCESS_ENABLED === undefined ? null : script.ACCESS_ENABLED; },
      scriptProps: { get: function (k) { return script[k] === undefined ? null : script[k]; }, set: function () { writes++; }, del: function () { writes++; } },
      userProps: { get: function () { return 'dummy-secret-value-xxxxxxxxxxxxxxxx'; } },
      stateStore: { get: function () { return null; }, keys: function () { return []; } },
      ledgerInspect: function () { return { code: 'LEDGER_ACCESS_OK', headers: 'COMPLETE', columnFormat: 'OK', rows: 1, sampled: 1 }; }
    },
    writes: function () { return writes; }
  };
}
function common() { return { LEDGER_SPREADSHEET_ID: 'sheet-DUMMY', ACCESS_ADMIN_ACTORS: '{"owner@example.test":"ADMIN-1"}' }; }

test('診断（分割形式・OFF）: ACCESS_CONFIG 未設定を不足扱いせず、source・各プロパティ状態・発行前提を値なしで示す', function () {
  var props = Object.assign(common(), splitProps({ ACCESS_ENABLED: null }));
  var d = diagDeps(props);
  var r = Infra.readOnlyDiagnostics(d.deps);
  assert.strictEqual(r.ok, true, r.failures.join(','));
  assert.strictEqual(r.config.source, 'SPLIT_V1');
  assert.strictEqual(r.config.state, 'VALID');
  assert.strictEqual(r.settings.ACCESS_CONFIG, 'MISSING');
  assert.strictEqual(r.config.splitProps.ACCESS_ELIGIBLE_BRANDS, 'SET');
  assert.strictEqual(r.issuance.state, 'READY');
  assert.strictEqual(r.issuance.brands, 1);
  assert.strictEqual(r.issuance.pilotBookingIds, 1);
  assert.strictEqual(r.issuance.keypads, 1);
  assert.strictEqual(r.issuance.limitedRollout, 'ON');
  assert.strictEqual(d.writes(), 0, '診断は書き込まない');
  var dump = JSON.stringify(r);
  [PILOT, DEV, 'ops@example.test', 'owner@example.test', 'sheet-DUMMY', 'dummy-secret'].forEach(function (w) { assert.ok(dump.indexOf(w) === -1, 'leak ' + w); });
});

test('診断: 旧形式＋分割プロパティの混在は CONFIG_INVALID（CONFIG_SOURCE_MIXED）で黙って通さない', function () {
  var props = Object.assign(common(), { ACCESS_CONFIG: legacyJson(), ACCESS_ENVIRONMENT: 'production', ACCESS_PILOT_BOOKING_IDS: JSON.stringify([PILOT]) });
  var r = Infra.readOnlyDiagnostics(diagDeps(props).deps);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.config.source, 'LEGACY');
  assert.strictEqual(r.config.state, 'INVALID');
  assert.ok(has(r.config.errors, 'CONFIG_SOURCE_MIXED'));
  assert.ok(has(r.failures, 'CONFIG_INVALID'));
  assert.strictEqual(r.issuance.state, 'NOT_CHECKED');
});

test('診断: 分割形式の型間違いは CONFIG_INVALID とエラーコード（値は出さない）', function () {
  var props = Object.assign(common(), splitProps({ ACCESS_ENABLED: null, ACCESS_LIMITED_ROLLOUT: 'TRUE', ACCESS_GRACE_BEFORE_SEC: 'abc' }));
  var r = Infra.readOnlyDiagnostics(diagDeps(props).deps);
  assert.strictEqual(r.ok, false);
  assert.ok(has(r.config.errors, 'LIMITED_ROLLOUT_INVALID'));
  assert.ok(has(r.config.errors, 'GRACE_BEFORE_INVALID'));
  assert.ok(JSON.stringify(r).indexOf('abc') === -1);
});

test('診断: 旧形式で VALID でも発行前提不足は issuance.problems に出る（ok は基盤の合否のまま）', function () {
  var c = JSON.parse(legacyJson()); delete c.eligibleBrands;
  var props = Object.assign(common(), { ACCESS_CONFIG: JSON.stringify(c), ACCESS_ENVIRONMENT: 'production' });
  var r = Infra.readOnlyDiagnostics(diagDeps(props).deps);
  assert.strictEqual(r.config.state, 'VALID');
  assert.strictEqual(r.issuance.state, 'NOT_READY');
  assert.ok(has(r.issuance.problems, 'ELIGIBLE_BRANDS_MISSING'));
});

// ---------- 既存フローの回帰（分割形式で読んだ設定で発行・回収が従来どおり動く）----------

test('回帰: 分割形式の設定で発行→確認まで従来どおり。通常キーは保持される', function () {
  var cfg = load(splitProps({ ACCESS_PILOT_BOOKING_IDS: '["SNB-1"]' })).cfg;
  var w = H.createWorld({ cfg: cfg });
  w.preload(DEV, 2); // 通常キー（利用者・管理者用の既存キー）
  var rt = w.runtime();
  w.records = [H.record()];
  rt.syncCycle();
  w.advance(300);
  rt.syncCycle();
  assert.strictEqual(w.callCount('createKey'), 1, 'パイロット予約1件だけ発行');
  assert.strictEqual(w.callCount('deleteKey'), 0, '通常キーに触れない');
  assert.strictEqual(w.keys[DEV].filter(function (k) { return /^USER-/.test(k.name); }).length, 2);
});

test('回帰: 分割形式で読込エラーがあれば同期は CONFIG_INVALID で何も呼ばない', function () {
  var cfg = load(splitProps({ ACCESS_PILOT_BOOKING_IDS: '["SNB-1"]', ACCESS_CONFIG: legacyJson() })).cfg;
  var w = H.createWorld({ cfg: cfg });
  w.records = [H.record()];
  var r = w.runtime().syncCycle();
  assert.strictEqual(r.error, 'CONFIG_INVALID');
  assert.strictEqual(w.calls.length, 0);
});

// ---------- レビュー指摘（PR #871）への回帰 ----------

test('移行漏れ防止: コードが読む設定キーはすべて split-v1 のどこかで表現できる（未知キー扱いで移行不能にしない）', function () {
  var fs = require('fs');
  var path = require('path');
  var src = ['SwitchBotAccessCore.gs', 'SwitchBotAccessInfra.gs', 'SwitchBotAccessApp.gs'].map(function (f) {
    return fs.readFileSync(path.join(__dirname, '..', 'gas', 'switchbot-access', f), 'utf8');
  }).join('\n');
  var keys = {};
  src.replace(/\b(?:config|cfg)\.([A-Za-z][A-Za-z0-9]*)/g, function (m, k) { keys[k] = true; return m; });
  // 診断出力のフィールド（out.config.*）と、ローダーが付与する内部項目は設定キーではない
  var notConfig = ['state', 'envMatch', 'errors', 'last4', 'splitProps', 'source', 'enabled', 'configLoadErrors'];
  var splitFields = ['eligibleBrands', 'limitedRollout', 'pilotBookingIds', 'graceBeforeSec', 'graceAfterSec'];
  var jsonKeys = [];
  Object.keys(Infra.SPLIT_JSON_KEYS).forEach(function (p) { jsonKeys = jsonKeys.concat(Infra.SPLIT_JSON_KEYS[p].required, Infra.SPLIT_JSON_KEYS[p].optional); });
  var missing = Object.keys(keys).filter(function (k) { return notConfig.indexOf(k) === -1 && splitFields.indexOf(k) === -1 && jsonKeys.indexOf(k) === -1; });
  assert.deepStrictEqual(missing, [], 'split-v1 で表現できない設定キー: ' + missing.join(','));
  // 代表例: autoDeleteExpired=false をそのまま移行でき、自動削除が有効に戻らない
  var core = JSON.parse(splitProps().ACCESS_CORE_CONFIG); core.autoDeleteExpired = false; core.expiredDeleteMaxPerSweep = 3;
  var r = load(splitProps({ ACCESS_CORE_CONFIG: JSON.stringify(core), ACCESS_DELIVERY: JSON.stringify({ adminMailTo: ['ops@example.test'], deliveryConfigured: false, maxDeliveryAttempts: 2 }) }));
  assert.deepStrictEqual(r.errors, []);
  assert.strictEqual(r.cfg.autoDeleteExpired, false);
  assert.strictEqual(r.cfg.maxDeliveryAttempts, 2);
});

test('発行前提: ブランドが一致しても ledgerTarget の facility/room と端末対応がずれていれば NOT_READY（コアと同じ完全一致で判定）', function () {
  function withDevs(kps) { return splitProps({ ACCESS_DEVICES: JSON.stringify({ environment: 'production', allowedLast4: ['01FD'], keypads: kps }) }); }
  var facMis = load(withDevs([{ brand: 'snb', facility: 'annex', deviceId: DEV }]));
  assert.deepStrictEqual(facMis.errors, []);
  assert.strictEqual(Infra.validateConfig(facMis.cfg).ok, true);
  var iss = Infra.issuanceReadiness(facMis.cfg);
  assert.strictEqual(iss.state, 'NOT_READY');
  assert.ok(has(iss.problems, 'KEYPAD_MISSING_FOR_BRAND'));
  var roomMis = Infra.issuanceReadiness(load(withDevs([{ brand: 'snb', facility: 'main', room: 'A', deviceId: DEV }])).cfg);
  assert.ok(has(roomMis.problems, 'KEYPAD_MISSING_FOR_BRAND'), 'ledgerTarget.room=null に対して room 付き端末は一致しない');
  var core = JSON.parse(splitProps().ACCESS_CORE_CONFIG); core.ledgerTarget = { facility: 'main', room: 'A' };
  var roomOk = load(splitProps({ ACCESS_CORE_CONFIG: JSON.stringify(core), ACCESS_DEVICES: JSON.stringify({ environment: 'production', allowedLast4: ['01FD'], keypads: [{ brand: 'snb', facility: 'main', room: 'A', deviceId: DEV }] }) }));
  assert.strictEqual(Infra.issuanceReadiness(roomOk.cfg).state, 'READY');
  // 旧形式は brand+facility+room の重複を起動時に拒否しないため、診断で曖昧さを示す
  var amb = JSON.parse(legacyJson({ keypads: [{ brand: 'snb', facility: 'main', deviceId: DEV }, { brand: 'snb', facility: 'main', deviceId: 'CCCCCCCCCCCC01FD' }] }));
  assert.ok(has(Infra.issuanceReadiness(load({ ACCESS_CONFIG: JSON.stringify(amb), ACCESS_ENVIRONMENT: 'production' }).cfg).problems, 'KEYPAD_AMBIGUOUS_FOR_BRAND'));
});

// ---------- タケルレビュー（PR #871）: 対象外ブランドの予備マッピングは READY を妨げない ----------

var DEV_SHARED = 'DDDDDDDDDDDD01FD'; // 共通の物理入口（3ブランド共用）のダミー
function threeBrandKeypads(over) {
  return [
    { brand: 'snb', facility: 'main', deviceId: DEV_SHARED },
    { brand: 'mens', facility: 'main', deviceId: DEV_SHARED },
    { brand: 'studio_x', facility: 'main', deviceId: DEV_SHARED }
  ].map(function (k) { return Object.assign({}, k, (over || {})[k.brand] || {}); });
}
function mensOnlyLegacy(kps) {
  return { ACCESS_CONFIG: legacyJson({ eligibleBrands: ['mens'], keypads: kps || threeBrandKeypads() }), ACCESS_ENVIRONMENT: 'production', ACCESS_ENABLED: 'true' };
}
function mensOnlySplit(kps) {
  return splitProps({
    ACCESS_ELIGIBLE_BRANDS: '["mens"]',
    ACCESS_DEVICES: JSON.stringify({ environment: 'production', allowedLast4: ['01FD'], keypads: kps || threeBrandKeypads() })
  });
}

[['legacy', mensOnlyLegacy], ['split-v1', mensOnlySplit]].forEach(function (c) {
  var name = c[0], make = c[1];

  test(name + ': Mensのみ eligible ＋ 3ブランドの keypads は READY（対象外は警告のみ）', function () {
    var r = load(make());
    assert.deepStrictEqual(r.errors, []);
    assert.strictEqual(Infra.validateConfig(r.cfg).ok, true);
    var iss = Infra.issuanceReadiness(r.cfg);
    assert.strictEqual(iss.state, 'READY', iss.problems.join(','));
    assert.deepStrictEqual(iss.problems, []);
    assert.deepStrictEqual(iss.warnings, ['KEYPAD_FOR_NON_TARGET_BRAND']);
    assert.strictEqual(iss.keypads, 3);
    assert.strictEqual(iss.brands, 1);
  });

  test(name + ': 対象外ブランド（snb / studio_x）の予約には発行しない。対象 Mens は共通入口で発行対象', function () {
    var cfg = load(make()).cfg;
    assert.strictEqual(Core.evaluateEligibility(booking({ brand: 'snb' }), cfg, NOW).reason, 'BRAND_NOT_TARGET');
    assert.strictEqual(Core.evaluateEligibility(booking({ brand: 'studio_x' }), cfg, NOW).reason, 'BRAND_NOT_TARGET');
    var ok = Core.evaluateEligibility(booking({ brand: 'mens' }), cfg, NOW);
    assert.strictEqual(ok.eligible, true);
    assert.strictEqual(ok.deviceId, DEV_SHARED);
  });

  test(name + ': 対象 Mens の facility/room 不一致は NOT_READY', function () {
    var fac = Infra.issuanceReadiness(load(make(threeBrandKeypads({ mens: { facility: 'annex' } }))).cfg);
    assert.strictEqual(fac.state, 'NOT_READY');
    assert.ok(has(fac.problems, 'KEYPAD_MISSING_FOR_BRAND'));
    var room = Infra.issuanceReadiness(load(make(threeBrandKeypads({ mens: { room: 'B' } }))).cfg);
    assert.strictEqual(room.state, 'NOT_READY');
    assert.ok(has(room.problems, 'KEYPAD_MISSING_FOR_BRAND'));
  });

  test(name + ': 対象 Mens の重複マッピングは停止（split-v1 は起動拒否、legacy は NOT_READY）', function () {
    var kps = threeBrandKeypads().concat([{ brand: 'mens', facility: 'main', deviceId: 'EEEEEEEEEEEE01FD' }]);
    var r = load(make(kps));
    if (name === 'split-v1') {
      assert.ok(has(r.errors, 'KEYPAD_DUPLICATE'));
      assert.strictEqual(r.cfg.enabled, false);
    } else {
      assert.deepStrictEqual(r.errors, []);
      var iss = Infra.issuanceReadiness(r.cfg);
      assert.strictEqual(iss.state, 'NOT_READY');
      assert.ok(has(iss.problems, 'KEYPAD_AMBIGUOUS_FOR_BRAND'));
    }
    assert.strictEqual(Core.evaluateEligibility(booking({ brand: 'mens' }), Object.assign({}, r.cfg, { enabled: true }), NOW).reason, 'KEYPAD_AMBIGUOUS');
  });

  test(name + ': 端末 allowlist は厳格なまま（対象外ブランドの端末でも許可外なら起動拒否）', function () {
    var r = load(make(threeBrandKeypads({ snb: { deviceId: H.DEV_VERIFY } })));
    assert.ok(has(Infra.validateConfig(r.cfg).errors, 'KEYPAD_NOT_ALLOWED_IN_ENV'));
  });
});

// ---------- 運営者方針（PR #871 補足）: 最終形は3ブランドすべて許可＋共通の物理端末 ----------

function allBrandsLegacy(kps) {
  return { ACCESS_CONFIG: legacyJson({ eligibleBrands: ['snb', 'mens', 'studio_x'], keypads: kps || threeBrandKeypads() }), ACCESS_ENVIRONMENT: 'production', ACCESS_ENABLED: 'true' };
}
function allBrandsSplit(kps) {
  return splitProps({
    ACCESS_ELIGIBLE_BRANDS: '["snb","mens","studio_x"]',
    ACCESS_DEVICES: JSON.stringify({ environment: 'production', allowedLast4: ['01FD'], keypads: kps || threeBrandKeypads() })
  });
}

[['legacy', allBrandsLegacy], ['split-v1', allBrandsSplit]].forEach(function (c) {
  var name = c[0], make = c[1];

  test(name + ': 3ブランドすべて許可＋共通端末は READY（警告なし）。各ブランドの予約が同じ共通端末で発行対象', function () {
    var r = load(make());
    assert.deepStrictEqual(r.errors, []);
    assert.strictEqual(Infra.validateConfig(r.cfg).ok, true);
    var iss = Infra.issuanceReadiness(r.cfg);
    assert.strictEqual(iss.state, 'READY', iss.problems.join(','));
    assert.deepStrictEqual(iss.problems, []);
    assert.deepStrictEqual(iss.warnings, []);
    assert.strictEqual(iss.brands, 3);
    assert.strictEqual(iss.keypads, 3);
    ['snb', 'mens', 'studio_x'].forEach(function (b) {
      var e = Core.evaluateEligibility(booking({ brand: b }), r.cfg, NOW);
      assert.strictEqual(e.eligible, true, b + ': ' + e.reason);
      assert.strictEqual(e.deviceId, DEV_SHARED);
    });
  });

  test(name + ': 3ブランド許可でも限定モードは維持（予約ID1件以外は NOT_PILOT_TARGET）。マージで全件拡大しない', function () {
    var cfg = load(make()).cfg;
    assert.strictEqual(cfg.limitedRollout, true);
    assert.strictEqual(Core.evaluateEligibility(booking({ brand: 'studio_x', bookingId: 'OTHER-0004' }), cfg, NOW).reason, 'NOT_PILOT_TARGET');
  });

  test(name + ': 3ブランド許可で1ブランドの端末対応が欠ける／facility不一致なら NOT_READY', function () {
    var missing = Infra.issuanceReadiness(load(make(threeBrandKeypads().filter(function (k) { return k.brand !== 'studio_x'; }))).cfg);
    assert.strictEqual(missing.state, 'NOT_READY');
    assert.ok(has(missing.problems, 'KEYPAD_MISSING_FOR_BRAND'));
    var fac = Infra.issuanceReadiness(load(make(threeBrandKeypads({ snb: { facility: 'annex' } }))).cfg);
    assert.strictEqual(fac.state, 'NOT_READY');
    assert.ok(has(fac.problems, 'KEYPAD_MISSING_FOR_BRAND'));
  });

  test(name + ': 3ブランド許可でも支払未承認・商用未承認は発行しない', function () {
    var cfg = load(make()).cfg;
    assert.strictEqual(Core.evaluateEligibility(booking({ brand: 'snb', paymentStatus: 'UNVERIFIED' }), cfg, NOW).reason, 'PAYMENT_NOT_ELIGIBLE');
    assert.strictEqual(Core.evaluateEligibility(booking({ brand: 'mens', status: 'PENDING' }), cfg, NOW).reason, 'NOT_CONFIRMED');
    assert.strictEqual(Core.evaluateEligibility(booking({ brand: 'studio_x' }), Object.assign({}, cfg, { commercialUseApproved: false }), NOW).reason, 'COMMERCIAL_USE_NOT_APPROVED');
  });
});

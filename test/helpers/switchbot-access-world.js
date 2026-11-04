/*
 * 独立GAS基盤（#754）テスト用のフェイク世界。実API・実機・実Spreadsheetには接続しない。
 * 秘密を使わない値のみ。完全deviceIdはテスト用のダミー。
 */
'use strict';

var fs = require('fs');
var path = require('path');
var vm = require('vm');
var crypto = require('node:crypto');

var ROOT = path.resolve(__dirname, '..', '..');
var Infra = require('../../gas/switchbot-access/SwitchBotAccessInfra.gs');
var C = require('../../gas/switchbot-access/SwitchBotAccessCore.gs');

var DEV = 'AAAAAAAAAAAA01FD';   // 本番想定（末尾01FD）
var DEV_VERIFY = 'BBBBBBBBBBBB37DD'; // 検証機（本番には載せない）
var PASS_RE = /\b[0-9]{8}\b/;

/** AccessKeySnapshot + 台帳リーダー(Booking shim) を実ファイルのままvmへ読み込む。 */
function loadSnapshot() {
  var ctx = vm.createContext({});
  ['gas/booking/shared/AccessKeySnapshot.gs', 'gas/switchbot-access/AccessLedgerReader.gs'].forEach(function (f) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f });
  });
  return { snapshot: ctx.AccessKeySnapshot, reader: ctx.AccessLedgerReader, ctx: ctx };
}

var LOADED = loadSnapshot();

function jst(date, time) { return new Date(date + 'T' + time + ':00+09:00'); }

function baseCfg(over) {
  return Object.assign({
    environment: 'production', allowedLast4: ['01FD'],
    enabled: true, commercialUseApproved: true,
    eligiblePaymentStatuses: ['STRIPE_PAID', 'ADMIN_APPROVED'], eligibleBrands: ['snb'],
    graceBeforeSec: 960, graceAfterSec: 900,
    keypads: [{ brand: 'snb', facility: 'main', deviceId: DEV }],
    ledgerTarget: { facility: 'main', room: null },
    adminMailTo: ['ops@example.test'],
    capacity: { stopAt: 80, officialLimit: 90 },
    deliveryConfigured: false,
    infra: {}
  }, over || {});
}

function record(over) {
  return Object.assign({
    bookingId: 'SNB-1', startAt: jst('2030-01-11', '10:00'), endAt: jst('2030-01-11', '12:00'), brand: 'snb',
    status: 'CONFIRMED', paymentMethod: 'オンラインクレジットカード', paymentStatus: 'paid',
    paymentConfirmedAt: jst('2030-01-05', '10:05'), confirmedAt: jst('2030-01-05', '10:05'), expiredAt: '',
    feeSettlementState: '', feeRecoveryRequiredAt: '', paymentRecoveryRequiredAt: '', revision: 1
  }, over || {});
}

function webhook(over) {
  var ctx = Object.assign({ deviceType: 'WoKeypad', deviceMac: DEV, eventName: 'createKey', commandId: 'C1', result: 'success' }, over || {});
  return JSON.stringify({ eventType: 'changeReport', eventVersion: '1', context: ctx, junk: 'x'.repeat(10) });
}

var TOKEN = 'T'.repeat(32);

function createWorld(opts) {
  opts = opts || {};
  var w = {
    nowMs: Date.parse('2030-01-10T13:00:00+09:00'),
    props: {}, secretProps: {}, mails: [], calls: [], logs: [],
    keys: {}, seq: 100, pendingRemoval: [],
    createMode: 'commandId', deleteMode: 'commandId', deleteAppliesAfterLists: 0,
    mailFail: false, lockBusy: false, locked: false, storeFail: null,
    records: [], ledgerFail: null, ledgerCalls: 0, lastTracked: [],
    identity: { email: 'owner@example.test' }, delivered: [], deliverFail: false,
    createdPasswords: []
  };
  w.keys[DEV] = [];
  w.keys[DEV_VERIFY] = [];
  w.cfg = baseCfg(opts.cfg);
  w.sec = function () { return Math.floor(w.nowMs / 1000); };
  w.advance = function (sec) { w.nowMs += sec * 1000; };
  w.preload = function (dev, n) { for (var i = 0; i < n; i++) w.keys[dev].push({ id: 'U' + i, name: 'USER-' + i, type: 'timeLimit' }); };
  w.callCount = function (name) { return w.calls.filter(function (c) { return c.name === name; }).length; };

  w.store = {
    get: function (k) { return w.props[k] === undefined ? null : w.props[k]; },
    set: function (k, v) {
      if (w.storeFail && w.storeFail(k, v)) throw new Error('STORE_FAIL');
      w.props[k] = String(v);
    },
    del: function (k) { delete w.props[k]; },
    keys: function () { return Object.keys(w.props); }
  };
  w.secrets = {
    get: function (k) { return w.secretProps[k] === undefined ? null : w.secretProps[k]; },
    set: function (k, v) { w.secretProps[k] = String(v); },
    del: function (k) { delete w.secretProps[k]; },
    keys: function () { return Object.keys(w.secretProps); }
  };
  w.lockService = {
    tryLock: function () { if (w.lockBusy || w.locked) return false; w.locked = true; return true; },
    releaseLock: function () { w.locked = false; }
  };
  w.api = {
    listDevices: function () {
      w.calls.push({ name: 'listDevices' });
      if (w.deleteAppliesAfterLists > 0 && w.pendingRemoval.length) {
        w.deleteAppliesAfterLists--;
        if (w.deleteAppliesAfterLists === 0) {
          w.pendingRemoval.forEach(function (p) { w.keys[p.dev] = w.keys[p.dev].filter(function (k) { return k.id !== p.id; }); });
          w.pendingRemoval = [];
        }
      }
      return { ok: true, devices: Object.keys(w.keys).map(function (d) { return { deviceId: d, deviceType: 'Keypad', keyList: w.keys[d].map(function (k) { return Object.assign({}, k); }) }; }) };
    },
    createKey: function (p) {
      w.calls.push({ name: 'createKey', device: p.deviceId });
      w.createdPasswords.push(p.password);
      w.seq++;
      w.keys[p.deviceId].push({ id: String(w.seq), name: p.name, type: 'timeLimit', startTime: String(p.startTime), endTime: String(p.endTime) });
      return { httpCode: 200, parsed: { statusCode: 100, body: w.createMode === 'commandId' ? { commandId: 'CMD' + w.seq } : {} } };
    },
    deleteKey: function (dev, id) {
      w.calls.push({ name: 'deleteKey', device: dev, id: id });
      w.seq++;
      if (w.deleteAppliesAfterLists > 0) w.pendingRemoval.push({ dev: dev, id: id });
      else w.keys[dev] = w.keys[dev].filter(function (k) { return k.id !== id; });
      return { httpCode: 200, parsed: { statusCode: 100, body: w.deleteMode === 'commandId' ? { commandId: 'DEL' + w.seq } : {} } };
    }
  };
  w.ledger = {
    read: function (ctx) {
      w.ledgerCalls++;
      w.lastTracked = ctx.trackedIds;
      if (w.ledgerFail) return { ok: false, error: w.ledgerFail };
      return { ok: true, records: w.records.map(function (r) { return Object.assign({}, r); }) };
    }
  };
  w.deps = function () {
    return {
      store: w.store, secrets: w.secrets, lockService: w.lockService, api: w.api, ledger: w.ledger, snapshot: LOADED.snapshot,
      sendMail: function (subject, body) { if (w.mailFail) throw new Error('MAIL_FAIL'); w.mails.push({ subject: subject, body: body }); },
      sha256Hex: function (s) { return crypto.createHash('sha256').update(s).digest('hex'); },
      randomInt: function (n) { return crypto.randomInt(n); },
      nowSec: w.sec, nowMs: function () { return w.nowMs; },
      identity: function () { return w.identity; },
      adminActors: { 'owner@example.test': 'ADMIN-1' },
      deliverCode: function (ref, code) { if (w.deliverFail) throw new Error('DELIVER_FAIL'); w.delivered.push({ ref: ref }); }
    };
  };
  w.runtime = function (cfgOver) {
    w.cfg = Object.assign({}, w.cfg, cfgOver || {});
    return Infra.createRuntime(w.deps(), w.cfg);
  };
  return w;
}

module.exports = {
  Infra: Infra, Core: C, DEV: DEV, DEV_VERIFY: DEV_VERIFY, TOKEN: TOKEN, PASS_RE: PASS_RE, LOADED: LOADED,
  createWorld: createWorld, baseCfg: baseCfg, record: record, webhook: webhook, jst: jst
};

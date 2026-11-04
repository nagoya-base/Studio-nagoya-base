/**
 * 予約確定 → SwitchBot Keypad 期間限定キー自動発行／変更・取消時の安全な削除（Issue #748）— 純粋ロジック。
 *
 * 既存予約GAS（gas/booking）・検証GAS（gas/switchbot-verify）からは参照しない独立モジュール。
 * GAS 依存（UrlFetchApp / PropertiesService / LockService / Utilities）を持たず、すべて deps で注入する
 * ため Node でモックテストできる。機能フラグ（config.enabled）は既定 OFF。OFF 時は変更 API を一切呼ばない。
 *
 * 状態（record.state）:
 *   PLANNED               … 計画のみ永続化済み。送信前
 *   SENDING               … 変更 API 送信直前に永続化。この状態で再開したら送信済みか不明 → UNKNOWN（再送しない）
 *   SENT_WAIT_WEBHOOK     … commandId あり。Webhook 照合待ち
 *   ACCEPTED_NO_COMMAND_ID… commandId なしで API 受理。変更 API は再送せず keyList 読み取り確認へ
 *   ISSUED_CONFIRMED      … 発行確認済み（evidence に根拠を別々に保存）
 *   DELETE_PENDING / DELETE_SENDING / DELETE_SENT … 削除の同様の段階
 *   DELETED_CONFIRMED / ALREADY_ABSENT … 削除確定／送信前から不在を確認
 *   EXPIRED               … 期限切れ（削除とは区別）。残存確認後に ARCHIVED_EXPIRED
 *   FAILED                … API 拒否 / Webhook failed（反映していない根拠がある）
 *   UNKNOWN               … 反映有無が断定できない。変更 API の自動再送は禁止。管理者判断の別手順のみ
 *   ABANDONED             … 管理者が keyList で不在を確認して放棄（新しい attempt を許す）
 */
var SwitchBotAccessCore = (function () {
  'use strict';

  var STATE = {
    PLANNED: 'PLANNED',
    SENDING: 'SENDING',
    SENT_WAIT_WEBHOOK: 'SENT_WAIT_WEBHOOK',
    ACCEPTED_NO_COMMAND_ID: 'ACCEPTED_NO_COMMAND_ID',
    ISSUED_CONFIRMED: 'ISSUED_CONFIRMED',
    DELETE_PENDING: 'DELETE_PENDING',
    DELETE_SENDING: 'DELETE_SENDING',
    DELETE_SENT: 'DELETE_SENT',
    DELETED_CONFIRMED: 'DELETED_CONFIRMED',
    ALREADY_ABSENT: 'ALREADY_ABSENT',
    EXPIRED: 'EXPIRED',
    ARCHIVED_EXPIRED: 'ARCHIVED_EXPIRED',
    FAILED: 'FAILED',
    UNKNOWN: 'UNKNOWN',
    ABANDONED: 'ABANDONED'
  };

  /** 追加の判断なしに「この record はもう何も送らない」状態。 */
  var TERMINAL = [STATE.DELETED_CONFIRMED, STATE.ALREADY_ABSENT, STATE.ARCHIVED_EXPIRED, STATE.FAILED, STATE.ABANDONED];

  var EVIDENCE = {
    WEBHOOK_SUCCESS: 'WEBHOOK_SUCCESS',
    KEYLIST_CONFIRMED: 'KEYLIST_CONFIRMED',
    KEYLIST_ABSENT: 'KEYLIST_ABSENT',
    ADMIN_KEYLIST: 'ADMIN_KEYLIST'
  };

  var OP = { ISSUE: 'ISSUE', REVOKE: 'REVOKE' };
  var JST_OFFSET_SEC = 9 * 3600;

  // ---------- 純関数 ----------

  function maskId(id) {
    var s = String(id || '');
    return s.length <= 4 ? '****' : '****' + s.slice(-4);
  }

  /** JST の日付 'YYYY-MM-DD' と時刻 'HH:mm' を UNIX 秒へ。形式不正は null。 */
  function jstToEpochSec(dateStr, timeStr) {
    var d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || ''));
    var t = /^(\d{2}):(\d{2})$/.exec(String(timeStr || ''));
    if (!d || !t) return null;
    var mo = Number(d[2]), da = Number(d[3]), h = Number(t[1]), mi = Number(t[2]);
    if (mo < 1 || mo > 12 || da < 1 || da > 31 || h > 24 || mi > 59 || (h === 24 && mi !== 0)) return null;
    var ms = Date.UTC(Number(d[1]), mo - 1, da, h, mi, 0);
    var chk = new Date(Date.UTC(Number(d[1]), mo - 1, da, 0, 0, 0));
    if (chk.getUTCMonth() !== mo - 1 || chk.getUTCDate() !== da) return null;
    return Math.floor(ms / 1000) - JST_OFFSET_SEC;
  }

  /** Keypad 対応表から完全一致 1 件を解決。未設定/複数/不一致は deviceId:null（フォールバック禁止）。 */
  function resolveKeypad(config, booking) {
    var list = Array.isArray(config && config.keypads) ? config.keypads : [];
    var hits = list.filter(function (k) {
      return k && k.brand === booking.brand && k.facility === booking.facility &&
        (k.room === undefined || k.room === null ? !booking.room : k.room === booking.room);
    });
    if (hits.length === 0) return { deviceId: null, error: 'KEYPAD_NOT_CONFIGURED' };
    if (hits.length > 1) return { deviceId: null, error: 'KEYPAD_AMBIGUOUS' };
    var id = hits[0].deviceId;
    if (typeof id !== 'string' || !id) return { deviceId: null, error: 'KEYPAD_NOT_CONFIGURED' };
    return { deviceId: id, error: null };
  }

  /**
   * 発行対象判定。推測で既定値を足さない: 設定が欠けていれば必ず停止側に倒す。
   * 戻り値 { eligible, reason, startSec, endSec, deviceId }
   */
  function evaluateEligibility(booking, config, nowSec) {
    function no(reason) { return { eligible: false, reason: reason }; }
    config = config || {};
    booking = booking || {};
    if (config.enabled !== true) return no('FLAG_OFF');
    if (config.commercialUseApproved !== true) return no('COMMERCIAL_USE_NOT_APPROVED');
    if (!booking.bookingId || typeof booking.revision !== 'number') return no('BOOKING_INVALID');
    if (booking.status !== 'CONFIRMED') return no('NOT_CONFIRMED');
    if (!Array.isArray(config.eligiblePaymentStatuses) || config.eligiblePaymentStatuses.indexOf(booking.paymentStatus) === -1) {
      return no('PAYMENT_NOT_ELIGIBLE');
    }
    if (!Array.isArray(config.eligibleBrands) || config.eligibleBrands.indexOf(booking.brand) === -1) return no('BRAND_NOT_TARGET');
    if (typeof config.graceBeforeSec !== 'number' || typeof config.graceAfterSec !== 'number' ||
        config.graceBeforeSec < 0 || config.graceAfterSec < 0) {
      return no('GRACE_NOT_CONFIGURED');
    }
    var s = jstToEpochSec(booking.date, booking.startTime);
    var e = jstToEpochSec(booking.endDate || booking.date, booking.endTime);
    if (s === null || e === null || s >= e) return no('TIME_INVALID');
    var startSec = s - config.graceBeforeSec;
    var endSec = e + config.graceAfterSec;
    if (endSec <= nowSec) return no('ALREADY_ENDED');
    var kp = resolveKeypad(config, booking);
    if (!kp.deviceId) return no(kp.error);
    return { eligible: true, reason: null, startSec: startSec, endSec: endSec, deviceId: kp.deviceId };
  }

  function validatePasscode(p) {
    return typeof p === 'string' && /^[0-9]{6,12}$/.test(p);
  }

  /** keyList 検査。完全な応答（対象 device 1 件・keyList 配列）以外は valid:false（0 件と断定しない）。 */
  function inspectKeyList(devices, deviceId, name) {
    if (!Array.isArray(devices)) return { valid: false, error: 'DEVICE_LIST_INVALID' };
    var devs = devices.filter(function (d) { return d && d.deviceId === deviceId; });
    if (devs.length !== 1) return { valid: false, error: devs.length === 0 ? 'DEVICE_NOT_FOUND' : 'DEVICE_AMBIGUOUS' };
    if (!Array.isArray(devs[0].keyList)) return { valid: false, error: 'KEYLIST_INVALID' };
    var hits = devs[0].keyList.filter(function (k) { return k && k.name === name; });
    var ids = hits.map(function (k) { return k.id; });
    return { valid: true, count: hits.length, entries: hits, ids: ids, error: null };
  }

  /** Webhook/端末識別子の正規化（大文字・区切り除去）。空は ''（推測で補完しない）。 */
  function normDev(s) {
    return typeof s === 'string' ? s.replace(/[:\-\s]/g, '').toUpperCase() : '';
  }

  /**
   * 削除用の不在検査（Issue #751）。対象 Keypad の keyList「全体」から、保存済み passcodeId と保存名の
   * 両方を独立に数える。別名で同 ID が残る／同名で別 ID が残る場合を見逃さない。
   * 対象外端末・keyList 欠落・id を持たない／オブジェクトでない要素（不完全応答）は valid:false。
   * 0 件と補完しない。passcodeId 未保存も valid:false（ID の不在を検証できない）。
   */
  function inspectAbsence(devices, deviceId, name, passcodeId) {
    if (passcodeId === undefined || passcodeId === null || String(passcodeId) === '') return { valid: false, error: 'PASSCODE_ID_MISSING' };
    if (!Array.isArray(devices)) return { valid: false, error: 'DEVICE_LIST_INVALID' };
    var devs = devices.filter(function (d) { return d && d.deviceId === deviceId; });
    if (devs.length !== 1) return { valid: false, error: devs.length === 0 ? 'DEVICE_NOT_FOUND' : 'DEVICE_AMBIGUOUS' };
    var list = devs[0].keyList;
    if (!Array.isArray(list)) return { valid: false, error: 'KEYLIST_INVALID' };
    for (var i = 0; i < list.length; i++) {
      var k = list[i];
      if (!k || typeof k !== 'object' || k.id === undefined || k.id === null || String(k.id) === '') {
        return { valid: false, error: 'KEYLIST_ENTRY_INVALID' };
      }
    }
    var pid = String(passcodeId);
    var byName = list.filter(function (k) { return k.name === name; });
    var byId = list.filter(function (k) { return String(k.id) === pid; });
    var both = byName.filter(function (k) { return String(k.id) === pid; });
    return { valid: true, nameCount: byName.length, idCount: byId.length, bothCount: both.length,
      absent: byName.length === 0 && byId.length === 0, error: null };
  }

  /** 作成後: 厳密に 1 件・ID あり・属性矛盾なしのときのみ確認済み。 */
  function judgeIssued(insp, expected) {
    if (!insp.valid) return { ok: false, error: insp.error };
    if (insp.count === 0) return { ok: false, error: 'KEY_NOT_FOUND' };
    if (insp.count > 1) return { ok: false, error: 'KEY_NAME_AMBIGUOUS' };
    var k = insp.entries[0];
    if (k.id === undefined || k.id === null || String(k.id) === '') return { ok: false, error: 'KEY_ID_MISSING' };
    if (k.type !== undefined && k.type !== 'timeLimit') return { ok: false, error: 'KEY_ATTR_MISMATCH' };
    if (k.startTime !== undefined && String(k.startTime) !== String(expected.startSec)) return { ok: false, error: 'KEY_ATTR_MISMATCH' };
    if (k.endTime !== undefined && String(k.endTime) !== String(expected.endSec)) return { ok: false, error: 'KEY_ATTR_MISMATCH' };
    return { ok: true, id: String(k.id) };
  }

  /** Webhook の解釈（Keypad changeReport の createKey/deleteKey のみ）。 */
  function parseKeypadWebhook(payload) {
    if (!payload || payload.eventType !== 'changeReport' || !payload.context) return null;
    var c = payload.context;
    if (c.deviceType !== 'WoKeypad' && c.deviceType !== 'WoKeypadTouch') return null;
    var name = String(c.eventName || '').trim();
    if (name !== 'createKey' && name !== 'deleteKey') return null;
    if (!c.commandId) return null;
    // 対象 Keypad（deviceMac）を永続イベントへ通す。欠落は '' のまま（取込側で採用しない）
    return { eventName: name, commandId: String(c.commandId), deviceMac: normDev(c.deviceMac),
      result: c.result === 'success' ? 'success' : (c.result === 'failed' ? 'failed' : 'other') };
  }

  function classifyApi(res) {
    if (!res || typeof res !== 'object') return { accepted: false, commandId: null };
    var p = res.parsed;
    var accepted = res.httpCode === 200 && p && p.statusCode === 100;
    var body = (p && p.body) || {};
    return { accepted: !!accepted, commandId: accepted && body.commandId ? String(body.commandId) : null };
  }

  // ---------- エンジン ----------

  /**
   * deps:
   *   store       { get(k), set(k,v), del(k), keys() }  状態（秘密を含まない）
   *   secrets     { get(k), set(k,v), del(k) }          秘密（passcode）専用。権限を分離
   *   lock        function(keys[], fn) → fn()           予約単位 + Keypad 単位の直列化
   *   api         { listDevices(), createKey({deviceId,name,password,startTime,endTime}), deleteKey(deviceId,id) }
   *                 create/delete は { httpCode, parsed } を返す。通信断は throw。
   *   notifyAdmin function(event)                        { code, ref, state } のみ（個人情報・秘密なし）。失敗時は throw 可
   *   deliverCode function(bookingRef, code, window)     正規受渡し先へ。確認済み後にのみ呼ぶ。失敗時 throw
   *   sha256Hex   function(str) → hex
   *   randomInt   function(n) → 0..n-1
   *   nowSec      function() → UNIX 秒
   */
  function createEngine(deps, config) {
    config = config || {};
    var maxReads = typeof config.maxReads === 'number' ? config.maxReads : 3;
    var webhookWaitSec = typeof config.webhookWaitSec === 'number' ? config.webhookWaitSec : 90;
    var readWaitSec = typeof config.readWaitSec === 'number' ? config.readWaitSec : 600; // commandId なし削除の読取確認の最大経過時間

    // ---- 永続層ヘルパ ----
    function load(k) { var r = deps.store.get(k); return r ? JSON.parse(r) : null; }
    function save(k, v) { deps.store.set(k, JSON.stringify(v)); }
    function recKey(id) { return 'OP_' + id; }
    function bkKey(bookingId) { return 'BK_' + bookingId; }
    /** Webhook は 端末×操作×commandId で別々に保存（別端末/別操作の同 commandId と衝突させない）。 */
    function evtKey(mac, eventName, commandId) { return 'EVT_' + mac + '_' + eventName + '_' + commandId; }
    function eventFor(rec, eventName, commandId) { return load(evtKey(normDev(rec.deviceId), eventName, commandId)); }

    function bookingIndex(bookingId) {
      return load(bkKey(bookingId)) || { bookingId: bookingId, head: null, ops: [] };
    }

    /** 予約 PII を含まない衝突しにくい操作名。 */
    function keyName(bookingId, revision, deviceId, op, attempt) {
      var h = deps.sha256Hex([bookingId, revision, deviceId, op, attempt].join('|'));
      return 'SNB-' + h.slice(0, 16);
    }

    function audit(rec, from, to, basis) {
      rec.history = rec.history || [];
      rec.history.push({ at: deps.nowSec(), from: from, to: to, basis: basis || null });
    }

    function transition(rec, to, basis) {
      audit(rec, rec.state, to, basis);
      rec.state = to;
      rec.updatedAt = deps.nowSec();
      save(recKey(rec.id), rec);
    }

    function alert(rec, code) {
      var dk = 'ALERT_' + rec.id + '_' + code;
      if (deps.store.get(dk)) return false; // 重複抑止（通知成功時のみ記録）
      try {
        deps.notifyAdmin({ code: code, ref: rec.bookingId, rev: rec.revision, device: maskId(rec.deviceId), state: rec.state });
        deps.store.set(dk, String(deps.nowSec()));
        return true;
      } catch (e) {
        return false; // 失敗時は記録しない → 次回再通知
      }
    }

    /** 未解決(UNKNOWN)の通知が未達なら再試行する（重複は alert 側で抑止）。 */
    function retryAlert(rec) {
      if (rec.state === STATE.UNKNOWN && rec.alertCode) alert(rec, rec.alertCode);
    }

    function readKeyList() {
      var out;
      try { out = deps.api.listDevices(); } catch (e) { return { ok: false, error: 'LIST_COMM_ERROR' }; }
      if (!out || out.ok !== true) return { ok: false, error: 'LIST_API_ERROR' };
      return { ok: true, devices: out.devices };
    }

    function stopUnknown(rec, code, reason) {
      rec.reason = reason;
      rec.alertCode = code; // 通知失敗時に後続の実行で再通知できるよう保持する
      transition(rec, STATE.UNKNOWN, null);
      alert(rec, code);
      return rec;
    }

    // ---- Webhook 取込 ----
    function ingestWebhook(payload) {
      var ev = parseKeypadWebhook(payload);
      if (!ev) return { stored: false };
      if (!ev.deviceMac) return { stored: false, reason: 'DEVICE_MISSING' }; // 対象不明のイベントは採用しない
      var k = evtKey(ev.deviceMac, ev.eventName, ev.commandId);
      var prev = load(k);
      if (prev) {
        // 重複は初回を維持（巻き戻さない）。結果が食い違う重複は矛盾として印を付ける（削除確定に使わない）
        if (prev.result !== ev.result && !prev.conflict) { prev.conflict = true; save(k, prev); }
        return { stored: false, duplicate: true };
      }
      ev.receivedAtSec = deps.nowSec();
      save(k, ev);
      return { stored: true };
    }

    // ---- 発行 ----
    function startIssue(booking, elig) {
      // 同じ操作ID名前空間(予約:改訂:Keypad)の既存 record すべてを避けて attempt を採番（上書き・重複索引を防ぐ）
      var attempt = 1;
      var ns = booking.bookingId + ':' + booking.revision + ':' + maskId(elig.deviceId) + ':' + OP.ISSUE + '#';
      while (deps.store.get(recKey(ns + attempt))) attempt++;
      var id = ns + attempt;
      var rec = {
        id: id, bookingId: booking.bookingId, revision: booking.revision, deviceId: elig.deviceId, op: OP.ISSUE,
        attempt: attempt, name: keyName(booking.bookingId, booking.revision, elig.deviceId, OP.ISSUE, attempt),
        startSec: elig.startSec, endSec: elig.endSec, state: STATE.PLANNED, passcodeId: '', commandId: '',
        evidence: [], reads: 0, history: [], createdAt: deps.nowSec(), updatedAt: deps.nowSec()
      };
      var code = '';
      for (var i = 0; i < 8; i++) code += String(deps.randomInt(10));
      // 秘密と計画を送信前に永続化（失敗したら送信しない）
      deps.secrets.set('SECRET_' + id, code);
      save(recKey(id), rec);
      var idx = bookingIndex(booking.bookingId);
      if (idx.ops.indexOf(id) === -1) idx.ops.push(id);
      save(bkKey(booking.bookingId), idx);
      return executeIssue(rec);
    }

    function executeIssue(rec) {
      var kl = readKeyList();
      if (!kl.ok) return stopUnknown(rec, 'PRECHECK_FAILED', kl.error);
      var pre = inspectKeyList(kl.devices, rec.deviceId, rec.name);
      if (!pre.valid) return stopUnknown(rec, 'PRECHECK_FAILED', pre.error);
      if (pre.count !== 0) return stopUnknown(rec, 'NAME_ALREADY_EXISTS', 'NAME_ALREADY_EXISTS');
      var password = deps.secrets.get('SECRET_' + rec.id);
      if (!validatePasscode(password)) return stopUnknown(rec, 'SECRET_MISSING', 'SECRET_MISSING');
      // 送信前に SENDING を永続化。保存に失敗したら例外のまま送信しない。
      transition(rec, STATE.SENDING, null);
      var res;
      try {
        res = deps.api.createKey({ deviceId: rec.deviceId, name: rec.name, password: password, startTime: rec.startSec, endTime: rec.endSec });
      } catch (e) {
        return stopUnknown(rec, 'SEND_COMM_ERROR', 'COMM_ERROR');
      }
      var c = classifyApi(res);
      if (!c.accepted) {
        // 4xx（429 除く）で明確に拒否された場合のみ FAILED。それ以外は受理有無が曖昧なので UNKNOWN。
        if (res && typeof res.httpCode === 'number' && res.httpCode >= 400 && res.httpCode < 500 && res.httpCode !== 429) {
          rec.reason = 'API_REJECTED';
          transition(rec, STATE.FAILED, null);
          alert(rec, 'ISSUE_REJECTED');
          deps.secrets.del('SECRET_' + rec.id);
          return rec;
        }
        return stopUnknown(rec, 'SEND_RESPONSE_UNKNOWN', 'RESPONSE_UNKNOWN');
      }
      rec.sentAtSec = deps.nowSec();
      if (c.commandId) {
        rec.commandId = c.commandId;
        transition(rec, STATE.SENT_WAIT_WEBHOOK, null);
      } else {
        transition(rec, STATE.ACCEPTED_NO_COMMAND_ID, null);
      }
      return reconcileIssue(rec);
    }

    /** 読み取りのみ。変更 API は一切呼ばない。 */
    function reconcileIssue(rec) {
      if (rec.state !== STATE.SENT_WAIT_WEBHOOK && rec.state !== STATE.ACCEPTED_NO_COMMAND_ID) return rec;
      var webhookOk = false;
      if (rec.state === STATE.SENT_WAIT_WEBHOOK) {
        var ev = eventFor(rec, 'createKey', rec.commandId);
        if (ev) {
          if (ev.result === 'failed') {
            rec.reason = 'WEBHOOK_FAILED';
            transition(rec, STATE.FAILED, null);
            alert(rec, 'ISSUE_FAILED');
            deps.secrets.del('SECRET_' + rec.id);
            return rec;
          }
          if (ev.result === 'success') webhookOk = true;
        }
        if (!webhookOk) {
          if (deps.nowSec() - rec.sentAtSec > webhookWaitSec) return stopUnknown(rec, 'WEBHOOK_TIMEOUT', 'WEBHOOK_TIMEOUT');
          return rec; // まだ待機（再実行で再確認）
        }
      }
      if (rec.reads >= maxReads) return stopUnknown(rec, 'READ_LIMIT', 'READ_LIMIT');
      rec.reads += 1;
      var kl = readKeyList();
      if (!kl.ok) {
        if (rec.reads >= maxReads) return stopUnknown(rec, 'READ_LIMIT', kl.error);
        save(recKey(rec.id), rec);
        return rec;
      }
      var j = judgeIssued(inspectKeyList(kl.devices, rec.deviceId, rec.name), rec);
      if (!j.ok) {
        // Webhook 成功なのに keyList 不一致 = 矛盾。成功へ寄せず停止。重複/ID欠落/属性矛盾も停止。
        if (webhookOk || j.error === 'KEY_NAME_AMBIGUOUS' || j.error === 'KEY_ID_MISSING' ||
            j.error === 'KEY_ATTR_MISMATCH' || j.error === 'DEVICE_LIST_INVALID' || j.error === 'KEYLIST_INVALID') {
          return stopUnknown(rec, 'CONFIRM_MISMATCH', j.error);
        }
        // commandId なしの 0 件: 反映待ちの可能性。上限まで読み取りのみ再試行
        if (rec.reads >= maxReads) return stopUnknown(rec, 'READ_LIMIT', j.error);
        save(recKey(rec.id), rec);
        return rec;
      }
      rec.passcodeId = j.id;
      if (webhookOk) rec.evidence.push(EVIDENCE.WEBHOOK_SUCCESS);
      rec.evidence.push(EVIDENCE.KEYLIST_CONFIRMED);
      transition(rec, STATE.ISSUED_CONFIRMED, null);
      return rec;
    }

    // ---- 削除 ----
    function startDelete(rec) {
      if (rec.state !== STATE.ISSUED_CONFIRMED && rec.state !== STATE.EXPIRED && rec.state !== STATE.DELETE_PENDING) return rec;
      if (rec.state !== STATE.DELETE_PENDING) transition(rec, STATE.DELETE_PENDING, null);
      return executeDelete(rec);
    }

    function executeDelete(rec) {
      var kl = readKeyList();
      if (!kl.ok) return stopUnknown(rec, 'DELETE_PRECHECK_FAILED', kl.error);
      var insp = inspectAbsence(kl.devices, rec.deviceId, rec.name, rec.passcodeId);
      if (!insp.valid) return stopUnknown(rec, 'DELETE_PRECHECK_FAILED', insp.error);
      // 保存 ID と保存名の両方が全 keyList から不在のときのみ「送信前から不在」
      if (insp.absent) {
        rec.evidence.push(EVIDENCE.KEYLIST_ABSENT);
        transition(rec, STATE.ALREADY_ABSENT, null);
        deps.secrets.del('SECRET_' + rec.id);
        return rec;
      }
      // 送信してよいのは「保存 ID・保存名が同一の 1 要素に一致し、他に ID/名前の残存がない」場合のみ
      if (insp.nameCount > 1 || insp.idCount > 1) return stopUnknown(rec, 'DELETE_AMBIGUOUS', 'KEY_NAME_AMBIGUOUS');
      if (insp.bothCount !== 1 || insp.nameCount !== 1 || insp.idCount !== 1) {
        return stopUnknown(rec, 'DELETE_ID_MISMATCH', 'ID_MISMATCH'); // 別名の同 ID／別 ID の同名
      }
      transition(rec, STATE.DELETE_SENDING, null);
      var res;
      try { res = deps.api.deleteKey(rec.deviceId, String(rec.passcodeId)); }
      catch (e) { return stopUnknown(rec, 'DELETE_COMM_ERROR', 'COMM_ERROR'); }
      var c = classifyApi(res);
      if (!c.accepted) return stopUnknown(rec, 'DELETE_RESPONSE_UNKNOWN', 'RESPONSE_UNKNOWN');
      rec.deleteCommandId = c.commandId || '';
      rec.deleteSentAtSec = deps.nowSec();
      rec.reads = 0;
      transition(rec, STATE.DELETE_SENT, null);
      return reconcileDelete(rec);
    }

    /**
     * 削除確定の照合（読み取りのみ。変更 API は呼ばない）。
     * commandId あり: 同一端末・deleteKey・同一 commandId・success の Webhook ＋ ID/名前の両不在。
     * commandId なし: Webhook を必須にせず、永続化した回数・時間上限内の keyList 読取のみ。
     * 読取回数(reads)と送信時刻(deleteSentAtSec)は record に永続化され、再起動でリセットされない。
     */
    function reconcileDelete(rec) {
      if (rec.state !== STATE.DELETE_SENT) return rec;
      if (typeof rec.deleteSentAtSec !== 'number') return stopUnknown(rec, 'DELETE_CONFIRM_FAILED', 'SENT_TIME_MISSING'); // 旧形式は補完しない
      var now = deps.nowSec();
      var webhookOk = false;
      if (rec.deleteCommandId) {
        var ev = eventFor(rec, 'deleteKey', rec.deleteCommandId);
        if (!ev) {
          if (now - rec.deleteSentAtSec > webhookWaitSec) return stopUnknown(rec, 'WEBHOOK_TIMEOUT', 'WEBHOOK_TIMEOUT');
          return rec; // 未着は期限まで保留（読取も消費しない）
        }
        if (ev.conflict) return stopUnknown(rec, 'DELETE_WEBHOOK_CONFLICT', 'WEBHOOK_CONFLICT');
        if (ev.result !== 'success') return stopUnknown(rec, 'DELETE_WEBHOOK_FAILED', ev.result === 'failed' ? 'WEBHOOK_FAILED' : 'WEBHOOK_NOT_SUCCESS');
        webhookOk = true;
      } else if (now - rec.deleteSentAtSec > readWaitSec) {
        return stopUnknown(rec, 'READ_LIMIT', 'READ_WINDOW_EXCEEDED');
      }
      if (rec.reads >= maxReads) return stopUnknown(rec, 'READ_LIMIT', 'READ_LIMIT');
      rec.reads += 1;
      save(recKey(rec.id), rec); // 読取回数を読取前に永続化（再起動でリセットしない）
      var kl = readKeyList();
      if (!kl.ok) {
        if (rec.reads >= maxReads) return stopUnknown(rec, 'READ_LIMIT', kl.error);
        return rec;
      }
      var insp = inspectAbsence(kl.devices, rec.deviceId, rec.name, rec.passcodeId);
      if (!insp.valid) return stopUnknown(rec, 'DELETE_CONFIRM_FAILED', insp.error);
      if (!insp.absent) {
        // Webhook 成功なのに残存 = 矛盾。成功へ寄せず停止
        if (webhookOk) return stopUnknown(rec, 'CONFIRM_MISMATCH', 'WEBHOOK_SUCCESS_BUT_REMAINS');
        if (rec.reads >= maxReads) return stopUnknown(rec, 'KEY_REMAINS', 'KEY_REMAINS');
        return rec; // commandId なし: 反映待ちの可能性。上限まで読取のみ
      }
      if (webhookOk) rec.evidence.push(EVIDENCE.WEBHOOK_SUCCESS);
      rec.evidence.push(EVIDENCE.KEYLIST_ABSENT);
      transition(rec, STATE.DELETED_CONFIRMED, null);
      deps.secrets.del('SECRET_' + rec.id);
      return rec;
    }

    function sameWindow(r, elig) {
      return r.startSec === elig.startSec && r.endSec === elig.endSec && r.deviceId === elig.deviceId;
    }

    function loadAll(idx) {
      return idx.ops.map(function (id) { return load(recKey(id)); }).filter(Boolean);
    }

    // ---- 同期（予約イベント／ジョブ再実行のエントリ） ----
    /**
     * 予約の最新スナップショットを渡して呼ぶ。何度呼んでも冪等。
     * - 古い改訂は無視（巻き戻し禁止）
     * - 取消・非対象・改訂変更時は旧キーを削除対象にする
     * - 旧キーの削除が確定するまで新キーは発行しない
     */
    function sync(booking) {
      var elig = evaluateEligibility(booking, config, deps.nowSec());
      var out = { actions: [], skipped: null };
      if (config.enabled !== true) { out.skipped = 'FLAG_OFF'; return out; } // OFF: 何も呼ばない・書かない
      var locks = ['BOOKING_' + booking.bookingId];
      if (elig.deviceId) locks.push('DEV_' + elig.deviceId);
      deps.lock(locks, function () {
        var idx = bookingIndex(booking.bookingId);
        if (idx.head && booking.revision < idx.head.revision) { out.skipped = 'STALE_REVISION'; return; }
        var cancelledNow = booking.status === 'CANCELLED';
        // 取消済みの後に届いた遅延確定イベント（同改訂以下）で発行しない
        if (idx.head && idx.head.cancelled && !cancelledNow && booking.revision <= idx.head.revision) { out.skipped = 'AFTER_CANCEL'; return; }
        idx.head = {
          revision: booking.revision, cancelled: cancelledNow, desired: !!(elig.eligible && !cancelledNow),
          startSec: elig.eligible ? elig.startSec : null, endSec: elig.eligible ? elig.endSec : null,
          deviceId: elig.eligible ? elig.deviceId : null
        };
        save(bkKey(booking.bookingId), idx);

        var desired = elig.eligible && !cancelledNow;

        // 進行中 record を前へ進める（読み取り中心。変更 API の再送はしない）
        loadAll(idx).forEach(function (r) {
          if (TERMINAL.indexOf(r.state) !== -1) return;
          retryAlert(r);
          if (r.state === STATE.SENDING || r.state === STATE.DELETE_SENDING) {
            stopUnknown(r, 'CRASH_RECOVERY', 'RESUMED_FROM_SENDING');
            out.actions.push('UNKNOWN:' + r.id);
          } else if (r.state === STATE.PLANNED) {
            if (desired && r.revision === booking.revision && sameWindow(r, elig)) {
              executeIssue(r); out.actions.push('RESUME_ISSUE:' + r.id); // 未送信が確実かつ現在も有効
            } else {
              // 現在の予約では不要になった未送信の計画は、createKey を呼ばずに破棄する
              transition(r, STATE.ABANDONED, 'UNSENT_OBSOLETE');
              deps.secrets.del('SECRET_' + r.id);
              out.actions.push('RETIRE_PLANNED:' + r.id);
            }
          } else if (r.state === STATE.SENT_WAIT_WEBHOOK || r.state === STATE.ACCEPTED_NO_COMMAND_ID) {
            reconcileIssue(r); out.actions.push('RECONCILE_ISSUE:' + r.id);
          } else if (r.state === STATE.DELETE_SENT) {
            reconcileDelete(r); out.actions.push('RECONCILE_DELETE:' + r.id);
          }
        });

        // 旧改訂・取消・非対象・期間/対象変更のキーは削除対象
        loadAll(idx).forEach(function (r) {
          if (r.op !== OP.ISSUE) return;
          var stale = !desired || r.revision !== booking.revision || !sameWindow(r, elig);
          if (!stale) return;
          if (r.state === STATE.ISSUED_CONFIRMED || r.state === STATE.EXPIRED || r.state === STATE.DELETE_PENDING) {
            startDelete(r); out.actions.push('DELETE:' + r.id);
          }
        });

        if (!desired) { out.skipped = elig.reason || 'CANCELLED'; return; }

        var recs = loadAll(idx);
        // 旧キーが未確定削除（UNKNOWN 含む）なら新規発行しない
        var blocking = recs.filter(function (r) {
          return r.op === OP.ISSUE && TERMINAL.indexOf(r.state) === -1 &&
            !(r.revision === booking.revision && sameWindow(r, elig));
        });
        if (blocking.length) {
          out.skipped = 'OLD_KEY_UNRESOLVED';
          blocking.forEach(function (r) { alert(r, 'OLD_KEY_UNRESOLVED'); });
          return;
        }
        var same = recs.filter(function (r) { return r.op === OP.ISSUE && r.revision === booking.revision && sameWindow(r, elig); });
        // 削除済み/放棄済みの過去 record は再発行を妨げない（期間 A→B→A の復元）。未完了・FAILED・期限切れは妨げる。
        var REISSUABLE = [STATE.ABANDONED, STATE.DELETED_CONFIRMED, STATE.ALREADY_ABSENT];
        if (same.some(function (r) { return REISSUABLE.indexOf(r.state) === -1; })) { out.skipped = out.skipped || 'ALREADY_PLANNED'; return; }
        startIssue(booking, elig);
        out.actions.push('ISSUE');
      });
      return out;
    }

    // ---- 受渡し ----
    /** ISSUED_CONFIRMED の record にのみ、正規受渡し先へコードを渡す。 */
    function deliver(recId) {
      var head = load(recKey(recId));
      if (!head) return { delivered: false, reason: 'NOT_CONFIRMED' };
      var result;
      // 予約・Keypad のロック下で再読込→検証→受渡し→保存まで行う（取消/削除/二重受渡しと競合させない）
      deps.lock(['BOOKING_' + head.bookingId, 'DEV_' + head.deviceId], function () { result = deliverLocked(recId); });
      return result;
    }

    function deliverLocked(recId) {
      var rec = load(recKey(recId));
      if (!rec || rec.state !== STATE.ISSUED_CONFIRMED) return { delivered: false, reason: 'NOT_CONFIRMED' };
      // 取消済み/改訂で置換された予約には、管理者が存在確認した場合でも受け渡さない
      var head = bookingIndex(rec.bookingId).head;
      if (!head || head.cancelled || !head.desired || head.revision !== rec.revision ||
          head.startSec !== rec.startSec || head.endSec !== rec.endSec || head.deviceId !== rec.deviceId) {
        return { delivered: false, reason: 'NOT_CURRENT' };
      }
      if (rec.deliveredAtSec) return { delivered: false, reason: 'ALREADY_DELIVERED' };
      var code = deps.secrets.get('SECRET_' + rec.id);
      if (!code) return { delivered: false, reason: 'SECRET_MISSING' };
      try {
        deps.deliverCode(rec.bookingId, code, { startSec: rec.startSec, endSec: rec.endSec });
      } catch (e) {
        alert(rec, 'DELIVER_FAILED');
        return { delivered: false, reason: 'DELIVER_FAILED' };
      }
      // 受渡し中に状態が進んでいても上書きしないよう、最新を再読込して受渡し時刻だけ追記する
      var fresh = load(recKey(rec.id)) || rec;
      fresh.deliveredAtSec = deps.nowSec();
      save(recKey(fresh.id), fresh);
      return { delivered: true };
    }

    // ---- 期限切れ・保持期限 ----
    /** 期限切れ（削除とは区別）。未解決状態の状態データ・秘密は破棄しない。 */
    function sweep() {
      var now = deps.nowSec();
      var retention = typeof config.retentionSec === 'number' ? config.retentionSec : 30 * 86400;
      deps.store.keys().filter(function (k) { return k.indexOf('OP_') === 0; }).forEach(function (k) {
        var head = load(k);
        if (!head) return;
        // 予約・Keypad のロック下で再読込してから評価する（進行中の削除等を巻き戻さない）
        deps.lock(['BOOKING_' + head.bookingId, 'DEV_' + head.deviceId], function () {
          var rec = load(k);
          if (rec) sweepOne(k, rec, now, retention);
        });
      });
    }

    function sweepOne(k, rec, now, retention) {
      retryAlert(rec);
      if (rec.state === STATE.ISSUED_CONFIRMED && rec.endSec <= now) {
        transition(rec, STATE.EXPIRED, 'TIME');
      }
      if (rec.state === STATE.EXPIRED) {
        var kl = readKeyList();
        var insp = kl.ok ? inspectAbsence(kl.devices, rec.deviceId, rec.name, rec.passcodeId) : { valid: false };
        if (insp.valid && insp.absent) {
          rec.evidence.push(EVIDENCE.KEYLIST_ABSENT);
          transition(rec, STATE.ARCHIVED_EXPIRED, null);
          deps.secrets.del('SECRET_' + rec.id);
        } else if (insp.valid) {
          alert(rec, 'EXPIRED_KEY_REMAINS'); // 容量管理: 管理者が adminDelete で削除
        } else {
          alert(rec, 'EXPIRED_CHECK_FAILED');
        }
      } else if (TERMINAL.indexOf(rec.state) !== -1 && rec.updatedAt && now - rec.updatedAt > retention) {
        deps.store.del(k);
        deps.secrets.del('SECRET_' + rec.id);
        // 通知の重複抑止マーカーも破棄（ID 再利用時に新しい操作の通知を抑止しない）
        deps.store.keys().forEach(function (ak) {
          if (ak.indexOf('ALERT_' + rec.id + '_') === 0) deps.store.del(ak);
        });
      }
    }

    // ---- 管理者復旧（フラグ OFF でも使える） ----
    /** 読み取り専用の現状確認。 */
    function adminInspect(recId) {
      var rec = load(recKey(recId));
      if (!rec) return { ok: false, error: 'NOT_FOUND' };
      var kl = readKeyList();
      if (!kl.ok) return { ok: false, error: kl.error };
      var insp = inspectKeyList(kl.devices, rec.deviceId, rec.name);
      if (!insp.valid) return { ok: false, error: insp.error };
      return { ok: true, count: insp.count, state: rec.state };
    }

    /**
     * UNKNOWN（発行）の管理者解決。管理者の判断は「どの結論を試すか」だけで、結論は常に keyList で検証する。
     *   CONFIRM_PRESENT … 厳密 1 件・属性整合のときのみ ISSUED_CONFIRMED（ADMIN_KEYLIST 根拠）
     *   ABANDON_ABSENT  … 0 件のときのみ ABANDONED（以後の新 attempt を許可）
     * 変更 API は呼ばない。
     */
    function adminResolveUnknown(recId, decision, actor) {
      var head = load(recKey(recId));
      if (!head) return { ok: false, error: 'NOT_RESOLVABLE' };
      if (!actor) return { ok: false, error: 'ACTOR_REQUIRED' };
      var result;
      // 他の遷移（削除など）と直列化。ロック取得後に再読込して検証し、最新状態を上書きしない
      deps.lock(['BOOKING_' + head.bookingId, 'DEV_' + head.deviceId], function () {
        result = resolveUnknownLocked(recId, decision, actor);
      });
      return result;
    }

    function resolveUnknownLocked(recId, decision, actor) {
      var rec = load(recKey(recId));
      if (!rec || rec.state !== STATE.UNKNOWN || rec.op !== OP.ISSUE) return { ok: false, error: 'NOT_RESOLVABLE' };
      var kl = readKeyList();
      if (!kl.ok) return { ok: false, error: kl.error };
      var insp = inspectKeyList(kl.devices, rec.deviceId, rec.name);
      if (!insp.valid) return { ok: false, error: insp.error };
      // keyList 取得中に状態が進んでいないか再確認（二重の安全策。最新状態を上書きしない）
      rec = load(recKey(recId));
      if (!rec || rec.state !== STATE.UNKNOWN) return { ok: false, error: 'NOT_RESOLVABLE' };
      if (decision === 'CONFIRM_PRESENT') {
        var j = judgeIssued(insp, rec);
        if (!j.ok) return { ok: false, error: j.error };
        rec.passcodeId = j.id;
        rec.evidence.push(EVIDENCE.ADMIN_KEYLIST);
        transition(rec, STATE.ISSUED_CONFIRMED, 'ADMIN:' + actor);
        return { ok: true, state: rec.state };
      }
      if (decision === 'ABANDON_ABSENT') {
        if (insp.count !== 0) return { ok: false, error: 'KEY_STILL_PRESENT' };
        transition(rec, STATE.ABANDONED, 'ADMIN:' + actor);
        deps.secrets.del('SECRET_' + rec.id);
        return { ok: true, state: rec.state };
      }
      return { ok: false, error: 'UNKNOWN_DECISION' };
    }

    /** 管理者による個別削除（フラグ OFF・ロールバック後も使える）。ISSUED_CONFIRMED/EXPIRED のみ。 */
    function adminDelete(recId, actor) {
      var head = load(recKey(recId));
      if (!head || !actor) return { ok: false, error: 'NOT_FOUND_OR_NO_ACTOR' };
      var out;
      deps.lock(['BOOKING_' + head.bookingId, 'DEV_' + head.deviceId], function () {
        var rec = load(recKey(recId)); // ロック取得後に再読込して検証（重複 deleteKey を防ぐ）
        if (rec && (rec.state === STATE.ISSUED_CONFIRMED || rec.state === STATE.EXPIRED || rec.state === STATE.DELETE_PENDING)) {
          out = startDelete(rec);
        }
      });
      if (!out) return { ok: false, error: 'NOT_DELETABLE' };
      return { ok: true, state: out.state };
    }

    /**
     * 管理者による読み取り専用の照合再開（フラグ OFF でも使える）。変更 API は呼ばない。
     * DELETE_SENT / 発行確認待ちを、keyList（と保存済み Webhook）で前へ進める。上限超過は UNKNOWN+通知。
     */
    function adminReconcile(recId, actor) {
      var rec = load(recKey(recId));
      if (!rec || !actor) return { ok: false, error: 'NOT_FOUND_OR_NO_ACTOR' };
      var out;
      deps.lock(['BOOKING_' + rec.bookingId, 'DEV_' + rec.deviceId], function () {
        rec = load(recKey(recId));
        if (rec.state === STATE.DELETE_SENT) out = reconcileDelete(rec);
        else if (rec.state === STATE.SENT_WAIT_WEBHOOK || rec.state === STATE.ACCEPTED_NO_COMMAND_ID) out = reconcileIssue(rec);
        else if (rec.state === STATE.SENDING || rec.state === STATE.DELETE_SENDING) {
          // 結果保存前に中断した送信。sync と同じ保守的復旧: UNKNOWN にして再送しない
          out = stopUnknown(rec, 'CRASH_RECOVERY', 'RESUMED_FROM_SENDING');
        }
        else if (rec.state === STATE.UNKNOWN) { retryAlert(rec); out = rec; }
      });
      if (!out) return { ok: false, error: 'NOT_RECONCILABLE' };
      return { ok: true, state: out.state };
    }

    /** 棚卸し（ロールバック用）。個人情報・秘密を含まない。 */
    function inventory() {
      return deps.store.keys().filter(function (k) { return k.indexOf('OP_') === 0; }).map(function (k) {
        var r = load(k);
        return { id: r.id, state: r.state, endSec: r.endSec, device: maskId(r.deviceId), unresolved: TERMINAL.indexOf(r.state) === -1 };
      });
    }

    return {
      sync: sync, ingestWebhook: ingestWebhook, deliver: deliver, sweep: sweep,
      adminInspect: adminInspect, adminReconcile: adminReconcile, adminResolveUnknown: adminResolveUnknown, adminDelete: adminDelete,
      inventory: inventory
    };
  }

  return {
    STATE: STATE, EVIDENCE: EVIDENCE, OP: OP, TERMINAL: TERMINAL,
    maskId: maskId, jstToEpochSec: jstToEpochSec, resolveKeypad: resolveKeypad,
    evaluateEligibility: evaluateEligibility, inspectKeyList: inspectKeyList, inspectAbsence: inspectAbsence, normDev: normDev, judgeIssued: judgeIssued,
    parseKeypadWebhook: parseKeypadWebhook, classifyApi: classifyApi, createEngine: createEngine
  };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = SwitchBotAccessCore;
}

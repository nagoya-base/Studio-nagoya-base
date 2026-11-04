/*
 * AccessKeySnapshot.gs — 予約台帳 → SwitchBot鍵連携（Issue #748 / #753）の「最新スナップショット」と
 * 鍵に関係する変更の判定。純粋ロジック（GAS依存なし）。
 *
 * 責務（#753）: 予約ルール（間隔30分・延長締切。#758）は持たない。確定後の台帳の最新状態を、鍵側
 * （独立GAS #754 / コア SwitchBotAccessCore）が読める形へ正規化し、「鍵に関係する項目が変わったか」を
 * revision 増分の判定に使うだけ。鍵API・メール・通知は一切呼ばない。
 *
 * 個人情報（氏名・メール・電話・目的）はスナップショットへ入れない。暗証番号も扱わない。
 *
 * 時刻: startAt/endAt（Date）を Asia/Tokyo（UTC+9、DSTなし）の 'YYYY-MM-DD' / 'HH:mm' へ UTC演算だけで変換する。
 * 実行環境のtimezone・Utilities.formatDate・Date#getHours等は使わない（環境依存と二重変換の排除）。
 * 分未満（秒・ミリ秒）が残る日時は丸めず TIME_NOT_MINUTE_ALIGNED として同期を止める。
 */
'use strict';

var AccessKeySnapshot = (function () {
  var JST_OFFSET_MS_ = 9 * 3600 * 1000;
  var TARGET_BRAND_ = 'snb';

  /* 支払根拠（コアの config.eligiblePaymentStatuses に渡す語彙）。承認不明は UNVERIFIED で安全停止側。 */
  var PAYMENT_BASIS = {
    STRIPE_PAID: 'STRIPE_PAID',
    ADMIN_APPROVED: 'ADMIN_APPROVED',
    UNVERIFIED: 'UNVERIFIED'
  };

  /* 変わったら revision を増やす台帳項目（鍵の発行・削除・期間・対象・支払根拠に関わるもの）。
     人数・メール送信済み時刻・料金明細などは含めない（人数のみの変更で再発行しない）。 */
  var KEY_RELEVANT_FIELDS = [
    'status', 'brand', 'paymentMethod', 'paymentStatus', 'paymentConfirmedAt', 'confirmedAt',
    'startAt', 'endAt',
    'feeSettlementState', 'feeRecoveryRequiredAt', 'paymentRecoveryRequiredAt'
  ];

  /* 追加料金の入金・判断が済んでいない延長は、鍵へ確定イベントとして流さない（#750）。 */
  var CHARGE_PENDING_STATES_ = ['PENDING_CHARGE', 'PENDING_DECISION'];

  function isDate_(v) {
    return v !== null && typeof v === 'object' && typeof v.getTime === 'function' && !isNaN(v.getTime());
  }

  function toMillis_(v) {
    if (isDate_(v)) return v.getTime();
    if (typeof v === 'string' && v.trim() !== '') {
      var ms = Date.parse(v);
      return isNaN(ms) ? null : ms;
    }
    return null;
  }

  function pad2_(n) { return (n < 10 ? '0' : '') + n; }

  /** Date/ISO文字列 → { date:'YYYY-MM-DD', time:'HH:mm', aligned:boolean }。不正は null。 */
  function toJst(value) {
    var ms = toMillis_(value);
    if (ms === null) return null;
    var shifted = new Date(ms + JST_OFFSET_MS_);
    return {
      date: shifted.getUTCFullYear() + '-' + pad2_(shifted.getUTCMonth() + 1) + '-' + pad2_(shifted.getUTCDate()),
      time: pad2_(shifted.getUTCHours()) + ':' + pad2_(shifted.getUTCMinutes()),
      aligned: shifted.getUTCSeconds() === 0 && shifted.getUTCMilliseconds() === 0
    };
  }

  function normalizeForFingerprint_(v) {
    if (v === null || v === undefined || v === '') return '';
    var ms = isDate_(v) ? v.getTime() : null;
    return ms !== null ? 'T' + ms : String(v);
  }

  /** 鍵関係項目だけの安定した指紋（Date はミリ秒、空は ''）。revision 比較・ドリフト検知に使う。 */
  function fingerprint(record) {
    var r = record || {};
    return KEY_RELEVANT_FIELDS.map(function (k) { return k + '=' + normalizeForFingerprint_(r[k]); }).join('|');
  }

  /**
   * before と after（更新後の値を反映した予約）で鍵関係項目が変わったか。
   * 鍵が存在し得るのは CONFIRMED の間だけなので、変更前後のどちらも CONFIRMED でない更新
   * （PENDING中の決済試行・日時変更・期限切れ後の編集など）では revision を増やさない。
   * PENDING→CONFIRMED（確定）・EXPIRED→CONFIRMED（復活）・CONFIRMED→CANCELLED/EXPIRED（取消）は
   * 片側が CONFIRMED なので増える。
   */
  function isKeyRelevantChange(before, after) {
    var b = before || {};
    var a = after || {};
    if (String(b.status || '') !== 'CONFIRMED' && String(a.status || '') !== 'CONFIRMED') return false;
    return fingerprint(b) !== fingerprint(a);
  }

  function parseRevision(raw) {
    if (raw === '' || raw === null || raw === undefined) return 0;
    var n = Number(raw);
    return Number.isInteger(n) && n >= 0 ? n : null;
  }

  /** 32bit FNV-1a。暗号用途ではなく、同一revisionでの内容ずれの検知用ダイジェスト。 */
  function digestOf_(text) {
    var h = 0x811c9dc5;
    for (var i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return ('00000000' + h.toString(16)).slice(-8);
  }

  function paymentBasisOf_(record) {
    var isCard = typeof Booking !== 'undefined' && Booking.isCardPaymentMethod(record.paymentMethod);
    if (isCard) {
      /* Stripe: 実入金（paymentStatus=paid）と入金確認時刻の両方が台帳にあるときだけ。 */
      var paid = String(record.paymentStatus || '') === 'paid' && !!record.paymentConfirmedAt;
      return paid ? PAYMENT_BASIS.STRIPE_PAID : PAYMENT_BASIS.UNVERIFIED;
    }
    /* 現金/PayPay等: 管理者の確定操作（confirmBooking）が残す confirmedAt を承認の台帳根拠とする。
       承認者の監査詳細は #750 で未確定のため、根拠が無ければ UNVERIFIED（安全停止）。 */
    return record.confirmedAt ? PAYMENT_BASIS.ADMIN_APPROVED : PAYMENT_BASIS.UNVERIFIED;
  }

  /**
   * 台帳レコード → 鍵連携用スナップショット。
   * options.facility / options.room: 鍵の対応表（brand/facility/room → 完全deviceId）の照合キー。台帳に無いため設定から渡す。
   * blockers が空でなければ、鍵側は新規発行・変更をせず管理者通知（revision・予約ID・理由コードのみ）。
   */
  function build(record, options) {
    var r = record || {};
    var opt = options || {};
    var blockers = [];

    var revision = parseRevision(r.revision);
    if (revision === null) blockers.push('REVISION_INVALID');

    /* brandが空のときだけ対象判定不能として止める。他ブランドはblockerではなく「対象外」: コアの
       eligibleBrands判定で発行せず、既存キーがあれば削除対象になる（SNBから他ブランドへ変更された予約の旧キー回収）。 */
    var brand = String(r.brand || '');
    if (brand === '') blockers.push('BRAND_UNKNOWN');

    var start = toJst(r.startAt);
    var end = toJst(r.endAt);
    if (!start || !end) {
      blockers.push('TIME_INVALID');
    } else {
      if (!start.aligned || !end.aligned) blockers.push('TIME_NOT_MINUTE_ALIGNED');
      if (toMillis_(r.startAt) >= toMillis_(r.endAt)) blockers.push('TIME_INVALID');
    }

    var basis = paymentBasisOf_(r);
    if (String(r.status || '') === 'CONFIRMED' && basis === PAYMENT_BASIS.UNVERIFIED) blockers.push('PAYMENT_UNVERIFIED');
    if (CHARGE_PENDING_STATES_.indexOf(String(r.feeSettlementState || '')) !== -1) blockers.push('EXTENSION_CHARGE_PENDING');
    if (r.feeRecoveryRequiredAt || r.paymentRecoveryRequiredAt) blockers.push('RECOVERY_REQUIRED');

    var snapshot = {
      bookingId: String(r.bookingId || ''),
      revision: revision === null ? 0 : revision,
      brand: brand,
      facility: opt.facility === undefined ? null : opt.facility,
      room: opt.room === undefined ? null : opt.room,
      status: String(r.status || ''),
      paymentStatus: basis,
      date: start ? start.date : null,
      startTime: start ? start.time : null,
      endDate: end ? end.date : null,
      endTime: end ? end.time : null,
      blockers: blockers,
      digest: digestOf_(fingerprint(r))
    };
    if (!snapshot.bookingId) snapshot.blockers.push('BOOKING_INVALID');
    return snapshot;
  }

  /* 確定予約でこのいずれかが残るときは鍵操作を凍結する（発行も削除もせず管理者通知）。既存キーは旧revisionのまま残す。 */
  var FREEZE_BLOCKERS_ = [
    'REVISION_INVALID', 'BOOKING_INVALID', 'BRAND_UNKNOWN', 'TIME_INVALID', 'TIME_NOT_MINUTE_ALIGNED',
    'PAYMENT_UNVERIFIED', 'EXTENSION_CHARGE_PENDING', 'RECOVERY_REQUIRED'
  ];
  /* 順序判定ができないもの。取消でも凍結する。 */
  var IDENTITY_BLOCKERS_ = ['REVISION_INVALID', 'BOOKING_INVALID'];

  /**
   * 発行開始（利用日の前日12:00 JST）。月・年跨ぎはエポック演算で自然に扱う。
   * 戻り値 { issueStartMs, open } 。open は nowMs >= issueStartMs（12:00:00ちょうどから発行）。
   * 時刻不正は { issueStartMs:null, open:false }。当日・前日12:00以降に確定した予約は、確定後の最初の照合で open。
   */
  function issueWindow(snapshot, nowMs) {
    var m = snapshot && /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(snapshot.date || ''));
    if (!m) return { issueStartMs: null, open: false };
    var jstMidnightMs = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) - JST_OFFSET_MS_;
    var issueStartMs = jstMidnightMs - 12 * 3600 * 1000; /* 前日12:00 = 利用日0:00の12時間前 */
    return { issueStartMs: issueStartMs, open: typeof nowMs === 'number' && nowMs >= issueStartMs };
  }

  /**
   * スナップショット → コア(SwitchBotAccessCore.createEngine().sync)へ渡す入力と処理方針。
   * - FREEZE: 鍵操作をしない（reasons付きで管理者通知する）。確定予約の支払/承認不明・延長追加料金未了・要復旧・
   *   時刻不正、および順序判定不能（revision/ID不正）。取消(CANCELLED)は revision/ID が正常なら凍結せず削除へ進める。
   * - SYNC: booking をそのまま sync へ。発行開始前の確定予約は status を HOLD_BEFORE_ISSUE_WINDOW に置換する。
   *   コアは非CONFIRMEDを「発行しない・旧キーは削除対象・取消扱いにはしない」と扱うため、前日12:00前に日程が
   *   動いた予約の旧キーは回収され、12:00以降の最初の照合（同revisionでも）で初めて発行される。
   */
  function toCoreInput(snapshot, nowMs) {
    var sn = snapshot || {};
    var blockers = Array.isArray(sn.blockers) ? sn.blockers : ['BOOKING_INVALID'];
    var identityBad = blockers.some(function (b) { return IDENTITY_BLOCKERS_.indexOf(b) !== -1; });
    var freezeReasons = blockers.filter(function (b) { return FREEZE_BLOCKERS_.indexOf(b) !== -1; });
    if (identityBad || (sn.status === 'CONFIRMED' && freezeReasons.length)) {
      return { action: 'FREEZE', reasons: freezeReasons, booking: null };
    }
    var status = sn.status;
    var hold = false;
    if (status === 'CONFIRMED' && !issueWindow(sn, nowMs).open) {
      status = 'HOLD_BEFORE_ISSUE_WINDOW';
      hold = true;
    }
    return {
      action: 'SYNC',
      reasons: hold ? ['BEFORE_ISSUE_WINDOW'] : [],
      booking: {
        bookingId: sn.bookingId, revision: sn.revision, status: status, paymentStatus: sn.paymentStatus,
        brand: sn.brand, facility: sn.facility, room: sn.room,
        date: sn.date, startTime: sn.startTime, endDate: sn.endDate, endTime: sn.endTime
      }
    };
  }

  /**
   * 照合要否を3条件で独立に判定する（revisionが不変でも時刻到達で処理する）。
   * tracked: { revision:number|null（未取込はnull）, issueWindowHandled:boolean, openKeyRecord:boolean }
   */
  function triggers(snapshot, tracked, nowMs) {
    var t = tracked || {};
    var reasons = [];
    if (t.revision === null || t.revision === undefined || t.revision !== snapshot.revision) reasons.push('REVISION_CHANGED');
    if (snapshot.status === 'CONFIRMED' && issueWindow(snapshot, nowMs).open && !t.issueWindowHandled) reasons.push('ISSUE_WINDOW_REACHED');
    if (t.openKeyRecord) reasons.push('OPEN_KEY_RECORD');
    return reasons;
  }

  return {
    issueWindow: issueWindow,
    toCoreInput: toCoreInput,
    triggers: triggers,
    PAYMENT_BASIS: PAYMENT_BASIS,
    KEY_RELEVANT_FIELDS: KEY_RELEVANT_FIELDS.slice(),
    toJst: toJst,
    fingerprint: fingerprint,
    isKeyRelevantChange: isKeyRelevantChange,
    parseRevision: parseRevision,
    build: build
  };
})();

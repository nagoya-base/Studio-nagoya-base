/*
 * OpsNormalizer.gs — Bookingsシートの値の検証・正規化（Issue #936）。
 *
 * - 取り出すのは ALLOWED_COLUMNS の列だけ。シート全列を返さない。メールアドレス・電話番号・
 *   備考・決済トークン/Stripe ID・カレンダーID・メール送信エラー文等は読み取り対象にも含めない
 *   （鍵の暗証番号等はBookingsシートに存在しない）。
 * - 予約IDは正本の値をそのまま使い、再採番しない。空欄・重複IDの行は一覧/詳細から除外し、
 *   issuesで行番号と理由を返す（別予約の詳細を誤表示しない）。
 * - 日時はJST。0（数値）・空欄（null=未入力）を区別し、値を推測で補完しない（終了が開始以前でも翌日へ補正しない）。
 * - 許可項目の列名が重複するヘッダーは、列の優先順位を決めずschemaErrorで停止する。
 * - 生の行データはログ・戻り値に含めない。issuesは行番号・予約ID・理由コードのみ。
 */
'use strict';

var OpsNormalizer = (function () {
  /* 読み取る列の許可リスト（これ以外の列は値を読まない）。 */
  var ALLOWED_COLUMNS = [
    'bookingId', 'createdAt', 'date', 'startAt', 'endAt', 'brand', 'name', 'people', 'purpose',
    'paymentMethod', 'status', 'source', 'confirmedAt', 'expiredAt', 'cancelledAt', 'updatedAt',
    'customerType', 'paymentStatus', 'priceAmount', 'priceOverrideAmount', 'priceOverrideAt',
    'planCode', 'largeParty'
  ];
  /* 一覧に必要で、無いと意味のある取得ができない列。 */
  var REQUIRED_COLUMNS = ['bookingId', 'date', 'startAt', 'brand', 'status'];

  var ERROR_REASONS = {
    missing_id: '予約IDが空欄',
    duplicate_id: '予約IDが重複',
    missing_date: '利用日が空欄',
    invalid_date: '利用日の形式が不正',
    invalid_start: '開始日時が不正または空欄'
  };
  var WARNING_REASONS = {
    invalid_end: '終了日時が不正または空欄',
    end_before_start: '終了が開始より前（日またぎを表す完全な日時がないため補正していません）',
    end_equals_start: '終了が開始と同時刻（補正していません）',
    date_mismatch: '利用日と開始日時の日付が不一致'
  };

  function text_(value, max) {
    if (value === null || value === undefined) return null;
    var s = String(value).trim();
    if (s === '') return null;
    return s.length > max ? s.slice(0, max) : s;
  }

  function stampText_(value) {
    /* 日時はタイムゾーン付きISO（+09:00）。Date、または既存Adminと同じ 'YYYY-MM-DD HH:mm'（JST）文字列のみ。
       それ以外の文字列は日時として保証できないため返さない（推測しない）。 */
    if (OpsContract.isDate(value)) return OpsContract.toIso(value.getTime());
    var m = typeof value === 'string' ? /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})$/.exec(value.trim()) : null;
    if (!m) return null;
    var day = OpsContract.parseJstDate(m[1]);
    var clock = OpsContract.parseClock(m[2]);
    return day === null || clock === null ? null : OpsContract.toIso(day + clock * 60000);
  }

  function numberOrNull_(value) {
    if (value === '' || value === null || value === undefined || typeof value === 'boolean') return null;
    var n = Number(value);
    return isFinite(n) ? n : null;
  }

  function truthy_(value) {
    return value === true || (typeof value === 'string' && /^(true|1|yes)$/i.test(value.trim()));
  }

  function isBlankRow_(row) {
    for (var i = 0; i < row.length; i++) {
      if (row[i] !== '' && row[i] !== null && row[i] !== undefined) return false;
    }
    return true;
  }

  function dateMs_(value) {
    if (OpsContract.isDate(value)) return { ms: OpsContract.parseJstDate(OpsContract.formatJstDate(value.getTime())), code: null };
    if (value === '' || value === null || value === undefined) return { ms: null, code: 'missing_date' };
    var ms = OpsContract.parseJstDate(String(value));
    return ms === null ? { ms: null, code: 'invalid_date' } : { ms: ms, code: null };
  }

  function clockOrDateMs_(value, baseDateMs) {
    if (OpsContract.isDate(value)) return value.getTime();
    var minutes = OpsContract.parseClock(typeof value === 'string' ? value : '');
    if (minutes === null || baseDateMs === null) return null;
    return baseDateMs + minutes * 60000;
  }

  function buildRecord_(get, rowNumber, issues, idCounts) {
    var bookingId = text_(get('bookingId'), 80);
    var codes = [];
    if (bookingId === null) codes.push('missing_id');
    /* 重複は不正行も含めて数える（不正な行と同じIDの有効行が、唯一の予約として残らないようにする）。 */
    else if (idCounts[bookingId] > 1) codes.push('duplicate_id');
    var d = dateMs_(get('date'));
    if (d.code) codes.push(d.code);
    var startMs = clockOrDateMs_(get('startAt'), d.ms);
    if (startMs === null) codes.push('invalid_start');
    if (codes.length) {
      issues.push({ row: rowNumber, bookingId: bookingId, severity: 'error', codes: codes });
      return null;
    }
    var warnings = [];
    var endRaw = get('endAt');
    var endMs = clockOrDateMs_(endRaw, d.ms);
    /* 終了が開始以前でも翌日へ補正しない（値を推測で補完しない）。日またぎは、終了が完全な日時（Date）で
       翌日として入っている場合のみ正式に扱う。時刻だけの文字列は同日として解釈し、逆転は警告する。 */
    if (endMs === null) warnings.push('invalid_end');
    else if (endMs === startMs) warnings.push('end_equals_start');
    else if (endMs < startMs) warnings.push('end_before_start');
    var dateText = OpsContract.formatJstDate(d.ms);
    if (OpsContract.formatJstDate(startMs) !== dateText) warnings.push('date_mismatch');
    if (warnings.length) issues.push({ row: rowNumber, bookingId: bookingId, severity: 'warning', codes: warnings });

    var service = OpsContract.serviceForBrand(get('brand'));
    var statusRaw = text_(get('status'), 20);
    var status = statusRaw && OpsContract.STATUS_LABELS[statusRaw.toUpperCase()] ? statusRaw.toUpperCase() : null;
    var overridden = text_(get('priceOverrideAt'), 40) !== null || OpsContract.isDate(get('priceOverrideAt'));
    var price = overridden ? numberOrNull_(get('priceOverrideAmount')) : numberOrNull_(get('priceAmount'));

    return {
      bookingId: bookingId,
      rowNumber: rowNumber,
      service: service.id,
      serviceLabel: service.label,
      brandRaw: text_(get('brand'), 40),
      status: status,
      statusRaw: status ? null : statusRaw,
      statusLabel: status ? OpsContract.STATUS_LABELS[status] : '不明',
      date: dateText,
      startMs: startMs,
      endMs: endMs,
      startAt: OpsContract.toIso(startMs),
      endAt: endMs === null ? null : OpsContract.toIso(endMs),
      name: text_(get('name'), 80),
      people: numberOrNull_(get('people')),
      customerType: text_(get('customerType'), 40),
      purpose: text_(get('purpose'), 200),
      paymentMethod: text_(get('paymentMethod'), 40),
      paymentStatus: text_(get('paymentStatus'), 40),
      planCode: text_(get('planCode'), 40),
      effectivePriceAmount: price,
      priceOverridden: overridden,
      largeParty: truthy_(get('largeParty')),
      source: text_(get('source'), 40),
      createdAt: stampText_(get('createdAt')),
      updatedAt: stampText_(get('updatedAt')),
      confirmedAt: stampText_(get('confirmedAt')),
      cancelledAt: stampText_(get('cancelledAt')),
      expiredAt: stampText_(get('expiredAt'))
    };
  }

  /*
   * values: getValues()相当の2次元配列（1行目がヘッダー）。
   * 戻り値: { schemaError: {missing:[]}|null, records: [], issues: [], blankRows: n, totalRows: n }
   */
  function normalize(values) {
    var header = values && values.length ? values[0] : [];
    var index = {};
    var duplicated = [];
    for (var c = 0; c < header.length; c++) {
      var name = typeof header[c] === 'string' ? header[c].trim() : '';
      if (name && ALLOWED_COLUMNS.indexOf(name) !== -1) {
        if (index[name] === undefined) index[name] = c;
        else if (duplicated.indexOf(name) === -1) duplicated.push(name);
      }
    }
    /* 許可項目の列名が重複していたら、どの列が正かを判断せず停止する（片方だけを正しい値として表示しない）。 */
    if (duplicated.length) {
      return { schemaError: { missing: [], duplicated: duplicated }, records: [], issues: [], blankRows: 0, totalRows: 0 };
    }
    var missing = REQUIRED_COLUMNS.filter(function (col) { return index[col] === undefined; });
    if (missing.length) {
      return { schemaError: { missing: missing }, records: [], issues: [], blankRows: 0, totalRows: 0 };
    }
    var issues = [];
    var records = [];
    var blankRows = 0;
    var totalRows = 0;
    /* 重複ID: 空白でない全行のIDを先に数え、該当する全行を除外する（どれが正かをこの層では判断しない）。 */
    var idCounts = {};
    for (var p = 1; p < values.length; p++) {
      if (isBlankRow_(values[p])) continue;
      var rawId = text_(index.bookingId === undefined ? '' : values[p][index.bookingId], 80);
      if (rawId !== null) idCounts[rawId] = (idCounts[rawId] || 0) + 1;
    }
    for (var r = 1; r < values.length; r++) {
      var row = values[r];
      if (isBlankRow_(row)) { blankRows++; continue; }
      totalRows++;
      var record = buildRecord_(function (key) { return index[key] === undefined ? '' : row[index[key]]; }, r + 1, issues, idCounts);
      if (record) records.push(record);
    }
    issues.sort(function (a, b) { return a.row - b.row; });
    var duplicateIds = Object.keys(idCounts).filter(function (k) { return idCounts[k] > 1; });
    return { schemaError: null, records: records, issues: issues, duplicateIds: duplicateIds, blankRows: blankRows, totalRows: totalRows };
  }

  function reasonText(code) {
    return ERROR_REASONS[code] || WARNING_REASONS[code] || code;
  }

  return {
    ALLOWED_COLUMNS: ALLOWED_COLUMNS,
    REQUIRED_COLUMNS: REQUIRED_COLUMNS,
    normalize: normalize,
    reasonText: reasonText
  };
})();

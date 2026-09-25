/*
 * Code.gs — 自社予約システム Web App エントリポイント（Issue #266: getAvailability / Issue #268: createBooking / Issue #342: estimatePrice）。
 *
 * doGet: action未指定=getAvailability・action=monthly=getMonthlyAvailability・
 *   action=estimatePrice=利用料金の見積り（Issue #342）。いずれも読み取り専用でPIIを
 *   含まない。
 * doPost: action未指定=createBooking（Issue #268で追加）・action=startCardCheckout=
 *   Stripe Checkout Session発行（Issue #341 PR-B）。いずれも個人情報を書き込む/参照する
 *   APIのため、GETではなくPOST専用にしている（GETクエリパラメータや閲覧履歴にPIIが
 *   残る事故を避けるため。actionの判定自体はURLクエリパラメータe.parameterで行う
 *   ―doGetのaction振り分けと同じ方式―が、実際の入力本体はcreateBookingと同様に
 *   POST bodyから読む）。
 *   createBooking自体もBookingPricing.computeBookingPriceで金額を必ず再計算する
 *   （estimatePriceが返す見積り値はフロント表示専用で、確定金額の正本ではない）。
 *   startCardCheckoutもBookingRepository.beginCardCheckout内でCardPayment.
 *   computeExpectedPaymentAmount経由の金額を必ず再計算し、bookingId以外の入力を
 *   受け取らない（クライアントから金額を送らせる余地自体を作らない）。
 *
 * デプロイ設定（README.md参照）:
 *   Execute as: Me
 *   Who has access: Anyone
 *
 * フロントエンドはCalendar ID・Spreadsheet IDを一切知らない。Script Propertiesで管理し、
 * getAvailabilityのレスポンスにもcreateBookingのレスポンスにも、他の予約のイベント詳細・
 * PIIを一切含めない（createBookingは呼び出した本人が送った内容の要約のみを返す）。
 */
'use strict';

function doGet(e) {
  var params = (e && e.parameter) || {};
  if (params.action === 'monthly') {
    return jsonOutput_(handleGetMonthlyAvailability_(params));
  }
  if (params.action === 'estimatePrice') {
    return jsonOutput_(handleEstimatePrice_(params));
  }
  return jsonOutput_(handleGetAvailability_(params));
}

function doPost(e) {
  var params = (e && e.parameter) || {};
  if (params.action === 'startCardCheckout') {
    return jsonOutput_(handleStartCardCheckout_(e));
  }
  return jsonOutput_(handleCreateBooking_(e));
}

/* Issue #273解決後に削除する一時関数。Booking Web Appのデプロイ所有者に
   Spreadsheet / Calendar / MailAppのOAuth認可を明示的に求めるため、エディタから手動実行する。 */
function authorizeBookingWebAppScopes() {
  var properties = PropertiesService.getScriptProperties();
  var spreadsheetId = properties.getProperty('SPREADSHEET_ID');
  var calendarId = properties.getProperty('CALENDAR_ID');

  if (!spreadsheetId || !calendarId) {
    throw new Error('SPREADSHEET_ID または CALENDAR_ID が設定されていません。');
  }

  SpreadsheetApp.openById(spreadsheetId).getId();

  var calendar = CalendarApp.getCalendarById(calendarId);
  if (!calendar) {
    throw new Error('Calendarを取得できません。');
  }
  calendar.getId();

  /* 実メールを送信せず、MailAppのOAuth scopeだけを要求する。 */
  MailApp.getRemainingDailyQuota();

  Logger.log('Booking Web App authorization check: OK');
}

/* e.postData.contentsをJSONとしてパースし、BookingRepository.createBookingへ渡す。
   createBooking内部・依存先で想定外の例外が発生した場合も、スタックトレースや内部エラー
   文言を外部レスポンスへ出さず、汎用のINTERNAL_ERRORとして返す（詳細はLoggerへのみ残す）。 */
function handleCreateBooking_(e) {
  /* Issue #273の一時診断用。ブラウザが受け取った応答とGAS実行ログを、PIIを
     記録せずに同一リクエストとして突合できるようにする。 */
  var requestId = Utilities.getUuid();
  Logger.log('requestId=' + requestId + ' createBooking=start');

  var payload;
  try {
    payload = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (parseError) {
    Logger.log('requestId=' + requestId + ' createBooking=result error.code=INVALID_JSON');
    return {
      success: false,
      error: { code: 'INVALID_JSON', message: 'リクエストの形式が正しくありません。' },
      requestId: requestId
    };
  }

  try {
    var result = BookingRepository.createBooking(payload, undefined, requestId);
    /* 診断中にRepositoryが想定外のnull/undefined等を返しても、requestId付与時の
       TypeErrorへ原因をすり替えず、相関可能なINTERNAL_ERRORとして返す。 */
    if (!result || typeof result !== 'object') {
      result = {
        success: false,
        error: { code: 'INTERNAL_ERROR', message: '予約処理中にエラーが発生しました。しばらくしてから再度お試しください。' }
      };
    }
    if (result && result.success) {
      Logger.log('requestId=' + requestId + ' createBooking=result success');
    } else {
      var errorCode = result && result.error && result.error.code;
      Logger.log('requestId=' + requestId + ' createBooking=result error.code=' + sanitizeErrorCode_(errorCode));
    }
    result.requestId = requestId;
    return result;
  } catch (unexpectedError) {
    /* 例外messageには入力値や設定値が混入し得るため、診断ログには出さない。 */
    Logger.log('requestId=' + requestId + ' createBooking=result error.code=INTERNAL_ERROR');
    return {
      success: false,
      error: { code: 'INTERNAL_ERROR', message: '予約処理中にエラーが発生しました。しばらくしてから再度お試しください。' },
      requestId: requestId
    };
  }
}

/* error.codeは固定の識別子だけをログへ出す。想定外の文字列はPII混入を避けて伏せる。 */
function sanitizeErrorCode_(errorCode) {
  var value = String(errorCode || 'UNKNOWN_ERROR');
  return /^[A-Z][A-Z0-9_]*$/.test(value) ? value : 'UNKNOWN_ERROR';
}

/*
 * Stripe Checkout Session発行（Issue #341 PR-B）。e.postData.contentsを{bookingId}のみを
 * 受け取るJSONとしてパースし、BookingRepository.beginCardCheckoutへ渡す。金額・ブランド等
 * bookingId以外のフィールドは一切受け取らない（クライアントに金額を主張させる余地自体を
 * 作らない。beginCardCheckout内部でCardPayment.computeExpectedPaymentAmount経由の
 * サーバー計算額のみを使う）。handleCreateBooking_と同じ方針で、想定外の例外は
 * スタックトレース・内部エラー文言を外部へ出さず汎用のINTERNAL_ERRORとして返す。
 */
function handleStartCardCheckout_(e) {
  var requestId = Utilities.getUuid();
  Logger.log('requestId=' + requestId + ' startCardCheckout=start');

  var payload;
  try {
    payload = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (parseError) {
    Logger.log('requestId=' + requestId + ' startCardCheckout=result error.code=INVALID_JSON');
    return {
      success: false,
      error: { code: 'INVALID_JSON', message: 'リクエストの形式が正しくありません。' },
      requestId: requestId
    };
  }

  var bookingId = payload && typeof payload.bookingId === 'string' ? payload.bookingId : '';
  if (!bookingId || bookingId.length > 64) {
    Logger.log('requestId=' + requestId + ' startCardCheckout=result error.code=INVALID_BOOKING_ID');
    return {
      success: false,
      error: { code: 'INVALID_BOOKING_ID', message: 'bookingIdを指定してください。' },
      requestId: requestId
    };
  }

  try {
    var result = BookingRepository.beginCardCheckout(bookingId);
    if (!result || typeof result !== 'object') {
      result = {
        success: false,
        error: { code: 'INTERNAL_ERROR', message: '決済処理中にエラーが発生しました。しばらくしてから再度お試しください。' }
      };
    }
    if (result && result.success) {
      Logger.log('requestId=' + requestId + ' startCardCheckout=result success');
    } else {
      var errorCode = result && result.error && result.error.code;
      Logger.log('requestId=' + requestId + ' startCardCheckout=result error.code=' + sanitizeErrorCode_(errorCode));
    }
    result.requestId = requestId;
    return result;
  } catch (unexpectedError) {
    Logger.log('requestId=' + requestId + ' startCardCheckout=result error.code=INTERNAL_ERROR');
    return {
      success: false,
      error: { code: 'INTERNAL_ERROR', message: '決済処理中にエラーが発生しました。しばらくしてから再度お試しください。' },
      requestId: requestId
    };
  }
}

/* params: { date, durationMinutes, brand }（すべて文字列。GASのdoGetクエリパラメータのため） */
function handleGetAvailability_(params) {
  var config = BookingConfig.getAvailabilityConfig();

  var request = {
    date: params.date,
    durationMinutes: parseDurationParam_(params.durationMinutes),
    brand: params.brand || null
  };

  var validationError = BookingAvailability.validateInput(request.date, request.durationMinutes, config);
  if (validationError) {
    return { success: false, error: validationError };
  }

  /*
   * 過去日はCalendarへ問い合わせる前にfail-closedに拒否する（2回目レビュー指摘対応）。
   * BookingAvailability.getAvailability内でも同じ判定を行うため二重の安全網になるが、
   * ここで先に弾くことで過去日リクエストの無駄なCalendar API呼び出しを避ける。
   * todayString算出はBookingAvailability.formatDateInTimezone（共通ヘルパー）を再利用し、
   * 判定ロジック自体を重複実装しない。receivedAtはこの後のgetAvailability呼び出しにも
   * そのまま渡し、同一リクエスト内で「現在時刻」が呼び出しごとにぶれないようにする。 */
  var receivedAt = new Date();
  var todayString = BookingAvailability.formatDateInTimezone(receivedAt, config.timezone);
  if (!todayString) {
    return { success: false, error: { code: 'INVALID_CONFIG', message: '営業時間・予約ルールの設定が正しくありません。' } };
  }
  if (request.date < todayString) {
    return { success: false, error: { code: 'INVALID_DATE', message: '過去の日付は指定できません。' } };
  }

  var calendarId = BookingConfig.getCalendarId();
  var busyIntervals = CalendarRepository.getBusyIntervalsForDate(calendarId, request.date, config.timezone);

  return BookingAvailability.getAvailability(request, busyIntervals, config, receivedAt);
}

/*
 * 月間空き状況（Issue #318）。paramsは { year, month, durationMinutes, brand }
 * （すべて文字列。GASのdoGetクエリパラメータのため）。
 *
 * 月間取得はHTTPリクエスト1回・Calendar.getEvents()も月内で1回に集約する
 * （CalendarRepository.getBusyIntervalsForRangeが対象月の全日付ぶんを1回のgetEvents()で
 * まとめて取得する。Issue #318追記のレビュー対応）。日ごとのステータス判定自体は
 * BookingAvailability.getMonthlyAvailabilityへ委譲し、ここでは配線のみを行う。
 */
function handleGetMonthlyAvailability_(params) {
  var config = BookingConfig.getAvailabilityConfig();

  var year = parsePositiveIntegerParam_(params.year);
  var month = parsePositiveIntegerParam_(params.month);
  var durationMinutes = parseDurationParam_(params.durationMinutes);
  var brand = params.brand || null;
  /* timeBand未指定・不正値はBookingAvailability.getMonthlyAvailability内の
     normalizeTimeBandがfail-closedにせずallへフォールバックする（Issue #324）。
     ここではparams.timeBandをそのまま渡すだけで、バリデーション・正規化を
     重複実装しない。 */
  var timeBand = params.timeBand;

  var request = { year: year, month: month, durationMinutes: durationMinutes, brand: brand, timeBand: timeBand };
  var validationError = BookingAvailability.validateMonthlyInput(year, month, durationMinutes, config);
  if (validationError) {
    return { success: false, error: validationError };
  }

  var monthString = year + '-' + (month < 10 ? '0' : '') + month;
  var lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  var startDate = monthString + '-01';
  var endDate = monthString + '-' + (lastDay < 10 ? '0' : '') + lastDay;

  var calendarId = BookingConfig.getCalendarId();
  var busyIntervalsByDate = CalendarRepository.getBusyIntervalsForRange(calendarId, startDate, endDate, config.timezone);

  return BookingAvailability.getMonthlyAvailability(request, busyIntervalsByDate, config, new Date());
}

/*
 * 利用料金の見積り（Issue #342）。予約フォームがStep2/3で日時・利用時間が揃った時点で
 * 呼ぶ、読み取り専用のGETエンドポイント。Calendar/Sheetsへは一切アクセスしない
 * （空き状況の再確認はgetAvailability側の責務であり、ここでは行わない）。
 *
 * ここで返す金額はあくまで見積りであり、実際に予約として保存される金額の正本ではない。
 * BookingRepository.createBookingは予約作成時に必ず同じBookingPricing.
 * computeBookingPriceで金額を再計算するため、フロントエンドはこの見積り値を「確定金額」
 * として送信・信用してはならない（createBookingのレスポンスに含まれるpriceが最終値）。
 *
 * params: { brand, date, durationMinutes, isMember }（すべて文字列。GASのdoGetクエリ
 * パラメータのため）。いずれもPIIを含まないため、GET・クエリパラメータで問題ない
 * （handleGetAvailability_と同じ方針）。
 */
function handleEstimatePrice_(params) {
  var config = BookingConfig.getAvailabilityConfig();

  if (!Booking.isAllowedBrand(params.brand)) {
    return { success: false, error: { code: 'INVALID_BRAND', message: 'このブランドではオンライン予約を受け付けていません。' } };
  }

  var durationMinutes = parseDurationParam_(params.durationMinutes);
  var validationError = BookingAvailability.validateInput(params.date, durationMinutes, config);
  if (validationError) {
    return { success: false, error: validationError };
  }

  var priceResult = BookingPricing.computeBookingPrice({
    brand: params.brand,
    date: params.date,
    durationMinutes: durationMinutes,
    isMember: parseBooleanParam_(params.isMember)
  });
  if (!priceResult.valid) {
    return { success: false, error: priceResult.error };
  }

  return {
    success: true,
    brand: params.brand,
    date: params.date,
    durationMinutes: durationMinutes,
    price: priceResult.price
  };
}

/*
 * '1'・'true'（大文字小文字を問わない）だけをtrueとして受理する。それ以外（未指定・
 * 'false'・不正な文字列等）はすべてfalseにするfail-closedな変換
 * （Booking.gsのisMember正規化=input.isMember === trueと同じ「会員特典を誤って
 * 適用しない」方向。GETクエリパラメータは常に文字列のため、Boolean('false')が
 * trueになってしまう素朴な変換は使わない）。
 */
function parseBooleanParam_(value) {
  return value === '1' || String(value).toLowerCase() === 'true';
}

/* 公開Web APIのため、"120abc"や"120.9"のような部分一致をparseIntで緩く受理しない。
   文字列全体が先頭0を持たない正の整数のときだけ数値化し、それ以外はNaNにする
   （Availability.gs側のバリデーションに判定を委ねる。マージ前レビュー指摘対応）。
   year/month（Issue #318のgetMonthlyAvailability）も同じ形式のクエリパラメータのため、
   同じパターン・同じ関数を共有する。 */
var POSITIVE_INTEGER_PATTERN_ = /^[1-9]\d*$/;

function parsePositiveIntegerParam_(value) {
  if (typeof value !== 'string' || !POSITIVE_INTEGER_PATTERN_.test(value)) return NaN;
  return parseInt(value, 10);
}

function parseDurationParam_(value) {
  return parsePositiveIntegerParam_(value);
}

function jsonOutput_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

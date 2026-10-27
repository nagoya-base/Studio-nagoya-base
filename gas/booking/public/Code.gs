/*
 * Code.gs — 自社予約システム Web App エントリポイント（Issue #266: getAvailability / Issue #268: createBooking / Issue #342: estimatePrice）。
 *
 * doGet: action未指定=getAvailability・action=monthly=getMonthlyAvailability・
 *   action=estimatePrice=利用料金の見積り（Issue #342）。いずれも読み取り専用でPIIを
 *   含まない。
 * doPost（Issue #471: action=startMembershipCheckout=SNB MEMBER入会Checkout開始も受け付ける）:
 *   action未指定=createBooking（Issue #268で追加）・action=startCardCheckout=
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
  if (params.action === 'optionCatalog') {
    return jsonOutput_(handleOptionCatalog_(params));
  }
  return jsonOutput_(handleGetAvailability_(params));
}

function doPost(e) {
  var params = (e && e.parameter) || {};
  if (params.action === 'startCardCheckout') {
    return jsonOutput_(handleStartCardCheckout_(e));
  }
  if (params.action === 'startMembershipCheckout') {
    return jsonOutput_(handleStartMembershipCheckout_(e));
  }
  if (params.action === 'requestMembershipStatus' || params.action === 'membershipStatus' || params.action === 'cancelMembership') {
    return jsonOutput_(handleMembershipStatusAction_(params.action, e));
  }
  if (params.action === 'testMonthly' || params.action === 'testEstimatePrice') {
    return jsonOutput_(handleTestCredentialRead_(params.action, e));
  }
  if (params.action === 'requestBookingMemberCode' || params.action === 'verifyBookingMemberCode' || params.action === 'bookingMemberStatus') {
    return jsonOutput_(handleBookingMemberAction_(params.action, e));
  }
  if (params.action === 'optionSummary' || params.action === 'submitOptions' || params.action === 'startOptionCheckout') {
    return jsonOutput_(handleOptionAction_(params.action, e));
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
 * Stripe Checkout Session発行（Issue #341 PR-B）。e.postData.contentsを{bookingId,
 * checkoutAccessToken}のみを受け取るJSONとしてパースし、BookingRepository.
 * beginCardCheckoutへ渡す。金額・ブランド等bookingId以外のフィールドは一切受け取らない
 * （クライアントに金額を主張させる余地自体を作らない。beginCardCheckout内部で
 * CardPayment.computeExpectedPaymentAmount経由のサーバー計算額のみを使う）。
 * handleCreateBooking_と同じ方針で、想定外の例外はスタックトレース・内部エラー文言を
 * 外部へ出さず汎用のINTERNAL_ERRORとして返す。
 *
 * checkoutAccessToken（PR #354レビュー対応・項目1）: bookingIdだけでは第三者が
 * Checkout URLを取得できてしまうため、createBooking（カード決済のみ）が発行し送信元
 * ブラウザへ返した推測困難なトークンの一致をbeginCardCheckoutへ必須で検証させる。
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

  /* トークン自体の値はログへ一切出力しない（形式チェックのみ。実際の一致判定は
     BookingRepository.beginCardCheckout側で行う）。 */
  var checkoutAccessToken = payload && typeof payload.checkoutAccessToken === 'string' ? payload.checkoutAccessToken : '';
  if (!checkoutAccessToken || checkoutAccessToken.length > 100) {
    Logger.log('requestId=' + requestId + ' startCardCheckout=result error.code=FORBIDDEN');
    return {
      success: false,
      error: { code: 'FORBIDDEN', message: '予約が見つからないか、操作の権限がありません。' },
      requestId: requestId
    };
  }

  try {
    var result = BookingRepository.beginCardCheckout(bookingId, checkoutAccessToken);
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

/*
 * SNB MEMBER入会Checkoutの開始（Issue #471）。{ email, brand }のみを受け取る（金額・戻り先URLは受け取らない。brandはsnb/mens/studio_xのコードのみ。Issue #504）。
 * 既存会員かどうかは応答に含めない（結果はメールで伝える）。想定外の例外は汎用のINTERNAL_ERRORとして返す。
 */
function handleStartMembershipCheckout_(e) {
  var requestId = Utilities.getUuid();
  var payload;
  try {
    payload = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (parseError) {
    return { success: false, error: { code: 'INVALID_JSON', message: 'リクエストの形式が正しくありません。' }, requestId: requestId };
  }
  try {
    var result = MembershipService.startCheckout({ email: payload && payload.email, brand: payload && payload.brand });
    if (!result || typeof result !== 'object') {
      result = { success: false, error: { code: 'INTERNAL_ERROR', message: '処理中にエラーが発生しました。しばらくしてから再度お試しください。' } };
    }
    Logger.log('requestId=' + requestId + ' startMembershipCheckout=result ' + (result.success ? 'success' : 'error.code=' + sanitizeErrorCode_(result.error && result.error.code)));
    result.requestId = requestId;
    return result;
  } catch (unexpectedError) {
    Logger.log('requestId=' + requestId + ' startMembershipCheckout=result error.code=INTERNAL_ERROR');
    return { success: false, error: { code: 'INTERNAL_ERROR', message: '処理中にエラーが発生しました。しばらくしてから再度お試しください。' }, requestId: requestId };
  }
}

/*
 * 会員資格確認（Issue #490）。requestMembershipStatus={ email }: 会員の有無にかかわらず同一応答で本人確認リンクを
 * メール送信。membershipStatus={ token }: ワンタイムトークンの本人にだけ会員状態を返す。PII・トークンを扱うためPOST専用で、
 * リクエスト本文・トークンはログに出さない。想定外の例外は汎用のINTERNAL_ERROR。
 * cancelMembership={ cancelToken }（Issue #506）: 本人確認の応答で渡した短命トークンの本人にだけ、次回更新停止を行う。
 */
function handleMembershipStatusAction_(action, e) {
  var requestId = Utilities.getUuid();
  var payload;
  try {
    payload = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (parseError) {
    return { success: false, error: { code: 'INVALID_JSON', message: 'リクエストの形式が正しくありません。' }, requestId: requestId };
  }
  try {
    var result;
    if (action === 'membershipStatus') {
      result = MembershipService.verifyStatusLink({ token: payload && payload.token });
    } else if (action === 'cancelMembership') {
      result = MembershipService.cancelMembership({ cancelToken: payload && payload.cancelToken });
    } else {
      result = MembershipService.requestStatusLink({ email: payload && payload.email });
    }
    if (!result || typeof result !== 'object') {
      result = { success: false, error: { code: 'INTERNAL_ERROR', message: '処理中にエラーが発生しました。しばらくしてから再度お試しください。' } };
    }
    Logger.log('requestId=' + requestId + ' ' + action + '=result ' + (result.success ? 'success' : 'error.code=' + sanitizeErrorCode_(result.error && result.error.code)));
    result.requestId = requestId;
    return result;
  } catch (unexpectedError) {
    Logger.log('requestId=' + requestId + ' ' + action + '=result error.code=INTERNAL_ERROR');
    return { success: false, error: { code: 'INTERNAL_ERROR', message: '処理中にエラーが発生しました。しばらくしてから再度お試しください。' }, requestId: requestId };
  }
}

/*
 * V2予約の会員確認（Issue #548。SNB / SNB mensの2026/12/1 0:00 JST以降に作成する直接予約）。メールアドレス・OTP・証明を扱うためPOST専用で、
 * リクエスト本文はログに出さない。想定外の例外は汎用のINTERNAL_ERROR。
 * - requestBookingMemberCode={ email }: 会員か否かにかかわらず同一の処理・同一の応答で6桁の確認コードをメール送信する。
 * - verifyBookingMemberCode={ email, code }: 確認コードを検証し、メール・用途に拘束した確認済み証明（60分）と、今日の先行予約資格を返す。
 * - bookingMemberStatus={ brand, email, proof, date?, durationMinutes?, startTime?, plan? }: 確認済み証明が有効な場合だけ、
 *   先行予約資格・利用日の会員資格・会員料金の見積りを返す（証明なし・期限切れ・メール不一致・改ざん時は会員情報を返さない）。
 */
function handleBookingMemberAction_(action, e) {
  var requestId = Utilities.getUuid();
  var payload;
  try {
    payload = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (parseError) {
    return { success: false, error: { code: 'INVALID_JSON', message: 'リクエストの形式が正しくありません。' }, requestId: requestId };
  }
  try {
    var result;
    if (action === 'verifyBookingMemberCode') {
      result = BookingMemberVerification.verifyCode({ email: payload && payload.email, code: payload && payload.code });
    } else if (action === 'bookingMemberStatus') {
      result = handleBookingMemberStatus_(payload || {});
    } else {
      result = BookingMemberVerification.requestCode({ email: payload && payload.email });
    }
    if (!result || typeof result !== 'object') {
      result = { success: false, error: { code: 'INTERNAL_ERROR', message: '処理中にエラーが発生しました。しばらくしてから再度お試しください。' } };
    }
    Logger.log('requestId=' + requestId + ' ' + action + '=result ' + (result.success ? 'success' : 'error.code=' + sanitizeErrorCode_(result.error && result.error.code)));
    result.requestId = requestId;
    return result;
  } catch (unexpectedError) {
    Logger.log('requestId=' + requestId + ' ' + action + '=result error.code=INTERNAL_ERROR');
    return { success: false, error: { code: 'INTERNAL_ERROR', message: '処理中にエラーが発生しました。しばらくしてから再度お試しください。' }, requestId: requestId };
  }
}

/*
 * 会員結果の再取得と会員料金の見積り。V1/V2はサーバー側の判定（BookingGenerationMode。緊急停止 ＞ 12/1前のTEST設定 ＞ サーバー時刻）で決め、クライアント指定では切り替えない。
 * V1・対象外ブランド（snb / mens以外）は、この確認の仕組みを使わないためエラー。会員料金は、確認済み証明が有効かつ利用日が会員資格内のときだけ。
 */
function handleBookingMemberStatus_(payload) {
  var brand = payload.brand;
  if (brand !== 'snb' && brand !== 'mens') {
    return { success: false, error: { code: 'INVALID_BRAND', message: 'このブランドでは会員確認を使用しません。' } };
  }
  var now = new Date();
  /* Issue #559: createBookingと同じ世代判定（テスト資格はPOST本文のtestCredentialを予約メールに拘束して検証する）。 */
  var decision = BookingGenerationMode.decide(now, brand, testContext_(payload));
  var generation = decision.generation;
  if (generation !== BookingPricing.GENERATION.V2) {
    return withTestCredentialStatus_({ success: false, error: { code: 'MEMBER_VERIFICATION_NOT_REQUIRED', message: 'この予約では会員確認は不要です。' }, priceGeneration: generation }, decision);
  }
  var date = typeof payload.date === 'string' ? payload.date : '';
  var status = BookingMemberVerification.memberStatus({ email: payload.email, proof: payload.proof, date: date }, now);
  if (!status.success) return status;
  status.priceGeneration = generation;
  withTestCredentialStatus_(status, decision);
  var config = BookingConfig.getAvailabilityConfig();
  var durationMinutes = typeof payload.durationMinutes === 'number' ? payload.durationMinutes : parseDurationParam_(payload.durationMinutes);
  if (date && durationMinutes && !BookingAvailability.validateInput(date, durationMinutes, config)) {
    var plan = BookingPricing.normalizePlan(payload.plan);
    if (plan === null || BookingPricing.isEventPlan(plan)) {
      return { success: false, error: { code: 'INVALID_PLAN', message: 'プランの指定が正しくありません。' } };
    }
    if (plan && status.memberOnDate !== true) {
      return { success: false, error: { code: MembershipRules.MEMBER_BENEFIT_DENIED_CODE, message: MembershipRules.MEMBER_BENEFIT_DENIED_MESSAGE } };
    }
    var priceResult = BookingPricing.computeBookingPrice({
      brand: brand,
      date: date,
      durationMinutes: durationMinutes,
      isMember: status.memberOnDate === true,
      startTime: payload.startTime,
      generation: generation,
      plan: plan
    });
    if (priceResult.valid) status.price = priceResult.price;
  }
  return status;
}

/*
 * 予約オプション（Issue #423。Studio X限定）。
 *
 * optionCatalog（GET）: オプションの種類・料金・文言。PIIなし・読み取り専用。料金は
 *   BookingOptions / Config（Script Properties）が正本で、画面はここから取得して表示する。
 * optionSummary / submitOptions / startOptionCheckout（POST。PIIを扱うためGETにしない）:
 *   いずれも「予約ID＋登録メールアドレス」で本人確認する。予約IDだけでは操作できない。
 *   本人確認の失敗は存在有無を区別しない同一のFORBIDDENを返し、予約ID単位でレート制限する。
 *   金額・状態はクライアントから受け取らない（optionsの選択内容とoptionOrderIdのみ）。
 */
function handleOptionCatalog_(params) {
  var brand = params.brand || '';
  if (!Booking.isAllowedBrand(brand)) {
    return { success: false, error: { code: 'INVALID_BRAND', message: 'このブランドではオンライン予約を受け付けていません。' } };
  }
  return { success: true, catalog: OptionOrderService.getCatalog(brand) };
}

var OPTION_ACTION_RATE_LIMIT_ = { windowMinutes: 10, maxCount: 20 };

function handleOptionAction_(action, e) {
  var requestId = Utilities.getUuid();
  Logger.log('requestId=' + requestId + ' ' + action + '=start');

  var payload;
  try {
    payload = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (parseError) {
    Logger.log('requestId=' + requestId + ' ' + action + '=result error.code=INVALID_JSON');
    return { success: false, error: { code: 'INVALID_JSON', message: 'リクエストの形式が正しくありません。' }, requestId: requestId };
  }

  var bookingId = payload && typeof payload.bookingId === 'string' ? payload.bookingId : '';
  var email = payload && typeof payload.email === 'string' ? payload.email : '';
  if (!bookingId || bookingId.length > 64 || !email || email.length > 254) {
    Logger.log('requestId=' + requestId + ' ' + action + '=result error.code=FORBIDDEN');
    return { success: false, error: { code: 'FORBIDDEN', message: '予約が見つからないか、操作の権限がありません。' }, requestId: requestId };
  }

  try {
    var allowed = RateLimiter.limitByKey('opt_' + bookingId, OPTION_ACTION_RATE_LIMIT_.windowMinutes, OPTION_ACTION_RATE_LIMIT_.maxCount);
    var result;
    if (!allowed) {
      result = { success: false, error: { code: 'RATE_LIMITED', message: '操作回数が多すぎます。しばらく時間を置いてから再度お試しください。' } };
    } else if (action === 'optionSummary') {
      result = OptionOrderService.getCustomerSummary(bookingId, email);
    } else if (action === 'submitOptions') {
      result = OptionOrderService.submitAddonOptions(bookingId, email, payload.options);
    } else {
      result = OptionOrderService.startOptionCheckout(bookingId, email, typeof payload.optionOrderId === 'string' ? payload.optionOrderId : '');
    }
    if (!result || typeof result !== 'object') {
      result = { success: false, error: { code: 'INTERNAL_ERROR', message: '処理中にエラーが発生しました。しばらくしてから再度お試しください。' } };
    }
    var errorCode = result.success ? '' : (result.error && result.error.code);
    Logger.log('requestId=' + requestId + ' ' + action + '=result ' + (result.success ? 'success' : 'error.code=' + sanitizeErrorCode_(errorCode)));
    result.requestId = requestId;
    return result;
  } catch (unexpectedError) {
    Logger.log('requestId=' + requestId + ' ' + action + '=result error.code=INTERNAL_ERROR');
    return { success: false, error: { code: 'INTERNAL_ERROR', message: '処理中にエラーが発生しました。しばらくしてから再度お試しください。' }, requestId: requestId };
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

  /* 予約可能期間（Issue #480）。90日超はCalendarへ問い合わせず、getAvailabilityと同じ判定・同じエラーで拒否する。 */
  if (BookingWindow.classifyDate(request.date, todayString) === BookingWindow.BAND.OUT_OF_RANGE) {
    return { success: false, error: { code: 'DATE_OUT_OF_RANGE', message: '予約できるのは' + BookingWindow.MEMBER_DAYS + '日先までです。' } };
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
function handleGetMonthlyAvailability_(params, context) {
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

  return withPriceGeneration_(BookingAvailability.getMonthlyAvailability(request, busyIntervalsByDate, config, new Date()), brand, context);
}

/*
 * 料金世代（'V1'|'V2'）をGET応答へ付ける（Issue #532）。予約フォームがV2（SNBは2026/12/1 00:00 JST以降）で
 * 会員の自己申告ラジオを出さないための判断を、ブラウザ端末の時計ではなくサーバーの現在時刻
 * （BookingGenerationMode.decide。createBookingの最終判定と同じ関数）に基づかせる。会員情報は一切含めない。
 * ブランド不明・失敗応答にはそのまま返す（フォームは世代を判定できなければラジオを表示する側へ倒す）。
 */
function withPriceGeneration_(result, brand, context) {
  if (result && result.success === true && typeof brand === 'string' && brand) {
    try {
      /* Issue #559: createBookingと同じ判定（BookingGenerationMode）。contextはテスト資格付きPOST（testMonthly）だけが渡す。 */
      var decision = BookingGenerationMode.decide(new Date(), brand, context);
      result.priceGeneration = decision.generation;
      withTestCredentialStatus_(result, decision);
    } catch (generationError) {
      /* 世代を付けられなくても応答は変えない（フォームはラジオを表示する側へ倒す）。 */
    }
  }
  return result;
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
 * params: { brand, date, durationMinutes, isMember, plan }（すべて文字列。GASのdoGetクエリ
 * パラメータのため）。いずれもPIIを含まないため、GET・クエリパラメータで問題ない
 * （handleGetAvailability_と同じ方針）。
 */
function handleEstimatePrice_(params, context) {
  var config = BookingConfig.getAvailabilityConfig();

  if (!Booking.isAllowedBrand(params.brand)) {
    return { success: false, error: { code: 'INVALID_BRAND', message: 'このブランドではオンライン予約を受け付けていません。' } };
  }

  var durationMinutes = parseDurationParam_(params.durationMinutes);
  var validationError = BookingAvailability.validateInput(params.date, durationMinutes, config);
  if (validationError) {
    return { success: false, error: validationError };
  }

  /* Issue #496: 貸切ベースプランの見積りにオプション指定が付いていれば、正常な見積りを返さず拒否する。 */
  if (BookingPricing.isEventPlan(BookingPricing.normalizePlan(params.plan)) && BookingPricing.hasOptionSelection(params.options)) {
    return { success: false, error: BookingPricing.eventPlanOptionsError() };
  }

  /* Issue #559: 世代はリクエスト1回につき1度だけ判定し、料金・応答のpriceGenerationに同じ値を使う。 */
  var decision = BookingGenerationMode.decide(new Date(), params.brand, context);
  var generation = decision.generation;
  var priceResult = BookingPricing.computeBookingPrice({
    brand: params.brand,
    date: params.date,
    durationMinutes: durationMinutes,
    /* Issue #548: V2のSNBはメールOTPの確認済み証明が無い限り会員料金にしない。見積りGETはクライアントのisMemberを無視して
       一般料金とし、会員料金の見積りは確認済み証明を検証するPOST（bookingMemberStatus）だけが返す。 */
    isMember: isEstimateMemberTierLocked_(params.brand, generation) ? false : parseBooleanParam_(params.isMember),
    startTime: params.startTime,
    generation: generation,
    /* Issue #478: 2名ペアパックの見積り。見積りAPIでは会員台帳を一切照会しない（会員の有無を
       探る口にしない）。資格の確認は予約作成時のサーバー側だけで行う。 */
    plan: params.plan
  });
  if (!priceResult.valid) {
    return { success: false, error: priceResult.error };
  }

  return withTestCredentialStatus_({
    success: true,
    brand: params.brand,
    date: params.date,
    durationMinutes: durationMinutes,
    price: priceResult.price,
    priceGeneration: generation
  }, decision);
}

function isEstimateMemberTierLocked_(brand, generation) {
  return brand === 'snb' && generation === BookingPricing.GENERATION.V2;
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

/*
 * テスト資格（Issue #559）。Booking Web App専用で、クライアントがモード値・世代値を指定する口は無い。
 * - testContext_: POST本文の { testCredential, email } だけを取り出す（文字列以外は無視）。URLクエリ・ヘッダーからは読まない。
 * - withTestCredentialStatus_: 資格を送ったリクエストにだけ、資格の扱い（VALID / INVALID / INACTIVE）を応答へ付ける。
 *   フォームはINVALID / INACTIVEで資格を破棄する。理由（期限切れ・失効・メール不一致等）は返さない（監査ログ側の識別子のみ）。
 */
function testContext_(payload) {
  var credential = payload && typeof payload.testCredential === 'string' ? payload.testCredential : '';
  var email = payload && typeof payload.email === 'string' ? payload.email : '';
  return credential ? { testCredential: credential, email: email } : undefined;
}

function withTestCredentialStatus_(result, decision) {
  if (decision && decision.testCredential !== BookingGenerationMode.CREDENTIAL.NONE) {
    result.testCredentialStatus = decision.testCredential;
  }
  return result;
}

/*
 * テスト資格付きの月間空き状況・見積り（POST。資格は本文のJSONに入れ、createBookingと同じContent-Type: text/plainで送る）。
 * GAS Web Appはカスタムリクエストヘッダーを読めず、GETクエリには資格を載せないため、資格が必要な匿名GET経路はこのPOSTへ置き換える。
 * 資格を持たない通常利用者の既存GET（action=monthly / estimatePrice）はそのまま。本文は { email, testCredential, ...GETと同じ項目 }。
 * 想定外の例外は汎用のINTERNAL_ERRORとして返し、本文・資格・メールはログに出さない。
 */
function handleTestCredentialRead_(action, e) {
  var requestId = Utilities.getUuid();
  var payload;
  try {
    payload = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (parseError) {
    return { success: false, error: { code: 'INVALID_JSON', message: 'リクエストの形式が正しくありません。' }, requestId: requestId };
  }
  try {
    var params = {};
    Object.keys(payload || {}).forEach(function (name) {
      var value = payload[name];
      /* GETクエリと同じく文字列として扱う（数値は文字列化。オブジェクト等はそのまま渡して下流の検証で拒否させる）。 */
      params[name] = typeof value === 'number' ? String(value) : value;
    });
    var context = testContext_(payload);
    var result = action === 'testMonthly' ? handleGetMonthlyAvailability_(params, context) : handleEstimatePrice_(params, context);
    if (!result || typeof result !== 'object') {
      result = { success: false, error: { code: 'INTERNAL_ERROR', message: '処理中にエラーが発生しました。しばらくしてから再度お試しください。' } };
    }
    Logger.log('requestId=' + requestId + ' ' + action + '=result ' + (result.success ? 'success' : 'error.code=' + sanitizeErrorCode_(result.error && result.error.code)));
    result.requestId = requestId;
    return result;
  } catch (unexpectedError) {
    Logger.log('requestId=' + requestId + ' ' + action + '=result error.code=INTERNAL_ERROR');
    return { success: false, error: { code: 'INTERNAL_ERROR', message: '処理中にエラーが発生しました。しばらくしてから再度お試しください。' }, requestId: requestId };
  }
}

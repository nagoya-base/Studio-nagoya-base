/*
 * BookingAdminWeb.gs — 個人用Booking Admin Web UI（Issue #305）。
 *
 * 「1人で使うBooking Adminを、スマホから確定・キャンセルしやすくする最低限のUI」が目的。
 * 新しい予約管理ロジックは一切作らず、既存の正式関数（confirmBooking(bookingId) /
 * cancelBookingAdmin(bookingId)。いずれもBookingAdmin.gs）とSpreadsheetRepository.gsの
 * 読み取り関数をそのまま呼ぶ薄いラッパーのみを置く。statusセルの直接編集・独自の
 * Calendar/Sheets/Mail/Recovery処理は一切持たない。
 *
 * 【重要・デプロイ先について】このファイルはBookingAdmin.gs等と同じBooking Admin
 * プロジェクト（`SPREADSHEET_ID`のSpreadsheetへコンテナバインド）へデプロイする。
 * 公開Booking Web Appプロジェクト（Code.gs）には一切追加しない。
 *
 * 【Web Appとしてのデプロイについて】Booking Adminプロジェクトは、従来「Spreadsheetの
 * UI拡張＋時間主導トリガー」としてのみ使い、Web Appとしてはデプロイしていなかった
 * （README「管理メニュー用GASプロジェクト（Booking Admin）のセットアップ」参照）。
 * このIssueでは、同一プロジェクトに`doGet()`を追加し、あわせてWeb Appとしてもデプロイする
 * （Execute as: Me / Who has access: Only myself。管理者本人のみアクセス可能）。
 * container-boundスクリプトはonOpen単純トリガーとWeb Appエントリポイントを同一プロジェクト内で
 * 共存させられるため、この変更によって「予約管理」カスタムメニューやPENDING TTL失効の
 * 時間主導トリガーの動作は変わらない。
 *
 * 【LockServiceについて】adminConfirmBooking/adminCancelBookingは、いずれもBookingAdmin.gsの
 * confirmBooking(bookingId)/cancelBookingAdmin(bookingId)をそのまま呼ぶ。
 * LockService.getScriptLock()はスクリプトプロジェクト単位の排他であり、呼び出し元が
 * onOpenメニューだろうとWeb App（doGet/google.script.run）だろうと同じLockを取得するため、
 * expirePendingBookingsとの排他は今までどおり保たれる（Web App化によってLock設計は
 * 変わらない）。
 *
 * このファイルはHtmlService/SpreadsheetApp.openByIdに依存するため、GAS実行環境でのみ
 * 動作する。node --testではdoGet以外（getAdminBookings/getAdminBookingDetail/
 * adminConfirmBooking/adminCancelBooking）をSpreadsheetApp等のスタブ経由で検証する。
 *
 * 【日時の扱いについて】Bookingsシートのstartat/endAt等はSpreadsheet上のDate値だが、
 * google.script.runをまたいでDateオブジェクトをそのまま返すと、クライアント側での扱いが
 * 実行環境依存になりやすい。ここでは既存のBookingAvailability.formatDateInTimezone/
 * formatTimeInTimezone（Availability.gs。他の管理者向け表示・メール本文でも使っている
 * 既存の純粋関数）を再利用し、Web UIへ渡す前に必ずAsia/Tokyo（Script Propertiesの
 * TIMEZONE）基準の文字列へ正規化する。新しい日時ロジックは追加していない。
 */
'use strict';

/* Web Appエントリポイント。BookingAdminPage.html（同一プロジェクトへ配布するHTMLファイル）を
   そのまま返すだけで、業務ロジックはここに一切持たない。 */
function doGet() {
  return HtmlService.createHtmlOutputFromFile('BookingAdminPage')
    .setTitle('Booking Admin')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/* Booking.gs/BookingRepository.gs等と同じduck-typingでDateかどうかを判定する。 */
function isAdminWebDateLike_(value) {
  return !!value && typeof value.getTime === 'function' && !isNaN(value.getTime());
}

/*
 * google.script.runでHTML側へ返す直前の最終防波堤（不具合修正: Stripe決済リンク送信）。
 *
 * getAdminBookings/getAdminBookingDetailはフィールドごとに手動でformatAdminDateTime_等を
 * 呼び、Date値を文字列へ正規化したうえで個別に組み立てたオブジェクトを返している
 * （このファイル冒頭のコメント「日時の扱いについて」参照）。一方adminSendCardPaymentLink等は
 * BookingMailer.gs（共有ロジック）の戻り値をそのままHTML側へ委譲する設計であり
 * （「独自ロジックを持たない」という既存の設計方針。このファイルの他のadmin*関数と同じ）、
 * BookingMailer.sendPaymentLinkMailForBookingの成功時の戻り値にはsentAt（Dateオブジェクト）が
 * 含まれる。sendPaymentLinkMailForBooking自体はtest/booking-mailer.test.jsやスクリプト
 * エディタからの直接呼び出しでもDateオブジェクトのまま扱われる前提のAPIであるため、
 * BookingMailer.gs側の戻り値の型は変更せず、HTML側へ返す直前のこの層でのみ変換する。
 *
 * - Dateオブジェクト（isAdminWebDateLike_）→ ISO 8601文字列（toISOString()）。
 *   Booking Admin画面はこの値を人が読む表示には使わず（表示用は既存のformatAdminDateTime_
 *   済み文字列のみ）、成功アラートの文言にも含めないため、タイムゾーン変換は不要。
 * - 値がundefinedのプロパティ → キーごと省略する。sendPaymentLinkMailForBookingは
 *   `intendedSendCount: metadataWriteFailed ? nextSendCount : undefined`のように成功時
 *   オブジェクトへ明示的にundefinedを持つプロパティを含めることがある。JSON.stringifyは
 *   これをキーごと省略するが、google.script.runの内部シリアライズはJSON.stringifyと
 *   同一の実装ではなく、オブジェクト中に明示的なundefinedプロパティが残っていると
 *   戻り値全体のシリアライズに失敗し、HTML側のwithSuccessHandlerへ結果の代わりにnullが
 *   渡ることがある（送信自体・履歴の記録は成功しているのに、画面には
 *   「送信できませんでした: null」とだけ表示される不具合の原因）。この関数はArray同様、
 *   undefinedを含む値を必ず取り除いてから返す。
 * - Array → 要素ごとに再帰する（要素がundefinedになった場合はnullへ置き換え、配列の
 *   添字がずれないようにする。JSON.stringifyの配列に対する挙動と揃える）。
 * - プレーンオブジェクト → キーごとに再帰し、変換結果がundefinedのキーは省略する。
 * - 上記以外（string/number/boolean/null）はそのまま返す。
 */
function sanitizeForClient_(value) {
  if (value === undefined || value === null) return value;
  if (isAdminWebDateLike_(value)) return value.toISOString();
  if (Array.isArray(value)) {
    return value.map(function (item) {
      var sanitized = sanitizeForClient_(item);
      return sanitized === undefined ? null : sanitized;
    });
  }
  if (typeof value === 'object') {
    var result = {};
    Object.keys(value).forEach(function (key) {
      var sanitized = sanitizeForClient_(value[key]);
      if (sanitized !== undefined) result[key] = sanitized;
    });
    return result;
  }
  return value;
}

/* Date値のみ'HH:mm'へ変換する。Date以外（''や既存の文字列）はそのまま返す。 */
function formatAdminTime_(value, timezone) {
  if (!isAdminWebDateLike_(value)) return value === undefined || value === null ? '' : value;
  return BookingAvailability.formatTimeInTimezone(value, timezone) || '';
}

/*
 * Date値のみ'YYYY-MM-DD'へ変換する。Date以外（''や既存の文字列）はそのまま返す。
 * Bookingsシートの`date`列は本来文字列として保存しているが、Google Sheets側の
 * セル書式・入力補完によって日付らしい文字列がDate値として保存・読み込まれる場合が
 * あるため、`record.date`もstartAt/endAt等と同じくduck-typingでDateかどうかを確認し、
 * Web UIへは必ず'YYYY-MM-DD'の文字列として返す。
 */
function formatAdminDate_(value, timezone) {
  if (!isAdminWebDateLike_(value)) return value === undefined || value === null ? '' : value;
  return BookingAvailability.formatDateInTimezone(value, timezone) || '';
}

/* Date値のみ'YYYY-MM-DD HH:mm'へ変換する。Date以外（''や既存の文字列）はそのまま返す。 */
function formatAdminDateTime_(value, timezone) {
  if (!isAdminWebDateLike_(value)) return value === undefined || value === null ? '' : value;
  var datePart = BookingAvailability.formatDateInTimezone(value, timezone);
  var timePart = BookingAvailability.formatTimeInTimezone(value, timezone);
  return datePart && timePart ? datePart + ' ' + timePart : '';
}

/*
 * createdAt専用の正規化関数（PRレビュー対応）。createdAtは一覧の「予約順」ソートの
 * キーとして使うため、他のDate列（date/startAt等。formatAdminDateTime_が「Date値以外は
 * そのまま返す」のでよい）と異なり、文字列で渡ってきた場合も含めて必ず比較可能な
 * 'YYYY-MM-DD HH:mm'形式へ揃える必要がある。素通りさせると、Sheetsの読み込み結果が
 * Date値ではなく不揃いな文字列だった場合に予約順ソートが崩れうるため：
 * - Date値 → formatAdminDateTime_と同じくAsia/Tokyo基準で'YYYY-MM-DD HH:mm'へ変換
 * - 既に'YYYY-MM-DD HH:mm'形式の文字列 → そのまま返す（余計な再変換をしない）
 * - それ以外の文字列でDateとして解釈できるもの（ISO文字列等）→ 同じ形式へ変換する
 * - 上記のいずれでもない値（空文字列・null/undefined・解釈不能な文字列・数値等）は
 *   形式を推測せず''へ落とす（例外を投げない。ソート側は空文字列同士なら
 *   bookingIdでの安定ソートにフォールバックする）
 */
function normalizeAdminCreatedAt_(value, timezone) {
  if (isAdminWebDateLike_(value)) return formatAdminDateTime_(value, timezone);
  if (typeof value !== 'string') return '';
  var trimmed = value.trim();
  if (trimmed === '') return '';
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(trimmed)) return trimmed;
  var parsed = new Date(trimmed);
  return isAdminWebDateLike_(parsed) ? formatAdminDateTime_(parsed, timezone) : '';
}

/*
 * 一覧取得（Issue #305「読み取り」節どおり、全件取得→UI側で今日/今後/すべてを絞り込む）。
 * 個人管理用途で件数が小規模な前提のため、専用の検索API・ページネーションは作らない。
 *
 * 「今日」判定を端末のtimezoneに依存させないため、サーバー側（Asia/Tokyo基準）で
 * 計算した`todayJst`を一覧と一緒に返す。クライアント側はこの文字列とbooking.date
 * （既にJST基準の'YYYY-MM-DD'）を単純比較するだけで、端末のtimezone設定に関わらず
 * 常に正しく「今日/今後」を判定できる。
 *
 * PIIを一般公開しないため、一覧カードの表示に不要なフィールド（email/phone/note/
 * mail SentAt系/lastMailError系等）はここでは返さない。それらは詳細取得
 * （getAdminBookingDetail）でのみ返す。
 *
 * createdAtは一覧の「予約順」ソート（クライアント側でcreatedAt降順に並べ替える）のために
 * 返す。カード表示には使わない（BookingAdminPage.html参照）。他のDate値と同じく
 * google.script.run越しにDateオブジェクトをそのまま渡さない。ソートキーとして
 * 比較可能な形式が必須なため、Date値だけを変換して文字列はそのまま素通りさせる
 * formatAdminDateTime_ではなく、文字列も含めて必ず'YYYY-MM-DD HH:mm'形式へ揃える
 * normalizeAdminCreatedAt_を使う（詳細は同関数のコメント参照）。
 */
/*
 * カード予約の支払期限（Issue #334）。createdAt/startAtが揃っている場合のみ
 * Booking.computeCardPaymentDueMillis（expirePendingBookingsの失効判定と同じ1関数）で
 * 計算し、Web UI用に'YYYY-MM-DD HH:mm'へ整形する。カード以外・データ不備の場合は
 * 空文字を返す（読み取り専用表示。台帳の値を書き換えることはしない）。
 */
function computeAdminCardPaymentDueAt_(record, timezone) {
  if (!Booking.isCardPaymentMethod(record.paymentMethod)) return '';
  if (!isAdminWebDateLike_(record.createdAt) || !isAdminWebDateLike_(record.startAt)) return '';
  var ttlConfig = BookingConfig.getTtlConfig();
  var dueMillis = Booking.computeCardPaymentDueMillis(record.createdAt.getTime(), record.startAt.getTime(), ttlConfig.minHoursBeforeStart);
  return formatAdminDateTime_(new Date(dueMillis), timezone);
}

function getAdminBookings() {
  var timezone = BookingConfig.getAvailabilityConfig().timezone;
  var todayJst = BookingAvailability.formatDateInTimezone(new Date(), timezone);
  var bookings = SpreadsheetRepository.getAllBookings().map(function (item) {
    var record = item.record;
    var priceSummary = buildAdminPriceSummary_(record);
    return {
      bookingId: record.bookingId,
      createdAt: normalizeAdminCreatedAt_(record.createdAt, timezone),
      date: formatAdminDate_(record.date, timezone),
      startAt: formatAdminTime_(record.startAt, timezone),
      endAt: formatAdminTime_(record.endAt, timezone),
      brand: record.brand,
      name: record.name,
      people: record.people,
      customerType: record.customerType,
      purpose: record.purpose,
      paymentMethod: record.paymentMethod,
      status: record.status,
      /* Issue #334: カード予約のみ非空（読み取り専用の支払期限表示用）。 */
      cardPaymentDueAt: computeAdminCardPaymentDueAt_(record, timezone),
      /*
       * Issue #342: 利用料金。一覧では「実際に案内すべき金額」（自動計算値・修正値の
       * いずれか）と「修正済みかどうか」だけを返し、詳細な区分（tier/dayType等）は
       * getAdminBookingDetailでのみ返す。キー名はeffectivePriceAmountとし、
       * getAdminBookingDetailが返すpriceAmount（＝予約時点の自動計算値。修正の有無に
       * 関わらず不変）と混同しないようにする。priceUpdateNeeded（PR #343レビュー対応）は
       * 「金額修正済みだが利用者への訂正案内がまだ」の案内漏れを一覧でも見えるようにする。
       */
      effectivePriceAmount: priceSummary.effectiveAmount,
      priceOverridden: priceSummary.overridden,
      priceUpdateNeeded: priceSummary.updateNeeded
    };
  });
  return { todayJst: todayJst, bookings: bookings };
}

/*
 * 利用料金の表示用サマリ（Issue #342。priceUpdateNeededはPR #343レビュー対応で追加）。
 * effectiveAmountはBooking.getEffectivePriceAmount（priceOverrideAtが空でなければ
 * priceOverrideAmountを優先）そのもので、「案内すべき実効金額」の判定ロジックをここで
 * 複製しない。料金データを持たない過去の予約ではeffectiveAmountがnullになる（Web UI側は
 * nullを「未計算」として表示する）。
 * priceUpdateNeeded: 管理者が金額を修正した（priceOverrideAtが非空）のに、その訂正案内
 * （BookingMailer.sendPriceUpdateMailForBooking）をまだ送っていない（priceUpdateMailSentAt
 * が未送信、または最後の修正より古い）PENDING予約だけtrueになる。一覧・詳細の両方でこのフラグを使い、「案内漏れ」を
 * 管理者が見落とさないようにする（PR #343レビュー「管理画面で案内漏れを防げるように」）。
 */
function needsPriceUpdateNotice_(record) {
  return record.status === Booking.STATUS.PENDING && Booking.needsPriceUpdateNotice(record);
}

function buildAdminPriceSummary_(record) {
  return {
    effectiveAmount: Booking.getEffectivePriceAmount(record),
    overridden: !!record.priceOverrideAt,
    updateNeeded: needsPriceUpdateNotice_(record)
  };
}

/*
 * 詳細取得。Bookingsの当該行の値を編集はしないが、Date値はWeb UI用の文字列へ正規化して
 * 返す（google.script.run越しにDateオブジェクトをそのまま渡さない）。lastMailError*の
 * 詳細（エラー内容・種別・日時）はWeb UIへは出さず、`hasMailError`（あり/なし）のみ返す
 * （障害調査はSpreadsheetを直接確認する運用のまま）。
 */
function getAdminBookingDetail(bookingId) {
  var found = SpreadsheetRepository.findRowByBookingId(bookingId);
  if (!found) {
    return { success: false, error: { code: 'NOT_FOUND', message: 'bookingIdが見つかりません: ' + bookingId } };
  }
  var timezone = BookingConfig.getAvailabilityConfig().timezone;
  var record = found.record;
  return {
    success: true,
    booking: {
      bookingId: record.bookingId,
      rescheduleVersion: isAdminWebDateLike_(record.startAt) && isAdminWebDateLike_(record.endAt) ? record.startAt.getTime() + ':' + record.endAt.getTime() : '',
      date: formatAdminDate_(record.date, timezone),
      startAt: formatAdminDateTime_(record.startAt, timezone),
      endAt: formatAdminDateTime_(record.endAt, timezone),
      brand: record.brand,
      status: record.status,
      name: record.name,
      email: record.email,
      phone: record.phone,
      people: record.people,
      customerType: record.customerType,
      purpose: record.purpose,
      paymentMethod: record.paymentMethod,
      source: record.source,
      note: record.note,
      pendingMailSentAt: formatAdminDateTime_(record.pendingMailSentAt, timezone),
      confirmedMailSentAt: formatAdminDateTime_(record.confirmedMailSentAt, timezone),
      cancelMailSentAt: formatAdminDateTime_(record.cancelMailSentAt, timezone),
      expiredMailSentAt: formatAdminDateTime_(record.expiredMailSentAt, timezone),
      reminderSentAt: formatAdminDateTime_(record.reminderSentAt, timezone),
      accessGuideSentAt: formatAdminDateTime_(record.accessGuideSentAt, timezone),
      hasMailError: !!record.lastMailErrorAt,
      /* Issue #334: カード予約のみ非空（読み取り専用の支払期限表示用）。 */
      cardPaymentDueAt: computeAdminCardPaymentDueAt_(record, timezone),
      /*
       * Issue #334 PR-C: Stripe決済リンク送信欄の表示制御・送信状態表示用。
       * isCardPaymentは「支払方法がオンラインクレジットカード」の判定を、Web UI側で
       * 内部文字列（'オンラインクレジットカード'）を複製せずBooking.gs 1箇所に
       * 委ねるための真偽値（Booking.isCardPaymentMethodと同じ判定）。
       * paymentLinkLastErrorMessageは、hasMailError（他メール種別と共有・真偽値のみ）と
       * 異なり、決済リンク送信専用の「最終送信エラー」表示のためsanitize済みの本文を
       * そのまま返す（Issue #334本文の管理画面要件どおり）。
       */
      isCardPayment: Booking.isCardPaymentMethod(record.paymentMethod),
      stripePaymentLinkUrl: record.stripePaymentLinkUrl || '',
      paymentLinkSentAt: formatAdminDateTime_(record.paymentLinkSentAt, timezone),
      paymentLinkSentTo: record.paymentLinkSentTo || '',
      paymentLinkSendCount: Number(record.paymentLinkSendCount) || 0,
      paymentLinkLastErrorAt: formatAdminDateTime_(record.paymentLinkLastErrorAt, timezone),
      paymentLinkLastErrorMessage: record.paymentLinkLastErrorMessage || '',
      /* PRレビュー対応: 送信履行が未確認（MailApp送信は成功したがpaymentLinkSentAtの
         記録に失敗した）状態を予約詳細へ表示するための項目。空でなければ、通常送信
         （forceなし）はGAS側で拒否される（BookingMailer.gs参照）。 */
      paymentLinkSendUnconfirmedAt: formatAdminDateTime_(record.paymentLinkSendUnconfirmedAt, timezone),
      /*
       * 第2回PRレビュー対応: paymentLinkSentAtの単独更新には成功したが、続くURL/送信先/
       * paymentLinkSendCount等の更新が失敗し、これらの記録内容が古いままの可能性がある
       * ことを予約詳細へ表示するための項目（送信可否には影響しない。表示専用）。
       */
      paymentLinkMetadataInconsistentAt: formatAdminDateTime_(record.paymentLinkMetadataInconsistentAt, timezone),
      /*
       * 第2回PRレビュー対応（同時再送の競合防止の拡張）: paymentLinkSentAtの内部表現
       * （epoch ms。未送信は0）。表示用のpaymentLinkSentAt（'YYYY-MM-DD HH:mm'。分単位）
       * とは別に、ミリ秒精度で送信履歴のバージョンをクライアントへ渡す。クライアントは
       * この値を解釈・加工せず、adminSendCardPaymentLinkの呼び出しへそのまま往復させる
       * だけの内部トークンとして扱う（BookingMailer.gsのcheckSendHistoryVersion_参照）。
       */
      paymentLinkSentAtVersion: isAdminWebDateLike_(record.paymentLinkSentAt) ? record.paymentLinkSentAt.getTime() : 0,
      /*
       * 利用料金の詳細（Issue #342）。priceAmountは予約時点の自動計算値（変更しない）、
       * priceOverrideAmount/priceOverrideAtは管理者による修正値・修正日時（未修正なら
       * それぞれnull/空文字）、effectivePriceAmountはBooking.getEffectivePriceAmountが
       * 返す「実際に案内すべき金額」。canEditPrice（PENDINGのみtrue）はUI側の編集フォーム
       * 表示制御用（実際の可否はBookingRepository.updateBookingPrice側で最終判定するため、
       * ここは表示制御のヒントに過ぎない）。
       */
      priceAmount: Number.isFinite(Number(record.priceAmount)) && record.priceAmount !== '' ? Number(record.priceAmount) : null,
      priceTier: record.priceTier || '',
      priceDayType: record.priceDayType || '',
      priceIsMember: record.priceIsMember === true,
      priceComputedAt: formatAdminDateTime_(record.priceComputedAt, timezone),
      priceOverrideAmount: record.priceOverrideAt && Number.isFinite(Number(record.priceOverrideAmount))
        ? Number(record.priceOverrideAmount)
        : null,
      priceOverrideAt: formatAdminDateTime_(record.priceOverrideAt, timezone),
      effectivePriceAmount: Booking.getEffectivePriceAmount(record),
      canEditPrice: record.status === Booking.STATUS.PENDING,
      /*
       * PR #343レビュー対応: 金額修正の利用者案内（訂正案内メール）の送信状況。
       * priceUpdateMailSentAtは他のメールSentAt列と同じ「空＝未送信」の慣習。
       * priceUpdateNeededは「修正済みだが案内がまだ」のときだけtrueになり、Web UI側が
       * 送信ボタンの強調表示（案内漏れの警告）に使う（buildAdminPriceSummary_参照）。
       */
      priceUpdateMailSentAt: formatAdminDateTime_(record.priceUpdateMailSentAt, timezone),
      priceUpdateNeeded: buildAdminPriceSummary_(record).updateNeeded,
      /*
       * Issue #344追記（料金差額の自動計算。PR #345レビュー対応で再設計）: 日程変更フォームの
       * 「基準料金」表示・「元料金未確認」判定に使う。PR #343の料金基盤（priceAmount/
       * priceTier/effectivePriceAmount）をそのまま再利用し、日程変更専用の「現在の確定金額」
       * 列は別途持たない。feeBaselineReadyは「実効金額が判明していて（getEffectivePriceAmount
       * !== null）、かつ会員区分（priceTier）も判明している」場合のみtrueになる
       * （BookingReschedule.gsのfeeBaseline_/computeFeeContext_と同じ判定基準）。
       * 既存予約（#342以前に作成された予約でpriceAmountが空）はfalseのままとなり、
       * BookingReschedule.backfillOriginalPriceで管理者が照合して入力する必要がある。
       */
      feeBaselineReady: Booking.getEffectivePriceAmount(record) !== null && !!record.priceTier,
      scheduleChangeCount: typeof record.scheduleChangeCount === 'number' && isFinite(record.scheduleChangeCount) ? record.scheduleChangeCount : 0,
      feePaidAmount: typeof record.feePaidAmount === 'number' && isFinite(record.feePaidAmount) ? record.feePaidAmount : 0,
      feeRefundedAmount: typeof record.feeRefundedAmount === 'number' && isFinite(record.feeRefundedAmount) ? record.feeRefundedAmount : 0,
      feeSettlementState: record.feeSettlementState || '',
      feeSettlementNote: record.feeSettlementNote || '',
      feeSettlementUpdatedAt: formatAdminDateTime_(record.feeSettlementUpdatedAt, timezone),
      /*
       * PR #345レビュー対応: 料金関連フィールドの部分更新失敗により整合性が保証できない
       * 場合のブロック状態（BookingReschedule.gsのfeeRecoveryRequiredAt参照）。空でなければ
       * Web UI側は日程変更・精算記録のいずれのフォームも操作不能にし、要復旧である旨と
       * 理由を表示する。
       */
      feeRecoveryRequiredAt: formatAdminDateTime_(record.feeRecoveryRequiredAt, timezone),
      feeRecoveryReason: record.feeRecoveryReason || '',
      /*
       * PR #345再レビュー対応（4回目）: feeRecoveryRequiredAtの保存自体が失敗する複合障害が
       * 起きると、フラグが立たないままFeeSettlementsにPENDING_APPLY/FAILED_NEEDS_RECOVERY
       * の行だけが残ることがある。BookingReschedule.gs側はfeeRecoveryRequiredAtの有無に
       * かかわらずこの状態をブロックするため、Web UI側もfeeRecoveryRequiredAtだけでなく
       * こちらを見て復旧導線（renderFeeRecoverySection_）を出す。resolveFeeRecoveryへの
       * 入り口も同じ判定（isInFeeRecovery_ OR hasUnresolvedSettlement）を使っている。
       */
      feeSettlementNeedsAttention: FeeSettlementRepository.hasUnresolvedSettlement(bookingId, null),
      /*
       * PR #345再レビュー対応（8回目）: 基準料金5列（priceAmount等）の書込み結果が
       * 不明のまま残っている予約かどうか。feeRecoveryRequiredAtの保存自体が失敗する
       * 複合障害が起きると、フラグだけでは検出できない（BookingReschedule.
       * isBaselineRecoveryBlocked参照）。Web UI側は専用の要復旧表示・
       * resolveBaselinePriceRecovery呼び出し導線を出す。
       */
      baselineRecoveryNeedsAttention: BookingReschedule.isBaselineRecoveryBlocked(bookingId)
    }
  };
}

/* 確定。既存の正式関数confirmBooking(bookingId)（BookingAdmin.gs）へそのまま委譲する。
   業務ロジックはコピーしない。 */
function adminConfirmBooking(bookingId) {
  return confirmBooking(bookingId);
}

/* キャンセル。既存の正式関数cancelBookingAdmin(bookingId)（BookingAdmin.gs）へそのまま
   委譲する。業務ロジックはコピーしない。実行前の確認ダイアログはHTML側（クライアント）で行う。 */
function adminCancelBooking(bookingId) {
  return cancelBookingAdmin(bookingId);
}

/* EXPIRED予約の復活（Issue #334）。既存の正式関数reviveExpiredBooking(bookingId)
   （BookingAdmin.gs）へそのまま委譲する。業務ロジックはコピーしない。実行前の確認
   ダイアログはHTML側（クライアント）で行う。 */
function adminReviveExpiredBooking(bookingId) {
  return reviveExpiredBooking(bookingId);
}

/*
 * Stripe決済リンクの送信（Issue #334 PR-C）。既存の正式関数sendCardPaymentLinkMail
 * （BookingAdmin.gs）へそのまま委譲する。業務ロジック（URL検証・予約状態/支払方法/
 * 期限の再検証・二重送信防止・送信履歴の記録）はコピーしない。送信前の内容確認
 * ダイアログ（予約者名・メール・利用日時・支払期限・送信するURLの表示）と、
 * 「明示的な再送」かどうかの判断はHTML側（クライアント）で行い、forceのみここへ渡す。
 *
 * expectedSendCount（PRレビュー対応。同時再送の競合防止）: クライアントが最後に
 * 取得した予約詳細のpaymentLinkSendCountをそのまま渡す。BookingMailer.gsの
 * checkSendHistoryVersion_が、Lock取得後の最新値と比較し、別タブ・別端末による
 * 先行送信が既にあれば古い画面からのこの呼び出しをSEND_HISTORY_CONFLICTとして拒否する。
 * expectedSentAtVersion（第2回PRレビュー対応）: クライアントが最後に取得した予約詳細の
 * paymentLinkSentAtVersion（epoch ms）をそのまま渡す。expectedSendCountとは独立に
 * 判定し、送信履歴2回目の書き込みだけが失敗してpaymentLinkSendCountが変化しない
 * ケースでも競合を検知できるようにする（checkSendHistoryVersion_参照）。
 *
 * 不具合修正（送信直後に「送信できませんでした: null」と表示される問題）: 業務ロジック
 * 自体はsendCardPaymentLinkMail（ひいてはBookingMailer.sendPaymentLinkMailForBooking）
 * へ委譲したまま変更しないが、その戻り値（成功時はsentAt。Dateオブジェクト）を
 * google.script.run経由でHTML側へ返す直前にsanitizeForClient_へ通し、Dateオブジェクトを
 * ISO 8601文字列へ変換する（詳細はsanitizeForClient_のコメント参照）。
 */
function adminSendCardPaymentLink(bookingId, paymentLinkUrl, force, expectedSendCount, expectedSentAtVersion) {
  return sanitizeForClient_(sendCardPaymentLinkMail(bookingId, paymentLinkUrl, {
    force: !!force,
    expectedSendCount: expectedSendCount,
    expectedSentAtVersion: expectedSentAtVersion
  }));
}

/*
 * 送信履歴の記録不整合の補正（第3回PRレビュー対応。confirmedUrl/confirmedSentToは
 * 第5回PRレビュー対応で追加）。既存の正式関数resolveCardPaymentLinkMetadataInconsistency
 * （BookingAdmin.gs）へそのまま委譲する。業務ロジック（対象の限定・補正値の検証・
 * Recovery記録）はコピーしない。実行前の内容確認（現在の送信回数・URL・送信先の表示、
 * 補正後の値の表示）はHTML側（クライアント）で行う。
 *
 * 不具合修正: adminSendCardPaymentLinkと同じ理由で、戻り値をsanitizeForClient_へ通してから
 * 返す（この関数の戻り値には現時点でDateオブジェクトは含まれないが、委譲先の
 * resolvePaymentLinkMetadataInconsistency（BookingMailer.gs）の戻り値をそのまま返す設計は
 * adminSendCardPaymentLinkと同じであるため、将来の変更で同種の問題が再発しないよう揃える）。
 */
function adminResolvePaymentLinkMetadataInconsistency(bookingId, confirmedSendCount, confirmedUrl, confirmedSentTo) {
  return sanitizeForClient_(resolveCardPaymentLinkMetadataInconsistency(bookingId, confirmedSendCount, confirmedUrl, confirmedSentTo));
}

/* 料金修正（Issue #342）。既存の正式関数updateBookingPrice（BookingAdmin.gs）へ
   そのまま委譲する。業務ロジック（PENDING限定・金額の妥当性検証）はコピーしない。
   実行前の確認ダイアログ（自動計算値と修正後の金額の表示）はHTML側（クライアント）で行う。 */
function adminUpdateBookingPrice(bookingId, newAmountJpy) {
  return updateBookingPrice(bookingId, newAmountJpy);
}

/*
 * 金額修正の利用者案内送信（PR #343レビュー対応）。既存の正式関数sendPriceUpdateMail
 * （BookingAdmin.gs）へそのまま委譲する。業務ロジック（金額修正済み・PENDING限定・
 * 二重送信防止）はコピーしない。実行前の確認ダイアログ（修正後の金額の表示）は
 * HTML側（クライアント）で行う。
 * 戻り値にはsentAt（Dateオブジェクト）を含みうるため、adminSendCardPaymentLinkと同じ理由で
 * sanitizeForClient_を通してから返す。
 */
function adminSendPriceUpdateMail(bookingId, options) {
  return sanitizeForClient_(sendPriceUpdateMail(bookingId, options));
}

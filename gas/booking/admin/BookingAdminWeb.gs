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
      cardPaymentDueAt: computeAdminCardPaymentDueAt_(record, timezone)
    };
  });
  return { todayJst: todayJst, bookings: bookings };
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
      paymentLinkSentAtVersion: isAdminWebDateLike_(record.paymentLinkSentAt) ? record.paymentLinkSentAt.getTime() : 0
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
 */
function adminSendCardPaymentLink(bookingId, paymentLinkUrl, force, expectedSendCount, expectedSentAtVersion) {
  return sendCardPaymentLinkMail(bookingId, paymentLinkUrl, {
    force: !!force,
    expectedSendCount: expectedSendCount,
    expectedSentAtVersion: expectedSentAtVersion
  });
}

/*
 * 送信履歴の記録不整合の補正（第3回PRレビュー対応）。既存の正式関数
 * resolveCardPaymentLinkMetadataInconsistency（BookingAdmin.gs）へそのまま委譲する。
 * 業務ロジック（対象の限定・補正値の検証・Recovery記録）はコピーしない。実行前の
 * 内容確認（現在の送信回数・補正後の送信回数の表示）はHTML側（クライアント）で行う。
 */
function adminResolvePaymentLinkMetadataInconsistency(bookingId, confirmedSendCount) {
  return resolveCardPaymentLinkMetadataInconsistency(bookingId, confirmedSendCount);
}

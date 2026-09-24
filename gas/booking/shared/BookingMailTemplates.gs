/*
 * BookingMailTemplates.gs — 利用者向けメールの件名・本文生成（Issue #271）。
 *
 * ここに置くのは件名・本文を組み立てる純粋関数のみ。MailApp / SpreadsheetApp /
 * PropertiesService等のGAS組み込みサービスには一切依存せず、node --testでそのまま
 * vm実行して検証できる（Availability.gs / Booking.gsと同方針）。
 *
 * ブランド差分（SNB / mens / Studio X）はBooking.getBrandLabel(record.brand)のみで吸収し、
 * ブランドごとにテンプレート関数をコピーしない（Issue #271本文の必須要件）。
 *
 * 秘密情報の扱い（最重要）:
 * - buildPendingMail / buildConfirmedMailは、呼び出し側が何を渡しても解錠コード・
 *   キーボックス番号を一切出力しない（accessGuide自体を引数に取らない設計にすることで、
 *   実装ミスによる誤送信を構造的に防いでいる）。
 * - buildReminderMailのみaccessGuideを受け取り、来場方法（住所・建物・部屋・入口案内・
 *   キーボックス位置・入室方法・案内URL）と、設定されていれば解錠コード等の秘密値を含める。
 *   accessGuideの秘密値（keyboxNumber/unlockCode）が空の場合、本文にはその旨を示す
 *   プレースホルダを出すのみで、値を偽装・省略の判断はBookingMailer.gs側（fail-safe:
 *   前日案内を成功扱いにしない）に委ねる。
 *
 * 利用日の曜日表示（Issue #311）: record.dateはタイムゾーン正規化済みの'YYYY-MM-DD'文字列
 * のため、BookingAvailability.formatDateWithWeekday（Availability.gs）で曜日を付ける。
 * new Date(record.date).getDay()のようなGAS実行環境のローカルtimezoneに依存する変換は
 * 使わない（AdminNotifier.gsと同じ共通関数を使い、曜日変換ロジックを二重実装しない）。
 */
'use strict';

var BookingMailTemplates = (function () {
  /* record.startAt/endAtはSheets台帳のDate値。config.timezone基準の'HH:mm'表示へ変換する
     （createBooking/confirmBooking等と同じ、ブラウザのローカルtimezoneに依存しない方式）。 */
  function formatTime_(date, timezone) {
    return BookingAvailability.formatTimeInTimezone(date, timezone) || '';
  }

  function formatDurationMinutes_(startAt, endAt) {
    if (!startAt || !endAt || typeof startAt.getTime !== 'function' || typeof endAt.getTime !== 'function') {
      return '';
    }
    var minutes = Math.round((endAt.getTime() - startAt.getTime()) / 60000);
    return minutes > 0 ? minutes + '分' : '';
  }

  function contactLine_(config) {
    return config && config.contactEmail ? 'お問い合わせ: ' + config.contactEmail : '';
  }

  function joinNonEmpty_(lines) {
    return lines.filter(function (line) { return line !== null && line !== undefined && line !== ''; }).join('\n');
  }

  /*
   * PENDING（仮予約受付メール）。
   * 「このメール時点では予約未確定」「管理者確認後に確定連絡を送る」旨を必ず含む。
   * キーボックス番号・解錠コード等は一切含めない（accessGuideを引数に取らない）。
   */
  function buildPendingMail(record, config) {
    var brandLabel = Booking.getBrandLabel(record.brand);
    var timezone = config.timezone;
    var startTime = formatTime_(record.startAt, timezone);
    var endTime = formatTime_(record.endAt, timezone);
    var duration = formatDurationMinutes_(record.startAt, record.endAt);

    var subject = '【' + brandLabel + '】仮予約を受け付けました（未確定）';
    var body = joinNonEmpty_([
      record.name + ' 様',
      '',
      brandLabel + ' のご予約を仮受付いたしました。',
      '※このメールの時点ではご予約はまだ確定しておりません。管理者が内容を確認のうえ、確定のご連絡を改めてお送りします。',
      '',
      '予約ID: ' + record.bookingId,
      '利用日: ' + BookingAvailability.formatDateWithWeekday(record.date),
      '開始時刻: ' + startTime,
      '終了時刻: ' + endTime,
      duration ? '利用時間: ' + duration : '',
      'ブランド: ' + brandLabel,
      '利用人数: ' + record.people,
      record.paymentMethod ? '支払方法: ' + record.paymentMethod : '',
      '',
      contactLine_(config)
    ]);

    return { subject: subject, body: body };
  }

  /*
   * CONFIRMED（予約確定メール）。件名で確定が分かるようにする。
   * 現行Bookings台帳に確定料金列がないため、料金は本文へ出さない（Issue #271本文の指示どおり）。
   */
  function buildConfirmedMail(record, config) {
    var brandLabel = Booking.getBrandLabel(record.brand);
    var timezone = config.timezone;
    var startTime = formatTime_(record.startAt, timezone);
    var endTime = formatTime_(record.endAt, timezone);
    var duration = formatDurationMinutes_(record.startAt, record.endAt);

    var subject = '【' + brandLabel + '】ご予約が確定しました';
    var body = joinNonEmpty_([
      record.name + ' 様',
      '',
      'ご予約が確定しましたのでお知らせいたします。',
      '',
      '予約ID: ' + record.bookingId,
      '利用日: ' + BookingAvailability.formatDateWithWeekday(record.date),
      '開始時刻: ' + startTime,
      '終了時刻: ' + endTime,
      duration ? '利用時間: ' + duration : '',
      'ブランド: ' + brandLabel,
      '利用人数: ' + record.people,
      record.paymentMethod ? '支払方法: ' + record.paymentMethod : '',
      '',
      'ご利用時は、施設の利用ルールを守り、利用後は原状回復をお願いいたします。設備・備品の取り扱いには十分ご注意ください。',
      '',
      '来場方法・キーボックス等の詳細案内は、利用日前日に別途メールでお送りします。',
      'ご不明点やキャンセル・変更のご希望は下記までご連絡ください。',
      contactLine_(config)
    ]);

    return { subject: subject, body: body };
  }

  /*
   * CANCELLED（キャンセルメール）。#271では共通関数を用意するのみで、実際にCANCELLED後の
   * Calendar/Sheets処理から呼ぶ配線は#272で行う（このIssueの対象外）。
   */
  function buildCancelledMail(record, config) {
    var brandLabel = Booking.getBrandLabel(record.brand);
    var timezone = config.timezone;
    var startTime = formatTime_(record.startAt, timezone);
    var endTime = formatTime_(record.endAt, timezone);

    var subject = '【' + brandLabel + '】ご予約キャンセルのお知らせ';
    var body = joinNonEmpty_([
      record.name + ' 様',
      '',
      '下記のご予約はキャンセルされました。',
      '',
      '予約ID: ' + record.bookingId,
      '利用日: ' + BookingAvailability.formatDateWithWeekday(record.date),
      '開始時刻: ' + startTime,
      '終了時刻: ' + endTime,
      'ブランド: ' + brandLabel,
      '',
      '改めてご利用をご希望の場合は、お手数ですが再度ご予約ください。',
      contactLine_(config)
    ]);

    return { subject: subject, body: body };
  }

  /*
   * EXPIRED（カード決済のPENDING失効通知。Issue #334）。
   * 管理者キャンセル文面（buildCancelledMail）は流用しない専用テンプレート。
   * 「失効判定は入金の自動検知ではなく管理者による承認の有無に基づく」（Issue #334本文）ため、
   * 入金の有無をシステムが自動確認したかのような文言は書かない。必ず次の3点を含める:
   * - 期限までに承認が確認できず失効したこと（入金の有無を断定しない）
   * - 利用希望なら予約ページから再度申し込むこと
   * - 支払い済みの場合は再申込・二重決済をせず運営へ連絡すること
   */
  function buildExpiredMail(record, config) {
    var brandLabel = Booking.getBrandLabel(record.brand);
    var timezone = config.timezone;
    var startTime = formatTime_(record.startAt, timezone);
    var endTime = formatTime_(record.endAt, timezone);

    var subject = '【' + brandLabel + '】ご予約が期限切れになりました（要再申込み）';
    var body = joinNonEmpty_([
      record.name + ' 様',
      '',
      '下記のご予約は、お支払い期限までに運営による確認ができなかったため、失効いたしました。',
      '',
      '予約ID: ' + record.bookingId,
      '利用日: ' + BookingAvailability.formatDateWithWeekday(record.date),
      '開始時刻: ' + startTime,
      '終了時刻: ' + endTime,
      'ブランド: ' + brandLabel,
      '',
      '改めてご利用をご希望の場合は、お手数ですが予約ページから再度お申し込みください。',
      'すでにお支払いが完了している場合は、再度のお申し込みや二重のお支払いをせず、下記までご連絡ください。',
      contactLine_(config)
    ]);

    return { subject: subject, body: body };
  }

  /* accessGuideの秘密値（keyboxNumber/unlockCode）が空の場合はプレースホルダを出す。
     値の要否判定・成功/失敗の扱いはBookingMailer.gs側の責務（このテンプレートは常に
     渡された値をそのまま出力するだけ）。 */
  function secretLine_(label, value) {
    return label + ': ' + (value ? value : '（未設定）');
  }

  /*
   * REMINDER（前日リマインド + 来場案内。1通にまとめる）。
   * PENDING/CONFIRMED直後のメールと異なり、ここでは来場方法・キーボックス位置・
   * 解錠コード等の秘密値を含める（CONFIRMEDの予約にのみ送る前提。呼び出し側で保証する）。
   */
  function buildReminderMail(record, config, accessGuide) {
    var brandLabel = Booking.getBrandLabel(record.brand);
    var timezone = config.timezone;
    var startTime = formatTime_(record.startAt, timezone);
    var endTime = formatTime_(record.endAt, timezone);
    var guide = accessGuide || {};

    var subject = '【' + brandLabel + '】明日のご利用案内';
    var body = joinNonEmpty_([
      record.name + ' 様',
      '',
      '明日のご予約について、来場方法をご案内します。',
      '',
      '予約ID: ' + record.bookingId,
      '利用日: ' + BookingAvailability.formatDateWithWeekday(record.date),
      '開始時刻: ' + startTime,
      '終了時刻: ' + endTime,
      'ブランド: ' + brandLabel,
      '',
      '--- 来場方法 ---',
      guide.address ? '住所: ' + guide.address : '',
      guide.building ? '建物: ' + guide.building : '',
      guide.room ? '部屋番号: ' + guide.room : '',
      guide.entrance ? '入口からのご案内: ' + guide.entrance : '',
      guide.keyboxLocation ? 'キーボックス位置: ' + guide.keyboxLocation : '',
      guide.entryMethod ? '入室方法: ' + guide.entryMethod : '',
      secretLine_('キーボックス番号', guide.keyboxNumber),
      secretLine_('解錠コード', guide.unlockCode),
      guide.url ? '利用案内ページ: ' + guide.url : '',
      guide.pdfUrl ? '案内PDF: ' + guide.pdfUrl : '',
      '',
      'ご利用時は忘れ物・原状回復にご注意ください。',
      contactLine_(config)
    ]);

    return { subject: subject, body: body };
  }

  return {
    buildPendingMail: buildPendingMail,
    buildConfirmedMail: buildConfirmedMail,
    buildCancelledMail: buildCancelledMail,
    buildExpiredMail: buildExpiredMail,
    buildReminderMail: buildReminderMail
  };
})();

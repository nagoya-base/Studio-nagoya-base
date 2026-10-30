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
   * ブランド（SNB / SNB mens / Studio X）別の案内先URL・署名・注意事項（Issue #422）。
   * 設定の唯一の定義はBooking.getBrandProfile。ここでは各テンプレートが共通ロジックのまま
   * 末尾へ差し込むだけで、予約日時・料金等の共通情報の組み立てはブランドで分岐させない。
   */
  function guideLine_(record) {
    return 'ご利用案内: ' + Booking.getBrandProfile(record.brand).guideUrl;
  }

  function rebookLine_(record) {
    return '再度のご予約はこちら: ' + Booking.getBrandProfile(record.brand).bookingUrl;
  }

  function signatureLines_(record) {
    var profile = Booking.getBrandProfile(record.brand);
    return joinNonEmpty_(profile.notes.concat(['', '--', profile.signature]));
  }

  /*
   * 利用料金の表示行（Issue #342）。record.priceAmountが数値化できない場合（列自体を
   * 持たない過去の予約、または想定外の空値）は空文字を返し、joinNonEmpty_により行自体を
   * 出さない（料金データがないことをエラーにせず、既存予約との後方互換を保つ）。
   * 表示する金額は必ずcreateBooking時点でGASが確定・保存した値（record.priceAmount。
   * 予約時点の料金表のスナップショット）であり、フォーム側の一時的な見積り値ではない。
   */
  function formatJpyAmount_(amount) {
    /* Number('')/Number(null)は0になってしまう（JSの仕様）ため、空文字・null・
       undefinedは先に弾く。過去の予約データ（priceAmount列が空文字）を「0円」と
       誤表示しないため（正しくは行自体を出さない）。 */
    if (amount === '' || amount === null || amount === undefined) return '';
    var value = Number(amount);
    if (!Number.isFinite(value)) return '';
    return value.toLocaleString('ja-JP') + '円';
  }

  /* 貸切ベースプラン（Issue #488 / #492）の予約か。BookingPricing.gsは本番の両プロジェクトに配布済みだが、
     メール文面の単体利用（BookingPricing未読込）でも従来の通常予約の本文を壊さないよう、未定義なら通常予約扱いにする。 */
  function isEventPlanRecord_(record) {
    return typeof BookingPricing !== 'undefined' && BookingPricing.isEventPlan(record.planCode);
  }

  /* 大人数利用（Issue #668）の予約か。Booking.gs未読込の単体利用でも通常予約の本文を壊さない。 */
  function isLargePartyRecord_(record) {
    return typeof Booking !== 'undefined' && typeof Booking.isLargePartyRecord === 'function' && Booking.isLargePartyRecord(record);
  }

  /* Issue #668: 基本部屋料金と人数加算を区別して出す。人数加算は予約全体に1回（利用時間ごとの加算ではない）。 */
  function largePartyPriceLines_(record) {
    var total = Number(record.priceAmount);
    var surcharge = Number(record.partySurcharge);
    if (!Number.isFinite(total) || !Number.isFinite(surcharge)) return '';
    return joinNonEmpty_([
      '基本部屋料金: ' + formatJpyAmount_(total - surcharge) + '（税込）',
      '人数加算（5人目以降1名につき1,000円×' + (surcharge / 1000) + '名・予約全体で1回）: ' + formatJpyAmount_(surcharge),
      '利用料金（合計）: ' + formatJpyAmount_(total) + '（税込）'
    ]);
  }

  function priceLine_(record) {
    if (isLargePartyRecord_(record)) {
      var breakdown = largePartyPriceLines_(record);
      if (breakdown) return breakdown;
    }
    var formatted = formatJpyAmount_(record.priceAmount);
    var line = formatted ? '利用料金: ' + formatted + '（税込）' : '';
    /* Issue #488 / #492: 貸切ベースプランは、プラン名と責任範囲（有人クロークではない）を
       料金と一緒に必ず示す。通常料金の予約（planCodeなし）の本文は1バイトも変えない。 */
    if (line && isEventPlanRecord_(record)) {
      return [
        'ご利用プラン: ' + BookingPricing.planLabel(record.planCode),
        line,
        '※本プランは有人クロークではありません。荷物・貴重品はお部屋の中でご自身で管理してください（スタッフによるお預かり・常駐はありません）。'
      ].join('\n');
    }
    return line;
  }

  /*
   * カード決済選択時のみ仮受付メールへ追加する案内（Issue #334 PR-B「3. 仮受付メール」/ Issue #407）。
   * 現金・PayPay・未定にはこのブロックを一切混入させない（buildPendingMail側の
   * isCardPaymentMethod分岐でのみ呼ぶ）。
   * Issue #407: カードは申込直後に表示されるStripe Checkoutの決済ページで支払う。支払期限は
   * Checkout Sessionの有効期限が正のため、旧「24時間以内に決済リンクをメール送付」
   * 「申込から72時間後まで」の案内と期限日時の表示は行わない。
   * Stripeの決済リンクそのものはここに含めない。
   */
  function buildCardPendingNotice_(record, config) {
    return joinNonEmpty_([
      '【クレジットカード決済のご案内】',
      'オンラインクレジットカードを選択した場合は、予約申込後そのままお支払いへ進みます。お支払い完了後、予約はすぐに確定します。',
      'オンラインクレジットカード決済は、予約申込後に表示される決済ページでお支払いください。',
      '決済ページの有効期限内にお支払いが完了した場合に予約が確定します。期限切れ・決済未完了の場合、予約は確定しません。',
      '予約申込後30分以内にお支払いを完了してください。決済を完了せずに時間が経過すると、予約が失効する場合があります。',
      '予約が確定しなかった場合にご利用を希望されるときは、改めて予約フォームからお申し込みください。',
      'すでにお支払い済みの場合は、再申し込みや二重決済をせず、運営までご連絡ください。'
    ]);
  }

  /* record.createdAt/record.startAtがDate値であるかのダックタイピング判定
     （gas/booking/shared/Booking.gsのisDateLike_と同じ方針。互いに依存させないため
     ここに複製する）。 */
  function isDateLike_(value) {
    return !!value && typeof value.getTime === 'function' && !isNaN(value.getTime());
  }

  /*
   * PENDING（受付メール）。現金・PayPay・未定は仮予約受付（Issue #445以前の文言）。
   * 「このメール時点では予約未確定」「管理者確認後に確定連絡を送る」旨を必ず含む。
   * オンラインクレジットカードは「予約申込を受け付けた／決済は未完了／続けて決済が必要／
   * 決済完了で自動確定／未完了のまま時間が経過すると失効し得る」旨を示し、管理者確認待ちとは書かない。
   * キーボックス番号・解錠コード等は一切含めない（accessGuideを引数に取らない）。
   * 利用料金（Issue #342。priceLine_）はcreateBooking時点でGASが確定・保存した
   * record.priceAmountを表示する。カード決済の場合でも、この金額表示だけで自動的に
   * 決済完了・予約確定として扱われることはない（既存どおり、確定は管理者の確認・
   * confirmBooking経由のみ）。
   */
  function buildLargePartyPendingMail(record, config) {
    var brandLabel = Booking.getBrandLabel(record.brand);
    var timezone = config.timezone;
    var subject = '【' + brandLabel + '】5〜7名のご利用を受け付けました（運営の承認待ち・未確定）';
    var body = joinNonEmpty_([
      record.name + ' 様',
      '',
      brandLabel + ' の5〜7名でのご利用申込を受け付けました。',
      '※このメールの時点ではご予約は確定していません。お支払いも不要です。',
      '※ご希望の枠は仮押さえしています。運営が内容を確認し、承認できる場合のみ確定料金とお支払い方法をご案内します。',
      '※承認後24時間以内にお支払いが完了しない場合は不成立となり、仮押さえを解除します。承認できない場合も仮押さえを解除します（4名扱いへの変更や自動のご請求はしません）。',
      '',
      '予約ID: ' + record.bookingId,
      '利用日: ' + BookingAvailability.formatDateWithWeekday(record.date),
      '開始時刻: ' + formatTime_(record.startAt, timezone),
      '終了時刻: ' + formatTime_(record.endAt, timezone),
      '利用人数: ' + record.people,
      priceLine_(record),
      '',
      contactLine_(config),
      guideLine_(record),
      signatureLines_(record)
    ]);
    return { subject: subject, body: body };
  }

  /* 承認メール（Issue #668）。確定料金・支払期限（承認から24時間）・支払いページを案内する。 */
  function buildLargePartyApprovedMail(record, config) {
    var brandLabel = Booking.getBrandLabel(record.brand);
    var timezone = config.timezone;
    var due = formatDeadline_(record.largePartyPaymentDueAt, timezone);
    if (!due) throw new Error('お支払い期限が記録されていないため承認メールを作成できません。');
    var payUrl = Booking.getBrandProfile(record.brand).siteUrl + 'booking/party/?bookingId=' + encodeURIComponent(record.bookingId);
    var subject = '【' + brandLabel + '】5〜7名のご利用を承認しました（' + due + 'までにお支払いください）';
    var body = joinNonEmpty_([
      record.name + ' 様',
      '',
      brandLabel + ' の5〜7名でのご利用を承認しました。確定料金は下記のとおりです。',
      '※お支払いが完了するまでご予約は確定しません。',
      '※お支払い期限は ' + due + '（承認から24時間以内）です。期限までにお支払いが完了しない場合は不成立となり、枠を解除します。',
      '',
      '予約ID: ' + record.bookingId,
      '利用日: ' + BookingAvailability.formatDateWithWeekday(record.date),
      '開始時刻: ' + formatTime_(record.startAt, timezone),
      '終了時刻: ' + formatTime_(record.endAt, timezone),
      '利用人数: ' + record.people,
      priceLine_(record),
      '',
      '【お支払い方法】オンラインクレジットカード決済',
      '下記のページで、予約IDとご予約時のメールアドレスを入力して決済へ進んでください。',
      payUrl,
      '',
      contactLine_(config),
      guideLine_(record),
      signatureLines_(record)
    ]);
    return { subject: subject, body: body };
  }

  /* 人数変更のお知らせ（Issue #668）。基本部屋料金と人数加算を区別し、前日・当日の減員は値下げ・返金しない旨を明記する。 */
  function buildPeopleChangedMail(record, config, change) {
    var brandLabel = Booking.getBrandLabel(record.brand);
    var lines = [
      record.name + ' 様',
      '',
      brandLabel + ' のご予約の利用人数を変更しました。',
      '',
      '予約ID: ' + record.bookingId,
      '利用日: ' + BookingAvailability.formatDateWithWeekday(record.date),
      '利用人数: ' + change.oldPeople + ' → ' + change.newPeople
    ];
    if (change.noRefund) {
      lines.push('※利用日の前日・当日の減員のため、人数加算分を含め料金の値下げ・返金はありません。');
      lines.push(priceLine_(record));
    } else {
      lines.push(priceLine_(record));
      if (change.needsApproval) lines.push('※5〜7名へ変更したため、運営の承認が必要です。承認後に、お支払い方法をご案内します。');
      if (change.additionalChargeDue) lines.push('お支払い済みの金額との差額 ' + formatJpyAmount_(change.additionalChargeDue) + ' を追加でご請求します。運営から改めてご案内します。');
      if (change.refundDue) lines.push('お支払い済みの金額との差額 ' + formatJpyAmount_(change.refundDue) + ' を返金します。運営から改めてご案内します。');
    }
    lines.push('', contactLine_(config), guideLine_(record), signatureLines_(record));
    return { subject: '【' + brandLabel + '】ご利用人数を変更しました', body: joinNonEmpty_(lines) };
  }

  function buildPendingMail(record, config) {
    if (isLargePartyRecord_(record)) return buildLargePartyPendingMail(record, config);
    var brandLabel = Booking.getBrandLabel(record.brand);
    var timezone = config.timezone;
    var startTime = formatTime_(record.startAt, timezone);
    var endTime = formatTime_(record.endAt, timezone);
    var duration = formatDurationMinutes_(record.startAt, record.endAt);
    var isCard = Booking.isCardPaymentMethod(record.paymentMethod);

    /* Issue #445: オンラインクレジットカードは「申込→そのままオンライン決済→決済完了で自動確定」。
       決済前に届く受付メールで「あとで決済すればよい」「確定連絡待ち」と誤解させないため、
       決済未完了であること・続けて決済が必要なこと・失効し得ることを明記する。現金・PayPay・未定は従来文言。 */
    var subject = isCard
      ? '【' + brandLabel + '】予約申込を受け付けました（決済完了で確定）'
      : '【' + brandLabel + '】仮予約を受け付けました（未確定）';
    var intro = isCard
      ? [
        brandLabel + ' のご予約申込を受け付けました。',
        '※このメールの時点ではお支払いが完了しておらず、ご予約はまだ確定しておりません。続けてオンライン決済を完了してください。お支払い完了後、ご予約は自動で確定します。',
        '※予約申込後30分以内にお支払いを完了してください。決済を完了せずに時間が経過すると、ご予約が失効する場合があります。'
      ]
      : [
        brandLabel + ' のご予約を仮受付いたしました。',
        '※このメールの時点ではご予約はまだ確定しておりません。当方で内容を確認のうえ、確定のご連絡を改めてお送りします。'
      ];
    var body = joinNonEmpty_([
      record.name + ' 様',
      '',
      intro[0],
      intro[1],
      intro[2] || '',
      '',
      '予約ID: ' + record.bookingId,
      '利用日: ' + BookingAvailability.formatDateWithWeekday(record.date),
      '開始時刻: ' + startTime,
      '終了時刻: ' + endTime,
      duration ? '利用時間: ' + duration : '',
      'ブランド: ' + brandLabel,
      '利用人数: ' + record.people,
      priceLine_(record),
      record.paymentMethod ? '支払方法: ' + record.paymentMethod : '',
      '',
      isCard ? buildCardPendingNotice_(record, config) : '',
      contactLine_(config),
      guideLine_(record),
      signatureLines_(record)
    ]);

    return { subject: subject, body: body };
  }

  /* paymentHoldExpiresAt（Date）をconfig.timezone基準の「YYYY/MM/DD HH:mm」へ整形する。
     端末・実行環境のローカルtimezoneには依存しない。整形できなければ空文字。 */
  function formatDeadline_(date, timezone) {
    if (!isDateLike_(date)) return '';
    var day = BookingAvailability.formatDateInTimezone(date, timezone);
    var time = BookingAvailability.formatTimeInTimezone(date, timezone);
    return day && time ? String(day).replace(/-/g, '/') + ' ' + time : '';
  }

  /*
   * カード決済の支払い案内メール（Issue #445）。Stripe Checkout Session作成成功後に、実際の
   * checkoutUrlとpaymentHoldExpiresAtを使って送る。画面を閉じても支払期限内ならこのメールの
   * リンクから同じCheckoutへ戻れる。checkout.url / checkout.expiresAt はBookingRepository.
   * beginCardCheckoutが返した値だけを使い、ここで推測・生成しない（無効なら例外＝fail-closed）。
   * 「管理者確認後に確定」「当方からの確定連絡待ち」とは書かない（決済完了で自動確定する）。
   */
  function buildCardCheckoutMail(record, config, checkout) {
    var url = checkout && typeof checkout.url === 'string' ? checkout.url : '';
    if (!/^https:\/\/[^\s]+$/.test(url)) {
      throw new Error('お支払いページのURLが無効なため支払い案内メールを作成できません。');
    }
    var deadline = formatDeadline_(checkout.expiresAt, config.timezone);
    if (!deadline) {
      throw new Error('お支払い期限が無効なため支払い案内メールを作成できません。');
    }
    var brandLabel = Booking.getBrandLabel(record.brand);
    var startTime = formatTime_(record.startAt, config.timezone);
    var endTime = formatTime_(record.endAt, config.timezone);
    var duration = formatDurationMinutes_(record.startAt, record.endAt);

    var subject = '【' + brandLabel + '】予約申込を受け付けました（決済ページのご案内）';
    var body = joinNonEmpty_([
      record.name + ' 様',
      '',
      brandLabel + ' のご予約申込を受け付けました。',
      '※このメールの時点ではお支払いが完了しておらず、ご予約はまだ確定しておりません。',
      '期限内にお支払いが完了すると、ご予約は自動で確定します。',
      '',
      'お支払いページ: ' + url,
      'お支払い期限: ' + deadline,
      '画面を閉じた場合も、期限内であればこのメールからお支払いページへ戻れます。',
      '期限を過ぎるとこのURLではお支払いできず、ご予約は確定せず失効します。',
      'すでにお支払い済みの場合は、再申し込みや二重決済をせず、運営までご連絡ください。',
      '',
      '予約ID: ' + record.bookingId,
      '利用日: ' + BookingAvailability.formatDateWithWeekday(record.date),
      '開始時刻: ' + startTime,
      '終了時刻: ' + endTime,
      duration ? '利用時間: ' + duration : '',
      'ブランド: ' + brandLabel,
      '利用人数: ' + record.people,
      priceLine_(record),
      record.paymentMethod ? '支払方法: ' + record.paymentMethod : '',
      '',
      contactLine_(config),
      guideLine_(record),
      signatureLines_(record)
    ]);

    return { subject: subject, body: body };
  }

  /*
   * CONFIRMED（予約確定メール）。件名で確定が分かるようにする。
   * 料金は本文へ出さない（Issue #271本文の指示どおり据え置き。Issue #342で仮予約受付
   * メール（buildPendingMail）へ料金を追加したが、確定メールには追加しない方針にした:
   * 管理者がPENDING時点でBookingRepository.updateBookingPriceにより金額を修正できる
   * ため、送信タイミングによって仮予約時と確定時で異なる金額が案内される事故を避ける。
   * 金額を確認したい場合はBooking Admin（実効金額はBooking.getEffectivePriceAmount）を見る運用とする）。
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
      accessGuideNoticeLine_(record, timezone),
      'ご不明点やキャンセル・変更のご希望は下記までご連絡ください。',
      contactLine_(config),
      guideLine_(record),
      signatureLines_(record)
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

    var rejected = isLargePartyRecord_(record) && Booking.largePartyApprovalStatus(record) === Booking.LARGE_PARTY_APPROVAL.REJECTED;
    var subject = rejected
      ? '【' + brandLabel + '】5〜7名のご利用は承認できませんでした（仮押さえを解除しました）'
      : '【' + brandLabel + '】ご予約キャンセルのお知らせ';
    var body = joinNonEmpty_([
      record.name + ' 様',
      '',
      rejected
        ? '下記の5〜7名でのご利用は、運営の確認の結果、今回は承認できませんでした。仮押さえを解除しています。お支払いは発生していません（4名扱いへの変更や自動のご請求もありません）。'
        : '下記のご予約はキャンセルされました。',
      '',
      '予約ID: ' + record.bookingId,
      '利用日: ' + BookingAvailability.formatDateWithWeekday(record.date),
      '開始時刻: ' + startTime,
      '終了時刻: ' + endTime,
      'ブランド: ' + brandLabel,
      '',
      refundNoticeLines_(record),
      '改めてご利用をご希望の場合は、お手数ですが再度ご予約ください。',
      rebookLine_(record),
      contactLine_(config),
      signatureLines_(record)
    ]);

    return { subject: subject, body: body };
  }

  /* Issue #412: 利用日がtimezone基準で今日か（確定メールの来場案内の一文の分岐用）。 */
  function isUseDateToday_(record, timezone) {
    var today = BookingAvailability.formatDateInTimezone(new Date(), timezone);
    var useDate = record.date && typeof record.date.getTime === 'function'
      ? BookingAvailability.formatDateInTimezone(record.date, timezone)
      : String(record.date || '');
    return !!today && today === useDate;
  }

  /*
   * 確定メールの来場案内に関する一文。当日予約は確定直後に即時送信、翌日以降は前日に送る
   * （Issue #412。Issue #414で鍵承認を廃止したため、Stripe予約も同じ文言）。
   */
  function accessGuideNoticeLine_(record, timezone) {
    /*
     * Issue #412: 利用日が当日の予約は、確定直後に来場案内を即時送信する（前日案内は届かない）。
     * 「利用日前日に送る」とは書かない。
     */
    if (isUseDateToday_(record, timezone)) {
      return 'このあと、来場方法・キーボックス等の詳細案内を別途メールでお送りします。';
    }
    return '来場方法・キーボックス等の詳細案内は、利用日前日に別途メールでお送りします。';
  }

  /*
   * Issue #341 PR-D: Stripeカード決済の予約を管理者が取り消した場合の返金に関する案内。
   * 取消メールの時点では「返金完了」とは書かない（返金の完了は、Stripeで返金がsucceeded
   * になった後に別メール＝buildRefundedMailで案内する）。
   * - 返金なし（NONE）: 返金がない旨のみ。
   * - 返金をStripeが受け付けた（refund_pending/refunded）: 返金額と「手続きを開始した」旨。
   * - それ以外（返金の結果確認中・失敗・未記録）: 金額を約束せず「確認のうえ改めて連絡」。
   * Stripe Checkoutで決済していない予約（現金・PayPay・旧Payment Link）は何も追加しない。
   */
  function refundNoticeLines_(record) {
    if (!Booking.isStripeCheckoutBooking(record)) return '';
    var paymentStatus = Booking.normalizePaymentStatus(record.paymentStatus);
    if (record.refundDecision === 'NONE') {
      return '今回のキャンセルでは、お支払い済みの利用料金の返金はございません。ご不明点は下記までお問い合わせください。\n';
    }
    if (!record.refundDecision) {
      /*
       * PR-Dレビュー対応・1回目: 未入金の取消では、発行済み決済URLの失効結果に応じて案内する。
       * 失効を確認できない間は「失効した」とは書かず、支払わないよう案内する。取消と同時期に
       * 決済が成立していた場合は、返金の有無を約束せず改めて連絡する旨だけを書く。
       */
      if (record.checkoutCancelState === 'PAYMENT_RECEIVED') {
        return 'お支払いの手続きが完了していたことを確認しました。お支払い済みの利用料金の取り扱いについては、確認のうえ改めてご連絡いたします。\n';
      }
      if (record.checkoutCancelState === 'UNKNOWN' || record.checkoutCancelState === 'EXPIRE_REQUESTED') {
        return 'お送りしているお支払い用のページからは、お支払いにならないようお願いいたします。' +
          'すでにお支払いの手続きをされた場合は、確認のうえ改めてご連絡いたします。\n';
      }
      if (record.checkoutCancelState === 'EXPIRED') {
        return 'お送りしていたお支払い用のページは無効になりました。お支払いは発生していません。\n';
      }
      if (paymentStatus !== Booking.PAYMENT_STATUS.PAID) return '';
      return 'お支払い済みの利用料金の取り扱いについては、確認のうえ改めてご連絡いたします。\n';
    }
    var amount = formatJpyAmount_(record.refundAmount);
    if (record.refundAttemptState === 'SUBMITTED' && amount &&
        (paymentStatus === Booking.PAYMENT_STATUS.REFUND_PENDING || paymentStatus === Booking.PAYMENT_STATUS.REFUNDED)) {
      return 'お支払い済みの利用料金のうち' + amount + 'について、クレジットカードへの返金手続きを開始しました。' +
        '返金の完了は改めてメールでお知らせします。\n';
    }
    return 'お支払い済みの利用料金の返金については、手続きの状況を確認のうえ改めてご連絡いたします。\n';
  }

  /*
   * REFUNDED（Issue #341 PR-D。Stripeで返金がsucceededになった後に1回だけ送る）。
   * カード明細への反映時期はカード会社によるため、日付は約束しない。
   */
  function buildRefundedMail(record, config) {
    var brandLabel = Booking.getBrandLabel(record.brand);
    var amount = formatJpyAmount_(record.refundAmount);
    if (!amount) {
      throw new Error('返金額が記録されていないため、返金完了メールを送信できません。');
    }
    var subject = '【' + brandLabel + '】ご返金手続き完了のお知らせ';
    var body = joinNonEmpty_([
      record.name + ' 様',
      '',
      '下記のご予約のお支払いについて、クレジットカードへの返金手続きが完了しました。',
      '',
      '予約ID: ' + record.bookingId,
      '利用日: ' + BookingAvailability.formatDateWithWeekday(record.date),
      'ブランド: ' + brandLabel,
      '返金額: ' + amount,
      '',
      'カードのご利用明細への反映時期はカード会社により異なり、数日〜数週間かかる場合があります。',
      contactLine_(config),
      signatureLines_(record)
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
      isLargePartyRecord_(record)
        ? '下記の5〜7名でのご利用は、承認の手続きまたはお支払いが期限（承認から24時間）までに完了しなかったため、不成立となり、仮押さえを解除しました。'
        : '下記のご予約は、お支払い期限までに運営による確認ができなかったため、失効いたしました。',
      '',
      '予約ID: ' + record.bookingId,
      '利用日: ' + BookingAvailability.formatDateWithWeekday(record.date),
      '開始時刻: ' + startTime,
      '終了時刻: ' + endTime,
      'ブランド: ' + brandLabel,
      '',
      '改めてご利用をご希望の場合は、お手数ですが予約ページから再度お申し込みください。',
      rebookLine_(record),
      'すでにお支払いが完了している場合は、再度のお申し込みや二重のお支払いをせず、下記までご連絡ください。',
      contactLine_(config),
      signatureLines_(record)
    ]);

    return { subject: subject, body: body };
  }

  /*
   * PAYMENT_LINK（Stripe決済リンクのご案内。Issue #334 PR-C）。
   * BookingMailer.sendPaymentLinkMailForBookingが、管理者がBooking Adminで入力・確認した
   * Stripe決済リンクURLをカード決済PENDINGの予約者へ送るときに使う。管理者キャンセル・
   * 仮受付・確定・失効通知のいずれの既存テンプレートも流用しない専用テンプレート。
   *
   * 必須内容（Issue #334本文どおり）:
   * - 予約者名・予約ID・利用日・開始/終了時刻
   * - Stripe決済リンク（paymentLinkUrl。呼び出し側でBooking.isValidStripePaymentLinkUrlに
   *   より検証済みのURLのみが渡される想定。ここでは検証しない）
   * - 実際の支払期限日時（Booking.computeCardPaymentDueMillis。Booking Admin表示・
   *   仮受付メールのカード案内と同じ1関数で計算し、期限の表示がずれないようにする）
   * - 期限までに支払い、確定の連絡を待つ旨（このメール送信だけでは予約は確定しない）
   * - 支払い済みなのに予約が失効した場合は、二重決済・再申し込みをせず運営へ連絡する旨
   * - 問い合わせ先
   *
   * 金額は本文へ出さない（Issue #334本文「料金は確認画面・メールに表示しない」を据え置き。
   * Issue #342でBookings台帳に料金列を追加したが、このメールへは追加しない: 実際の
   * 決済金額はStripeの決済リンク自体の画面で確認する運用であり、GAS側の自動計算値・
   * 管理者の修正値と表示がずれるリスクを構造的に避けるため）。
   */
  function buildPaymentLinkMail(record, config, paymentLinkUrl) {
    var brandLabel = Booking.getBrandLabel(record.brand);
    var timezone = config.timezone;
    var startTime = formatTime_(record.startAt, timezone);
    var endTime = formatTime_(record.endAt, timezone);
    var ttlConfig = (config && config.ttlConfig) || {};

    var dueDisplay = '';
    if (isDateLike_(record.createdAt) && isDateLike_(record.startAt)) {
      var dueMillis = Booking.computeCardPaymentDueMillis(
        record.createdAt.getTime(),
        record.startAt.getTime(),
        ttlConfig.minHoursBeforeStart,
        Booking.cardMinHoldHours(record, config.timezone, ttlConfig.minHoldHours)
      );
      var dueDate = new Date(dueMillis);
      var dueDateString = BookingAvailability.formatDateInTimezone(dueDate, timezone);
      var dueTimeString = formatTime_(dueDate, timezone);
      dueDisplay = dueDateString ? BookingAvailability.formatDateWithWeekday(dueDateString) + ' ' + dueTimeString : '';
    }

    var subject = '【' + brandLabel + '】お支払いのご案内（決済リンク）';
    if (record.status === Booking.STATUS.EXPIRED) {
      /* Issue #428: 期限切れ予約への手動案内。枠は解放済みのため、お支払い確認後に
         空き状況を確認して確定する旨を明記し、確定を約束する文面にしない。 */
      return {
        subject: subject,
        body: joinNonEmpty_([
          record.name + ' 様',
          '',
          'ご予約はお支払い期限を過ぎて一度失効しておりますが、下記のStripe決済リンクをご案内いたします。',
          '',
          '予約ID: ' + record.bookingId,
          '利用日: ' + BookingAvailability.formatDateWithWeekday(record.date),
          '開始時刻: ' + startTime,
          '終了時刻: ' + endTime,
          'ブランド: ' + brandLabel,
          '',
          '決済リンク: ' + paymentLinkUrl,
          '',
          'お支払いの確認後、枠の空き状況を確認のうえ、予約を確定した場合に確定のご連絡をお送りします。',
          '失効後は他のご予約が入っている場合があり、その場合はご予約を確定できません（お支払い済みの場合は別途ご連絡のうえ対応いたします）。',
          'このメールの送信のみでは予約は確定しておりません。',
          contactLine_(config),
          signatureLines_(record)
        ])
      };
    }
    var body = joinNonEmpty_([
      record.name + ' 様',
      '',
      'ご予約のお支払い方法として、下記のStripe決済リンクをご案内いたします。',
      '',
      '予約ID: ' + record.bookingId,
      '利用日: ' + BookingAvailability.formatDateWithWeekday(record.date),
      '開始時刻: ' + startTime,
      '終了時刻: ' + endTime,
      'ブランド: ' + brandLabel,
      '',
      '決済リンク: ' + paymentLinkUrl,
      'お支払い期限: ' + (dueDisplay || '（お問い合わせください）'),
      '',
      '期限までにお支払いのうえ、予約確定のご連絡をお待ちください。このメールの送信のみでは予約は確定しておりません。',
      '期限までに確定のご連絡ができなかった場合、予約は自動的に失効いたします。',
      'すでにお支払いが完了しているにもかかわらず予約が失効した場合は、再度のお申し込みや二重のお支払いをせず、下記までご連絡ください。',
      contactLine_(config),
      signatureLines_(record)
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
   *
   * 文言は送信日と利用日の関係で切り替える（Issue #420）。config.timezone基準で
   * 利用日 === 送信日（options.now。省略時は現在時刻）なら「本日」、それ以外は「明日」。
   * 送信経路（前日18時台・19時以降の即時送信・21時catch-up・当日即時送信）ごとの
   * 複製はせず、すべてこの1箇所で決める。
   */
  function buildReminderMail(record, config, accessGuide, options) {
    var brandLabel = Booking.getBrandLabel(record.brand);
    var timezone = config.timezone;
    var startTime = formatTime_(record.startAt, timezone);
    var endTime = formatTime_(record.endAt, timezone);
    var guide = accessGuide || {};
    var now = options && options.now;
    var sendDate = BookingAvailability.formatDateInTimezone(now || new Date(), timezone);
    var useDate = record.date && typeof record.date.getTime === 'function'
      ? BookingAvailability.formatDateInTimezone(record.date, timezone)
      : record.date;
    var dayWord = sendDate && useDate === sendDate ? '本日' : '明日';

    /* Issue #422: 利用案内ページはブランド別。ACCESS_GUIDE_URLは従来どおりSNBでのみ優先し、
       mens / Studio XへSNB向けの案内URLを出さない。 */
    var reminderGuideUrl = Booking.getBrandProfile(record.brand).key === 'snb'
      ? (guide.url || Booking.getBrandProfile(record.brand).guideUrl)
      : Booking.getBrandProfile(record.brand).guideUrl;

    var subject = '【' + brandLabel + '】' + dayWord + 'のご利用案内';
    var body = joinNonEmpty_([
      record.name + ' 様',
      '',
      dayWord + 'のご予約について、来場方法をご案内します。',
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
      reminderGuideUrl ? '利用案内ページ: ' + reminderGuideUrl : '',
      guide.pdfUrl ? '案内PDF: ' + guide.pdfUrl : '',
      '',
      'ご利用時は忘れ物・原状回復にご注意ください。',
      contactLine_(config),
      signatureLines_(record)
    ]);

    return { subject: subject, body: body };
  }

  /*
   * PRICE_UPDATE（管理者による金額修正の案内。PR #343レビュー対応）。
   *
   * 仮予約受付メール（buildPendingMail）で案内した金額を、管理者が予約確定前に
   * BookingRepository.updateBookingPriceで修正した場合、利用者へ修正後の金額を
   * 改めて案内するための専用テンプレート。既存の仮予約受付・確定・決済リンクの
   * いずれのテンプレートも流用しない（それぞれの既存方針・秘密情報の扱いに影響を
   * 与えないため）。
   *
   * 表示する金額は必ずBooking.getEffectivePriceAmount（priceOverrideAmountが優先）を
   * 使う。呼び出し側（BookingMailer.sendPriceUpdateMailForBooking）は、修正
   * （priceOverrideAt）が実際に存在する予約に対してのみこの関数を呼ぶ想定だが、
   * 万一存在しない状態で呼ばれても、ここでは例外を投げて呼び出し側にfail-closedな
   * 失敗として扱わせる（金額不明のまま「訂正後の金額」と称するメールを送らないため）。
   *
   * 予約確定前であることは引き続き明記し、「確定」という語は使わない（既存の
   * buildPendingMail/仮予約完了画面と同じ方針。Issue #342本文「仮予約受付と予約確定を
   * 明確に区別する」）。
   */
  function buildPriceUpdateMail(record, config) {
    var brandLabel = Booking.getBrandLabel(record.brand);
    var timezone = config.timezone;
    var startTime = formatTime_(record.startAt, timezone);
    var endTime = formatTime_(record.endAt, timezone);
    var formattedAmount = formatJpyAmount_(Booking.getEffectivePriceAmount(record));
    if (!formattedAmount) {
      throw new Error('利用料金が確定していないため、訂正案内メールを送信できません。');
    }

    var subject = '【' + brandLabel + '】ご予約の利用料金の訂正について';
    var body = joinNonEmpty_([
      record.name + ' 様',
      '',
      'ご予約の利用料金について、当初お送りした仮予約受付メールの金額から訂正がございましたので、改めてご案内いたします。',
      '※このメールの時点でもご予約はまだ確定しておりません。内容をご確認ください。',
      '',
      '予約ID: ' + record.bookingId,
      '利用日: ' + BookingAvailability.formatDateWithWeekday(record.date),
      '開始時刻: ' + startTime,
      '終了時刻: ' + endTime,
      'ブランド: ' + brandLabel,
      '訂正後の利用料金: ' + formattedAmount + '（税込）',
      '',
      'このままお申し込みを続けられる場合、改めてのご連絡は不要です。ご不明点やお申し込みを取りやめたい場合は下記までご連絡ください。',
      contactLine_(config),
      signatureLines_(record)
    ]);

    return { subject: subject, body: body };
  }

  return {
    buildPendingMail: buildPendingMail,
    buildLargePartyApprovedMail: buildLargePartyApprovedMail,
    buildPeopleChangedMail: buildPeopleChangedMail,
    buildCardCheckoutMail: buildCardCheckoutMail,
    buildConfirmedMail: buildConfirmedMail,
    buildCancelledMail: buildCancelledMail,
    buildExpiredMail: buildExpiredMail,
    buildReminderMail: buildReminderMail,
    buildPaymentLinkMail: buildPaymentLinkMail,
    buildPriceUpdateMail: buildPriceUpdateMail,
    buildRefundedMail: buildRefundedMail
  };
})();

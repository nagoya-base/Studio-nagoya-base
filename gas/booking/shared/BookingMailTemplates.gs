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
 * 利用日時の表示（Issue #311 / #705）: 利用者向けの日時は日本語形式（2026年12月1日（火）8:00〜11:00）へ
 * 統一する。record.dateは'YYYY-MM-DD'文字列またはDate値のため、BookingAvailability.formatDateJa
 * （Availability.gs）がconfig.timezone基準で正規化して曜日を付ける。
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

  /* 利用日時の共通表示（Issue #705）。利用者向けメールは、すべてこの1行
     「利用日時: 2026年12月1日（火）8:00〜11:00」へ統一する。JavaScriptのDate文字列
     （Tue Dec 01 2026 ... GMT+0900）は本文へ出さない。整形ロジックはAvailability.gsの
     共通関数（formatDateJa / formatTimeRangeJa / formatDurationJa）に集約している。 */
  function dateTimeLine_(record, timezone) {
    var date = BookingAvailability.formatDateJa(record.date, timezone);
    var range = BookingAvailability.formatTimeRangeJa(record.startAt, record.endAt, timezone);
    return '利用日時: ' + date + (range ? range : '');
  }

  function durationLine_(record) {
    var duration = BookingAvailability.formatDurationJa(record.startAt, record.endAt);
    return duration ? '利用時間: ' + duration : '';
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


  /* Issue #667: 作品撮りサポートプラン（mens）の予約か。BookingPricing未読込の単体利用でも通常予約の本文を壊さない。 */
  function isPhotoSupportRecord_(record) {
    return !!record && record.planCode === 'mens_photo_support';
  }

  /* Issue #667: 金額内訳（部屋料金＋スタッフ対応料金）と対応内容。申込受付・承認・管理画面で同じ表示にする。 */
  function photoSupportBreakdownLines_(record) {
    var servicesLabel = typeof BookingPricing !== 'undefined' ? BookingPricing.photoSupportServicesLabel(record.supportServices) : '';
    var room = formatJpyAmount_(record.supportRoomAmount);
    var staff = formatJpyAmount_(record.supportStaffAmount);
    var total = formatJpyAmount_(record.priceAmount);
    var equipmentItems = typeof BookingOptions !== 'undefined' && record.supportEquipment ? BookingOptions.describeSupportEquipment(record.supportEquipment) : [];
    var equipmentAmount = formatJpyAmount_(record.supportEquipmentAmount);
    var lines = [
      'ご利用プラン: ' + (typeof BookingPricing !== 'undefined' ? BookingPricing.planLabel(record.planCode) : '作品撮りサポートプラン'),
      servicesLabel ? 'スタッフ対応: ' + servicesLabel : '',
      room ? '部屋料金: ' + room + '（税込）' : '',
      staff ? 'スタッフ対応料金: ' + staff + '（税込）' : '',
      equipmentItems.length > 0 ? '有料機材: ' + equipmentItems.join('、') : '',
      equipmentItems.length > 0 && equipmentAmount ? '有料機材料金: ' + equipmentAmount + '（税込。共通の機材カタログの料金）' : '',
      total ? 'お支払い合計: ' + total + '（税込' + (equipmentItems.length > 0 ? '。部屋料金・スタッフ対応料金・有料機材料金の合計' : '。有料機材は別料金で、お申し込みの場合は合計に加算します') + '）' : ''
    ];
    /* Issue #679: 希望背景（専用列supportBackdrop。旧予約・背景なしは何も足さない）。背景の選択は料金に影響しない。 */
    var backdropLabel = typeof BookingOptions !== 'undefined' ? BookingOptions.describeSupportBackdrop(record.supportBackdrop) : '';
    if (backdropLabel) {
      lines.push('希望背景: ' + backdropLabel + '（背景は申込時点では確保されません。対応可否を確認後にご案内します。背景だけの料金はありません）');
      if (record.supportServices === 'CLEANUP') {
        lines.push('背景の設置: ご自身で行っていただきます（「片付けのみ」のため、事前設営は含まれません。背景を希望しても事前設営料金は加算されません）');
      }
      lines.push('背景スタンド（200円）は、機材として明示的に選択した場合のみ加算されます。背景を選んだだけでは追加されません。');
    }
    return lines;
  }

  /* Issue #679: 希望背景のうち、利用者自身が行うセルフ作業（片付けのみ＝設置、事前設営のみ＝片付け）の確定済み案内。背景なし・両方スタッフ対応は空。 */
  function photoSupportBackdropGuidance_(record) {
    if (typeof BookingOptions === 'undefined' || !record.supportBackdrop) return '';
    return BookingOptions.renderSupportBackdropGuidance(record.supportBackdrop, record.supportServices).text;
  }

  /* Issue #667: 申込受付メール。承認待ちであり、承認前はお支払いできないこと・当日依頼や常駐対応でないことを必ず示す。 */
  function buildPhotoSupportReceivedMail_(record, config) {
    var brandLabel = Booking.getBrandLabel(record.brand);
    var timezone = config.timezone;
    var subject = '【' + brandLabel + '】作品撮りサポートプランのお申し込みを受け付けました（承認待ち・未確定）';
    var body = joinNonEmpty_([
      record.name + ' 様',
      '',
      brandLabel + ' の作品撮りサポートプランのお申し込みを受け付けました。対象の時間帯は仮押さえしています。',
      '※このメールの時点では予約は確定していません。運営がスタッフ対応の可否・機材・予約枠を確認します（承認待ち）。',
      '※承認前はお支払いできません。承認できる場合は、確定料金とお支払いのご案内をお送りします。お支払い期限は承認後24時間です。',
      '※承認できない場合は仮押さえを解除し、本プランは不成立となります（通常のSNB mens料金へは自動で切り替えません）。',
      '',
      '予約ID: ' + record.bookingId,
      dateTimeLine_(record, config.timezone),
      durationLine_(record),
      '利用人数: ' + record.people,
      photoSupportBreakdownLines_(record).join('\n'),
      photoSupportBackdropGuidance_(record) ? '\n' + photoSupportBackdropGuidance_(record) : '',
      '',
      '【ご注意】',
      'スタッフ対応は、照明配置と選択した背景を使った撮影環境の事前準備・片付けに限ります（撮影代行・緊縛の施術や指導・吊り設備の組み替えは含みません）。',
      'スタッフが常駐するサービスではなく、当日のご依頼はできません。SNB MEMBER限定のサービスです。',
      contactLine_(config),
      guideLine_(record),
      signatureLines_(record)
    ]);
    return { subject: subject, body: body };
  }

  /* Issue #667: 承認・お支払い案内メール。確定料金・お支払いページ・承認後24時間の期限を示し、お支払い完了までは未確定であることを明記する。 */
  function buildSupportApprovedMail(record, config, payment) {
    var url = payment && typeof payment.url === 'string' ? payment.url : '';
    if (!/^https:\/\/[^\s]+$/.test(url)) {
      throw new Error('お支払いページのURLが無効なため承認案内メールを作成できません。');
    }
    var deadline = formatDeadline_(record.supportPaymentDueAt, config.timezone);
    if (!deadline) {
      throw new Error('お支払い期限が無効なため承認案内メールを作成できません。');
    }
    var brandLabel = Booking.getBrandLabel(record.brand);
    var timezone = config.timezone;
    var subject = '【' + brandLabel + '】作品撮りサポートプランを承認しました（お支払いは' + deadline + 'まで）';
    var body = joinNonEmpty_([
      record.name + ' 様',
      '',
      brandLabel + ' の作品撮りサポートプランのお申し込みを承認しました。',
      '※お支払いが完了するまで予約は確定していません。下記のお支払い期限（承認後24時間）までにお支払いください。',
      '※期限までにお支払いが完了しない場合は不成立となり、仮押さえを解除します。通常のSNB mens料金へは自動で切り替わりません。',
      '',
      'お支払いページ: ' + url,
      'お支払い期限: ' + deadline,
      '',
      '予約ID: ' + record.bookingId,
      dateTimeLine_(record, config.timezone),
      durationLine_(record),
      '利用人数: ' + record.people,
      photoSupportBreakdownLines_(record).join('\n'),
      photoSupportBackdropGuidance_(record) ? '\n' + photoSupportBackdropGuidance_(record) : '',
      '',
      '確定後のキャンセルは、お支払い総額（部屋料金・スタッフ対応料金・同時にご注文の有料機材料金）に対し、SNBの既存のキャンセル規定を適用します。',
      'すでにお支払い済みの場合は、二重決済をせず、運営までご連絡ください。',
      contactLine_(config),
      guideLine_(record),
      signatureLines_(record)
    ]);
    return { subject: subject, body: body };
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
      dateTimeLine_(record, config.timezone),
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
      dateTimeLine_(record, config.timezone),
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
      '利用日: ' + BookingAvailability.formatDateJa(record.date, config.timezone),
      '利用人数: ' + change.oldPeople + ' → ' + change.newPeople
    ];
    if (typeof change.onsitePaymentAmount === 'number') lines.push('当日のお支払い額は' + formatJpyAmount_(change.onsitePaymentAmount) + 'です。');
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
    if (isPhotoSupportRecord_(record)) return buildPhotoSupportReceivedMail_(record, config);
    var brandLabel = Booking.getBrandLabel(record.brand);
    var timezone = config.timezone;
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
      dateTimeLine_(record, config.timezone),
      durationLine_(record),
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
      dateTimeLine_(record, config.timezone),
      durationLine_(record),
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

  /* ===== スマホ向けメールの共通レンダラ（Issue #901） =====
   * 予約確定メール・来場案内メールだけが使う。同じ「ブロック列」から text/plain と HTML を
   * 同時に作るため、HTML版とテキスト版で必要事項（日時・場所・手順・リンク）がずれない。
   * 外部画像・トラッキング・外部CSS・スクリプトは使わない。差し込む値はすべてHTMLエスケープし、
   * https以外のURLはリンクにしない。キーボックス番号などの秘密値は、呼び出し側が渡した
   * 値だけを描画する（ここでは取得・ログ出力・推測をしない）。 */
  function escapeHtml_(value) {
    return String(value === null || value === undefined ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function safeHttpsUrl_(value) {
    var url = String(value === null || value === undefined ? '' : value).trim();
    return /^https:\/\/[^\s<>"']+$/.test(url) ? url : '';
  }

  function textLines_(value) {
    return String(value).split('\n');
  }

  function htmlParagraphs_(value, style) {
    return textLines_(value).map(function (line) {
      return '<p style="margin:0 0 8px;' + (style || '') + '">' + escapeHtml_(line) + '</p>';
    }).join('');
  }

  /* 「11/12(木)」形式（件名用）。日付が解釈できなければ空文字（件名から日付部分を省く）。 */
  function shortDateLabel_(record, timezone) {
    var ja = BookingAvailability.formatDateJa(record.date, timezone);
    var m = /(\d+)月(\d+)日（(.)）/.exec(ja);
    return m ? m[1] + '/' + m[2] + '(' + m[3] + ')' : '';
  }

  function startTimeLabel_(record, timezone) {
    var t = formatTime_(record.startAt, timezone);
    return t ? t.replace(/^0(\d:)/, '$1') : '';
  }

  /* 件名の日時部分。例: 「11/12(木) 9:30–10:30」。開始/終了が取れないときは取れた分だけ。 */
  function subjectWhenLabel_(record, timezone, withEnd) {
    var date = shortDateLabel_(record, timezone);
    var start = startTimeLabel_(record, timezone);
    var end = withEnd ? formatTime_(record.endAt, timezone).replace(/^0(\d:)/, '$1') : '';
    var time = start ? (end ? start + '–' + end : start) : '';
    return [date, time].filter(Boolean).join(' ');
  }

  function addDaysYmd_(ymd, days) {
    var p = String(ymd).split('-');
    if (p.length !== 3) return '';
    var d = new Date(Date.UTC(parseInt(p[0], 10), parseInt(p[1], 10) - 1, parseInt(p[2], 10) + days));
    return BookingAvailability.formatDateInTimezone(d, 'UTC') || '';
  }

  function useDateYmd_(record, timezone) {
    return record.date && typeof record.date.getTime === 'function'
      ? BookingAvailability.formatDateInTimezone(record.date, timezone)
      : String(record.date || '');
  }

  /* 利用日と送信時点の関係: 'today' | 'tomorrow' | 'later'（過去日・解釈不能も 'later'）。timezone基準。 */
  function useDateRelation_(record, timezone, now) {
    var today = BookingAvailability.formatDateInTimezone(now, timezone);
    var use = useDateYmd_(record, timezone);
    if (!today || !use) return 'later';
    if (use === today) return 'today';
    if (use === addDaysYmd_(today, 1)) return 'tomorrow';
    return 'later';
  }

  function hourInTimezone_(now, timezone) {
    var t = BookingAvailability.formatTimeInTimezone(now, timezone);
    var h = t ? parseInt(String(t).split(':')[0], 10) : NaN;
    return Number.isFinite(h) ? h : null;
  }

  /*
   * 予約別暗証番号（Access GASが別メールで送る）の案内文。送信時点と利用日の関係で説明を切り替え、
   * 「前日18時以降」という固定案内を当日予約・18時を過ぎた翌日予約へ機械的に出さない（Issue #901）。
   * - 当日: 前日の配信を待たず、発行でき次第送る（#753 当日予約の即時処理）。
   * - 前日18時以降に確定した翌日予約（確定メールのみ）: 配信開始時刻を過ぎているため、発行でき次第。
   * - それ以外: 従来の3行（#881）をそのまま使う。
   * 送付済みとは断定しない。旧共通暗証番号はこの案内と同じメールに出さない。
   */
  function perBookingCodeNoticeLines_(record, timezone, now, context) {
    var intro = '入室用の暗証番号は、ご予約ごとに専用の番号を発行し、このメールとは別のメールでお送りします。';
    var missing = '暗証番号のメールが届かない場合は、このメールにご返信ください。';
    var relation = useDateRelation_(record, timezone, now);
    if (relation === 'today') {
      return [intro, 'ご利用当日のご予約のため、発行でき次第お送りします。すでに届いている場合は、そちらをご確認ください。', missing];
    }
    if (relation === 'tomorrow' && context === 'confirmed') {
      var hour = hourInTimezone_(now, timezone);
      if (hour !== null && hour >= 18) {
        return [intro, '前日18時の配信開始時刻を過ぎているため、発行でき次第順次お送りします。', missing];
      }
    }
    return PER_BOOKING_CODE_NOTICE_LINES;
  }

  var MAIL_DARK_CSS_ = '@media (prefers-color-scheme: dark){' +
    '.m-bg{background-color:#121212 !important}' +
    '.m-card{background-color:#1e1e1e !important;color:#f1f1f1 !important;border-color:#555 !important}' +
    '.m-box{background-color:#262626 !important;border-color:#8ab4f8 !important;color:#f1f1f1 !important}' +
    '.m-muted{color:#c4c4c4 !important}' +
    '.m-h{border-left-color:#8ab4f8 !important;color:#f1f1f1 !important}' +
    '.m-a{color:#8ab4f8 !important}' +
    '}';

  /* HTML: 1列・表組み・本文16px・インラインstyle中心（Gmail iOS/Android・Apple Mail）。 */
  function renderBlocksHtml_(model) {
    var parts = [];
    var hero = model.hero;
    if (model.lead) parts.push(htmlParagraphs_(model.lead, 'margin-bottom:12px;'));
    if (hero) {
      parts.push(
        '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="m-box" style="margin:0 0 20px;border:2px solid #0b57d0;border-radius:10px;background-color:#eef3fd;color:#1a1a1a;">' +
        '<tr><td style="padding:16px;">' +
        '<p style="margin:0 0 6px;font-size:16px;font-weight:bold;">' + escapeHtml_(hero.kicker) + '</p>' +
        (hero.dateText ? '<p style="margin:0;font-size:24px;line-height:1.3;font-weight:bold;">' + escapeHtml_(hero.dateText) + '</p>' : '') +
        (hero.timeText ? '<p style="margin:2px 0 0;font-size:24px;line-height:1.3;font-weight:bold;">' + escapeHtml_(hero.timeText) + '</p>' : '') +
        (hero.meta && hero.meta.length ? '<p style="margin:10px 0 0;font-size:16px;line-height:1.6;">' + hero.meta.map(escapeHtml_).join('<br>') + '</p>' : '') +
        '</td></tr></table>'
      );
    }
    model.blocks.forEach(function (b) {
      if (b.type === 'heading') {
        parts.push('<h2 class="m-h" style="margin:24px 0 10px;padding:2px 0 2px 10px;border-left:4px solid #0b57d0;font-size:18px;line-height:1.4;">' + escapeHtml_(b.text) + '</h2>');
      } else if (b.type === 'p') {
        parts.push(htmlParagraphs_(b.text, b.small ? 'font-size:14px;' : ''));
      } else if (b.type === 'kv') {
        parts.push('<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 8px;">' +
          b.rows.map(function (r) {
            return '<tr><td valign="top" style="padding:4px 10px 4px 0;font-size:14px;line-height:1.5;white-space:nowrap;" class="m-muted">' + escapeHtml_(r[0]) + '</td>' +
              '<td valign="top" style="padding:4px 0;font-size:16px;line-height:1.5;">' + escapeHtml_(r[1]) + '</td></tr>';
          }).join('') + '</table>');
      } else if (b.type === 'steps') {
        /* Issue #901: 番号と見出しだけを横並びにし、説明・リンク・番号枠は全幅の縦積み（細い右列に長文を流さない）。 */
        b.items.forEach(function (s, i) {
          parts.push('<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 16px;">' +
            '<tr><td style="padding:0;"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>' +
            '<td valign="middle" width="36" style="padding:0 10px 0 0;"><div style="width:30px;height:30px;line-height:30px;text-align:center;border:2px solid #0b57d0;border-radius:15px;font-size:16px;font-weight:bold;">' + (i + 1) + '</div></td>' +
            '<td valign="middle"><p style="margin:0;font-size:17px;font-weight:bold;line-height:1.4;">' + escapeHtml_(s.title) + '</p></td></tr></table></td></tr>' +
            '<tr><td style="padding:8px 0 0;">' +
            (s.lines || []).map(function (l) { return htmlParagraphs_(l); }).join('') +
            (s.rows || []).map(function (r) {
              return '<p class="m-muted" style="margin:0;font-size:14px;line-height:1.5;">' + escapeHtml_(r[0]) + '</p>' +
                '<p style="margin:0 0 8px;font-size:16px;line-height:1.6;">' + escapeHtml_(r[1]) + '</p>';
            }).join('') +
            (s.links || []).map(function (l) {
              var lh = safeHttpsUrl_(l.url);
              return lh ? '<p style="margin:0 0 8px;font-size:16px;line-height:1.6;"><a class="m-a" href="' + escapeHtml_(lh) + '" target="_blank" rel="noopener" style="color:#0b57d0;text-decoration:underline;font-weight:bold;">' + escapeHtml_(l.htmlLabel || l.label) + '</a></p>' : '';
            }).join('') +
            (s.secret ? '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="m-box" style="margin:8px 0 0;border:2px solid #0b57d0;border-radius:8px;background-color:#eef3fd;color:#1a1a1a;"><tr><td style="padding:10px 12px;">' +
              '<p style="margin:0;font-size:14px;font-weight:bold;">' + escapeHtml_(s.secret.label) + '</p>' +
              '<p style="margin:2px 0 6px;font-size:24px;font-weight:bold;letter-spacing:2px;font-family:Menlo,Consolas,monospace;word-break:break-all;">' + escapeHtml_(s.secret.value) + '</p>' +
              (s.secret.note ? '<p style="margin:0;font-size:14px;line-height:1.5;">' + escapeHtml_(s.secret.note) + '</p>' : '') +
              '</td></tr></table>' : '') +
            '</td></tr></table>');
        });
      } else if (b.type === 'callout') {
        parts.push('<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="m-box" style="margin:0 0 14px;border:2px solid #0b57d0;border-radius:8px;background-color:#eef3fd;color:#1a1a1a;"><tr><td style="padding:12px 14px;">' +
          '<p style="margin:0 0 6px;font-size:16px;font-weight:bold;">' + escapeHtml_(b.title) + '</p>' +
          htmlParagraphs_(b.text, 'font-size:15px;line-height:1.6;') + '</td></tr></table>');
      } else if (b.type === 'button') {
        var href = safeHttpsUrl_(b.url);
        parts.push(href
          ? '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:6px 0 14px;max-width:360px;"><tr>' +
            '<td align="center" bgcolor="#0b57d0" style="background-color:#0b57d0;border:2px solid #0842a0;border-radius:10px;">' +
            '<a href="' + escapeHtml_(href) + '" target="_blank" rel="noopener" style="display:block;padding:14px 18px;color:#ffffff;font-size:17px;font-weight:bold;line-height:1.4;text-align:center;text-decoration:none;">' + escapeHtml_(b.label) + '</a></td></tr></table>'
          : '');
      } else if (b.type === 'links') {
        parts.push('<p style="margin:0 0 8px;font-size:16px;line-height:1.8;">' + b.items.map(function (l) {
          var href2 = safeHttpsUrl_(l.url);
          return href2 ? '<a class="m-a" href="' + escapeHtml_(href2) + '" target="_blank" rel="noopener" style="color:#0b57d0;text-decoration:underline;">' + escapeHtml_(l.htmlLabel || l.label) + '</a>' : '';
        }).filter(Boolean).join('<br>') + '</p>');
      }
    });
    var footer = (model.footer || []).map(function (l) { return escapeHtml_(l); }).join('<br>');
    return '<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8">' +
      '<meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark">' +
      '<title>' + escapeHtml_(model.title) + '</title><style>' + MAIL_DARK_CSS_ + '</style></head>' +
      '<body class="m-bg" style="margin:0;padding:0;background-color:#f4f4f4;color:#1a1a1a;font-family:-apple-system,BlinkMacSystemFont,\'Hiragino Sans\',\'Yu Gothic\',Meiryo,sans-serif;font-size:16px;line-height:1.7;">' +
      '<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:#f4f4f4;">' + escapeHtml_(model.preheader || '') + '&zwnj;&nbsp;&zwnj;&nbsp;</div>' +
      '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="m-bg" style="background-color:#f4f4f4;"><tr><td align="center" style="padding:12px;">' +
      '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="m-card" style="max-width:600px;background-color:#ffffff;border:1px solid #dddddd;border-radius:10px;color:#1a1a1a;"><tr><td style="padding:20px 16px;">' +
      parts.join('') +
      (footer ? '<p class="m-muted" style="margin:20px 0 0;padding-top:12px;border-top:1px solid #cccccc;font-size:14px;line-height:1.7;color:#555555;">' + footer + '</p>' : '') +
      '</td></tr></table></td></tr></table></body></html>';
  }

  /* text/plain: HTMLと同じブロック列から作る。URLは省略せず全文を載せる（HTML非対応環境で手順とリンクが読める）。 */
  function renderBlocksText_(model) {
    var lines = [];
    function gap() { if (lines.length && lines[lines.length - 1] !== '') lines.push(''); }
    if (model.greeting) { lines.push(model.greeting); gap(); }
    if (model.lead) { lines.push(model.lead); gap(); }
    if (model.hero) {
      lines.push(model.hero.kicker);
      if (model.hero.textLine) lines.push(model.hero.textLine);
      (model.hero.meta || []).forEach(function (m) { lines.push(m); });
      gap();
    }
    model.blocks.forEach(function (b) {
      if (b.type === 'heading') { gap(); lines.push('■ ' + b.text); }
      else if (b.type === 'p') { Array.prototype.push.apply(lines, textLines_(b.text)); gap(); }
      else if (b.type === 'kv') { b.rows.forEach(function (r) { lines.push(r[0] + ': ' + r[1]); }); gap(); }
      else if (b.type === 'steps') {
        b.items.forEach(function (s, i) {
          lines.push((i + 1) + '. ' + s.title);
          (s.lines || []).forEach(function (l) { textLines_(l).forEach(function (x) { lines.push('   ' + x); }); });
          (s.rows || []).forEach(function (r) { lines.push('   ' + r[0] + ': ' + r[1]); });
          (s.links || []).forEach(function (l) { var su = safeHttpsUrl_(l.url); if (su) lines.push('   ' + l.label + ': ' + su); });
          if (s.secret) {
            lines.push('   ' + s.secret.label + ': ' + s.secret.value);
            if (s.secret.note) lines.push('   ' + s.secret.note);
          }
        });
        gap();
      } else if (b.type === 'callout') { lines.push('【' + b.title + '】'); Array.prototype.push.apply(lines, textLines_(b.text)); gap(); }
      else if (b.type === 'button') { var u = safeHttpsUrl_(b.url); if (u) { lines.push('▼ ' + b.label); lines.push(u); gap(); } }
      else if (b.type === 'links') { b.items.forEach(function (l) { var u2 = safeHttpsUrl_(l.url); if (u2) lines.push(l.label + ': ' + u2); }); gap(); }
    });
    (model.footer || []).forEach(function (l) { lines.push(l); });
    return lines.filter(function (l, i) { return !(l === '' && (i === 0 || lines[i - 1] === '')); })
      .join('\n').replace(/\n+$/, '');
  }

  /*
   * CONFIRMED（予約確定メール）。件名で確定が分かるようにする。
   * 料金は本文へ出さない（Issue #271本文の指示どおり据え置き。Issue #342で仮予約受付
   * メール（buildPendingMail）へ料金を追加したが、確定メールには追加しない方針にした:
   * 管理者がPENDING時点でBookingRepository.updateBookingPriceにより金額を修正できる
   * ため、送信タイミングによって仮予約時と確定時で異なる金額が案内される事故を避ける。
   * 金額を確認したい場合はBooking Admin（実効金額はBooking.getEffectivePriceAmount）を見る運用とする）。
   */
  function buildConfirmedMail(record, config, options) {
    /* Issue #881: options.perBookingCode===true（新方式対象予約）のときだけ予約別暗証番号の別送案内を足す。
       確定メールは従来から暗証番号を載せない（旧共通コードも出さない）。
       Issue #901: スマホで「いつ・どこ・どう入る・何を待つ」が数秒で分かる構成へ再設計。
       件名と冒頭に日時、次のアクション（別メールで届く入室情報）を動的に説明し、
       キーボックス・設備・原状復帰の長文は来場案内メールとご利用案内ページへ集約する。 */
    var perBookingCode = !!(options && options.perBookingCode === true);
    var brandLabel = Booking.getBrandLabel(record.brand);
    var timezone = config.timezone;
    var now = options && options.now && typeof options.now.getTime === 'function' ? options.now : new Date();

    var when = subjectWhenLabel_(record, timezone, true);
    var subject = '【' + brandLabel + '】予約確定' + (when ? '｜' + when : '');

    var dateText = BookingAvailability.formatDateJa(record.date, timezone);
    var timeText = BookingAvailability.formatTimeRangeJa(record.startAt, record.endAt, timezone);
    var duration = BookingAvailability.formatDurationJa(record.startAt, record.endAt);
    var meta = [
      'ブランド: ' + brandLabel,
      record.people ? '利用人数: ' + record.people : '',
      record.paymentMethod ? '支払方法: ' + record.paymentMethod : ''
    ].filter(Boolean);

    var noticeLine = accessGuideNoticeLine_(record, timezone, now);
    var blocks = [
      { type: 'heading', text: '次にすること' },
      { type: 'p', text: noticeLine }
    ];
    if (perBookingCode) {
      blocks.push({
        type: 'callout',
        title: 'ご予約専用の入室暗証番号は別メールです',
        text: perBookingCodeNoticeLines_(record, timezone, now, 'confirmed').join('\n')
      });
    }
    blocks.push(
      { type: 'p', text: 'ご利用ルール・原状回復のお願いは、下記のご利用案内でご確認ください。', small: true },
      { type: 'heading', text: 'ご予約情報・お問い合わせ' },
      { type: 'kv', rows: [['予約ID', record.bookingId]].concat(duration ? [['利用時間', duration]] : []) },
      { type: 'p', text: 'ご不明点やキャンセル・変更のご希望は下記までご連絡ください。' + (config && config.contactEmail ? '\nお問い合わせ: ' + config.contactEmail : '') },
      { type: 'links', items: [{ label: 'ご利用案内', url: Booking.getBrandProfile(record.brand).guideUrl }] }
    );

    var footer = signatureLines_(record).split('\n');
    var preheader = dateText + (timeText ? ' ' + timeText : '') + ' のご予約を承りました。' +
      (perBookingCode ? '入室暗証番号は別メールでお送りします。' : '来場方法は別メールでご案内します。');
    var model = {
      title: subject,
      preheader: preheader,
      greeting: record.name + ' 様',
      hero: {
        kicker: 'ご予約が確定しました',
        dateText: dateText,
        timeText: timeText,
        textLine: dateTimeLine_(record, timezone),
        meta: meta
      },
      blocks: blocks,
      footer: footer
    };
    return { subject: subject, body: renderBlocksText_(model), htmlBody: renderBlocksHtml_(model) };
  }

  /*
   * CANCELLED（キャンセルメール）。#271では共通関数を用意するのみで、実際にCANCELLED後の
   * Calendar/Sheets処理から呼ぶ配線は#272で行う（このIssueの対象外）。
   */
  function buildCancelledMail(record, config) {
    var brandLabel = Booking.getBrandLabel(record.brand);
    var timezone = config.timezone;
    if (isPhotoSupportRecord_(record) && !record.supportApprovedAt) {
      /* Issue #667: 承認前のキャンセル＝不承認（スタッフ対応・機材・予約枠の都合）。仮押さえを解除し、プランは不成立。 */
      return {
        subject: '【' + brandLabel + '】作品撮りサポートプランを承認できませんでした',
        body: joinNonEmpty_([
          record.name + ' 様',
          '',
          '下記の作品撮りサポートプランのお申し込みは、スタッフ対応・機材・予約枠の都合により承認できませんでした。仮押さえは解除し、本プランは不成立です。お支払いは発生していません。',
          '※通常のSNB mens料金へは自動で切り替わりません。通常の時間貸しをご希望の場合は、改めて予約ページからお申し込みください。',
          '',
          '予約ID: ' + record.bookingId,
          dateTimeLine_(record, config.timezone),
          '',
          rebookLine_(record),
          contactLine_(config),
          signatureLines_(record)
        ])
      };
    }

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
      dateTimeLine_(record, config.timezone),
      durationLine_(record),
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
  function isUseDateToday_(record, timezone, now) {
    var today = BookingAvailability.formatDateInTimezone(now || new Date(), timezone);
    var useDate = record.date && typeof record.date.getTime === 'function'
      ? BookingAvailability.formatDateInTimezone(record.date, timezone)
      : String(record.date || '');
    return !!today && today === useDate;
  }

  /*
   * 確定メールの来場案内に関する一文。当日予約は確定直後に即時送信、翌日以降は前日に送る
   * （Issue #412。Issue #414で鍵承認を廃止したため、Stripe予約も同じ文言）。
   */
  function accessGuideNoticeLine_(record, timezone, now) {
    /*
     * Issue #412: 利用日が当日の予約は、確定直後に来場案内を即時送信する（前日案内は届かない）。
     * 「利用日前日に送る」とは書かない。
     */
    if (isUseDateToday_(record, timezone, now)) {
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
      '利用日: ' + BookingAvailability.formatDateJa(record.date, config.timezone),
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
    if (isPhotoSupportRecord_(record)) {
      /* Issue #667: 作品撮りサポートの不成立通知。通常のSNB mens料金へは自動で切り替えない。 */
      return {
        subject: '【' + brandLabel + '】作品撮りサポートプランは不成立となりました',
        body: joinNonEmpty_([
          record.name + ' 様',
          '',
          '下記の作品撮りサポートプランは、承認後24時間以内にお支払いが完了しなかったため（または承認に至らなかったため）、不成立となりました。仮押さえは解除しています。',
          '※通常のSNB mens料金へは自動で切り替わりません。お支払いは発生していません。',
          '',
          '予約ID: ' + record.bookingId,
          dateTimeLine_(record, config.timezone),
          '',
          '改めてご利用をご希望の場合は、予約ページから再度お申し込みください（作品撮りサポートプランは利用日の7日前までのお申し込みです）。',
          rebookLine_(record),
          'すでにお支払いが完了している場合は、再度のお申し込みや二重のお支払いをせず、下記までご連絡ください。',
          contactLine_(config),
          signatureLines_(record)
        ])
      };
    }

    var subject = '【' + brandLabel + '】ご予約が期限切れになりました（要再申込み）';
    var body = joinNonEmpty_([
      record.name + ' 様',
      '',
      isLargePartyRecord_(record)
        ? '下記の5〜7名でのご利用は、承認の手続きまたはお支払いが期限（承認から24時間）までに完了しなかったため、不成立となり、仮押さえを解除しました。'
        : '下記のご予約は、お支払い期限までに運営による確認ができなかったため、失効いたしました。',
      '',
      '予約ID: ' + record.bookingId,
      dateTimeLine_(record, config.timezone),
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
      dueDisplay = dueDateString ? BookingAvailability.formatDateJa(dueDateString, timezone) + ' ' + dueTimeString : '';
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
          dateTimeLine_(record, config.timezone),
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
      dateTimeLine_(record, config.timezone),
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
  /*
   * Issue #881: 予約別暗証番号（独立Access GASが別メールで送る）の案内。確定メール・前日リマインドの
   * 新方式対象予約（BookingConfig.resolveAccessCodeDelivery().perBookingCode===true）で共通に使う。
   * 配送時期はAccess GASの現行ジョブ仕様（delivery.startHoursBeforeDay既定6＝利用日前日18:00 JST以降、
   * それ以降に確定した予約は発行後の次の配送周期）に合わせる。送付済みとは断定しない。
   * 旧共通暗証番号はこの案内と同じメールに出さない。未着時はこのメール（予約メールの返信先）への返信を案内する。
   */
  var PER_BOOKING_CODE_NOTICE_LINES = [
    '入室用の暗証番号は、ご予約ごとに専用の番号を発行し、このメールとは別のメールでお送りします。',
    'お届けは利用日前日の18時以降です（それ以降に確定したご予約は、確定後に順次お送りします）。',
    '暗証番号のメールが届かない場合は、このメールにご返信ください。'
  ];
  var PER_BOOKING_CODE_NOTICE_LINE = PER_BOOKING_CODE_NOTICE_LINES.join('\n');

  function buildReminderMail(record, config, accessGuide, options) {
    var brandLabel = Booking.getBrandLabel(record.brand);
    var timezone = config.timezone;
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

    /* Issue #753: SNBかつ options.separateCodeNotice===true（Script Property経由）のときだけ一行を足す。
       鍵の暗証番号そのものはこのメールに載せない（独立GASの別メール。#752）。ブランドが空/不明の旧データは対象外。 */
    /* Issue #832: options.perBookingCode===true（BookingConfig.resolveAccessCodeDelivery由来の新方式対象予約）
       のときは、旧固定「解錠コード」行（ラベル・値とも）を出さず、予約別暗証番号の別送案内
       （PER_BOOKING_CODE_NOTICE_LINES。#881で配送時期・未着時の返信案内つきへ更新）を出す。旧文言は新方式では使わない。送付済みとは断定しない。ACCESS_KEY_NOTICE_ENABLED
       （separateCodeNotice）は新方式の判定に影響しない。オートロック用キーボックス位置・番号は従来どおり残す。 */
    var perBookingCode = !!(options && options.perBookingCode === true);
    var separateCodeLine = perBookingCode
      ? ''
      : (options && options.separateCodeNotice === true && record.brand === 'snb'
        ? '入室用の暗証番号は、別のメールでお送りします。' : '');

    /* Issue #901: 件名は「本日/明日の来場案内｜11/12(木) 9:30」。日付・開始時刻が取れない場合は省く。 */
    var when = subjectWhenLabel_(record, timezone, false);
    var subject = '【' + brandLabel + '】' + dayWord + 'の来場案内' + (when ? '｜' + when : '');

    var dateText = BookingAvailability.formatDateJa(record.date, timezone);
    var timeText = BookingAvailability.formatTimeRangeJa(record.startAt, record.endAt, timezone);

    /* 地図: 設定された地図URL（ACCESS_GUIDE_MAP_URL）を優先。無ければ、設定済みの住所・建物名から
       地図アプリの検索リンクを作る（住所自体が未設定なら地図リンクは出さない＝場所を推測しない）。 */
    var mapUrl = safeHttpsUrl_(guide.mapUrl) || (guide.address
      ? 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(guide.address + (guide.building ? ' ' + guide.building : ''))
      : '');

    var placeRows = [];
    if (guide.address) placeRows.push(['住所', guide.address]);
    if (guide.building) placeRows.push(['建物', guide.building]);
    if (guide.room) placeRows.push(['部屋番号', guide.room]);

    /* キーボックス番号は「鍵の保管箱」の番号。予約固有の入室暗証番号（別メール）・旧共通の解錠コードとは
       別物であることを、番号の直下に必ず明記する（Issue #901。取り違え防止）。 */
    var keyboxNote = perBookingCode
      ? '※これは鍵を保管する箱の番号です。入室用の暗証番号（別メール）とは別の番号です。'
      : '※これは鍵を保管する箱の番号です。入室用の暗証番号・解錠コードとは別の番号です。';

    var step1 = { title: '建物の正面入口へ', lines: [], rows: [] };
    if (guide.entrance) step1.rows.push(['入口からのご案内', guide.entrance]);
    var step2 = { title: '指定位置のキーボックスを開ける', lines: [], rows: [], secret: { label: 'キーボックス番号', value: guide.keyboxNumber ? guide.keyboxNumber : '（未設定）', note: keyboxNote } };
    if (guide.keyboxLocation) step2.rows.push(['キーボックス位置', guide.keyboxLocation]);
    /* Issue #901: 詳細案内リンク・PDFはStep 2の中（位置説明の直後・番号枠の前）に置く。
       リンク先（ACCESS_GUIDE_URL／ブランド別の利用案内ページ／ACCESS_GUIDE_PDF_URL）の内容は
       このテンプレートでは保証できないため、「写真で確認」などリンク先の中身を約束するラベルにしない。 */
    /* 運営者確認: 案内PDFはキーボックス位置を説明する資料なのでStep 2（位置の直後・番号枠の前）に置く。
       PDF未設定なら架空の資料を示さず出さない。PDF内の写真の有無は未確認のため「写真で」とは断定しない。
       利用案内ページは入室・退室を含む利用方法全般の案内なので、キーボックス専用の名称にせず、3ステップの後に独立して置く。 */
    step2.links = [];
    if (guide.pdfUrl) step2.links.push({ label: 'キーボックスの位置・行き方を確認（PDF）', url: guide.pdfUrl });
    var step3 = { title: '解錠して入室', lines: [], rows: [] };
    if (guide.entryMethod) step3.rows.push(['入室方法', guide.entryMethod]);
    if (!perBookingCode) {
      step3.secret = { label: '解錠コード', value: guide.unlockCode ? guide.unlockCode : '（未設定）', note: '' };
    }

    var blocks = [
      { type: 'heading', text: 'ご利用の場所' },
      { type: 'kv', rows: placeRows },
      { type: 'button', label: '地図を開く', url: mapUrl },
      { type: 'heading', text: '入室の3ステップ' },
      { type: 'steps', items: [step1, step2, step3] }
    ];
    /* Issue #753: SNB＋ACCESS_KEY_NOTICE_ENABLED のときだけの一行（旧方式の暗証番号別送案内）。手順の直下に置く。 */
    if (separateCodeLine) blocks.push({ type: 'p', text: separateCodeLine });
    if (reminderGuideUrl) {
      blocks.push({ type: 'heading', text: '利用案内' });
      blocks.push({ type: 'links', items: [{ label: '利用案内ページ', htmlLabel: '写真つきの詳しい案内を見る（利用案内ページ）', url: reminderGuideUrl }] });
    }
    blocks.push(
      { type: 'heading', text: 'ご退室時' },
      { type: 'p', text: '施錠し、鍵を使った場合は元の場所へ戻して、備品は原状に戻してください。' },
      { type: 'heading', text: 'ご予約情報・お問い合わせ' },
      { type: 'kv', rows: [['予約ID', record.bookingId], ['ブランド', brandLabel]] }
    );
    if (config && config.contactEmail) blocks.push({ type: 'p', text: 'お問い合わせ: ' + config.contactEmail });

    var model = {
      title: subject,
      preheader: dayWord + 'のご予約の来場方法です。' + (perBookingCode ? '入室暗証番号は別メールで届きます。' : ''),
      greeting: record.name + ' 様',
      lead: dayWord + 'のご予約について、来場方法をご案内します。',
      hero: {
        kicker: dayWord + 'の来場案内',
        dateText: dateText,
        timeText: timeText,
        textLine: dateTimeLine_(record, timezone),
        meta: []
      },
      blocks: blocks,
      footer: signatureLines_(record).split('\n')
    };
    /* ファーストビューは日時・住所・部屋・地図。暗証番号の別送案内は、その直後（入室手順の前）に置く。 */
    if (perBookingCode) {
      model.blocks.splice(3, 0, {
        type: 'callout',
        title: '入室用の暗証番号は別メールです',
        text: perBookingCodeNoticeLines_(record, timezone, now || new Date(), 'reminder').join('\n')
      });
    }
    return { subject: subject, body: renderBlocksText_(model), htmlBody: renderBlocksHtml_(model) };
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
      dateTimeLine_(record, config.timezone),
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
    buildSupportApprovedMail: buildSupportApprovedMail,
    buildConfirmedMail: buildConfirmedMail,
    buildCancelledMail: buildCancelledMail,
    buildExpiredMail: buildExpiredMail,
    buildReminderMail: buildReminderMail,
    buildPaymentLinkMail: buildPaymentLinkMail,
    buildPriceUpdateMail: buildPriceUpdateMail,
    buildRefundedMail: buildRefundedMail
  };
})();

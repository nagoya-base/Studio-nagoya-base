/*
 * OptionMailTemplates.gs — 予約オプション（Issue #423）の利用者向けメール文面。
 *
 * 件名・本文を組み立てる純粋関数のみ（BookingMailTemplates.gsと同方針。GAS組み込み
 * サービスに依存しない）。署名・案内URLは既存のBooking.getBrandProfileを使い、ブランド別に
 * テンプレートをコピーしない。無料セルフセッティングの定型案内はBookingOptions.
 * renderSelfGuidance（唯一の正本）から取得する。
 *
 * 秘密情報（解錠コード・キーボックス番号等）は一切含めない。決済URL（Stripe Checkout）も
 * メールには載せず、本人確認付きの案内ページ（予約ID＋登録メール）へ誘導する
 * （URLの転送・流出で第三者が決済ページへ到達する経路を作らない）。
 */
'use strict';

var OptionMailTemplates = (function () {
  function joinNonEmpty_(lines) {
    return lines.filter(function (line) { return line !== null && line !== undefined && line !== ''; }).join('\n');
  }

  function formatJpy_(amount) {
    var value = Number(amount);
    return Number.isFinite(value) ? value.toLocaleString('ja-JP') + '円' : '';
  }

  function signature_(booking) {
    var profile = Booking.getBrandProfile(booking.brand);
    return joinNonEmpty_(['', '--', profile.signature]);
  }

  /* 本人確認付きのオプション案内ページ（予約IDはURLに含めるが、操作には登録メールの入力が必要）。 */
  function buildOptionsPageUrl(booking) {
    var profile = Booking.getBrandProfile(booking.brand);
    return profile.bookingUrl + 'options/?bookingId=' + encodeURIComponent(booking.bookingId);
  }

  function contactLine_(config) {
    return config && config.contactEmail ? 'お問い合わせ（メール）: ' + config.contactEmail : '';
  }

  function bookingLines_(booking, config) {
    return [
      '予約ID: ' + booking.bookingId,
      '利用日: ' + BookingAvailability.formatDateWithWeekday(booking.date)
    ];
  }

  function orderLines_(order) {
    var lines = (order.items || []).map(function (code) { return '  ・' + BookingOptions.describeItem(code); });
    if (order.amountJpy > 0) lines.push('  料金: ' + formatJpy_(order.amountJpy) + '（税込）');
    else lines.push('  料金: 無料');
    return ['注文ID: ' + order.optionOrderId].concat(lines);
  }

  /* 申込受付メール。注文ごとの状態（確定／承認待ち／お支払い待ち）と、無料セルフの定型案内を載せる。 */
  function buildOptionReceivedMail(booking, orders, config) {
    var brandLabel = Booking.getBrandLabel(booking.brand);
    var blocks = [];
    var guidanceItems = [];
    var hasStaff = false;
    var hasEquipment = false;
    var hasHold = false;
    var hasShower = false;
    orders.forEach(function (order) {
      var state;
      if (order.category === BookingOptions.CATEGORY.FREE) {
        state = '状態: 確定（無料・お支払い不要）';
        guidanceItems = guidanceItems.concat(order.items || []);
      } else if (order.category === BookingOptions.CATEGORY.STAFF_SERVICE) {
        state = '状態: 承認待ち（まだ確定していません・お支払いは不要です）';
        hasStaff = true;
      } else if (order.category === BookingOptions.CATEGORY.MEMBER_SERVICE) {
        state = '状態: 運営の確認待ち（まだ確定していません・お支払いは不要です）';
        hasShower = true;
      } else if (order.approvalStatus === BookingOptions.APPROVAL_STATUS.PENDING_APPROVAL) {
        state = '状態: 利用許可の確認待ち（まだ確定していません・お支払いは不要です）';
        hasHold = true;
      } else {
        state = '状態: お支払い待ち（ご予約の確定後にお支払いいただけます）';
        hasEquipment = true;
      }
      blocks.push(joinNonEmpty_(orderLines_(order).concat([state])));
    });

    var guidance = BookingOptions.renderSelfGuidance(guidanceItems);
    var lines = [
      booking.name + ' 様',
      '',
      'オプションのお申し込みを受け付けました。',
      ''
    ].concat(bookingLines_(booking, config)).concat(['']).concat([blocks.join('\n\n')]);

    if (hasStaff) {
      lines.push('');
      lines.push(BookingOptions.NOTICES.STAFF_SERVICE_APPROVAL);
    }
    if (hasShower) {
      lines.push('');
      lines.push(BookingOptions.NOTICES.SHOWER_APPROVAL);
    }
    if (hasHold) {
      lines.push('');
      lines.push('有料レンタル機材は施錠管理しているため、セルフでのご利用には管理者の利用許可（信用確認）が必要です。管理者が許可を確認するまでお支払い・確定はできません。確認後にご案内します（許可が確認できない場合はお受けできません）。');
    }
    if (hasEquipment || hasStaff || hasHold || hasShower) {
      lines.push('');
      lines.push('お支払い・状況のご確認はこちら（予約IDとご登録のメールアドレスで確認します）:');
      lines.push(buildOptionsPageUrl(booking));
    }
    if (guidance.text) {
      lines.push('');
      lines.push(guidance.text);
    }
    lines.push('');
    lines.push(contactLine_(config));
    lines.push(signature_(booking));

    return { subject: '【' + brandLabel + '】オプションのお申し込みを受け付けました', body: joinNonEmpty_(lines), guidanceIncomplete: guidance.incomplete };
  }

  /* 承認メール。承認後にオンライン決済をお願いする（Checkoutは案内ページから本人確認後に開始）。 */
  function buildOptionApprovedMail(booking, order, config) {
    var brandLabel = Booking.getBrandLabel(booking.brand);
    var isEquipment = order.category === BookingOptions.CATEGORY.EQUIPMENT;
    var isShower = order.category === BookingOptions.CATEGORY.MEMBER_SERVICE;
    var freeSet = isEquipment && Number(order.amountJpy) === 0;
    var lines = (freeSet ? [
      booking.name + ' 様',
      '',
      '有料レンタル機材のセルフレンタルについて、利用許可を確認しました。',
      'ポータブルストロボ・ライト等とのセット無料分のため、お支払いは不要です。下記の内容で確定しました。',
      ''
    ] : isEquipment ? [
      booking.name + ' 様',
      '',
      '有料レンタル機材のセルフレンタルについて、利用許可を確認しました。',
      '下記のページからオンライン決済をお願いします。ご予約が確定している場合にお支払いいただけます。お支払いの完了をもって確定となります。',
      ''
    ] : isShower ? [
      booking.name + ' 様',
      '',
      'ご希望のシャワー利用について、対応可能と確認できました。',
      '下記のページからオンライン決済をお願いします。お支払いの完了をもって利用確定となります。',
      ''
    ] : [
      booking.name + ' 様',
      '',
      'お申し込みのスタッフ対応について、対応可能と確認できました。',
      '下記のページからオンライン決済をお願いします。お支払いの完了をもって確定となります。',
      ''
    ]).concat(bookingLines_(booking, config)).concat(orderLines_(order)).concat(freeSet ? [] : [
      '',
      'お支払いはこちら（予約IDとご登録のメールアドレスで確認します）:',
      buildOptionsPageUrl(booking)
    ]).concat([
      '',
      contactLine_(config),
      signature_(booking)
    ]);
    return { subject: '【' + brandLabel + '】' + (freeSet ? '有料レンタル機材の利用を許可しました（セット無料・確定）' : isEquipment ? '有料レンタル機材の利用を許可しました（お支払いのお願い）' : isShower ? 'シャワー利用を承認しました（お支払いのお願い）' : 'スタッフ対応を承認しました（お支払いのお願い）'), body: joinNonEmpty_(lines) };
  }

  /* 不承認メール。部屋のご予約には影響しないことを明記する。 */
  function buildOptionDeclinedMail(booking, order, config) {
    var brandLabel = Booking.getBrandLabel(booking.brand);
    var isEquipment = order.category === BookingOptions.CATEGORY.EQUIPMENT;
    var isShower = order.category === BookingOptions.CATEGORY.MEMBER_SERVICE;
    var lines = (isShower ? [
      booking.name + ' 様',
      '',
      'ご希望のシャワー利用は、当日の対応の都合によりお受けできませんでした。申し訳ありません。',
      'お支払いは発生していません。ご予約（部屋の利用）の内容には影響ありません。',
      ''
    ] : isEquipment ? [
      booking.name + ' 様',
      '',
      'お申し込みの有料レンタル機材は、管理者による利用許可を確認できなかったため、セルフレンタルをお受けできませんでした。',
      'お支払いは発生していません。ご予約（部屋の利用）の内容には影響ありません。',
      'ご利用許可についてのご相談は、メールでお問い合わせください。',
      ''
    ] : [
      booking.name + ' 様',
      '',
      'お申し込みのスタッフ対応は、スタッフの予定の都合により対応できませんでした。申し訳ありません。',
      'お支払いは発生していません。ご予約（部屋の利用）の内容には影響ありません。',
      'セルフでの設営・原状復帰（無料）をご希望の場合は、案内ページからお申し込みいただけます。',
      ''
    ]).concat(bookingLines_(booking, config)).concat(orderLines_(order)).concat([
      '',
      buildOptionsPageUrl(booking),
      contactLine_(config),
      signature_(booking)
    ]);
    return { subject: '【' + brandLabel + '】' + (isShower ? 'シャワー利用について（お受けできませんでした）' : isEquipment ? '有料レンタル機材のお申し込みについて（お受けできませんでした）' : 'スタッフ対応について（対応できませんでした）'), body: joinNonEmpty_(lines) };
  }

  /* お支払い完了・確定メール。 */
  function buildOptionConfirmedMail(booking, order, config) {
    var brandLabel = Booking.getBrandLabel(booking.brand);
    var guidance = BookingOptions.renderSelfGuidance(order.items || []);
    var lines = [
      booking.name + ' 様',
      '',
      'オプションのお支払いを確認しました。下記の内容で確定しました。',
      ''
    ].concat(bookingLines_(booking, config)).concat(orderLines_(order));
    if (guidance.text) {
      lines.push('');
      lines.push(guidance.text);
    }
    lines.push('');
    lines.push(contactLine_(config));
    lines.push(signature_(booking));
    return { subject: '【' + brandLabel + '】オプションが確定しました', body: joinNonEmpty_(lines) };
  }

  return {
    buildOptionsPageUrl: buildOptionsPageUrl,
    buildOptionReceivedMail: buildOptionReceivedMail,
    buildOptionApprovedMail: buildOptionApprovedMail,
    buildOptionDeclinedMail: buildOptionDeclinedMail,
    buildOptionConfirmedMail: buildOptionConfirmedMail
  };
})();

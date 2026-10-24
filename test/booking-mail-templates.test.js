/*
 * BookingMailTemplates.gs のテスト（Issue #271）。
 * 純粋関数のみを扱うため、GAS組み込みサービスのスタブは不要（Availability.gs/Booking.gs
 * と同じくvmでそのまま実行できる）。
 */
'use strict';

var test = require('node:test');
var assert = require('node:assert');
var loadBookingSandbox = require('./helpers/gas-sandbox').loadBookingSandbox;

var FILES = ['Availability.gs', 'Booking.gs', 'BookingMailTemplates.gs'];

function loadTemplates() {
  return loadBookingSandbox(FILES, {}).BookingMailTemplates;
}

var CONFIG = { timezone: 'Asia/Tokyo', contactEmail: 'contact@example.com' };

function sampleRecord(overrides) {
  return Object.assign(
    {
      bookingId: 'SX-20261001-AAAAAAAA',
      date: '2026-10-01',
      startAt: new Date('2026-10-01T10:00:00+09:00'),
      endAt: new Date('2026-10-01T12:00:00+09:00'),
      brand: 'studio_x',
      name: '山田太郎',
      email: 'taro@example.com',
      people: '2名',
      paymentMethod: '現金'
    },
    overrides || {}
  );
}

/* ダミーの来場案内（Issue #271「16. 来場案内」テンプレートテストでは実秘密値を使わない）。 */
var DUMMY_ACCESS_GUIDE = {
  address: '愛知県名古屋市...',
  building: 'テストビル',
  room: '101',
  entrance: '正面入口から左手',
  keyboxLocation: '玄関脇',
  entryMethod: '玄関の暗証番号を入力して解錠',
  keyboxNumber: 'TEST-KEYBOX',
  unlockCode: 'TEST-CODE',
  url: 'https://example.com/how-to',
  pdfUrl: 'https://example.com/guide.pdf'
};

test('buildPendingMail: 件名/本文に「未確定」が明記される', function () {
  var templates = loadTemplates();
  var mail = templates.buildPendingMail(sampleRecord(), CONFIG);
  assert.match(mail.subject + mail.body, /未確定/);
});

test('buildPendingMail: 予約ID/氏名/利用日/開始/終了/利用時間/人数/支払方法/問い合わせ先を含む', function () {
  var templates = loadTemplates();
  var mail = templates.buildPendingMail(sampleRecord(), CONFIG);
  assert.match(mail.body, /SX-20261001-AAAAAAAA/);
  assert.match(mail.body, /山田太郎/);
  assert.match(mail.body, /2026-10-01/);
  assert.match(mail.body, /10:00/);
  assert.match(mail.body, /12:00/);
  assert.match(mail.body, /120分/);
  assert.match(mail.body, /2名/);
  assert.match(mail.body, /現金/);
  assert.match(mail.body, /contact@example\.com/);
});

/* ── 利用料金の表示（Issue #342） ── */

test('buildPendingMail: record.priceAmountがある場合、「利用料金: X円（税込）」を含む', function () {
  var templates = loadTemplates();
  var mail = templates.buildPendingMail(sampleRecord({ priceAmount: 4000 }), CONFIG);
  assert.match(mail.body, /利用料金: 4,000円（税込）/);
});

test('buildPendingMail: priceAmountが未設定・空文字・数値化できない過去の予約データでも例外を投げず、料金の行を出さない', function () {
  var templates = loadTemplates();
  [undefined, '', null, 'abc'].forEach(function (badPrice) {
    var mail = templates.buildPendingMail(sampleRecord({ priceAmount: badPrice }), CONFIG);
    assert.doesNotMatch(mail.body, /利用料金/, JSON.stringify(badPrice) + ' では利用料金の行を出さないべき');
  });
});

test('buildPendingMail: priceAmount:0は数値として有効なため「0円」と表示する（未計算の空文字とは区別する）', function () {
  var templates = loadTemplates();
  var mail = templates.buildPendingMail(sampleRecord({ priceAmount: 0 }), CONFIG);
  assert.match(mail.body, /利用料金: 0円（税込）/);
});

test('buildConfirmedMail/buildPaymentLinkMail: priceAmountがあっても金額を一切表示しない（既存方針を維持し、案内金額の齟齬を避ける）', function () {
  var templates = loadTemplates();
  var record = sampleRecord({ priceAmount: 4000 });
  var confirmed = templates.buildConfirmedMail(record, CONFIG);
  var paymentLink = templates.buildPaymentLinkMail(record, CONFIG, 'https://buy.stripe.com/test_ABC123');
  assert.doesNotMatch(confirmed.body, /利用料金/);
  assert.doesNotMatch(confirmed.body, /4,000円/);
  assert.doesNotMatch(paymentLink.body, /利用料金/);
  assert.doesNotMatch(paymentLink.body, /4,000円/);
});

test('buildPendingMail: キーボックス番号・解錠コードを一切含まない（accessGuideを引数に取らない構造）', function () {
  var templates = loadTemplates();
  var mail = templates.buildPendingMail(sampleRecord(), CONFIG);
  assert.strictEqual(mail.body.indexOf('TEST-KEYBOX'), -1);
  assert.strictEqual(mail.body.indexOf('TEST-CODE'), -1);
  assert.strictEqual(typeof templates.buildPendingMail.length, 'number');
  assert.strictEqual(templates.buildPendingMail.length, 2, 'buildPendingMailはrecordとconfigの2引数のみを取る（accessGuideを受け取らない）');
});

/* ── カード決済の仮受付メール案内（Issue #334 PR-B「3. 仮受付メール」） ── */

test('buildPendingMail: カード決済のみ、Checkoutの決済ページでの支払い・有効期限内の決済成功で確定・期限切れ/未完了は確定しない旨を含み、旧24時間/72時間の案内を含まない（Issue #407）', function () {
  var templates = loadTemplates();
  var record = sampleRecord({
    paymentMethod: 'オンラインクレジットカード',
    createdAt: new Date('2026-09-28T10:00:00+09:00'),
    startAt: new Date('2026-10-05T10:00:00+09:00')
  });
  var config = Object.assign({}, CONFIG, { ttlConfig: { minHoursBeforeStart: 2 } });
  var mail = templates.buildPendingMail(record, config);

  assert.match(mail.body, /【クレジットカード決済のご案内】/);
  assert.match(mail.body, /予約申込後に表示される決済ページでお支払いください。/);
  assert.match(mail.body, /決済ページの有効期限内にお支払いが完了した場合に予約が確定します。期限切れ・決済未完了の場合、予約は確定しません。/);
  assert.match(mail.body, /改めて予約フォームからお申し込みください。/);
  assert.match(mail.body, /すでにお支払い済みの場合は、再申し込みや二重決済をせず、運営までご連絡ください。/);
  assert.doesNotMatch(mail.body, /24時間以内|72時間|お支払い期限：|決済リンクは/);
});

test('buildPendingMail: カード決済の受付メールは、決済未完了・続けて決済が必要・決済完了で自動確定・失効し得る旨を示し、仮受付・管理者確認待ちとは書かない（Issue #445）', function () {
  var templates = loadTemplates();
  var record = sampleRecord({
    paymentMethod: 'オンラインクレジットカード',
    createdAt: new Date('2026-09-28T10:00:00+09:00'),
    startAt: new Date('2026-10-05T10:00:00+09:00')
  });
  var config = Object.assign({}, CONFIG, { ttlConfig: { minHoursBeforeStart: 2 } });
  var mail = templates.buildPendingMail(record, config);

  assert.match(mail.subject, /予約申込を受け付けました（決済完了で確定）/);
  assert.doesNotMatch(mail.subject, /仮予約|未確定/);
  assert.match(mail.body, /お支払いが完了しておらず、ご予約はまだ確定しておりません/);
  assert.match(mail.body, /続けてオンライン決済を完了してください/);
  assert.match(mail.body, /お支払い完了後、ご予約は自動で確定します/);
  assert.match(mail.body, /決済を完了せずに時間が経過すると、ご予約が失効する場合があります/);
  assert.match(mail.body, /お支払い完了後、予約はすぐに確定します/);
  assert.doesNotMatch(mail.body, /仮受付|仮予約|管理者|当方で内容を確認|確定のご連絡を改めて/);
});

test('buildPendingMail: 現金・PayPay・未定は従来どおり仮受付→管理者確認→確定連絡の文言を維持する（Issue #445）', function () {
  ['現金', 'PayPay', '未定'].forEach(function (paymentMethod) {
    var templates = loadTemplates();
    var mail = templates.buildPendingMail(sampleRecord({ paymentMethod: paymentMethod }), CONFIG);
    assert.match(mail.subject, /仮予約を受け付けました（未確定）/, paymentMethod);
    assert.match(mail.body, /仮受付いたしました/, paymentMethod);
    assert.match(mail.body, /このメールの時点ではご予約はまだ確定しておりません。当方で内容を確認のうえ、確定のご連絡を改めてお送りします。/, paymentMethod);
    assert.doesNotMatch(mail.body, /管理者/, paymentMethod);
  });
});

test('buildPendingMail: 現金・PayPay・未定にはカード専用の注意書きが一切混入しない', function () {
  var templates = loadTemplates();
  ['現金', 'PayPay', '未定'].forEach(function (paymentMethod) {
    var templatesEach = loadTemplates();
    var record = sampleRecord({
      paymentMethod: paymentMethod,
      createdAt: new Date('2026-09-28T10:00:00+09:00')
    });
    var config = Object.assign({}, CONFIG, { ttlConfig: { minHoursBeforeStart: 2 } });
    var mail = templatesEach.buildPendingMail(record, config);
    assert.strictEqual(mail.body.indexOf('クレジットカード決済のご案内'), -1, paymentMethod + 'にカード案内が混入しないこと');
    assert.strictEqual(mail.body.indexOf('決済リンク'), -1, paymentMethod + 'に決済リンク文言が混入しないこと');
  });
});

test('buildPendingMail: カード決済でもcreatedAt/startAtが欠けていても例外を投げず、案内文を出す', function () {
  var templates = loadTemplates();
  var record = sampleRecord({ paymentMethod: 'オンラインクレジットカード', createdAt: undefined });
  var config = Object.assign({}, CONFIG, { ttlConfig: { minHoursBeforeStart: 2 } });
  var mail = templates.buildPendingMail(record, config);
  assert.match(mail.body, /【クレジットカード決済のご案内】/);
  assert.match(mail.body, /決済ページの有効期限内にお支払いが完了した場合に予約が確定します/);
});

test('buildConfirmedMail: 件名で予約確定が分かる', function () {
  var templates = loadTemplates();
  var mail = templates.buildConfirmedMail(sampleRecord(), CONFIG);
  assert.match(mail.subject, /確定/);
});

test('buildConfirmedMail: 必須内容を含み、来場詳細は前日案内で送る旨が書かれる。料金は含めない', function () {
  var templates = loadTemplates();
  var mail = templates.buildConfirmedMail(sampleRecord(), CONFIG);
  assert.match(mail.body, /SX-20261001-AAAAAAAA/);
  assert.match(mail.body, /2026-10-01/);
  assert.match(mail.body, /10:00/);
  assert.match(mail.body, /12:00/);
  assert.match(mail.body, /前日/);
  assert.strictEqual(mail.body.indexOf('料金'), -1, '現行Bookingsに確定料金列がないため料金を出さない');
});

test('buildConfirmedMail: 利用上の基本注意を含む（PRレビュー対応。Issue #271本文の必須内容）', function () {
  var templates = loadTemplates();
  var mail = templates.buildConfirmedMail(sampleRecord(), CONFIG);
  assert.match(mail.body, /原状回復/);
});

test('buildConfirmedMail: キーボックス番号・解錠コードを含まない（直後メールには来場秘密値を出さない）', function () {
  var templates = loadTemplates();
  var mail = templates.buildConfirmedMail(sampleRecord(), CONFIG);
  assert.strictEqual(mail.body.indexOf('TEST-KEYBOX'), -1);
  assert.strictEqual(mail.body.indexOf('TEST-CODE'), -1);
  assert.strictEqual(templates.buildConfirmedMail.length, 2);
});

test('buildCancelledMail: キャンセル済みであること・予約ID・元の利用日時・ブランドを含む', function () {
  var templates = loadTemplates();
  var mail = templates.buildCancelledMail(sampleRecord(), CONFIG);
  assert.match(mail.subject, /キャンセル/);
  assert.match(mail.body, /キャンセル/);
  assert.match(mail.body, /SX-20261001-AAAAAAAA/);
  assert.match(mail.body, /2026-10-01/);
  assert.match(mail.body, /Studio X/);
});

/*
 * buildExpiredMail（Issue #334: カード決済PENDING失効通知）。
 * 管理者キャンセル文面（buildCancelledMail）を流用せず、失効判定が「入金の自動検知」ではなく
 * 「管理者による承認の有無」であることを前提に、支払い済みの可能性を否定しない文言のみを
 * 使う（「未払いのため」「お支払いが確認できなかったため」のような、入金を自動確認したかの
 * ような断定表現を含めない）。
 */
test('buildExpiredMail: 件名/本文に「期限切れ」「要再申込み」が明記され、キャンセルメールの文面（buildCancelledMail）を流用しない', function () {
  var templates = loadTemplates();
  var mail = templates.buildExpiredMail(sampleRecord({ paymentMethod: 'オンラインクレジットカード' }), CONFIG);
  assert.match(mail.subject, /期限切れ/);
  assert.match(mail.body, /予約ページから再度お申し込み/);
  assert.doesNotMatch(mail.body, /下記のご予約はキャンセルされました/, 'buildCancelledMailの文面を流用してはいけない');
});

test('buildExpiredMail: 予約ID/利用日/開始/終了/ブランドを含み、再申込み案内と支払い済みの場合の連絡案内の両方を含む', function () {
  var templates = loadTemplates();
  var mail = templates.buildExpiredMail(sampleRecord({ paymentMethod: 'オンラインクレジットカード' }), CONFIG);
  assert.match(mail.body, /SX-20261001-AAAAAAAA/);
  assert.match(mail.body, /2026-10-01/);
  assert.match(mail.body, /10:00/);
  assert.match(mail.body, /12:00/);
  assert.match(mail.body, /Studio X/);
  assert.match(mail.body, /再度お申し込み/, '再申込みの案内を含むべき');
  assert.match(mail.body, /二重のお支払い/, '支払い済みの場合は運営へ連絡し、再申込み・二重決済をしない旨を含むべき');
  assert.match(mail.body, /contact@example\.com/);
});

test('buildExpiredMail: 入金の有無をシステムが自動確認したかのような断定表現を含まない（Issue #334本文の必須要件）', function () {
  var templates = loadTemplates();
  var mail = templates.buildExpiredMail(sampleRecord({ paymentMethod: 'オンラインクレジットカード' }), CONFIG);
  assert.doesNotMatch(mail.body, /お支払いが確認できなかった/);
  assert.doesNotMatch(mail.body, /未払いのため/);
  assert.doesNotMatch(mail.body, /入金が確認できません/);
});

test('buildExpiredMail: キーボックス番号・解錠コードを一切含まない（accessGuideを引数に取らない構造。buildPendingMail/buildConfirmedMailと同方針）', function () {
  var templates = loadTemplates();
  assert.strictEqual(templates.buildExpiredMail.length, 2);
});

/*
 * buildPaymentLinkMail（Issue #334 PR-C: Booking AdminからのStripe決済リンク送信）。
 * 管理者キャンセル・仮受付・確定・失効通知のいずれのテンプレートも流用しない専用テンプレート。
 */
var SAMPLE_PAYMENT_LINK_URL = 'https://buy.stripe.com/test_ABC123';

test('buildPaymentLinkMail: 予約者名/予約ID/利用日・開始・終了時刻/決済リンク/問い合わせ先を含む', function () {
  var templates = loadTemplates();
  var record = sampleRecord({ paymentMethod: 'オンラインクレジットカード' });
  var mail = templates.buildPaymentLinkMail(record, CONFIG, SAMPLE_PAYMENT_LINK_URL);
  assert.match(mail.body, /山田太郎/);
  assert.match(mail.body, /SX-20261001-AAAAAAAA/);
  assert.match(mail.body, /利用日: 2026-10-01（木）/);
  assert.match(mail.body, /10:00/);
  assert.match(mail.body, /12:00/);
  assert.match(mail.body, new RegExp(SAMPLE_PAYMENT_LINK_URL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(mail.body, /contact@example\.com/);
});

test('buildPaymentLinkMail: 実際の支払期限日時（Booking.computeCardPaymentDueMillis）を、Booking Admin表示・仮受付メールと同じ計算式で含む', function () {
  var templates = loadTemplates();
  var record = sampleRecord({
    paymentMethod: 'オンラインクレジットカード',
    createdAt: new Date('2026-09-28T10:00:00+09:00'),
    startAt: new Date('2026-10-05T10:00:00+09:00')
  });
  var config = Object.assign({}, CONFIG, { ttlConfig: { minHoursBeforeStart: 2 } });
  var mail = templates.buildPaymentLinkMail(record, config, SAMPLE_PAYMENT_LINK_URL);
  /* createdAt+72h = 2026-10-01 10:00（buildPendingMailの同条件テストと同じ計算結果）。 */
  assert.match(mail.body, /お支払い期限: 2026-10-01（木） 10:00/);
});

test('buildPaymentLinkMail: 期限内の支払い・確定連絡待ちの旨、および支払い済みで失効した場合は二重決済・再申し込みをせず運営へ連絡する旨を含む', function () {
  var templates = loadTemplates();
  var record = sampleRecord({ paymentMethod: 'オンラインクレジットカード' });
  var mail = templates.buildPaymentLinkMail(record, CONFIG, SAMPLE_PAYMENT_LINK_URL);
  assert.match(mail.body, /期限までにお支払いのうえ、予約確定のご連絡をお待ちください/);
  assert.match(mail.body, /このメールの送信のみでは予約は確定しておりません/);
  assert.match(mail.body, /自動的に失効/);
  assert.match(mail.body, /二重のお支払いをせず/);
});

test('buildPaymentLinkMail: 料金を一切表示しない（Issue #334本文の既存方針を維持。Issue #342で料金列を追加した後も変更しない）', function () {
  var templates = loadTemplates();
  var record = sampleRecord({ paymentMethod: 'オンラインクレジットカード' });
  var mail = templates.buildPaymentLinkMail(record, CONFIG, SAMPLE_PAYMENT_LINK_URL);
  assert.strictEqual(mail.body.indexOf('料金'), -1);
  assert.strictEqual(mail.body.indexOf('円'), -1);
});

test('buildPaymentLinkMail: createdAt/startAtが欠けている場合も例外を投げず、期限なしの文言で案内する', function () {
  var templates = loadTemplates();
  var record = sampleRecord({ paymentMethod: 'オンラインクレジットカード', createdAt: undefined });
  var mail = templates.buildPaymentLinkMail(record, CONFIG, SAMPLE_PAYMENT_LINK_URL);
  assert.match(mail.body, /お問い合わせください/);
});

test('buildPaymentLinkMail: キーボックス番号・解錠コードを一切含まない（accessGuideを引数に取らない構造。他の利用者向けテンプレートと同方針）', function () {
  var templates = loadTemplates();
  assert.strictEqual(templates.buildPaymentLinkMail.length, 3, 'buildPaymentLinkMailはrecord/config/paymentLinkUrlの3引数のみを取る');
});

/*
 * buildPriceUpdateMail（管理者による金額修正の利用者案内。PR #343レビュー対応）。
 * 表示する金額は必ずBooking.getEffectivePriceAmount（priceOverrideAmountがあれば優先）
 * 経由の値であることを検証する。
 */
test('buildPriceUpdateMail: 予約ID/氏名/利用日時/ブランド/修正後の金額（実効金額）/問い合わせ先を含み、「確定」という語は使わない', function () {
  var templates = loadTemplates();
  var record = sampleRecord({ priceAmount: 4000, priceOverrideAmount: 3500, priceOverrideAt: new Date('2026-09-30T12:00:00+09:00') });
  var mail = templates.buildPriceUpdateMail(record, CONFIG);
  assert.match(mail.subject, /訂正/);
  assert.match(mail.body, /SX-20261001-AAAAAAAA/);
  assert.match(mail.body, /山田太郎/);
  assert.match(mail.body, /2026-10-01/);
  assert.match(mail.body, /Studio X/);
  assert.match(mail.body, /訂正後の利用料金: 3,500円（税込）/);
  assert.match(mail.body, /contact@example\.com/);
  assert.match(mail.body, /まだ確定しておりません/, '予約確定前であることを明記するべき（buildPendingMailと同方針）');
});

test('buildPriceUpdateMail: 自動計算額（priceAmount）ではなく修正後の実効金額（priceOverrideAmount）を表示する', function () {
  var templates = loadTemplates();
  var record = sampleRecord({ priceAmount: 4000, priceOverrideAmount: 3500, priceOverrideAt: new Date('2026-09-30T12:00:00+09:00') });
  var mail = templates.buildPriceUpdateMail(record, CONFIG);
  assert.doesNotMatch(mail.body, /4,000円/);
});

test('buildPriceUpdateMail: 予約確定前であることを明記する', function () {
  var templates = loadTemplates();
  var record = sampleRecord({ priceAmount: 4000, priceOverrideAmount: 3500, priceOverrideAt: new Date('2026-09-30T12:00:00+09:00') });
  var mail = templates.buildPriceUpdateMail(record, CONFIG);
  assert.match(mail.body, /まだ確定しておりません/);
});

test('buildPriceUpdateMail: 案内できる金額が一切ない（priceAmount/priceOverrideAmountともに未設定）場合は例外を投げる（呼び出し側でfail-closedに扱わせる）', function () {
  var templates = loadTemplates();
  var record = sampleRecord({});
  assert.throws(function () { templates.buildPriceUpdateMail(record, CONFIG); });
});

test('buildPriceUpdateMail: priceOverrideAtが空でもpriceAmount（自動計算値）があれば、それを実効金額として表示する（「修正があること」自体の必須チェックはBookingMailer側の責務）', function () {
  var templates = loadTemplates();
  var record = sampleRecord({ priceAmount: 4000 });
  var mail = templates.buildPriceUpdateMail(record, CONFIG);
  assert.match(mail.body, /4,000円（税込）/);
});

test('buildPriceUpdateMail: キーボックス番号・解錠コードを一切含まない（accessGuideを引数に取らない構造。他の利用者向けテンプレートと同方針）', function () {
  var templates = loadTemplates();
  assert.strictEqual(templates.buildPriceUpdateMail.length, 2, 'buildPriceUpdateMailはrecordとconfigの2引数のみを取る');
});

test('buildReminderMail: 「明日」の案内であることが分かり、来場方法一式を含む', function () {
  var templates = loadTemplates();
  var mail = templates.buildReminderMail(sampleRecord(), CONFIG, DUMMY_ACCESS_GUIDE);
  assert.match(mail.body, /明日/);
  assert.match(mail.body, /SX-20261001-AAAAAAAA/);
  assert.ok(mail.body.indexOf(DUMMY_ACCESS_GUIDE.address) !== -1);
  assert.match(mail.body, /テストビル/);
  assert.match(mail.body, /101/);
  assert.match(mail.body, /正面入口/);
  assert.match(mail.body, /玄関脇/);
  assert.match(mail.body, /入室方法/);
  assert.match(mail.body, /how-to/);
  assert.match(mail.body, /guide\.pdf/);
});

test('buildReminderMail: 当日送信（利用日 === 送信日）は「本日」の件名・本文になる（Issue #420）', function () {
  var templates = loadTemplates();
  var mail = templates.buildReminderMail(sampleRecord(), CONFIG, DUMMY_ACCESS_GUIDE, { now: new Date('2026-10-01T09:00:00+09:00') });
  assert.match(mail.subject, /^【Studio X】本日のご利用案内$/);
  assert.match(mail.body, /本日のご予約について、来場方法をご案内します。/);
  assert.strictEqual(mail.body.indexOf('明日'), -1);
});

test('buildReminderMail: 前日送信（18時台・19時以降・21時catch-up）は「明日」の件名・本文になる（Issue #420）', function () {
  var templates = loadTemplates();
  ['2026-09-30T18:00:00+09:00', '2026-09-30T19:30:00+09:00', '2026-09-30T21:00:00+09:00'].forEach(function (iso) {
    var mail = templates.buildReminderMail(sampleRecord(), CONFIG, DUMMY_ACCESS_GUIDE, { now: new Date(iso) });
    assert.match(mail.subject, /^【Studio X】明日のご利用案内$/, iso);
    assert.match(mail.body, /明日のご予約について、来場方法をご案内します。/, iso);
    assert.strictEqual(mail.body.indexOf('本日'), -1, iso);
  });
});

test('buildReminderMail: JST日付境界はconfig.timezone基準で判定する（UTCでは前日でもJSTでは当日）', function () {
  var templates = loadTemplates();
  /* 2026-09-30T15:30Z = JST 2026-10-01 00:30。UTC日付は9/30だがJSTでは利用日当日。 */
  var justAfterMidnight = templates.buildReminderMail(sampleRecord(), CONFIG, DUMMY_ACCESS_GUIDE, { now: new Date('2026-09-30T15:30:00Z') });
  assert.match(justAfterMidnight.subject, /本日のご利用案内/);
  /* 2026-09-30T14:59Z = JST 2026-09-30 23:59。まだ前日。 */
  var justBeforeMidnight = templates.buildReminderMail(sampleRecord(), CONFIG, DUMMY_ACCESS_GUIDE, { now: new Date('2026-09-30T14:59:00Z') });
  assert.match(justBeforeMidnight.subject, /明日のご利用案内/);
});

test('buildReminderMail: record.dateがDate値でも同じ判定になり、SNB / SNB mens / Studio Xで同じ挙動（Issue #420）', function () {
  var templates = loadTemplates();
  var now = new Date('2026-10-01T09:00:00+09:00');
  ['snb', 'mens', 'studio_x'].forEach(function (brand) {
    var same = templates.buildReminderMail(sampleRecord({ brand: brand, date: new Date('2026-10-01T00:00:00+09:00') }), CONFIG, DUMMY_ACCESS_GUIDE, { now: now });
    assert.match(same.subject, /本日のご利用案内/, brand);
    var next = templates.buildReminderMail(sampleRecord({ brand: brand, date: '2026-10-02' }), CONFIG, DUMMY_ACCESS_GUIDE, { now: now });
    assert.match(next.subject, /明日のご利用案内/, brand);
  });
});

test('buildReminderMail: ダミーのキーボックス番号・解錠コードが含まれる（実秘密値はテストで使わない）', function () {
  var templates = loadTemplates();
  var mail = templates.buildReminderMail(sampleRecord(), CONFIG, DUMMY_ACCESS_GUIDE);
  assert.match(mail.body, /TEST-KEYBOX/);
  assert.match(mail.body, /TEST-CODE/);
});

test('buildReminderMail: 秘密値が未設定の場合はプレースホルダを出す（値の要否判定・成功可否はBookingMailer側の責務）', function () {
  var templates = loadTemplates();
  var mail = templates.buildReminderMail(sampleRecord(), CONFIG, { address: '住所のみ設定' });
  assert.match(mail.body, /未設定/);
  assert.strictEqual(mail.body.indexOf('TEST-KEYBOX'), -1);
});

test('brandラベル: snb/mens/studio_xで同じロジックを使い、表示名だけが変わる（3ブランドのコピー実装を作らない）', function () {
  var templates = loadTemplates();
  var expectedLabels = { snb: 'SNB', mens: 'SNB mens', studio_x: 'Studio X' };
  Object.keys(expectedLabels).forEach(function (brand) {
    var record = sampleRecord({ brand: brand, bookingId: brand + '-BOOKING' });
    var pending = templates.buildPendingMail(record, CONFIG);
    var confirmed = templates.buildConfirmedMail(record, CONFIG);
    var cancelled = templates.buildCancelledMail(record, CONFIG);
    var reminder = templates.buildReminderMail(record, CONFIG, DUMMY_ACCESS_GUIDE);
    [pending, confirmed, cancelled, reminder].forEach(function (mail) {
      assert.match(mail.subject + mail.body, new RegExp(expectedLabels[brand].replace(/ /g, '\\s')), brand);
    });
  });
});

/*
 * 利用日の曜日表示（Issue #311）。BookingAvailability.formatDateWithWeekday（Availability.gs）
 * を共通で使い、'YYYY-MM-DD（曜）'形式で表示することを、利用者向け4テンプレート
 * （仮予約受付・予約確定・キャンセル・前日リマインド）すべてで確認する。
 * sampleRecord()の既定date '2026-10-01' は木曜日。
 */
test('利用日の曜日表示: buildPendingMail/buildConfirmedMail/buildCancelledMail/buildReminderMailすべてで利用日に曜日が付く', function () {
  var templates = loadTemplates();
  var record = sampleRecord();

  var pending = templates.buildPendingMail(record, CONFIG);
  var confirmed = templates.buildConfirmedMail(record, CONFIG);
  var cancelled = templates.buildCancelledMail(record, CONFIG);
  var reminder = templates.buildReminderMail(record, CONFIG, DUMMY_ACCESS_GUIDE);

  [pending, confirmed, cancelled, reminder].forEach(function (mail) {
    assert.match(mail.body, /利用日: 2026-10-01（木）/);
  });
});

test('利用日の曜日表示: 別の曜日（2026-10-05は月曜日）でも正しく表示される', function () {
  var templates = loadTemplates();
  var record = sampleRecord({ date: '2026-10-05' });

  var mail = templates.buildConfirmedMail(record, CONFIG);
  assert.match(mail.body, /利用日: 2026-10-05（月）/);
});

/*
 * ============================================================================
 * Issue #422: SNB / SNB mens / Studio X の案内メール分離
 * ============================================================================
 */
var BRAND_CASES = [
  { brand: 'snb', label: 'SNB', path: '/Studio-nagoya-base/booking/', guide: '/Studio-nagoya-base/how-to/', signature: 'Studio Nagoya Base' },
  { brand: 'mens', label: 'SNB mens', path: '/mens/booking/', guide: '/mens/how-to/', signature: 'SNB mens（Studio Nagoya Base）' },
  { brand: 'studio_x', label: 'Studio X', path: '/studio-x/booking/', guide: '/studio-x/how-to/', signature: 'Studio X' }
];
var ALL_BUILDERS_ = {
  buildPendingMail: function (t, r) { return t.buildPendingMail(r, CONFIG); },
  buildConfirmedMail: function (t, r) { return t.buildConfirmedMail(r, CONFIG); },
  buildCancelledMail: function (t, r) { return t.buildCancelledMail(r, CONFIG); },
  buildExpiredMail: function (t, r) { return t.buildExpiredMail(r, CONFIG); },
  buildReminderMail: function (t, r) { return t.buildReminderMail(r, CONFIG, DUMMY_ACCESS_GUIDE, { now: new Date('2026-09-30T18:00:00+09:00') }); },
  buildPaymentLinkMail: function (t, r) { return t.buildPaymentLinkMail(r, CONFIG, 'https://buy.stripe.com/test_abc'); },
  buildPriceUpdateMail: function (t, r) { return t.buildPriceUpdateMail(r, CONFIG); },
  buildRefundedMail: function (t, r) { return t.buildRefundedMail(r, CONFIG); }
};

BRAND_CASES.forEach(function (c) {
  Object.keys(ALL_BUILDERS_).forEach(function (name) {
    test('Issue #422: ' + name + ' は ' + c.brand + ' の署名・ブランド名を出し、共通予約情報を欠落させない', function () {
      var t = loadTemplates();
      var record = sampleRecord({ brand: c.brand, priceAmount: 8000, refundAmount: 4000 });
      var mail = ALL_BUILDERS_[name](t, record);
      var text = mail.subject + '\n' + mail.body;
      assert.ok(mail.subject.indexOf('【' + c.label + '】') === 0, mail.subject);
      assert.ok(mail.body.indexOf('--\n' + c.signature) !== -1, '署名: ' + c.signature);
      assert.match(mail.body, /SX-20261001-AAAAAAAA/);
      assert.match(mail.body, /山田太郎/);
      assert.match(mail.body, /contact@example\.com/);
      /* 他ブランドの案内先URL・署名を混入させない */
      BRAND_CASES.filter(function (o) { return o.brand !== c.brand; }).forEach(function (o) {
        if (o.brand !== 'snb') {
          assert.ok(text.indexOf(o.path) === -1, o.brand + 'のURLが混入: ' + name);
        }
      });
    });
  });
});

test('Issue #422: Studio XのメールにSNB / mens / 緊縛の表現・リンクを含めない', function () {
  var t = loadTemplates();
  var record = sampleRecord({ brand: 'studio_x', priceAmount: 8000, refundAmount: 4000, paymentMethod: 'オンラインクレジットカード' });
  Object.keys(ALL_BUILDERS_).forEach(function (name) {
    var mail = ALL_BUILDERS_[name](t, record);
    var text = mail.subject + '\n' + mail.body;
    assert.ok(!/緊縛|SNB|Studio Nagoya Base|\/mens\//.test(text), name + ': ' + text);
    assert.ok(!/nagoya-base\.github\.io\/Studio-nagoya-base\/(booking|how-to)\//.test(text), name + ': SNB向けURL');
  });
});

test('Issue #422: キャンセル・失効メールは各ブランドの予約ページへ誘導する', function () {
  var t = loadTemplates();
  var expected = {
    snb: 'https://nagoya-base.github.io/Studio-nagoya-base/booking/',
    mens: 'https://nagoya-base.github.io/Studio-nagoya-base/mens/booking/',
    studio_x: 'https://nagoya-base.github.io/Studio-nagoya-base/studio-x/booking/'
  };
  Object.keys(expected).forEach(function (brand) {
    var record = sampleRecord({ brand: brand });
    assert.ok(t.buildCancelledMail(record, CONFIG).body.indexOf('再度のご予約はこちら: ' + expected[brand]) !== -1);
    assert.ok(t.buildExpiredMail(record, CONFIG).body.indexOf('再度のご予約はこちら: ' + expected[brand]) !== -1);
  });
});

test('Issue #422: 仮予約・確定メールは各ブランドの利用案内URLを出す', function () {
  var t = loadTemplates();
  var expected = {
    snb: 'https://nagoya-base.github.io/Studio-nagoya-base/how-to/',
    mens: 'https://nagoya-base.github.io/Studio-nagoya-base/mens/how-to/',
    studio_x: 'https://nagoya-base.github.io/Studio-nagoya-base/studio-x/how-to/'
  };
  Object.keys(expected).forEach(function (brand) {
    var record = sampleRecord({ brand: brand });
    assert.ok(t.buildPendingMail(record, CONFIG).body.indexOf('ご利用案内: ' + expected[brand]) !== -1);
    assert.ok(t.buildConfirmedMail(record, CONFIG).body.indexOf('ご利用案内: ' + expected[brand]) !== -1);
  });
});

test('Issue #422: 前日リマインドの利用案内ページ — SNBは従来のACCESS_GUIDE_URL優先、mens/Studio Xはブランド別URL', function () {
  var t = loadTemplates();
  var opts = { now: new Date('2026-09-30T18:00:00+09:00') };
  var snb = t.buildReminderMail(sampleRecord({ brand: 'snb' }), CONFIG, DUMMY_ACCESS_GUIDE, opts);
  assert.ok(snb.body.indexOf('利用案内ページ: https://example.com/how-to') !== -1);
  var mens = t.buildReminderMail(sampleRecord({ brand: 'mens' }), CONFIG, DUMMY_ACCESS_GUIDE, opts);
  assert.ok(mens.body.indexOf('利用案内ページ: https://nagoya-base.github.io/Studio-nagoya-base/mens/how-to/') !== -1);
  var sx = t.buildReminderMail(sampleRecord({ brand: 'studio_x' }), CONFIG, DUMMY_ACCESS_GUIDE, opts);
  assert.ok(sx.body.indexOf('利用案内ページ: https://nagoya-base.github.io/Studio-nagoya-base/studio-x/how-to/') !== -1);
  assert.ok(sx.body.indexOf('example.com/how-to') === -1);
});

test('Issue #422: brandが空の既存予約データはSNB扱いでメールを組み立てられる（後方互換）', function () {
  var t = loadTemplates();
  var mail = t.buildPendingMail(sampleRecord({ brand: '' }), CONFIG);
  assert.ok(mail.body.indexOf('--\nStudio Nagoya Base') !== -1);
  assert.match(mail.body, /SX-20261001-AAAAAAAA/);
});

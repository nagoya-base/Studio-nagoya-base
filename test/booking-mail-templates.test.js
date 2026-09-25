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

test('buildPendingMail: キーボックス番号・解錠コードを一切含まない（accessGuideを引数に取らない構造）', function () {
  var templates = loadTemplates();
  var mail = templates.buildPendingMail(sampleRecord(), CONFIG);
  assert.strictEqual(mail.body.indexOf('TEST-KEYBOX'), -1);
  assert.strictEqual(mail.body.indexOf('TEST-CODE'), -1);
  assert.strictEqual(typeof templates.buildPendingMail.length, 'number');
  assert.strictEqual(templates.buildPendingMail.length, 2, 'buildPendingMailはrecordとconfigの2引数のみを取る（accessGuideを受け取らない）');
});

/* ── カード決済の仮受付メール案内（Issue #334 PR-B「3. 仮受付メール」） ── */

test('buildPendingMail: カード決済のみ、決済リンクの送信予定・実際の支払期限日時・自動失効・再申し込み方法を含む', function () {
  var templates = loadTemplates();
  var record = sampleRecord({
    paymentMethod: 'オンラインクレジットカード',
    createdAt: new Date('2026-09-28T10:00:00+09:00'),
    startAt: new Date('2026-10-05T10:00:00+09:00')
  });
  var config = Object.assign({}, CONFIG, { ttlConfig: { minHoursBeforeStart: 2 } });
  var mail = templates.buildPendingMail(record, config);

  assert.match(mail.body, /【クレジットカード決済のご案内】/);
  assert.match(mail.body, /決済リンクは、お申し込みから24時間以内にメールでお送りします。/);
  /* 支払期限はBooking.computeCardPaymentDueMillis（createdAt+72時間。利用開始2時間前の
     上限には掛からない）に基づく実際の日時が入る。フォーム上の「目安」表示
     （scripts/booking-logic.jsのcardPaymentDueDisplay）とは別に、ここでは必ず
     createdAt/startAtから計算したサーバー側の値を使う。 */
  assert.match(mail.body, /お支払い期限：お申し込みから72時間後（2026-10-01（木） 10:00）/);
  assert.match(mail.body, /期限までに予約が確定しなかった場合は、予約が自動的に失効します。/);
  assert.match(mail.body, /改めて予約フォームからお申し込みください。/);
  assert.match(mail.body, /すでにお支払い済みの場合は、再申し込みや二重決済をせず、運営までご連絡ください。/);
});

test('buildPendingMail: カード決済の注意書きは、冒頭の既存仮受付案内と重複する「仮受付です」の行を含まない（重複整理）', function () {
  var templates = loadTemplates();
  var record = sampleRecord({
    paymentMethod: 'オンラインクレジットカード',
    createdAt: new Date('2026-09-28T10:00:00+09:00'),
    startAt: new Date('2026-10-05T10:00:00+09:00')
  });
  var config = Object.assign({}, CONFIG, { ttlConfig: { minHoursBeforeStart: 2 } });
  var mail = templates.buildPendingMail(record, config);

  /* 冒頭の既存案内（「このメールの時点では…」）は残る */
  assert.match(mail.body, /このメールの時点ではご予約はまだ確定しておりません/);
  /* カード注意書き側の末尾「仮受付です」の重複行は出さない */
  var occurrences = (mail.body.match(/仮受付/g) || []).length;
  assert.strictEqual(occurrences, 1, '「仮受付」を含む文言は冒頭の既存案内1回のみであるべき');
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

test('buildPendingMail: カード決済でもcreatedAt/startAtが欠けている場合は例外を投げず、括弧内の日時なしで案内文だけ出す', function () {
  var templates = loadTemplates();
  var record = sampleRecord({ paymentMethod: 'オンラインクレジットカード', createdAt: undefined });
  var config = Object.assign({}, CONFIG, { ttlConfig: { minHoursBeforeStart: 2 } });
  var mail = templates.buildPendingMail(record, config);
  assert.match(mail.body, /【クレジットカード決済のご案内】/);
  assert.match(mail.body, /お支払い期限：お申し込みから72時間後/);
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

test('buildPaymentLinkMail: 料金を一切表示しない（Bookings台帳に確定料金列がないため）', function () {
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

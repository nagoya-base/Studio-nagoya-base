/*
 * Issue #472: 会員制度（SNB MEMBER・2026/12/1開始）のWeb表示・規約/特商法・FAQ・Studio X会員限定スタッフ対応。
 *
 * 画面に載せる料金が料金ロジック（BookingPricing.gs。#470）と一致すること、会員条件の文言が
 * 会員案内ページ・利用規約・特商法・FAQで矛盾しないこと、禁止表現（1時間で元が取れる等）が無いこと、
 * Studio Xの機材料金・スタッフ料金が正本（_data/studio_x_equipment.json）と一致することを静的に検証する。
 * 料金計算・Stripe・会員台帳のロジックは対象外（変更しない）。
 */
'use strict';

var test = require('node:test');
var assert = require('node:assert');
var fs = require('node:fs');
var path = require('node:path');
var loadBookingSandbox = require('./helpers/gas-sandbox').loadBookingSandbox;
var loadFrontendSandbox = require('./helpers/frontend-sandbox').loadFrontendSandbox;

var ROOT = path.join(__dirname, '..');
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }
function textOf(html) {
  return html.replace(/<!--[\s\S]*?-->/g, '').replace(/\{%-?[\s\S]*?-?%\}/g, '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').replace(/ ?([^\x00-\x7f]) ?/g, '$1').trim();
}
function stripComments(html) { return html.replace(/<!--[\s\S]*?-->/g, '').replace(/\{%-?\s*comment\s*-?%\}[\s\S]*?\{%-?\s*endcomment\s*-?%\}/g, ''); }

var Pricing = loadBookingSandbox(['JapaneseHolidays.gs', 'BookingPricing.gs'], {}).BookingPricing;
var WEEKDAY = '2026-12-07'; /* 月曜 */
var WEEKEND = '2026-12-05'; /* 土曜 */
function yen(n) { return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',') + '円'; }
function price(brand, date, hours, isMember, generation) {
  var r = Pricing.computeBookingPrice({ brand: brand, date: date, durationMinutes: hours * 60, isMember: isMember, generation: generation });
  assert.strictEqual(r.valid, true);
  return r.price.amount;
}

/* index.html 等の「pricing-card」から、ヘッダー文言で表を取り出す（列順: 時間 / 土日祝 / 平日）。 */
function tableByHeader(html, headerPart) {
  var re = /<div class="pricing-card-header">([^<]*)<\/div>\s*<table>([\s\S]*?)<\/table>/g;
  var m;
  while ((m = re.exec(html))) {
    if (m[1].indexOf(headerPart) === -1) continue;
    var rows = {};
    var rowRe = /<tr[^>]*>\s*<td>([^<]*)(?:<span[^>]*>[^<]*<\/span>)?<\/td>\s*<td>([^<]*)<\/td>\s*<td>([^<]*)<\/td>/g;
    var r;
    while ((r = rowRe.exec(m[2]))) rows[r[1].trim()] = { weekend: r[2].trim(), weekday: r[3].trim() };
    return rows;
  }
  throw new Error('料金表が見つからない: ' + headerPart);
}
var LABELS = { 1: '1時間', 2: '2時間', 3: '3時間', 4: '4時間' };

test('SNB: 一般料金は現行料金のまま（値上げなし）で、料金ロジックV2（2026/12/1以降）と一致する', function () {
  var t = tableByHeader(read('index.html'), '通常価格');
  var expected = { '1時間': ['2,000円', '2,500円'], '2時間': ['4,000円', '5,000円'], '3時間': ['6,000円', '7,500円'], '4時間': ['8,000円', '10,000円'], '延長（1h）': ['2,000円', '2,500円'] };
  Object.keys(expected).forEach(function (k) {
    assert.deepStrictEqual([t[k].weekday, t[k].weekend], expected[k], k);
  });
  [1, 2, 3, 4].forEach(function (h) {
    assert.strictEqual(t[LABELS[h]].weekday, yen(price('snb', WEEKDAY, h, false, 'V2')), h + 'h 平日');
    assert.strictEqual(t[LABELS[h]].weekend, yen(price('snb', WEEKEND, h, false, 'V2')), h + 'h 土日祝');
    /* 2026/12/1以降の一般料金は、それ以前（V1）と同額＝値上げしていない */
    assert.strictEqual(price('snb', WEEKDAY, h, false, 'V2'), price('snb', WEEKDAY, h, false, 'V1'));
    assert.strictEqual(price('snb', WEEKEND, h, false, 'V2'), price('snb', WEEKEND, h, false, 'V1'));
  });
  assert.strictEqual(t['延長（1h）'].weekday, yen(price('snb', WEEKDAY, 5, false, 'V2') - price('snb', WEEKDAY, 4, false, 'V2')));
  assert.strictEqual(t['延長（1h）'].weekend, yen(price('snb', WEEKEND, 5, false, 'V2') - price('snb', WEEKEND, 4, false, 'V2')));
});

test('SNB: SNB MEMBER料金の表が料金ロジックと一致する（現行会員料金のまま）', function () {
  var t = tableByHeader(read('index.html'), 'SNB MEMBER料金');
  [1, 2, 3, 4].forEach(function (h) {
    assert.strictEqual(t[LABELS[h]].weekday, yen(price('snb', WEEKDAY, h, true, 'V2')));
    assert.strictEqual(t[LABELS[h]].weekend, yen(price('snb', WEEKEND, h, true, 'V2')));
  });
  assert.deepStrictEqual([t['3時間'].weekday, t['3時間'].weekend, t['4時間'].weekday, t['4時間'].weekend], ['5,500円', '7,000円', '7,000円', '9,000円']);
  assert.strictEqual(t['延長（1h）'].weekday, yen(price('snb', WEEKDAY, 5, true, 'V2') - price('snb', WEEKDAY, 4, true, 'V2')));
  assert.strictEqual(t['延長（1h）'].weekend, yen(price('snb', WEEKEND, 5, true, 'V2') - price('snb', WEEKEND, 4, true, 'V2')));
});

test('SNB: 会員案内ページの比較表（一般/会員/差額）が料金ロジックと一致し、3時間以上で割引・3時間で月会費相当・4時間で1,000円の差額になる', function () {
  var html = read('membership/index.html');
  var rows = {};
  var re = /<tr[^>]*><td>([^<]*)<\/td><td>([^<]*)<\/td><td>([^<]*)<\/td><td>([^<]*)<\/td><td>([^<]*)<\/td><td>([^<]*)<\/td><\/tr>/g;
  var m;
  while ((m = re.exec(html))) rows[m[1]] = m.slice(2);
  [1, 2, 3, 4].forEach(function (h) {
    var wdG = price('snb', WEEKDAY, h, false, 'V2'), wdM = price('snb', WEEKDAY, h, true, 'V2');
    var weG = price('snb', WEEKEND, h, false, 'V2'), weM = price('snb', WEEKEND, h, true, 'V2');
    assert.deepStrictEqual(rows[LABELS[h]], [yen(wdG), yen(wdM), yen(weG), yen(weM), yen(wdG - wdM)], h + '時間');
    assert.strictEqual(wdG - wdM, weG - weM, '平日と土日祝で差額が同じ');
    if (h >= 3) assert.ok(wdG - wdM > 0, h + '時間は会員料金の方が安い');
    else assert.strictEqual(wdG - wdM, 0, h + '時間は一般料金と同額');
  });
  assert.strictEqual(price('snb', WEEKDAY, 4, false, 'V2') - price('snb', WEEKDAY, 4, true, 'V2'), 1000, '4時間の差額は1,000円（月会費500円の2倍）');
  assert.strictEqual(price('snb', WEEKDAY, 3, false, 'V2') - price('snb', WEEKDAY, 3, true, 'V2'), 500, '3時間の差額は月会費500円相当');
  assert.strictEqual(price('snb', WEEKEND, 4, false, 'V2') - price('snb', WEEKEND, 4, true, 'V2'), 1000);
  assert.deepStrictEqual(rows['4時間'][4], '1,000円');
});

test('SNB: 会員訴求は「3時間以上で割引」「3時間で月会費相当」。旧「2時間以上で会費相当以上」・値上げ・過剰表現が無い', function () {
  var pages = ['index.html', 'membership/index.html', 'legal/index.html', '_includes/legal_ja.html', 'mens/index.html', 'en.html', 'legal/en.html', '_data/news_ja.yml'];
  pages.forEach(function (p) {
    var t = textOf(read(p));
    assert.ok(!/2時間以上(の(ご)?利用)?(なら|で)[^。]*(会費|差額)/.test(t.replace(/「2時間以上で会費相当以上の差額」[^。]*/g, '')), p + ' に旧「2時間以上で会費相当」');
    assert.ok(!/1回で元が取れ|1時間で元が取れ|必ず(お)?得|必ず元が取れ/.test(t), p + ' に過剰表現');
    assert.ok(!/値上げ|料金改定|一般料金を改定|一般料金が(上がり|変わり)/.test(t.replace(/Pricing revisions/g, '')), p + ' に値上げ・改定の表示');
    assert.ok(!/(安く(使う|利用)|お得に(使う|利用)|割引を受ける)(ため|なら|には)[^。]*(会員(に)?(なって|加入|登録)|ご加入)/.test(t), p + ' に加入を促しすぎる表現');
  });
  var idx = textOf(read('index.html'));
  assert.ok(idx.indexOf('3時間以上のご利用で一般料金より安く') !== -1);
  assert.ok(idx.indexOf('3時間のご利用で、一般料金との差額が月会費500円相当') !== -1);
  assert.ok(idx.indexOf('継続・長時間ご利用の方向けの優遇制度') !== -1);
  var m = textOf(read('membership/index.html'));
  assert.ok(m.indexOf('3時間以上のご利用で、会員料金は一般料金より安くなります') !== -1);
  assert.ok(m.indexOf('3時間のご利用で、一般料金との差額が月会費（500円）相当') !== -1);
  var faq = textOf(read('how-to/index.html'));
  assert.ok(faq.indexOf('3時間以上のご利用で一般料金より安くなり、3時間のご利用で一般料金との差額が月会費500円相当') !== -1);
});

test('SNB: 加入前に「月額500円」「入会日基準の自動更新」「日割りなし」を表示し、同意のうえ既存の入会APIへ接続する（決済URL固定なし）', function () {
  var html = read('membership/index.html');
  var form = html.slice(html.indexOf('class="membership-summary"'), html.indexOf('</form>'));
  var t = textOf(form);
  ['月額500円', '入会日を基準に毎月自動更新', '入会日から1か月有効', '日割りなし', '日割りでの返金はありません'].forEach(function (w) { assert.ok(t.indexOf(w) !== -1, '入会前の表示に「' + w + '」'); });
  assert.match(form, /id="membership-consent"[^>]*required/, '同意チェック必須');
  assert.ok(!/stripe\.com|buy\.stripe|checkout\.stripe/.test(html + read('scripts/membership-join.js')), 'Checkout URLを固定記載しない');
  var js = read('scripts/membership-join.js');
  assert.ok(js.indexOf('action=startMembershipCheckout') !== -1 && js.indexOf('JSON.stringify({ email: email, brand: brand })') !== -1, '金額・会員判定をフロントで持たず、メールのみ既存APIへ送る');
});

test('SNB: 会員加入CTAがあり、会員案内ページへ接続し、初回利用者から加入可・旧会員は自動移行しないと案内する', function () {
  var idx = read('index.html');
  assert.match(idx, /id="snb-member"[\s\S]*?href="\{\{ '\/membership\/' \| relative_url \}\}"[^>]*>SNB MEMBERの内容を見て加入する/);
  var snb = textOf(idx);
  /* 契約条件の詳細は #610 で会員案内ページ（membership_terms）へ集約 */
  var terms = textOf(read('membership/index.html') + read('_includes/membership_terms_ja.html'));
  assert.ok(terms.indexOf('初めてご利用の方も') !== -1);
  assert.ok(terms.indexOf('自動では移行しません') !== -1);
  assert.ok(!/自動(的)?に(SNB MEMBER|会員)へ(移行|引き継)/.test(snb) && !/自動で(SNB MEMBER|会員)へ(移行|引き継)/.test(snb));
  var form = read('membership/index.html');
  assert.match(form, /id="membership-join-form"/);
  assert.match(form, /type="email"/);
  assert.match(form, /scripts\/membership-join\.js/);
});

test('会員条件: 会員案内ページ・利用規約・特商法・FAQが同じ必須項目を明記し、旧制度の記述が残っていない', function () {
  var terms = textOf(read('_includes/membership_terms_ja.html'));
  assert.ok(terms.indexOf('プレスタート') === -1, '実在しない既存プレスタート会員向けの例外を案内しない（Issue #592）');
  [
    ['月額500円', '月額500円'], ['Stripe', 'Stripe'], ['入会日基準の自動更新', '入会日を基準に毎月自動更新'], ['入会日から1か月有効', '入会日から1か月間、会員資格が有効'], ['日割りなし', '日割りはありません'],
    ['日割り返金なし', '日割りを含め返金しません'], ['解約方法', '予約フォーム'], ['解約後', '支払い済みの期間の末日'],
    ['決済失敗', '猶予期間なく'], ['初回利用者', '初めてご利用の方も'], ['自動移行しない', '自動では移行しません']
  ].forEach(function (c) { assert.ok(terms.indexOf(c[1]) !== -1, '会員条件に「' + c[0] + '」が必要'); });

  var legal = read('_includes/legal_ja.html');
  assert.ok(legal.indexOf("{% include membership_terms_ja.html %}") !== -1, '利用規約が共通の会員条件を参照');
  assert.ok(read('membership/index.html').indexOf("{% include membership_terms_ja.html %}") !== -1, '会員案内が共通の会員条件を参照');
  var law = legal.slice(legal.indexOf('特定商取引法に基づく表記'));
  var lawText = textOf(law);
  ['月額500円', '入会日を基準に毎月自動更新', 'Stripe', '日割りなしで入会日から1か月有効', '解約', 'お支払い済みの期間の末日まで', '日割りを含め返金しません', '失敗した更新分', '初めてご利用の方から加入できます', '自動では移行しません']
    .forEach(function (w) { assert.ok(lawText.indexOf(w) !== -1, '特商法表記に「' + w + '」が必要'); });

  /* トップのFAQは#594で4問に絞った。会員のFAQ全件は how-to/index.html（FAQ正本, #612）に保持する */
  ['how-to/index.html'].forEach(function (p) {
    var t = textOf(read(p));
    ['月額500円', 'Stripe', '入会日を基準に毎月自動更新', '日割りはありません', '解約', '返金しません', '更新時の決済に失敗した場合', '初めてご利用の方も加入できます', '自動では移行しない']
      .forEach(function (w) { assert.ok(t.indexOf(w) !== -1, p + ' のFAQに「' + w + '」が必要'); });
  });

  /* 旧制度（利用実績による継続・失効・復帰、運営者の承認制）が公開ページに残っていない */
  ['index.html', 'legal/index.html', 'mens/index.html', 'mens/legal/index.html', 'membership/index.html', '_includes/legal_ja.html',
   '_includes/reservation_form_ja.html', '_includes/booking_app_ja.html', 'mens/how-to/index.html', 'mens/booking/index.html'].forEach(function (p) {
    var t = textOf(stripComments(read(p)));
    assert.ok(!/前月に1回以上の利用実績|前月の利用実績が0件|入会審査の対象|当施設が承認した(会員|継続利用者)|承認した会員のみ/.test(t) || p === '_includes/booking_app_ja.html', p + ' に旧会員制度の記述');
    assert.ok(!/メンズページを見た/.test(t), p + ' に旧申告制の記述');
  });
});

test('FAQのJSON-LDと表示が一致する（SNB MEMBER項目。トップは#594で4問に絞ったため全件の規約ページで検査）', function () {
  ['how-to/index.html'].forEach(function (p) {
    var html = read(p);
    var ld = null;
    html.replace(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g, function (_, body) {
      var parsed = JSON.parse(body);
      if (parsed['@type'] === 'FAQPage') ld = parsed;
      return '';
    });
    assert.ok(ld, p + ' にFAQPageのJSON-LD');
    var q = ld.mainEntity.filter(function (e) { return /SNB MEMBER/.test(e.name); });
    assert.strictEqual(q.length, 3, p); /* legalはプレスタートFAQ（#490）を含む */
    q.forEach(function (e) { assert.ok(html.indexOf('<div class="faq-answer">' + e.acceptedAnswer.text + '</div>') !== -1, p + ': ' + e.name); });
  });
});

test('mens: MEMBER料金は加入有無に関係なく自動適用、料金優遇であり会員資格の付与ではないと明記', function () {
  var idx = textOf(read('mens/index.html'));
  assert.ok(idx.indexOf('への加入有無にかかわらず') !== -1);
  assert.ok(idx.indexOf('料金の優遇') !== -1 && idx.indexOf('会員資格が付与されるものではありません') !== -1);
  assert.ok(idx.indexOf('会員限定のサービスなど、会員資格を前提とするサービスが自動で使えるようになるものでもありません') !== -1);
  var t = tableByHeader(read('mens/index.html'), '会員料金');
  [1, 2, 3, 4].forEach(function (h) {
    assert.strictEqual(t[LABELS[h]].weekday, yen(price('mens', WEEKDAY, h, false, 'V2')));
    assert.strictEqual(t[LABELS[h]].weekend, yen(price('mens', WEEKEND, h, false, 'V2')));
  });
  var legal = textOf(read('_includes/legal_ja.html'));
  assert.ok(legal.indexOf('料金の優遇であり、SNB MEMBERの会員資格が付与されるものではありません') !== -1);
  assert.ok(textOf(read('mens/how-to/index.html')).indexOf('会員資格は付与されません') !== -1);
});

test('Studio X: 2026/10/26以降の料金はセルフ利用基本料金（Issue #486 / #492）で、旧一般料金・旧制度・旧スライド料金に戻っていない', function () {
  var html = read('studio-x/index.html');
  var t = textOf(html);
  /* 料金ロジック(V2 GENERAL)の値がそのまま表示されている */
  [1, 2, 3, 4].forEach(function (h) {
    assert.strictEqual(price('studio_x', WEEKDAY, h, false, 'V2'), 1200 * h, 'Studio X V2平日=1,200円/時');
    assert.strictEqual(price('studio_x', WEEKEND, h, false, 'V2'), 1500 * h, 'Studio X V2土日祝=1,500円/時');
  });
  assert.ok(t.indexOf('3時間3,600円（平日）／4,500円（土日祝）') !== -1);
  assert.ok(t.indexOf('4時間4,800円（平日）／6,000円（土日祝）') !== -1);
  assert.ok(t.indexOf('延長1時間ごと1,200円（平日）／1,500円（土日祝）') !== -1);
  assert.ok(t.indexOf('2時間2,400円/延長1時間1,200円') !== -1 && t.indexOf('2時間3,000円/延長1時間1,500円') !== -1);
  assert.ok(t.indexOf('1,200円〜/ 1時間') !== -1 && t.indexOf('1,500円〜/ 1時間') !== -1);
  /* Issue #486: スタッフ設営はプレミアムオプションとして訴求し、料金は維持 */
  assert.ok(t.indexOf('プレミアムオプション') !== -1);
  assert.ok(t.indexOf('事前設営3,000円／片付け3,000円／設営＋片付けセット5,000円') !== -1);
  assert.ok(t.indexOf('会員・非会員の区別なく、どなたも同じ料金') !== -1);
  /* 「現行一般料金へ一本化」や旧「3時間以内2,000円」「SNB新一般料金」への追従になっていない */
  assert.ok(!/3時間6,000円（平日）|4時間8,000円（平日）|延長1時間ごと2,000円（平日）/.test(t.replace(/従来の料金/g, '')));
  assert.ok(!/3時間以内2,000円|4時間目以降\+?1,000円/.test(t));
  assert.ok(!/7,500円（平日）|10,000円（平日）|2,500円（平日）|3時間5,500円|4時間7,000円/.test(t));
  /* V2では会員価格表示・会員区分選択が無い（予約UI） */
  var logic = loadFrontendSandbox(['booking-logic.js'], {}).BookingLogic;
  assert.strictEqual(logic.brandShowsMemberOption('studio_x', Date.parse('2026-10-26T00:00:00+09:00'), 'V2'), false, 'サーバーの料金世代がV2なら会員区分を出さない（Issue #532）');
  assert.strictEqual(logic.brandShowsMemberOption('studio_x', Date.parse('2026-10-25T23:59:59+09:00'), 'V1'), true, 'V1は現行のまま');
  assert.strictEqual(logic.brandShowsMemberOption('mens', 0), false);
  assert.ok(!/会員価格|会員料金|会員区分/.test(t), 'Studio Xトップに会員価格・会員区分の表示がない');
});

/* Issue #478: #469 / #472 の「機材レンタル自体は会員限定ではない（会員限定はスタッフ対応のみ）」を上書きし、
   2026/12/1以降の新規作成分から Studio Xの有料オプション全般（rental全件 + staffService全件）を会員限定とする。 */
test('Studio X: 機材料金は変更なし・セルフ設営無料・有料オプション全般（機材レンタル＋スタッフ対応）が会員限定（スタッフ3,000/3,000/5,000円）', function () {
  var data = JSON.parse(read('_data/studio_x_equipment.json'));
  var rental = {};
  data.rental.forEach(function (e) { rental[e.code] = e.unitPriceJpy; });
  assert.deepStrictEqual(rental, {
    COB_BICOLOR: 800, PANEL_FULLCOLOR: 500, COB_FULLCOLOR: 1000, BACKGROUND_STAND: 200, STROBE_MONOBLOCK: 800,
    STROBE_PORTABLE: 1000, COMMANDER_CANON: 300, COMMANDER_SONY: 300, STAND_260: 200, BOWENS_BRACKET: 200,
    SOFTBOX_STRIP_60X90: 300, SOFTBOX_STRIP_30X120: 300, SOFTBOX_60: 300, COLOR_FILTER_SET: 200
  });
  assert.deepStrictEqual([data.staffService.services.PRE_SETUP.priceJpy, data.staffService.services.CLEANUP.priceJpy, data.staffService.services.BOTH.priceJpy], [3000, 3000, 5000]);
  assert.ok(data.freeSelf.length > 0, 'セルフ設営の無料備品を維持');

  var catalog = read('_includes/equipment_catalog_ja.html');
  assert.match(catalog, /プレミアムオプション：スタッフ設営・片付け（会員限定）/);
  assert.match(catalog, /<th>セルフ設営<\/th><td>無料<\/td>/);
  assert.match(catalog, /<th>セルフ原状復帰<\/th><td>無料<\/td>/);
  assert.match(catalog, /\{\{ pair\[1\]\.priceJpy \}\}円/, '料金は正本から表示（直書きしない）');
  /* 有料の機材レンタルも会員限定（#478で#469/#472の旧前提を上書き）。セルフ設営・原状復帰は無料のまま。 */
  var rentalBlock = catalog.slice(catalog.indexOf('id="equipment-rental"'), catalog.indexOf('id="equipment-self"'));
  assert.ok(/有料レンタル機材（会員限定）/.test(rentalBlock) && /セットで0円になる機材も会員限定のまま/.test(textOf(rentalBlock)));
  var flow = textOf(read('_includes/studio_x_option_flow_ja.html'));
  assert.ok(flow.indexOf('有料オプション（機材のレンタル・スタッフ対応）は会員限定です') !== -1 && flow.indexOf('セルフ設営・セルフ片付け（無料）') !== -1);
  var top = textOf(read('studio-x/index.html'));
  assert.ok(top.indexOf('有料オプションは会員限定です') !== -1);
  assert.ok(top.indexOf('スタッフ設営のプレミアムオプション（事前設営3,000円／片付け3,000円／設営＋片付けセット5,000円）') !== -1 && top.indexOf('機材のレンタルは1点ごとの個別料金で、スタッフ設営とあわせて会員限定です') !== -1, '#607: 金額は1段落に統合し、会員限定条件を維持');
  assert.ok(top.indexOf('セルフ設営・セルフ片付けは無料') !== -1);
  assert.ok(read('scripts/booking-options.js').indexOf('（会員限定・事前確認制）') !== -1, '予約オプション画面のスタッフ選択に会員限定を表示');
});

test('Studio X: 本文はSNB MEMBERを前面に出さず「会員限定」と書く。加入が必要な箇所だけ会員案内へリンクする', function () {
  ['studio-x/index.html', '_includes/studio_x_option_flow_ja.html', 'studio-x/how-to/index.html'].forEach(function (p) {
    assert.ok(!/SNB MEMBER|Studio Nagoya Base|SNB/.test(textOf(read(p)).replace(/©\s*Studio X \/ Studio Nagoya Base/, '')), p + ' にSNBブランド/SNB MEMBERの表記');
  });
  var catalog = read('_includes/equipment_catalog_ja.html');
  var staff = catalog.slice(catalog.indexOf('id="staff-service"'));
  assert.ok(!/SNB MEMBER/.test(textOf(staff)), 'スタッフ対応の本文にSNB MEMBERを出さない');
  assert.match(staff, /<a href="\{\{ '\/membership\/' \| relative_url \}\}">会員案内ページ<\/a>/);
  var legal = read('studio-x/legal/index.html');
  assert.match(legal, /会員限定のサービス/);
  assert.ok(!/SNB MEMBER/.test(textOf(legal)));
});

test('スペースマーケット: 経由でもスタッフ対応は申込可だが会員限定の条件は共通（非会員の例外なし）。部屋料金・運用は変更しない', function () {
  var t = textOf(read('_includes/equipment_catalog_ja.html'));
  assert.ok(t.indexOf('スペースマーケット経由のご予約でもスタッフ対応はお申込みいただけますが、会員限定の条件は同じです') !== -1);
  assert.ok(t.indexOf('非会員でもスタッフ対応可') === -1 && !/スペースマーケット経由(なら|の場合は)非会員/.test(t));
  var legal = textOf(read('studio-x/legal/index.html'));
  assert.ok(legal.indexOf('スペースマーケット経由のご予約でもスタッフ対応をお申込みいただけますが、会員限定の条件は同じです') !== -1);
  /* Studio X V2の部屋料金はセルフ利用基本料金（Issue #486）。SNB / mensの料金表は参照しない */
  var src = read('gas/booking/shared/BookingPricing.gs');
  assert.ok(src.indexOf('V2: {\n        GENERAL: STUDIO_X_V2_SELF_RATES_\n      }') !== -1);
});

test('Studio X 規約・特商法: 会員限定のスタッフ対応料金が正本と一致し、部屋料金は2026/10/26・会員限定は2026/12/1適用と明記する（Issue #492）', function () {
  var legal = textOf(read('studio-x/legal/index.html'));
  assert.ok(legal.indexOf('事前設営3,000円／片付け3,000円／セット5,000円') !== -1);
  assert.ok(legal.indexOf('2026年10月26日以降に作成するご予約の部屋の利用料金は、会員・非会員の区別なく同額') !== -1);
  assert.ok(legal.indexOf('部屋の利用料金は2026年10月26日から、有料オプションの会員限定は2026年12月1日から適用') !== -1);
});

test('入会フォーム: メールだけをstartMembershipCheckoutへ送り、STRIPE_CHECKOUT_ENABLEDを変更していない', function () {
  var js = read('scripts/membership-join.js');
  assert.ok(js.indexOf("action=startMembershipCheckout") !== -1);
  assert.ok(js.indexOf('JSON.stringify({ email: email, brand: brand })') !== -1);
  assert.ok(!/STRIPE_CHECKOUT_ENABLED|checkoutUrl|secret/i.test(js), 'フロントに決済URL・秘密情報を持たない');
  assert.ok(js.indexOf('CHECKOUT_DISABLED') !== -1, '受付停止中の表示を持つ');
  /* キルスイッチの既定値(Config.gs)は変更しない */
  assert.ok(/STRIPE_CHECKOUT_ENABLED/.test(read('gas/booking/shared/Config.gs')));
});

test('モバイル表示: 会員比較表は横スクロール枠に入り、フォームはページ幅を超えない', function () {
  var css = read('styles/common.css');
  assert.match(css, /\.pricing-table-scroll\s*\{[^}]*overflow-x:\s*auto/);
  assert.match(css, /\.membership-join input\[type="email"\]\s*\{[^}]*width:\s*100%/);
  assert.match(read('membership/index.html'), /<meta name="viewport" content="width=device-width, initial-scale=1.0">/);
});

test('内部資料: 料金表・ブランド分離基準が新ルールで、チェックリストに旧会員制度の定義が残っていない', function () {
  var doc = read('docs/membership-pricing-2026-12.md');
  ['SNB: 会員 / 非会員で部屋料金が異なる', '全員', 'MEMBER料金', 'セルフ利用の基本料金', '平日1,200円/時・土日祝1,500円/時', '有料オプション全般が会員限定', '3,000円', '5,000円'].forEach(function (w) {
    assert.ok(doc.indexOf(w.replace('SNB: 会員 / 非会員で部屋料金が異なる', '会員 / 非会員で部屋料金が異なる')) !== -1, w);
  });
  assert.ok(!/「承認した会員のみ」が正/.test(read('REVIEW_CHECKLIST.md')));
  ['mens-phase1-copy-proposal', 'mens-phase2-structure-proposal', 'mens-phase3-assets-seo-proposal', 'mens-phase4-implementation-report'].forEach(function (n) {
    assert.ok(read('docs/' + n + '.md').indexOf('2026/12/1以降は無効') !== -1, n);
  });
});

test('更新・解約の表現（Issue #532）: 入会日基準の更新日に請求し、支払済みの期間の資格が成立。解約に25日などの締切を設けず、「翌月分」と書かない', function () {
  var pages = ['_includes/membership_terms_ja.html', '_includes/legal_ja.html', 'index.html', 'legal/index.html', 'membership/index.html', 'legal/en.html', 'en.html'];
  pages.forEach(function (p) {
    var raw = read(p);
    var t = textOf(raw);
    var body = t;
    assert.ok(!/25日|25th/.test(body), p + ' に解約の締切日（25日）が残っている');
    assert.ok(!/翌月分の会費|翌月分を|next month['’]s (fee|membership)/i.test(body), p + ' に「翌月分」の表現が残っている');
  });
  var terms = textOf(read('_includes/membership_terms_ja.html'));
  assert.ok(terms.indexOf('入会日を基準とした毎月の更新日に会費が自動で請求され、決済が成功すると、お支払い済みの期間（次の更新日の前日まで）の会員資格が有効になります') !== -1);
  assert.ok(terms.indexOf('次回の更新前に解約の手続きが完了した場合、次回以降の自動更新を停止します') !== -1);
  assert.ok(terms.indexOf('お支払い済みの期間の末日（次の更新日の前日）までは会員資格が有効') !== -1);
  ['how-to/index.html'].forEach(function (p) {
    var raw = read(p);
    assert.ok(textOf(raw).indexOf('入会日を基準に毎月自動更新され、決済が成功した期間の会員資格が有効になります') !== -1, p);
    assert.ok(textOf(raw).indexOf('次回の更新前に解約の手続きが完了した場合、次回以降の自動更新を停止します') !== -1, p);
  });
  assert.ok(textOf(read('_includes/legal_ja.html')).indexOf('更新日に自動請求します（決済が成功した期間の会員資格が有効になります）') !== -1);
  assert.ok(textOf(read('docs/membership-pricing-2026-12.md')).indexOf('締切日は設けていない') !== -1);
});


test('入会元ブランド別の戻り先（Issue #504）: フォームはブランドコードだけを持ち、完了ページはブランド別導線に戻す', function () {
  assert.match(read('membership/index.html'), /id="membership-join-form" data-membership-brand="snb"/);
  assert.match(read('mens/membership/index.html'), /id="membership-join-form" data-membership-brand="mens"/);
  assert.match(read('studio-x/membership/index.html'), /id="membership-join-form" data-membership-brand="studio_x"/);
  var js = read('scripts/membership-join.js');
  assert.ok(/\['snb', 'mens', 'studio_x'\]\.indexOf\(brand\)/.test(js), 'ブランドは許可コードのみ');
  assert.ok(!/successUrl|cancelUrl|success_url|cancel_url/.test(js), 'クライアントは戻り先URLを扱わない');

  var mens = read('mens/membership/complete.html');
  assert.ok(mens.indexOf("'/mens/booking/'") !== -1 && mens.indexOf("'/mens/membership/'") !== -1);
  assert.ok(mens.indexOf("'/booking/' |") === -1, 'mens完了ページからSNB予約へ誘導しない');
  var sx = read('studio-x/membership/complete.html');
  assert.ok(sx.indexOf('href="../booking/"') !== -1 && sx.indexOf('href="../membership/"') !== -1);
  assert.ok(/<meta name="robots" content="noindex/.test(mens) && /<meta name="robots" content="noindex/.test(sx));
  assert.ok(mens.indexOf("'/membership/status/'") !== -1 && sx.indexOf("'/membership/status/'") !== -1, '会員資格確認ページは共通');
});

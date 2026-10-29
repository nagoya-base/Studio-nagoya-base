const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

function read(rel) { return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8'); }
function textOf(html) { return html.replace(/<script[\s\S]*?<\/script>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' '); }

var top = read('studio-x/index.html');
var topText = textOf(top);
var howTo = textOf(read('studio-x/how-to/index.html'));
var plan = textOf(read('studio-x/base-plan/index.html'));

test('#596 ヒーロー: trust stripを統合し、重要情報6点をヒーローに集約（情報は失わない）', function () {
  assert.ok(top.indexOf('trust-strip') === -1, 'trust stripは独立セクションとして残さない');
  var facts = /<dl class="hero-facts">([\s\S]*?)<\/dl>/.exec(top)[1];
  assert.strictEqual((facts.match(/<dd>/g) || []).length, 6);
  ['完全個室・無人貸切', '1〜4名・人数追加料金なし', '白黒背景・照明無料', 'スマホ撮影OK', '上前津 徒歩8分', '8:00〜23:00'].forEach(function (w) {
    assert.ok(facts.indexOf(w) !== -1, w);
  });
});

test('#596 WHY STUDIO Xと利用用途は1セクションに統合され、用途は4項目・各1〜2文', function () {
  assert.ok(top.indexOf('class="statement') === -1);
  var sec = /<section class="for-you[\s\S]*?<\/section>/.exec(top)[0];
  assert.ok(sec.indexOf('WHY STUDIO X') !== -1 && sec.indexOf('世界観に入り込める部屋') !== -1);
  assert.ok(textOf(sec).indexOf('カメラマンなしのセルフ撮影も、一眼カメラでの本格撮影も歓迎') !== -1);
  var cases = sec.match(/<article>[\s\S]*?<\/article>/g);
  assert.strictEqual(cases.length, 4);
  ['コスプレ・少人数併せ', 'ポートレート・創作', 'セルフ撮影・推し活制作', '撮影練習・ライティング'].forEach(function (h, i) {
    assert.ok(cases[i].indexOf('<h3>' + h + '</h3>') !== -1, h);
    assert.ok((textOf(cases[i]).match(/。/g) || []).length <= 2, h + ' は2文まで');
  });
});

test('#596 6つの世界は維持。教室セットの常設品は設備リストへ集約（重複説明なし）', function () {
  ['サイバー・ネオン', '白背景', '黒背景', '教室セット', '和ダーク', 'グランジ・廃墟風'].forEach(function (n) {
    assert.ok(top.indexOf('<h3>' + n + '</h3>') !== -1, n);
  });
  var worlds = /<section class="worlds[\s\S]*?<\/section>/.exec(top)[0];
  assert.ok(worlds.indexOf('学校机、椅子、教卓、黒板') === -1, '世界カードに設備列挙を重複させない');
  assert.ok(top.indexOf('教室セット：学校机、椅子、教卓、黒板') !== -1, '設備リストに保持');
});

test('#596 無料機材セクションとWHAT\'S INSIDEは1つの#specsに統合（代表設備6点）。詳細はequipmentへ', function () {
  assert.ok(top.indexOf('equipment-highlight-card') === -1 && top.indexOf('id="equipment-highlight-title"') === -1);
  var specs = /<section class="specs[\s\S]*?<\/section>/.exec(top)[0];
  assert.strictEqual((specs.match(/<dt>/g) || []).length, 6);
  ['白・黒の背景紙ロール', '天井フルカラーLED／バイカラーLEDパネル2灯／レフ板', '大型全身ミラー', 'ユニットバス、カーテン内で着替え可能', 'カメラ、ストロボ、外部照明の持ち込み可'].forEach(function (w) {
    assert.ok(specs.indexOf(w) !== -1, w);
  });
  assert.ok(specs.indexOf('href="equipment/"') !== -1);
  var eq = textOf(read('studio-x/equipment/index.html') + read('_includes/equipment_photo_cards.html'));
  assert.ok(eq.indexOf('点灯した状態を見ながら') !== -1 && eq.indexOf('レフ板 5-in-1（80cm）') !== -1, '移転先(equipment)に無料機材の詳細が残っている');
});

test('#596 初めての方へ: 3ステップ常時表示、当日の流れ4ステップは折りたたみで保持（ACCESSから移転）', function () {
  var beg = /<section class="beginners[\s\S]*?<\/section>/.exec(top)[0];
  assert.strictEqual((beg.match(/<span>STEP 0\d<\/span>/g) || []).length, 3);
  var more = /<details class="beginners-more[\s\S]*?<\/details>/.exec(beg)[0];
  ['予約後に入室案内を確認', 'キーボックスから鍵を受け取る', 'スマートロックで入室', '撮影後に簡易清掃・原状復帰', 'href="how-to/"'].forEach(function (w) { assert.ok(more.indexOf(w) !== -1, w); });
  assert.ok(top.indexOf('ON THE DAY') === -1);
  assert.ok(beg.indexOf('カードは決済確認後に自動確定、現金・PayPayは内容確認後の当方からの確定連絡をもって成立します') !== -1, '予約成立条件はSTEP 02に一本化');
  assert.ok(howTo.indexOf('確定連絡をもって予約成立となります') !== -1, '詳細は利用ガイドにも保持');
});

test('#596 料金: 基本料金は常時表示、細かい適用条件は折りたたみで保持。会員特典の詳細はmembershipへ誘導', function () {
  var price = /<section class="price section-shell" id="price"[\s\S]*?<\/section>/.exec(top)[0];
  var visible = price.replace(/<details[\s\S]*?<\/details>/, '');
  ['1,200<small>円〜 / 1時間</small>', '1,500<small>円〜 / 1時間</small>', '人数追加料金なし（最大4名）', '会員・非会員の区別なく、どなたも同じ料金'].forEach(function (w) {
    assert.ok(visible.indexOf(w) !== -1, '常時表示: ' + w);
  });
  var more = /<details class="price-more[\s\S]*?<\/details>/.exec(price)[0];
  ['3時間3,600円', '4時間4,800円', '2026年10月26日以降に作成するご予約', '2026年10月25日までに作成したご予約', 'プレミアムオプション', 'href="membership/"', 'href="equipment/#staff-service"'].forEach(function (w) {
    assert.ok(more.indexOf(w) !== -1, '折りたたみ: ' + w);
  });
  assert.ok(price.indexOf('貸切ベース') === -1, '通常料金とベースプランを混ぜない');
});

test('#596 6時間貸切ベースプラン: トップは要約、詳細は専用ページに全て保持', function () {
  var sec = top.slice(top.indexOf('id="osu-base-plan"'), top.indexOf('id="access"'));
  var shown = sec.replace(/<details[\s\S]*?<\/details>/g, '').replace(/<div class="price-cards">[\s\S]*?<\/article>\s*<\/div>/, '');
  assert.ok(textOf(shown).length < 330, '常時表示は要約のみ: ' + textOf(shown).length);
  ['有人クロークではありません', '途中延長はできません', 'シャワー利用は含まれません', '本プランを選択した場合のみ適用'].forEach(function (w) {
    assert.ok(shown.indexOf(w) === -1 && /<details class="price-more[\s\S]*?<\/details>/.exec(sec)[0].indexOf(w) !== -1, '条件は折りたたみ内: ' + w);
  });
  assert.ok(textOf(sec).length < 900, '要約は短く保つ: ' + textOf(sec).length);
  ['こんな方におすすめ', '友人同士で落ち着いて着替えたい', 'キャリーケースや衣装を置いて身軽にイベントを回りたい', 'イベント途中に休憩したい', 'メイク直し・衣装直しのために戻れる場所がほしい', '公式更衣室の混雑を避けたい',
    'イベント参加時の拠点', '大型ミラー利用', 'スマートフォン等での簡易撮影OK', '利用時間は6時間以上（8:00〜21:00の範囲・1時間単位）'.replace('利用時間は', '利用時間は'),
    '用途限定のパッケージ商品', '共用部や建物内に荷物を放置しない', '他の利用者とお部屋を共用することはありません', '利用規約の責任範囲', '原状復帰', '本格的な撮影用途で通常のStudio X設備・オプションをご利用になる場合は、プランを選ばず通常の予約',
    '貸切ベースプランは荷物を預かってもらえますか？', '貸切ベースプランはいつでも予約できますか？', '貸切ベースプランの時間と人数は？'].forEach(function (w) {
    assert.ok(plan.indexOf(w) !== -1, '特設ページに保持: ' + w);
  });
});

test('#596/#624 FAQ: トップは本文と重複しない3問、全5問は利用ガイドに保持（当日予約を含む）', function () {
  var faq = /<section class="faq[\s\S]*?<\/section>/.exec(top)[0];
  var qs = faq.match(/<summary>[\s\S]*?<\/summary>/g);
  assert.strictEqual(qs.length, 3);
  assert.deepStrictEqual(qs.map(function (s) { return s.replace(/<\/?summary>/g, ''); }), [
    'スマートフォンだけでも撮影できますか？', '着替える場所はありますか？', 'ストロボや照明を持ち込めますか？']);
  assert.ok(faq.indexOf('何人まで利用できますか') === -1, '人数FAQはトップから外す（料金本文と重複）');
  ['初めてご利用', '6時間貸切ベースプランとは'].forEach(function (w) {
    assert.ok(faq.indexOf(w) === -1, w + ' は本文と重複するためFAQにしない');
  });
  assert.ok(top.indexOf('id="beginners"') !== -1 && top.indexOf('id="osu-base-plan"') !== -1, '本文アンカー維持');
  assert.ok(top.indexOf('"FAQPage"') === -1 && faq.indexOf('data-analytics-faq-id') === -1, 'トップにFAQ構造化データ/GA4 FAQ IDなし');
  assert.ok(faq.indexOf('href="how-to/#faq"') !== -1);
  var guide = read('studio-x/how-to/index.html');
  var gfaq = /id="faq">[\s\S]*?<\/section>/.exec(guide)[0];
  ['スマートフォンだけでも撮影できますか？', '何人まで利用できますか？', '着替える場所はありますか？', 'ストロボや照明を持ち込めますか？', '当日でも予約できますか？',
    '会員登録の有無は当日予約の条件ではありません', '初めてご利用の方はオンラインクレジットカード決済のみ'].forEach(function (w) {
    assert.ok(gfaq.indexOf(w) !== -1, w);
  });
  assert.ok(guide.indexOf('href="#faq"') !== -1, 'ページ内メニューにFAQ');
});

test('#596 予約CTAは現行bookingへ統一。旧受付条件・ブランド混在・スペースマーケット導線がない', function () {
  var ctas = top.match(/data-analytics-type="booking" [^>]*>|<a [^>]*href="booking\/[^"]*"[^>]*>/g) || [];
  assert.ok(ctas.length >= 5);
  var hrefs = top.match(/href="[^"]*"/g);
  hrefs.forEach(function (h) { assert.ok(!/reservation\/form|ssl\.form|forms\.gle|docs\.google\.com\/forms/.test(h), '旧予約フォーム: ' + h); });
  assert.ok(!/前日まで(の)?(ご)?(予約|受付)|会員のみ当日|会員に限り当日|当日.{0,6}会員(の)?(お客様)?に限り/.test(topText), '旧受付条件');
  assert.ok(!/緊縛|吊り床|SNB|スペースマーケット|スペマ|spacemarket/i.test(topText.replace(/©\s*Studio X \/ Studio Nagoya Base/, '')));
  assert.ok(!/spacemarket/i.test(top));
});

test('#596 ページ全体の分量: 整理前(HTML 35.6KB・表示テキスト約5,260字)より明確に短い', function () {
  assert.ok(top.length < 30000, 'HTMLサイズ: ' + top.length);
  assert.ok(topText.length < 4100, '表示テキスト量: ' + topText.length);
});

test('#596 スマホ初期表示: 常時表示の説明文は短く（原則1〜2文）、詳細条件は閉じた<details>か詳細ページへ', function () {
  var shown = top.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<details[\s\S]*?<\/details>/g, '').replace(/<blockquote[\s\S]*?<\/blockquote>/g, '');
  (shown.match(/<p[^>]*>[\s\S]*?<\/p>/g) || []).forEach(function (p) {
    var t = textOf(p).trim();
    assert.ok(t.length <= 130, '長文が常時表示: ' + t.slice(0, 40) + '… (' + t.length + ')');
    assert.ok((t.match(/。/g) || []).length <= 2, '3文以上が常時表示: ' + t.slice(0, 40));
  });
  assert.ok(!/<details[^>]*\sopen/.test(top), '<details>は初期状態で閉じる');
  /* 主要情報（基本料金・世界・用途・設備・アクセス・CTA）は折りたたまない */
  var details = (top.match(/<details[\s\S]*?<\/details>/g) || []).join('');
  ['1,200<small>', '1,500<small>', 'id="worlds"', '愛知県名古屋市中区富士見町5-24', 'class="button button-primary" href="booking/"'].forEach(function (w) {
    assert.ok(details.indexOf(w) === -1, '折りたたみ内に主要情報: ' + w);
  });
});

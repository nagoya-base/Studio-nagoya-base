/*
 * scripts/survey-analytics.js のテスト（Issue #374）。ファネル・再コード・クロス集計・n<5警告。
 */
'use strict';

var test = require('node:test');
var assert = require('node:assert');
var Core = require('../scripts/survey-core.js');
var Analytics = require('../scripts/survey-analytics.js');
var schema = require('../survey/survey-schema.json');
var A = require('./helpers/survey-answers');

var seq = 0;
function rec(answers, timestamp) {
  seq += 1;
  var hash = '123e4567-e89b-42d3-a456-' + String(100000000000 + seq);
  var result = Core.validateSubmission(schema, { respondent_hash: hash, answers: answers });
  assert.ok(result.ok, JSON.stringify(result.errors));
  var record = result.record;
  record.timestamp = timestamp || '2026-10-08T15:30:00.000Z';
  return record;
}
function many(n, factory) {
  var out = [];
  for (var i = 0; i < n; i++) out.push(factory(i));
  return out;
}
function stage(funnel, key) {
  return funnel.stages.filter(function (s) { return s.key === key; })[0];
}

test('未利用者ファネルは入れ子で、前段階通過者だけが次の分母。初認知者はファネル外で別指標', function () {
  var records = [
    /* 事前認知なし(初認知)・意向あり */
    rec(A.nonuser({ usage_status: 'first_time', snb_usage_intent_3m: 'definitely' })),
    rec(A.nonuser({ usage_status: 'first_time', snb_usage_intent_3m: 'no' })),
    /* 事前認知あり→カテゴリ需要なし(脱落) */
    rec(A.nonuser({ preferred_frequency: 'none' })),
    /* 需要あり→検討行動なし(脱落) */
    rec(A.nonuser({ consideration_actions: ['nothing'] })),
    /* 検討あり→価格不受容(7,000円)(脱落) */
    rec(A.nonuser({ max_price_3h_weekend: 'p7000' })),
    /* 価格受容→意向なし */
    rec(A.nonuser({ max_price_3h_weekend: 'p8000', snb_usage_intent_3m: 'unsure' })),
    /* 最後まで通過 */
    rec(A.nonuser({ max_price_3h_weekend: 'p10000_plus', snb_usage_intent_3m: 'definitely' })),
    rec(A.nonuser({ usage_status: 'name_only', max_price_3h_weekend: 'p9000', snb_usage_intent_3m: 'probably' })),
    /* 利用者は未利用者ファネルに入らない */
    rec(A.user())
  ];
  var funnel = Analytics.nestedFunnel(schema, records, schema.analysis.funnels.nonuser);
  assert.strictEqual(funnel.total, 8);
  assert.deepStrictEqual(funnel.stages.map(function (s) { return s.count; }), [6, 5, 4, 3, 2]);
  assert.strictEqual(stage(funnel, 'category_demand').rateFromPrevious, 5 / 6);
  assert.strictEqual(stage(funnel, 'intent').rateFromPrevious, 2 / 3);
  assert.strictEqual(stage(funnel, 'intent').rateFromStart, 2 / 8);
  assert.strictEqual(funnel.outside.total, 2);
  assert.strictEqual(funnel.outside.count, 1);
  assert.strictEqual(funnel.outside.rate, 0.5);
});

test('価格受容は 8,000円以上のみ（7,500円を受容できる水準）', function () {
  var cond = stage(schema.analysis.funnels.nonuser, 'price_acceptance').cond;
  ['p8000', 'p9000', 'p10000_plus'].forEach(function (v) { assert.ok(Core.evalCondition(cond, { max_price_3h_weekend: v })); });
  ['p5000_or_less', 'p6000', 'p7000', 'unknown', ''].forEach(function (v) { assert.ok(!Core.evalCondition(cond, { max_price_3h_weekend: v })); });
});

test('利用者ファネル: 利用経験→2回以上→再利用意向上位2段階→6回以上（入れ子）', function () {
  var records = [
    rec(A.user({ visit_count: 'once', reuse_intent: 'definitely' })),
    rec(A.user({ visit_count: 'two_three', reuse_intent: 'neutral' })),
    rec(A.user({ visit_count: 'four_five', reuse_intent: 'probably' })),
    rec(A.user({ visit_count: 'six_ten', reuse_intent: 'definitely' })),
    rec(A.user({ visit_count: 'eleven_plus', reuse_intent: 'never' })),
    rec(A.nonuser())
  ];
  var funnel = Analytics.nestedFunnel(schema, records, schema.analysis.funnels.user);
  assert.strictEqual(funnel.total, 6);
  assert.deepStrictEqual(funnel.stages.map(function (s) { return s.count; }), [5, 4, 2, 1]);
  assert.strictEqual(funnel.stages[0].rateFromStart, 5 / 6);
});

test('再コード: 地域・利用目的・価格・緊縛ロール', function () {
  var region = Analytics.buildAxis(schema, 'region_group', 'region_group');
  function classify(overrides) { return region.classify(A.nonuser(overrides)); }
  assert.deepStrictEqual(classify({ prefecture: 'aichi', aichi_area: 'nagoya' }), ['nagoya']);
  assert.deepStrictEqual(classify({ prefecture: 'aichi', aichi_area: 'mikawa' }), ['aichi_other']);
  assert.deepStrictEqual(classify({ prefecture: 'gifu' }), ['tokai_other']);
  assert.deepStrictEqual(classify({ prefecture: 'mie' }), ['tokai_other']);
  assert.deepStrictEqual(classify({ prefecture: 'shizuoka' }), ['tokai_other']);
  assert.deepStrictEqual(classify({ prefecture: 'tokyo' }), ['far']);
  assert.deepStrictEqual(classify({ prefecture: 'overseas' }), ['far']);
  assert.deepStrictEqual(classify({ prefecture: '' }), []);

  var purpose = Analytics.buildAxis(schema, 'purpose_group', 'purpose_group');
  assert.deepStrictEqual(purpose.classify({ usage_purpose: ['self_practice', 'nawakai', 'kinbaku_shoot', 'video_stream'] }).sort(),
    ['kinbaku_shoot', 'lesson_social', 'other_shoot', 'practice']);
  assert.deepStrictEqual(purpose.classify({ usage_purpose: ['none'] }), []);
  assert.deepStrictEqual(purpose.categories.map(function (c) { return c.label; }), ['練習系', '講習・交流系', '緊縛撮影系', 'その他撮影・制作系']);

  var price = Analytics.buildAxis(schema, 'price_group', 'price_group');
  assert.deepStrictEqual(price.categories.map(function (c) { return c.label; }), ['5,000円以下', '6,000〜7,000円', '8,000円以上', 'わからない']);
  assert.deepStrictEqual(price.classify({ max_price_3h_weekend: 'p7000' }), ['6000_7000']);
  assert.deepStrictEqual(price.classify({ max_price_3h_weekend: 'p9000' }), ['ge8000']);

  var role = Analytics.buildAxis(schema, 'kinbaku_role_group', 'kinbaku_role_group');
  assert.deepStrictEqual(role.classify({ kinbaku_role: ['tie', 'tied'] }), ['includes_tie']);
  assert.deepStrictEqual(role.classify({ kinbaku_role: ['tied', 'observer'] }), ['receiver_only']);
  assert.deepStrictEqual(role.classify({ kinbaku_role: ['photographer'] }), ['shoot_watch']);
  assert.deepStrictEqual(role.classify({ kinbaku_role: ['unsure'] }), ['inexperienced_other']);
});

test('クロス集計: 全セルにnがあり、n<5はlow。maskで件数・割合を伏せる', function () {
  var records = many(6, function () { return rec(A.nonuser({ member_composition: 'solo' })); })
    .concat(many(3, function () { return rec(A.nonuser({ member_composition: 'male_male', usage_purpose: ['lesson'] })); }));
  var spec = schema.analysis.crosstabs.filter(function (c) { return c.id === 'seg_status'; })[0];
  var table = Analytics.crosstab(schema, records, spec);
  var solo = table.rows.filter(function (r) { return r.key === 'solo'; })[0];
  var male = table.rows.filter(function (r) { return r.key === 'male_male'; })[0];
  assert.strictEqual(solo.n, 6);
  var soloKnown = solo.cells.filter(function (c) { return c.key === 'known_not_used'; })[0];
  assert.strictEqual(soloKnown.count, 6);
  assert.strictEqual(soloKnown.low, false);
  var maleKnown = male.cells.filter(function (c) { return c.key === 'known_not_used'; })[0];
  assert.strictEqual(maleKnown.count, 3);
  assert.strictEqual(maleKnown.low, true);
  table.rows.forEach(function (r) { r.cells.forEach(function (c) { assert.strictEqual(typeof c.count, 'number'); assert.strictEqual(typeof c.low, 'boolean'); }); });

  var masked = Analytics.crosstab(schema, records, spec, { mask: true });
  var maskedMale = masked.rows.filter(function (r) { return r.key === 'male_male'; })[0].cells.filter(function (c) { return c.key === 'known_not_used'; })[0];
  assert.strictEqual(maskedMale.count, null);
  assert.strictEqual(maskedMale.share, null);
});

test('クロス集計: 利用目的(再コード)×利用時間 は複数選択を各カテゴリへ数える', function () {
  var records = [
    rec(A.user({ usage_purpose: ['self_practice', 'lesson'], preferred_duration: 'h3' })),
    rec(A.user({ usage_purpose: ['self_practice'], preferred_duration: 'h2' }))
  ];
  var spec = schema.analysis.crosstabs.filter(function (c) { return c.id === 'purpose_duration'; })[0];
  var table = Analytics.crosstab(schema, records, spec);
  var practice = table.rows.filter(function (r) { return r.key === 'practice'; })[0];
  var lesson = table.rows.filter(function (r) { return r.key === 'lesson_social'; })[0];
  assert.strictEqual(practice.n, 2);
  assert.strictEqual(lesson.n, 1);
});

test('Issue指定のクロス集計がすべて定義済みで、補助クロスは標本が少ないと抑止される', function () {
  var ids = schema.analysis.crosstabs.map(function (c) { return c.row + '|' + c.col; });
  ['usage_segment|usage_status', 'usage_segment|usage_purpose', 'usage_segment|preferred_frequency', 'usage_segment|max_price_3h_weekend',
    'usage_segment|current_price_rating', 'usage_segment|primary_alternative_space', 'usage_segment|nonuse_reasons', 'usage_segment|conversion_factors',
    'usage_segment|snb_interest_features', 'usage_segment|privacy_needs', 'usage_segment|snb_usage_intent_3m', 'usage_purpose|preferred_duration',
    'usage_purpose|preferred_frequency', 'usage_purpose|max_price_3h_weekend', 'awareness_source|snb_usage_intent_3m',
    'primary_alternative_space|max_price_3h_weekend', 'region_group|snb_usage_intent_3m', 'gender_identity|usage_purpose',
    'sexual_orientation|usage_purpose', 'sexual_orientation|privacy_needs'].forEach(function (key) {
    assert.ok(ids.indexOf(key) !== -1, '未定義のクロス集計: ' + key);
  });
  var dashboard = Analytics.buildDashboard(schema, many(10, function () { return rec(A.user({ gender_identity: 'male', sexual_orientation: 'gay' })); }), [], {});
  var aux = dashboard.crosstabs.filter(function (c) { return c.aux; });
  assert.strictEqual(aux.length, 3);
  aux.forEach(function (c) { assert.strictEqual(c.suppressed, true); assert.deepStrictEqual(c.rows, []); });
  var main = dashboard.crosstabs.filter(function (c) { return !c.aux; });
  main.forEach(function (c) { assert.ok(c.rows.length > 0, c.id); });
  var big = Analytics.buildDashboard(schema, many(60, function () { return rec(A.user({ gender_identity: 'male', sexual_orientation: 'gay' })); }), [], {});
  big.crosstabs.filter(function (c) { return c.aux; }).forEach(function (c) { assert.ok(!c.suppressed); });
});

test('有料オプション価格受容: 金額P以上を許容した割合と「無料なら使う」の分離', function () {
  var records = [
    rec(A.user({ paid_options_interest: ['shower'], price_shower: 'y300' })),
    rec(A.user({ paid_options_interest: ['shower'], price_shower: 'y800' })),
    rec(A.user({ paid_options_interest: ['shower'], price_shower: 'y1500_plus' })),
    rec(A.user({ paid_options_interest: ['shower'], price_shower: 'free_only' })),
    rec(A.user({ paid_options_interest: ['none'] }))
  ];
  var spec = schema.analysis.paidOptionPrices.filter(function (s) { return s.option === 'shower'; })[0];
  var curve = Analytics.priceAcceptance(schema, records, spec);
  assert.strictEqual(curve.interested, 4);
  assert.strictEqual(curve.interestRate, 4 / 5);
  assert.strictEqual(curve.answered, 4);
  assert.strictEqual(curve.freeOnly, 1);
  assert.strictEqual(curve.aboveCount, 1);
  var at = function (amount) { return curve.points.filter(function (p) { return p.amount === amount; })[0]; };
  assert.strictEqual(at(300).count, 3);
  assert.strictEqual(at(800).count, 2);
  assert.strictEqual(at(1500).count, 1);
});

test('ステップ到達（離脱計測）は同一respondentの重複を1回に数える', function () {
  var events = [
    { respondent_hash: 'a', step_id: 'age' }, { respondent_hash: 'a', step_id: 'age' }, { respondent_hash: 'a', step_id: 'usage' },
    { respondent_hash: 'b', step_id: 'age' }
  ];
  var reach = Analytics.stepReach(schema, events);
  assert.strictEqual(reach[0].id, 'age');
  assert.strictEqual(reach[0].count, 2);
  assert.strictEqual(reach[1].count, 1);
  assert.strictEqual(reach[1].rateFromFirst, 0.5);
});

test('ダッシュボード: 必須の集計項目を含み、timestamp・respondent_hashを含めず日付(JST)に丸める', function () {
  var records = [
    rec(A.user({ free_feedback: 'シャワーが欲しい' }), '2026-10-08T15:30:00.000Z'),
    rec(A.nonuser({ support_message: '応援しています' }), '2026-10-08T01:00:00.000Z')
  ];
  var d = Analytics.buildDashboard(schema, records, [], { segment: 'all' });
  assert.strictEqual(d.summary.n, 2);
  assert.strictEqual(d.summary.usedRate, 0.5);
  assert.strictEqual(d.summary.preAwarenessRate, 1);
  var ids = d.distributions.map(function (x) { return x.id; });
  ['usage_purpose', 'group_size', 'preferred_duration', 'preferred_frequency', 'primary_alternative_space', 'max_price_3h_weekend', 'current_price_rating',
    'pricing_preferences', 'paid_options_interest', 'privacy_needs', 'nonuse_reasons', 'consideration_actions', 'conversion_factors',
    'snb_interest_features', 'snb_usage_intent_3m', 'reuse_intent', 'awareness_source', 'age', 'region', 'usage_segment'].forEach(function (id) {
    assert.ok(ids.indexOf(id) !== -1, id);
  });
  var rating = d.distributions.filter(function (x) { return x.id === 'current_price_rating'; })[0];
  assert.strictEqual(rating.split.length, 2, '利用経験者/未利用者で分けて集計');
  assert.deepStrictEqual(d.freeText.map(function (f) { return f.date; }), ['2026-10-09', '2026-10-08']);
  var serialized = JSON.stringify(d);
  assert.ok(!/respondent_hash|T15:30|T01:00/.test(serialized));
  assert.ok(!/123e4567/.test(serialized));
  assert.strictEqual(d.responsesByDate.length, 2);
});

test('ダッシュボードのセグメント絞り込みはファネルにも効く', function () {
  var records = [
    rec(A.nonuser({ member_composition: 'solo' })),
    rec(A.nonuser({ member_composition: 'male_male', snb_usage_intent_3m: 'no' })),
    rec(A.user({ member_composition: 'male_male' }))
  ];
  var all = Analytics.buildDashboard(schema, records, [], { segment: 'all' });
  var male = Analytics.buildDashboard(schema, records, [], { segment: 'male_male' });
  assert.strictEqual(all.funnels.nonuser.total, 2);
  assert.strictEqual(male.funnels.nonuser.total, 1);
  assert.strictEqual(male.funnels.user.total, 2);
  assert.strictEqual(male.summary.n, 2);
  assert.strictEqual(male.segmentComparison.length, 6, '構成別比較は絞り込みに関わらず全構成を返す');
});

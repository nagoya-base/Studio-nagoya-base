/*
 * scripts/survey-core.js + survey/survey-schema.json のテスト（Issue #374）。
 * ブラウザとGASが共有するコアを、schemaそのものに対して検証する。
 */
'use strict';

var test = require('node:test');
var assert = require('node:assert');
var fs = require('fs');
var path = require('path');
var Core = require('../scripts/survey-core.js');
var schema = require('../survey/survey-schema.json');
var A = require('./helpers/survey-answers');

var HASH = '123e4567-e89b-42d3-a456-426614174000';

function submit(answers, extra) {
  return Core.validateSubmission(schema, Object.assign({ respondent_hash: HASH, answers: answers }, extra || {}));
}
function codes(result, field) {
  return result.errors.filter(function (e) { return !field || e.field === field; }).map(function (e) { return e.code; });
}

test('schema: 設問ID・選択肢・列名が一意で、表示条件は既出の設問だけを参照する', function () {
  var seen = {};
  var fields = {};
  Core.eachQuestion(schema, function (q) {
    assert.ok(!seen[q.id], 'duplicate question ' + q.id);
    seen[q.id] = true;
    if (q.options) {
      var values = q.options.map(function (o) { return o.value; });
      assert.strictEqual(new Set(values).size, values.length, q.id + ' option values');
      assert.ok(!values.some(function (v) { return /^\d+$/.test(v); }), q.id + ' numeric-like value');
    }
    Core.fieldsOfQuestion(q).forEach(function (f) { assert.ok(!fields[f], 'dup field ' + f); fields[f] = true; });
    (function check(cond) {
      if (!cond) return;
      (cond.all || cond.any || []).forEach(check);
      if (cond.not) check(cond.not);
      if (cond.q) assert.ok(seen[cond.q], q.id + ' references later/unknown ' + cond.q);
    })(q.showIf);
    (q.otherTexts || []).forEach(function (o) {
      assert.ok(Core.findOption(q, o.when), q.id + ' otherTexts.when');
    });
  });
});

test('schema: responses列がIssue #374の列定義と一致する（completion_stageは events 実装のため持たない）', function () {
  var expected = ('timestamp respondent_hash age_screening usage_status age prefecture country region_other aichi_area aichi_area_other ' +
    'kinbaku_role kinbaku_role_other member_composition usage_segment group_size usage_purpose usage_purpose_other preferred_duration ' +
    'preferred_schedule preferred_frequency primary_alternative_space primary_alternative_space_other alternative_spaces alternative_spaces_other ' +
    'max_price_3h_weekend current_price_rating pricing_preferences pricing_preferences_other paid_options_interest paid_options_interest_other ' +
    'price_photo_equipment price_shower price_amenities price_early_late privacy_needs privacy_needs_other visit_count reuse_intent good_points ' +
    'good_points_other improvement_points improvement_points_other nonuse_reasons nonuse_reasons_other consideration_actions snb_interest_features ' +
    'snb_interest_features_other conversion_factors conversion_factors_other snb_usage_intent_3m awareness_source awareness_source_other preferred_media ' +
    'preferred_media_other gender_identity gender_identity_other sexual_orientation sexual_orientation_other free_feedback support_message survey_path').split(' ');
  assert.deepStrictEqual(Core.responseColumns(schema), expected);
});

test('Q0: 17歳以下は保存対象外（AGE_NOT_ELIGIBLE）で、他の値があっても recordを返さない', function () {
  var result = submit(A.user({ age_screening: 'under_18' }));
  assert.strictEqual(result.ok, false);
  assert.deepStrictEqual(codes(result), ['AGE_NOT_ELIGIBLE']);
  assert.strictEqual(result.record, null);
  assert.strictEqual(submit(A.user({ age_screening: '' })).ok, false);
});

test('有効な利用者・未利用者の回答は検証を通り、性別・性的指向が未回答でも完了できる', function () {
  var user = submit(A.user());
  assert.strictEqual(user.ok, true, JSON.stringify(user.errors));
  assert.strictEqual(user.record.gender_identity, '');
  assert.strictEqual(user.record.sexual_orientation, '');
  var nonuser = submit(A.nonuser());
  assert.strictEqual(nonuser.ok, true, JSON.stringify(nonuser.errors));
});

test('利用経験で分岐: 利用者は未利用者設問を、未利用者は利用者設問を保存しない（隠れたrequiredで送信不能にもならない）', function () {
  var user = submit(A.user({ nonuse_reasons: ['far'], snb_usage_intent_3m: 'probably', snb_interest_features: ['privacy'], conversion_factors: ['cheaper'], consideration_actions: ['saw_x'] }));
  assert.strictEqual(user.ok, true);
  ['nonuse_reasons', 'consideration_actions', 'snb_interest_features', 'conversion_factors'].forEach(function (f) { assert.deepStrictEqual(user.record[f], []); });
  assert.strictEqual(user.record.snb_usage_intent_3m, '');

  var non = submit(A.nonuser({ visit_count: 'once', reuse_intent: 'definitely', good_points: ['fee'], improvement_points: ['fee'] }));
  assert.strictEqual(non.ok, true);
  assert.strictEqual(non.record.visit_count, '');
  assert.strictEqual(non.record.reuse_intent, '');
  assert.deepStrictEqual(non.record.good_points, []);
  assert.deepStrictEqual(non.record.improvement_points, []);

  var missingUserField = submit(A.user({ visit_count: '' }));
  assert.deepStrictEqual(codes(missingUserField, 'visit_count'), ['REQUIRED']);
});

test('検討行動(Q23)・未利用理由(Q22)は「今回初めて知った」には表示せず保存しない。Q26は取得する', function () {
  var first = submit(A.nonuser({ usage_status: 'first_time' }));
  assert.strictEqual(first.ok, true, JSON.stringify(first.errors));
  assert.deepStrictEqual(first.record.consideration_actions, []);
  assert.deepStrictEqual(first.record.nonuse_reasons, []);
  assert.strictEqual(first.record.snb_usage_intent_3m, 'probably');
  var noIntent = submit(A.nonuser({ usage_status: 'first_time', snb_usage_intent_3m: '' }));
  assert.deepStrictEqual(codes(noIntent, 'snb_usage_intent_3m'), ['REQUIRED']);
  var noConsider = submit(A.nonuser({ consideration_actions: [] }));
  assert.deepStrictEqual(codes(noConsider, 'consideration_actions'), ['REQUIRED']);
});

test('愛知県の地域分岐と、海外・その他の任意自由記述', function () {
  assert.deepStrictEqual(codes(submit(A.user({ aichi_area: '' })), 'aichi_area'), ['REQUIRED']);
  var other = submit(A.nonuser({ aichi_area: 'nagoya' }));
  assert.strictEqual(other.record.aichi_area, '', '愛知県以外では地域を保存しない');
  var unknown = submit(A.user({ aichi_area: 'unknown_other' }));
  assert.strictEqual(unknown.ok, true, '「その他・わからない」の自由記述は任意');
  assert.strictEqual(submit(A.user({ aichi_area: 'unknown_other', aichi_area_other: '知多' })).record.aichi_area_other, '知多');
  assert.strictEqual(submit(A.user({ aichi_area: 'nagoya', aichi_area_other: '残るはず無し' })).record.aichi_area_other, '');

  var overseas = submit(A.nonuser({ prefecture: 'overseas' }));
  assert.strictEqual(overseas.ok, true, '海外の国名は任意');
  assert.strictEqual(submit(A.nonuser({ prefecture: 'overseas', country: 'Taiwan' })).record.country, 'Taiwan');
  assert.strictEqual(submit(A.nonuser({ prefecture: 'tokyo', country: 'Taiwan' })).record.country, '', '海外以外では国を破棄');
  assert.strictEqual(submit(A.nonuser({ prefecture: 'other' })).ok, true);
  assert.strictEqual(submit(A.nonuser({ prefecture: 'other', region_other: 'どこか' })).record.region_other, 'どこか');
});

test('緊縛ロール: 縛る側＋縛られる側、未経験＋興味あり併用可。「関心がない」は積極項目と排他。「両方」は無い', function () {
  assert.strictEqual(submit(A.user({ kinbaku_role: ['tie', 'tied'] })).ok, true);
  assert.strictEqual(submit(A.user({ kinbaku_role: ['tie', 'unsure'] })).ok, true);
  assert.strictEqual(submit(A.user({ kinbaku_role: ['no_interest'] })).ok, true);
  assert.strictEqual(submit(A.user({ kinbaku_role: ['no_interest', 'unsure'] })).ok, true);
  ['tie', 'tied', 'photographer', 'observer'].forEach(function (v) {
    assert.deepStrictEqual(codes(submit(A.user({ kinbaku_role: ['no_interest', v] })), 'kinbaku_role'), ['EXCLUSIVE_CONFLICT']);
  });
  var role = Core.findQuestion(schema, 'kinbaku_role');
  assert.ok(!role.options.some(function (o) { return /両方/.test(o.label); }));
  assert.deepStrictEqual(codes(submit(A.user({ kinbaku_role: ['other'] })), 'kinbaku_role_other'), ['REQUIRED']);
  assert.strictEqual(submit(A.user({ kinbaku_role: ['other'], kinbaku_role_other: '撮影補助' })).ok, true);
});

test('member_composition → usage_segment（性的指向は使わない）', function () {
  var map = { solo: 'solo', male_male: 'male_male', female_female: 'female_female', mixed: 'mixed', group: 'group', undecided: 'undecided' };
  Object.keys(map).forEach(function (composition) {
    var result = submit(A.user({ member_composition: composition, sexual_orientation: 'gay' }));
    assert.strictEqual(result.record.usage_segment, map[composition]);
  });
  assert.strictEqual(submit(A.user({ member_composition: 'mixed', sexual_orientation: 'gay' })).record.usage_segment, 'mixed');
  /* クライアントが usage_segment を直接送っても無視される（派生列はサーバーが生成） */
  assert.strictEqual(submit(A.user({ member_composition: 'solo', usage_segment: 'group' })).record.usage_segment, 'solo');
  /* 性的指向はどの設問の表示条件にも使われない */
  Core.eachQuestion(schema, function (q) {
    assert.ok(JSON.stringify(q.showIf || {}).indexOf('sexual_orientation') === -1, q.id);
    assert.ok(JSON.stringify(q.showIf || {}).indexOf('gender_identity') === -1, q.id);
  });
});

test('「特にない」「現状でよい」等の排他制御は全設問で効く', function () {
  var checked = 0;
  Core.eachQuestion(schema, function (q) {
    (q.options || []).forEach(function (option) {
      if (!option.exclusive) return;
      checked += 1;
      var other = q.options.filter(function (o) { return o.value !== option.value && !o.exclusive; })[0];
      var base = q.id === 'snb_interest_features' || q.id === 'conversion_factors' || q.id === 'nonuse_reasons' || q.id === 'consideration_actions' ? A.nonuser() : A.user();
      var bad = Core.processAnswers(schema, Object.assign({}, base, (function () { var o = {}; o[q.id] = [option.value, other.value]; return o; })()));
      assert.ok(bad.errors.some(function (e) { return e.field === q.id && e.code === 'EXCLUSIVE_CONFLICT'; }), q.id + ' ' + option.value);
    });
  });
  assert.ok(checked >= 10);
  ['preferred_schedule:any', 'usage_purpose:none', 'pricing_preferences:as_is', 'paid_options_interest:none', 'privacy_needs:none'].forEach(function (pair) {
    var p = pair.split(':');
    var single = {}; single[p[0]] = [p[1]];
    assert.strictEqual(Core.processAnswers(schema, Object.assign({}, A.user(), single)).errors.length, 0, pair);
  });
});

test('Q17 privacy_needs は最大3つまで', function () {
  assert.strictEqual(submit(A.user({ privacy_needs: ['whole_rental', 'no_encounter', 'unmanned_entry'] })).ok, true);
  assert.deepStrictEqual(codes(submit(A.user({ privacy_needs: ['whole_rental', 'no_encounter', 'unmanned_entry', 'discreet'] })), 'privacy_needs'), ['TOO_MANY']);
  var q = Core.findQuestion(schema, 'privacy_needs');
  assert.deepStrictEqual(Core.toggleMulti(q, ['whole_rental', 'no_encounter', 'unmanned_entry'], 'discreet', true), ['whole_rental', 'no_encounter', 'unmanned_entry']);
});

test('「その他」自由記述は選択時のみ必須。選択解除で値を破棄する', function () {
  assert.deepStrictEqual(codes(submit(A.user({ usage_purpose: ['other'] })), 'usage_purpose_other'), ['REQUIRED']);
  assert.strictEqual(submit(A.user({ usage_purpose: ['other'], usage_purpose_other: '会議' })).ok, true);
  assert.strictEqual(submit(A.user({ usage_purpose: ['lesson'], usage_purpose_other: '残らない' })).record.usage_purpose_other, '');
  assert.deepStrictEqual(codes(submit(A.user({ primary_alternative_space: 'other' })), 'primary_alternative_space_other'), ['REQUIRED']);
  assert.deepStrictEqual(codes(submit(A.user({ pricing_preferences: ['other'] })), 'pricing_preferences_other'), ['REQUIRED']);
  assert.deepStrictEqual(codes(submit(A.user({ privacy_needs: ['other'] })), 'privacy_needs_other'), ['REQUIRED']);
  assert.deepStrictEqual(codes(submit(A.user({ paid_options_interest: ['other'] })), 'paid_options_interest_other'), ['REQUIRED']);
});

test('Q12A alternative_spaces は任意で、Q12が「まだしていない／借りない」のときは保存しない', function () {
  assert.strictEqual(submit(A.user()).ok, true);
  assert.deepStrictEqual(submit(A.user({ alternative_spaces: ['home', 'outdoor'] })).record.alternative_spaces, ['home', 'outdoor']);
  assert.deepStrictEqual(submit(A.user({ primary_alternative_space: 'not_yet', alternative_spaces: ['home'] })).record.alternative_spaces, []);
});

test('有料オプション: 選択した項目の価格だけ必須。選択解除で価格回答を破棄。無料需要と支払意思を判別できる', function () {
  assert.deepStrictEqual(codes(submit(A.user({ paid_options_interest: ['shower'] })), 'price_shower'), ['REQUIRED']);
  var ok = submit(A.user({ paid_options_interest: ['shower', 'early_late'], price_shower: 'free_only', price_early_late: 'y1000' }));
  assert.strictEqual(ok.ok, true);
  assert.strictEqual(ok.record.price_shower, 'free_only');
  var removed = submit(A.user({ paid_options_interest: ['early_late'], price_shower: 'y500', price_early_late: 'refuse' }));
  assert.strictEqual(removed.record.price_shower, '', '選択解除した項目の価格は破棄');
  assert.strictEqual(removed.record.price_early_late, 'refuse');
  var photo = Core.findQuestion(schema, 'price_photo_equipment');
  assert.ok(photo.options.some(function (o) { return o.kind === 'free_only'; }));
  /* 現行無料備品（照明・ミラー等）を追加サービス候補に混在させない */
  var labels = Core.findQuestion(schema, 'paid_options_interest').options.map(function (o) { return o.label; }).join('|');
  assert.ok(!/ミラー|照明|縄|ロープ|吊り/.test(labels));
  assert.match(Core.findQuestion(schema, 'paid_options_interest').hint, /保証するものではありません/);
});

test('Q13: 現行料金は回答前に表示されない（schema上もreveal内にのみ存在し、Q13/Q14の文言・HTMLに無い）', function () {
  var q13 = Core.findQuestion(schema, 'max_price_3h_weekend');
  assert.match(q13.label, /土日祝・3時間・1室貸切/);
  assert.match(q13.label, /これ以上なら利用を見送る/);
  assert.ok(q13.lockOnLeave);
  var step = schema.steps.filter(function (s) { return s.reveal; })[0];
  assert.strictEqual(step.id, 'price_rating');
  assert.strictEqual(Core.shouldReveal(step, {}), false);
  assert.strictEqual(Core.shouldReveal(step, { max_price_3h_weekend: '' }), false);
  assert.strictEqual(Core.shouldReveal(step, { max_price_3h_weekend: 'p7000' }), true);
  assert.strictEqual(Core.shouldReveal(step, { max_price_3h_weekend: 'unknown' }), true);

  var withoutReveal = JSON.parse(JSON.stringify(schema));
  delete withoutReveal.steps.filter(function (s) { return s.reveal; })[0].reveal;
  var rest = JSON.stringify(withoutReveal);
  ['7,500', '4,000', '5,000円', '6,000円'].forEach(function (price) {
    var hits = rest.split(price).length - 1;
    if (price === '7,500' || price === '4,000') assert.strictEqual(hits, 0, price + ' が reveal 以外に存在する');
  });
  /* 現行料金（7,500円等）は初期HTML・クライアントJS・CSSのどこにも埋め込まない */
  ['survey/index.html', 'scripts/survey-app.js', 'styles/survey.css'].forEach(function (file) {
    var text = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    assert.ok(!/7,?500|4,?000/.test(text), file);
  });
  var q14 = Core.findQuestion(schema, 'current_price_rating');
  assert.ok(!/\d/.test(q14.label));
});

test('表示条件から外れた値・schema外フィールド・不正な型は保存しない／拒否する', function () {
  var polluted = submit(A.nonuser({ evil_field: 'x', __proto__: { a: 1 }, constructor: 'c' }));
  assert.strictEqual(polluted.ok, true);
  assert.ok(!('evil_field' in polluted.record));
  Object.keys(polluted.record).forEach(function (key) {
    assert.ok(Core.responseColumns(schema).indexOf(key) !== -1, '定義外の列が混入: ' + key);
  });

  assert.deepStrictEqual(codes(submit(A.user({ usage_status: 'hacked' })), 'usage_status'), ['INVALID_OPTION']);
  assert.deepStrictEqual(codes(submit(A.user({ usage_purpose: 'self_practice' })), 'usage_purpose'), ['INVALID_TYPE']);
  assert.deepStrictEqual(codes(submit(A.user({ usage_purpose: ['self_practice', 'nope'] })), 'usage_purpose'), ['INVALID_OPTION']);
  assert.deepStrictEqual(codes(submit(A.user({ age: 5 })), 'age'), ['INVALID_TYPE']);
  assert.deepStrictEqual(codes(submit(A.user({ free_feedback: 'x'.repeat(501) })), 'free_feedback'), ['TOO_LONG']);
  assert.deepStrictEqual(codes(submit(A.user({ free_feedback: { a: 1 } })), 'free_feedback'), ['INVALID_TYPE']);
  assert.strictEqual(submit(A.user({ free_feedback: 'x'.repeat(500), support_message: '応援しています' })).ok, true);
});

test('不正なpayloadを拒否する', function () {
  [null, undefined, 'x', 5, [], { answers: null }, { answers: [] }, { answers: {} }].forEach(function (payload) {
    assert.strictEqual(Core.validateSubmission(schema, payload).ok, false);
  });
  assert.strictEqual(Core.validateSubmission(schema, { respondent_hash: 'not-uuid', answers: A.user() }).ok, false);
  assert.strictEqual(Core.validateSubmission(schema, { respondent_hash: HASH, answers: A.user() }).ok, true);
  var wide = {}; for (var i = 0; i < 300; i++) wide['f' + i] = 'x';
  assert.strictEqual(Core.validateSubmission(schema, { respondent_hash: HASH, answers: wide }).ok, false);
});

test('survey_path は英数字・ - _ のみ（32文字まで）', function () {
  assert.strictEqual(submit(A.user(), { survey_path: 'x_main-1' }).record.survey_path, 'x_main-1');
  assert.strictEqual(submit(A.user(), { survey_path: '<script>' }).record.survey_path, '');
  assert.strictEqual(submit(A.user(), { survey_path: 'a'.repeat(33) }).record.survey_path, '');
});

test('recordToRow / rowToRecord: 列順・multi配列・数式インジェクション対策', function () {
  var result = submit(A.user({ free_feedback: '=HYPERLINK("http://evil")', support_message: '+1 応援' }));
  var row = Core.recordToRow(schema, result.record, '2026-10-08T00:00:00.000Z');
  var columns = Core.responseColumns(schema);
  assert.strictEqual(row.length, columns.length);
  assert.strictEqual(row[columns.indexOf('free_feedback')].charAt(0), "'");
  assert.strictEqual(row[columns.indexOf('support_message')].charAt(0), "'");
  assert.strictEqual(row[columns.indexOf('usage_purpose')], 'self_practice,kinbaku_shoot');
  var back = {};
  columns.forEach(function (c, i) { back[c] = row[i]; });
  var record = Core.rowToRecord(schema, back);
  assert.deepStrictEqual(record.usage_purpose, ['self_practice', 'kinbaku_shoot']);
  assert.strictEqual(record.free_feedback, '=HYPERLINK("http://evil")');
  assert.deepStrictEqual(record.alternative_spaces, []);
});

test('制御文字の除去・改行正規化', function () {
  var result = submit(A.user({ free_feedback: 'a\u0000b\r\nc\u0007' }));
  assert.strictEqual(result.record.free_feedback, 'ab\nc');
});

test('nextStep / visibleSteps: 利用経験で正しい枝に進み、全設問が非表示のステップは飛ばす', function () {
  function path_(answers) {
    var ids = [];
    var step = Core.nextStep(schema, Core.processAnswers(schema, answers).answers, null);
    while (step) { ids.push(step.id); step = Core.nextStep(schema, Core.processAnswers(schema, answers).answers, step.id); }
    return ids;
  }
  var user = path_(A.user());
  assert.ok(user.indexOf('user_experience') !== -1 && user.indexOf('user_feedback') !== -1);
  assert.ok(user.indexOf('nonuser_reasons') === -1 && user.indexOf('nonuser_interest') === -1);
  var non = path_(A.nonuser());
  assert.ok(non.indexOf('user_experience') === -1 && non.indexOf('nonuser_interest') !== -1 && non.indexOf('nonuser_reasons') !== -1);
  var first = path_(A.nonuser({ usage_status: 'first_time' }));
  assert.ok(first.indexOf('nonuser_reasons') === -1 && first.indexOf('nonuser_interest') !== -1);
  assert.strictEqual(user[user.length - 1], 'free_text');
});

test('toggleMulti: 排他・併用不可を即時反映する', function () {
  var q = Core.findQuestion(schema, 'kinbaku_role');
  assert.deepStrictEqual(Core.toggleMulti(q, ['tie', 'unsure'], 'no_interest', true), ['unsure', 'no_interest']);
  assert.deepStrictEqual(Core.toggleMulti(q, ['no_interest'], 'tie', true), ['tie']);
  assert.deepStrictEqual(Core.toggleMulti(q, ['tie'], 'unsure', true), ['tie', 'unsure']);
  var purposes = Core.findQuestion(schema, 'usage_purpose');
  assert.deepStrictEqual(Core.toggleMulti(purposes, ['lesson', 'nawakai'], 'none', true), ['none']);
  assert.deepStrictEqual(Core.toggleMulti(purposes, ['none'], 'lesson', true), ['lesson']);
  assert.deepStrictEqual(Core.toggleMulti(purposes, ['lesson', 'nawakai'], 'lesson', false), ['nawakai']);
});

test('generateUuid: v4形式で、cryptoが無くても生成できる', function () {
  assert.ok(Core.isValidRespondentHash(Core.generateUuid(null)));
  assert.ok(Core.isValidRespondentHash(Core.generateUuid({ getRandomValues: function (a) { for (var i = 0; i < a.length; i++) a[i] = i * 7; } })));
  assert.notStrictEqual(Core.generateUuid(null), Core.generateUuid(null));
});

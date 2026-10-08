/* アンケートのテスト用に「全設問を満たす有効な回答」を組み立てる補助。 */
'use strict';

var USER = {
  age_screening: 'adult', usage_status: 'used', age: 'a30_39', prefecture: 'aichi', aichi_area: 'nagoya',
  kinbaku_role: ['tie', 'tied'], member_composition: 'male_male', group_size: 'p2',
  usage_purpose: ['self_practice', 'kinbaku_shoot'], preferred_duration: 'h3',
  preferred_schedule: ['sat_pm'], preferred_frequency: 'monthly', primary_alternative_space: 'rental_space',
  max_price_3h_weekend: 'p8000', current_price_rating: 'fair', pricing_preferences: ['as_is'],
  paid_options_interest: ['none'], privacy_needs: ['whole_rental', 'unmanned_entry'],
  visit_count: 'six_ten', reuse_intent: 'definitely', good_points: ['privacy'], improvement_points: ['none'],
  awareness_source: 'x'
};

var NONUSER = {
  age_screening: 'adult', usage_status: 'known_not_used', age: 'a25_29', prefecture: 'tokyo',
  kinbaku_role: ['unsure'], member_composition: 'solo', group_size: 'p1',
  usage_purpose: ['portrait_shoot'], preferred_duration: 'h2', preferred_schedule: ['any'],
  preferred_frequency: 'every_2_3m', primary_alternative_space: 'general_studio',
  max_price_3h_weekend: 'p6000', current_price_rating: 'expensive', pricing_preferences: ['weekday_discount'],
  paid_options_interest: ['none'], privacy_needs: ['discreet'],
  nonuse_reasons: ['far'], consideration_actions: ['saw_x'], snb_interest_features: ['privacy'],
  conversion_factors: ['cheaper'], snb_usage_intent_3m: 'probably', awareness_source: 'x'
};

function make(base, overrides) {
  var out = JSON.parse(JSON.stringify(base));
  Object.keys(overrides || {}).forEach(function (key) { out[key] = overrides[key]; });
  return out;
}

module.exports = {
  user: function (overrides) { return make(USER, overrides); },
  nonuser: function (overrides) { return make(NONUSER, overrides); }
};

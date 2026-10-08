/*
 * scripts/survey-analytics.js — アンケート集計（Issue #374）のDOM/GAS非依存ロジック。
 *
 * 入力は survey/survey-schema.json と、SurveyCore.rowToRecordで復元した回答record配列のみ。
 * 再コード定義（地域・利用目的・価格・緊縛ロール）、ファネル定義、クロス集計の組み合わせ、
 * ダッシュボード項目はすべてschemaの analysis セクションが正本で、このファイルには書かない。
 * 管理者Web App（gas/survey/admin/）が呼び、結果だけを画面へ返す（生データは返さない）。
 *
 * 小標本対策: 各セルにnを必ず付け、n < analysis.minCell は low=true を立てる。
 * mask=true のときは low のセルの件数・割合を null にする（公開結果向け）。
 */
'use strict';

var SurveyAnalytics = (function () {
  function core() {
    return typeof SurveyCore !== 'undefined' ? SurveyCore : require('./survey-core.js');
  }

  function sourceQuestion(schema, fieldId) {
    var question = core().findQuestion(schema, fieldId);
    if (question) return question;
    /* 派生列（usage_segment）は元設問の選択肢ラベルを写して使う。 */
    var found = null;
    core().eachQuestion(schema, function (q) {
      if (q.derives && q.derives.field === fieldId) found = q;
    });
    return found ? { id: fieldId, type: 'single', derivedFrom: found } : null;
  }

  function questionLabel(schema, fieldId) {
    var q = core().findQuestion(schema, fieldId);
    return q ? q.label : fieldId;
  }

  function regionClassify(recode) {
    return function (record) {
      var pref = record.prefecture;
      if (!pref) return [];
      if (pref === 'aichi') return [record.aichi_area === 'nagoya' ? 'nagoya' : 'aichi_other'];
      if (recode.tokaiPrefectures.indexOf(pref) !== -1) return ['tokai_other'];
      return ['far'];
    };
  }

  /* 集計軸: { categories:[{key,label}], classify(record) -> キー配列 } */
  function buildAxis(schema, fieldId, recodeId) {
    var analysis = schema.analysis;
    if (recodeId) {
      var recode = analysis.recodes[recodeId];
      var categories = recode.groups.map(function (g) { return { key: g.key, label: g.label }; });
      if (recode.type === 'region') {
        return { id: recodeId, label: recode.label, categories: categories, classify: regionClassify(recode) };
      }
      return {
        id: recodeId,
        label: recode.label,
        categories: categories,
        classify: function (record) {
          var list = core().toList(record[recode.source]);
          var hits = [];
          for (var i = 0; i < recode.groups.length; i++) {
            var group = recode.groups[i];
            var matched = list.some(function (v) { return group.values.indexOf(v) !== -1; });
            if (matched) {
              hits.push(group.key);
              if (recode.priority) break;
            }
          }
          return hits;
        }
      };
    }
    var question = sourceQuestion(schema, fieldId);
    var options = question && question.derivedFrom ? question.derivedFrom.options : (question && question.options) || [];
    var map = question && question.derivedFrom ? question.derivedFrom.derives.map : null;
    var cats = options.map(function (o) { return { key: map ? map[o.value] : o.value, label: o.label }; });
    return {
      id: fieldId,
      label: questionLabel(schema, fieldId),
      categories: cats,
      classify: function (record) {
        var known = cats.map(function (c) { return c.key; });
        return core().toList(record[fieldId]).filter(function (v) { return known.indexOf(v) !== -1; });
      }
    };
  }

  function distributionByAxis(axis, records) {
    var counts = {};
    var answered = 0;
    records.forEach(function (record) {
      var keys = axis.classify(record);
      if (!keys.length) return;
      answered += 1;
      keys.forEach(function (key) { counts[key] = (counts[key] || 0) + 1; });
    });
    return {
      n: answered,
      items: axis.categories.map(function (c) {
        var count = counts[c.key] || 0;
        return { key: c.key, label: c.label, count: count, share: answered ? count / answered : 0 };
      })
    };
  }

  function distribution(schema, records, fieldId, recodeId) {
    var axis = buildAxis(schema, fieldId, recodeId);
    var result = distributionByAxis(axis, records);
    result.id = axis.id;
    result.label = axis.label;
    return result;
  }

  /*
   * クロス集計。行カテゴリ別に「その行に属し、かつ列変数に回答した人」を母数(row.n)とし、
   * 各セルに件数(count)・行内割合(share)・low(count < minCell) を付ける。
   * 複数選択の軸では1人が複数カテゴリへ入る（行・列とも）。
   */
  function crosstab(schema, records, spec, options) {
    var minCell = (options && options.minCell) || schema.analysis.minCell;
    var mask = !!(options && options.mask);
    var rowAxis = buildAxis(schema, spec.row, spec.rowRecode);
    var colAxis = buildAxis(schema, spec.col, spec.colRecode);

    var rows = rowAxis.categories.map(function (rowCat) {
      var members = records.filter(function (record) { return rowAxis.classify(record).indexOf(rowCat.key) !== -1; });
      var base = 0;
      var counts = {};
      members.forEach(function (record) {
        var keys = colAxis.classify(record);
        if (!keys.length) return;
        base += 1;
        keys.forEach(function (key) { counts[key] = (counts[key] || 0) + 1; });
      });
      return {
        key: rowCat.key,
        label: rowCat.label,
        n: base,
        cells: colAxis.categories.map(function (colCat) {
          var count = counts[colCat.key] || 0;
          var low = count < minCell;
          return {
            key: colCat.key,
            count: mask && low ? null : count,
            share: mask && low ? null : (base ? count / base : 0),
            low: low
          };
        })
      };
    });
    return {
      id: spec.id,
      label: spec.label,
      aux: !!spec.aux,
      minCell: minCell,
      columns: colAxis.categories,
      rows: rows
    };
  }

  /* 入れ子ファネル。各段階は前段階を通過した人だけが分母。 */
  function nestedFunnel(schema, records, definition) {
    var core_ = core();
    var population = records.filter(function (r) { return core_.evalCondition(definition.population, r); });
    var current = population;
    var previous = population.length;
    var stages = definition.stages.map(function (stage) {
      current = current.filter(function (r) { return core_.evalCondition(stage.cond, r); });
      var count = current.length;
      var row = {
        key: stage.key,
        label: stage.label,
        count: count,
        rateFromPrevious: previous ? count / previous : 0,
        rateFromStart: population.length ? count / population.length : 0,
        low: count < schema.analysis.minCell
      };
      previous = count;
      return row;
    });
    var result = { label: definition.label, total: population.length, stages: stages };
    if (definition.outside) {
      var outside = records.filter(function (r) { return core_.evalCondition(definition.outside.population, r); });
      var hit = outside.filter(function (r) { return core_.evalCondition(definition.outside.metric.cond, r); });
      result.outside = {
        label: definition.outside.label,
        metricLabel: definition.outside.metric.label,
        total: outside.length,
        count: hit.length,
        rate: outside.length ? hit.length / outside.length : 0,
        low: hit.length < schema.analysis.minCell
      };
    }
    return result;
  }

  /* 有料オプション価格受容曲線。金額P以上を許容した人の割合（選択者のうち価格質問に回答した人が分母）。 */
  function priceAcceptance(schema, records, spec) {
    var question = core().findQuestion(schema, spec.question);
    var interested = records.filter(function (r) { return core().toList(r.paid_options_interest).indexOf(spec.option) !== -1; });
    var answered = interested.filter(function (r) { return r[spec.question]; });
    function willingness(record) {
      var option = core().findOption(question, record[spec.question]);
      if (!option || option.kind === 'free_only' || option.kind === 'refuse') return 0;
      return option.amount || 0;
    }
    var amounts = [];
    question.options.forEach(function (o) {
      if (o.amount && amounts.indexOf(o.amount) === -1) amounts.push(o.amount);
    });
    amounts.sort(function (a, b) { return a - b; });
    var freeOnly = answered.filter(function (r) {
      var o = core().findOption(question, r[spec.question]);
      return o && (o.kind === 'free_only' || o.kind === 'refuse');
    }).length;
    var above = answered.filter(function (r) {
      var o = core().findOption(question, r[spec.question]);
      return o && o.kind === 'above';
    }).length;
    return {
      option: spec.option,
      label: spec.label,
      interested: interested.length,
      interestRate: records.length ? interested.length / records.length : 0,
      answered: answered.length,
      freeOnly: freeOnly,
      freeOnlyRate: answered.length ? freeOnly / answered.length : 0,
      aboveCount: above,
      points: amounts.map(function (amount) {
        var count = answered.filter(function (r) { return willingness(r) >= amount; }).length;
        return {
          amount: amount,
          count: count,
          share: answered.length ? count / answered.length : 0,
          low: answered.length < schema.analysis.minCell
        };
      })
    };
  }

  function segmentComparison(schema, records) {
    var core_ = core();
    var axis = buildAxis(schema, 'usage_segment');
    var funnels = schema.analysis.funnels;
    function stageCond(funnel, key) {
      return funnel.stages.filter(function (stage) { return stage.key === key; })[0].cond;
    }
    return axis.categories.map(function (cat) {
      var members = records.filter(function (r) { return r.usage_segment === cat.key; });
      var used = members.filter(function (r) { return r.usage_status === 'used'; });
      var nonUsers = members.filter(function (r) { return core_.evalCondition(funnels.nonuser.population, r); });
      var positive = nonUsers.filter(function (r) { return core_.evalCondition(stageCond(funnels.nonuser, 'intent'), r); });
      var reuse = used.filter(function (r) { return core_.evalCondition(stageCond(funnels.user, 'reuse'), r); });
      var ge8000 = members.filter(function (r) { return core_.evalCondition(stageCond(funnels.nonuser, 'price_acceptance'), r); });
      var priced = members.filter(function (r) { return r.max_price_3h_weekend; });
      return {
        key: cat.key,
        label: cat.label,
        n: members.length,
        usedRate: members.length ? used.length / members.length : 0,
        nonUserIntentN: nonUsers.length,
        nonUserIntentRate: nonUsers.length ? positive.length / nonUsers.length : 0,
        reuseN: used.length,
        reuseRate: used.length ? reuse.length / used.length : 0,
        priceN: priced.length,
        priceGe8000Rate: priced.length ? ge8000.length / priced.length : 0,
        low: members.length < schema.analysis.minCell
      };
    });
  }

  function jstDate(value) {
    var date = value instanceof Date ? value : new Date(value);
    if (isNaN(date.getTime())) return '';
    var jst = new Date(date.getTime() + 9 * 3600 * 1000);
    return jst.toISOString().slice(0, 10);
  }

  /* ステップ到達数（離脱計測）。events: [{respondent_hash, step_id}]。同一respondentの重複は1回。 */
  function stepReach(schema, events) {
    var seen = {};
    var counts = {};
    events.forEach(function (event) {
      var key = event.respondent_hash + '|' + event.step_id;
      if (seen[key]) return;
      seen[key] = true;
      counts[event.step_id] = (counts[event.step_id] || 0) + 1;
    });
    var first = null;
    return schema.steps.map(function (step) {
      var count = counts[step.id] || 0;
      if (first === null) first = count;
      return { id: step.id, title: step.title, count: count, rateFromFirst: first ? count / first : 0 };
    });
  }

  /*
   * ダッシュボード一式。filter.segment で usage_segment を絞り込む（all=全体）。
   * 自由記述は日付(JST)単位に丸めた投稿日とともに返す。個別のtimestampは返さない。
   * records: rowToRecord済み＋ timestamp(Date|string|undefined)。
   */
  function buildDashboard(schema, allRecords, events, filter) {
    var segment = filter && filter.segment && filter.segment !== 'all' ? filter.segment : null;
    var records = segment ? allRecords.filter(function (r) { return r.usage_segment === segment; }) : allRecords;
    var analysis = schema.analysis;
    var core_ = core();

    var used = records.filter(function (r) { return r.usage_status === 'used'; });
    var preAware = records.filter(function (r) { return r.usage_status && r.usage_status !== 'first_time'; });
    var firstTime = records.filter(function (r) { return r.usage_status === 'first_time'; });
    var n = records.length;

    var distributions = analysis.dashboard.map(function (item) {
      var out = { id: item.id, label: item.label || questionLabel(schema, item.field) };
      var dist = distribution(schema, records, item.field, item.recode);
      out.n = dist.n;
      out.items = dist.items;
      if (item.splitUsed) {
        out.split = [
          { label: '利用経験者', dist: distribution(schema, used, item.field, item.recode) },
          { label: '未利用者', dist: distribution(schema, records.filter(function (r) { return r.usage_status && r.usage_status !== 'used'; }), item.field, item.recode) }
        ];
      }
      return out;
    });

    var crosstabs = analysis.crosstabs.map(function (spec) {
      var result = crosstab(schema, records, spec);
      if (spec.aux && n < analysis.auxMinN) {
        result.suppressed = true;
        result.rows = [];
        result.columns = [];
      }
      return result;
    });

    var freeText = [];
    records.forEach(function (r) {
      if (r.free_feedback || r.support_message) {
        freeText.push({ date: jstDate(r.timestamp), free_feedback: r.free_feedback || '', support_message: r.support_message || '' });
      }
    });
    freeText.sort(function (a, b) { return a.date < b.date ? 1 : a.date > b.date ? -1 : 0; });

    var byDate = {};
    records.forEach(function (r) {
      var d = jstDate(r.timestamp);
      if (d) byDate[d] = (byDate[d] || 0) + 1;
    });

    return {
      filter: { segment: segment || 'all' },
      minCell: analysis.minCell,
      summary: {
        n: n,
        usedRate: n ? used.length / n : 0,
        preAwarenessRate: n ? preAware.length / n : 0,
        firstTimeRate: n ? firstTime.length / n : 0
      },
      distributions: distributions,
      priceAcceptance: analysis.paidOptionPrices.map(function (spec) { return priceAcceptance(schema, records, spec); }),
      funnels: {
        nonuser: nestedFunnel(schema, records, analysis.funnels.nonuser),
        user: nestedFunnel(schema, records, analysis.funnels.user)
      },
      segmentComparison: segmentComparison(schema, allRecords),
      crosstabs: crosstabs,
      stepReach: stepReach(schema, events || []),
      responsesByDate: Object.keys(byDate).sort().map(function (d) { return { date: d, count: byDate[d] }; }),
      freeText: freeText
    };
  }

  return {
    buildAxis: buildAxis,
    distribution: distribution,
    crosstab: crosstab,
    nestedFunnel: nestedFunnel,
    priceAcceptance: priceAcceptance,
    segmentComparison: segmentComparison,
    stepReach: stepReach,
    buildDashboard: buildDashboard,
    jstDate: jstDate
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = SurveyAnalytics;

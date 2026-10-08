/*
 * scripts/survey-core.js — 利用・市場調査アンケート（Issue #374）のDOM非依存コア。
 *
 * 設問定義の正本は survey/survey-schema.json の1ファイルのみ。このファイルは、そのschemaを
 * 入力として「表示条件の評価」「入力の正規化・検証」「保存行への変換」だけを行う。
 * ブラウザ（scripts/survey-app.js）とGAS（gas/survey/）の両方が、このファイルそのものを
 * 読み込んで使う（GAS側へは scripts/prepare-survey-gas-project.js がコピーする）。
 * そのため設問文・選択肢・必須/任意・条件分岐・排他制御はここにもGAS側にも書かない。
 *
 * 値の規約:
 *   single/text → 文字列（未回答・条件外は ""）
 *   multi       → 文字列配列（未回答・条件外は []）
 *   条件から外れた設問（自由記述欄を含む）の値は、必ず上記の空値へ破棄される。
 */
'use strict';

var SurveyCore = (function () {
  var UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  var SURVEY_PATH_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
  var CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
  var FORMULA_TRIGGER = /^[=+\-@\t\r]/;
  var MAX_PAYLOAD_FIELDS = 200;

  function isEmptyValue(value) {
    return value === undefined || value === null || value === '' ||
      (Array.isArray(value) && value.length === 0);
  }

  function toList(value) {
    if (Array.isArray(value)) return value;
    return isEmptyValue(value) ? [] : [value];
  }

  /* 条件式の評価。cond が無ければ常に真。
     {all:[..]} {any:[..]} {not:..} / {q, eq|in|notIn|includes|notIncludes|includesAny|nonEmpty} */
  function evalCondition(cond, answers) {
    if (!cond) return true;
    var i;
    if (cond.all) {
      for (i = 0; i < cond.all.length; i++) if (!evalCondition(cond.all[i], answers)) return false;
      return true;
    }
    if (cond.any) {
      for (i = 0; i < cond.any.length; i++) if (evalCondition(cond.any[i], answers)) return true;
      return false;
    }
    if (cond.not) return !evalCondition(cond.not, answers);

    var value = answers ? answers[cond.q] : undefined;
    var list = toList(value);
    if (Object.prototype.hasOwnProperty.call(cond, 'eq')) return value === cond.eq;
    if (cond.in) return !Array.isArray(value) && cond.in.indexOf(value) !== -1;
    if (cond.notIn) {
      for (i = 0; i < list.length; i++) if (cond.notIn.indexOf(list[i]) !== -1) return false;
      return true;
    }
    if (Object.prototype.hasOwnProperty.call(cond, 'includes')) return list.indexOf(cond.includes) !== -1;
    if (Object.prototype.hasOwnProperty.call(cond, 'notIncludes')) return list.indexOf(cond.notIncludes) === -1;
    if (cond.includesAny) {
      for (i = 0; i < cond.includesAny.length; i++) if (list.indexOf(cond.includesAny[i]) !== -1) return true;
      return false;
    }
    if (Object.prototype.hasOwnProperty.call(cond, 'nonEmpty')) return cond.nonEmpty ? !isEmptyValue(value) : isEmptyValue(value);
    return false;
  }

  function eachQuestion(schema, callback) {
    schema.steps.forEach(function (step) {
      step.questions.forEach(function (question) { callback(question, step); });
    });
  }

  function findQuestion(schema, id) {
    var found = null;
    eachQuestion(schema, function (question) { if (question.id === id) found = question; });
    return found;
  }

  /* その設問が保存する列（設問ID→その他自由記述→派生列の順）。 */
  function fieldsOfQuestion(question) {
    var fields = [question.id];
    (question.otherTexts || []).forEach(function (other) {
      if (fields.indexOf(other.field) === -1) fields.push(other.field);
    });
    if (question.derives) fields.push(question.derives.field);
    return fields;
  }

  function responseFields(schema) {
    var fields = [];
    eachQuestion(schema, function (question) {
      fieldsOfQuestion(question).forEach(function (field) { fields.push(field); });
    });
    return fields;
  }

  /* responsesシートの列順。schemaから生成するので、列定義をコード側に二重管理しない。 */
  function responseColumns(schema) {
    return ['timestamp', 'respondent_hash'].concat(responseFields(schema)).concat(['survey_path', 'is_test']);
  }

  function eventColumns() {
    return ['timestamp', 'respondent_hash', 'step_id', 'is_test'];
  }

  /* 旧Spreadsheetに無くてもよい末尾列の数（Issue #381）。ヘッダに無ければ書き込み時に追加する。 */
  var OPTIONAL_TAIL_COLUMNS = 1;

  /* テスト回答/イベントの印。1/'1'/true のみ真。空欄・0・その他は本番扱い（既存行は空欄＝本番）。 */
  function isTestFlag(value) {
    return value === 1 || value === '1' || value === true;
  }

  /* 送信payloadの is_test。厳密に 1 / true のときだけテスト（?test=1 のみ。"true"文字列等は本番扱い）。 */
  function normalizeTestFlag(value) {
    return value === 1 || value === true ? 1 : 0;
  }

  function emptyValueFor(question) {
    return question.type === 'multi' ? [] : '';
  }

  function optionValues(question) {
    return (question.options || []).map(function (option) { return option.value; });
  }

  function findOption(question, value) {
    var options = question.options || [];
    for (var i = 0; i < options.length; i++) if (options[i].value === value) return options[i];
    return null;
  }

  function cleanText(value) {
    return String(value).replace(/\r\n?/g, '\n').replace(CONTROL_CHARS, '').trim();
  }

  function setEmpty(answers, question) {
    fieldsOfQuestion(question).forEach(function (field) {
      answers[field] = field === question.id ? emptyValueFor(question) : '';
    });
  }

  function processOtherTexts(question, input, answers, selected, errors) {
    (question.otherTexts || []).forEach(function (other) {
      var active = selected.indexOf(other.when) !== -1;
      var limit = other.maxLength || 100;
      var raw = input[other.field];
      if (!active) {
        if (!(other.field in answers)) answers[other.field] = '';
        return;
      }
      if (raw !== undefined && raw !== null && typeof raw !== 'string') {
        errors.push({ field: other.field, code: 'INVALID_TYPE' });
        raw = '';
      }
      var text = cleanText(raw || '');
      if (text.length > limit) {
        errors.push({ field: other.field, code: 'TOO_LONG' });
        text = '';
      }
      if (!text && other.required) errors.push({ field: other.field, code: 'REQUIRED' });
      answers[other.field] = text;
    });
  }

  function processSingle(question, input, answers, errors) {
    var raw = input[question.id];
    var value = '';
    if (raw !== undefined && raw !== null && raw !== '') {
      if (typeof raw !== 'string') errors.push({ field: question.id, code: 'INVALID_TYPE' });
      else if (!findOption(question, raw)) errors.push({ field: question.id, code: 'INVALID_OPTION' });
      else value = raw;
    }
    if (!value && question.required && !errors.some(function (e) { return e.field === question.id; })) {
      errors.push({ field: question.id, code: 'REQUIRED' });
    }
    answers[question.id] = value;
    return value ? [value] : [];
  }

  function processMulti(question, input, answers, errors) {
    var raw = input[question.id];
    var before = errors.length;
    var picked = [];
    if (raw !== undefined && raw !== null && raw !== '') {
      if (!Array.isArray(raw)) {
        errors.push({ field: question.id, code: 'INVALID_TYPE' });
      } else {
        raw.forEach(function (item) {
          if (typeof item !== 'string' || !findOption(question, item)) {
            errors.push({ field: question.id, code: 'INVALID_OPTION' });
          } else if (picked.indexOf(item) === -1) {
            picked.push(item);
          }
        });
      }
    }
    /* 保存順は選択肢の定義順に正規化する。 */
    var ordered = optionValues(question).filter(function (value) { return picked.indexOf(value) !== -1; });

    ordered.forEach(function (value) {
      var option = findOption(question, value);
      if (option.exclusive && ordered.length > 1) errors.push({ field: question.id, code: 'EXCLUSIVE_CONFLICT' });
      (option.conflictsWith || []).forEach(function (other) {
        if (ordered.indexOf(other) !== -1) errors.push({ field: question.id, code: 'EXCLUSIVE_CONFLICT' });
      });
    });
    if (question.maxSelect && ordered.length > question.maxSelect) {
      errors.push({ field: question.id, code: 'TOO_MANY' });
    }
    if (!ordered.length && question.required && errors.length === before) {
      errors.push({ field: question.id, code: 'REQUIRED' });
    }
    answers[question.id] = ordered;
    return ordered;
  }

  function processText(question, input, answers, errors) {
    var raw = input[question.id];
    var text = '';
    if (raw !== undefined && raw !== null && raw !== '') {
      if (typeof raw !== 'string') {
        errors.push({ field: question.id, code: 'INVALID_TYPE' });
      } else {
        text = cleanText(raw);
        if (text.length > (question.maxLength || 500)) {
          errors.push({ field: question.id, code: 'TOO_LONG' });
          text = '';
        }
      }
    }
    if (!text && question.required && !errors.some(function (e) { return e.field === question.id; })) {
      errors.push({ field: question.id, code: 'REQUIRED' });
    }
    answers[question.id] = text;
    return [];
  }

  /*
   * 入力の正規化と検証（ブラウザ・サーバー共通）。
   * - schema順に走査し、表示条件を満たさない設問は値（自由記述・派生列を含む）をすべて空へ破棄する。
   *   前の設問が破棄された結果を使って後続の条件を評価するため、親が非表示なら子も必ず非表示になる。
   * - schemaに無いキーは結果に含めない（保存しない）。
   * - 非表示の必須設問は検証対象外（送信不能にならない）。
   * 戻り値: { answers: 全列分の正規化済み値, errors: [{field, code}] }
   */
  function processAnswers(schema, rawAnswers) {
    var input = rawAnswers && typeof rawAnswers === 'object' && !Array.isArray(rawAnswers) ? rawAnswers : {};
    var answers = {};
    var errors = [];

    eachQuestion(schema, function (question) {
      if (!evalCondition(question.showIf, answers)) {
        setEmpty(answers, question);
        return;
      }
      var selected;
      if (question.type === 'multi') selected = processMulti(question, input, answers, errors);
      else if (question.type === 'text') selected = processText(question, input, answers, errors);
      else selected = processSingle(question, input, answers, errors);

      processOtherTexts(question, input, answers, selected, errors);

      if (question.derives) {
        var source = answers[question.id];
        answers[question.derives.field] = (typeof source === 'string' && question.derives.map[source]) || '';
      }
    });
    return { answers: answers, errors: errors };
  }

  function stepFields(step) {
    var fields = [];
    step.questions.forEach(function (question) {
      fieldsOfQuestion(question).forEach(function (field) { fields.push(field); });
    });
    return fields;
  }

  function stepErrors(step, errors) {
    var fields = stepFields(step);
    return errors.filter(function (error) { return fields.indexOf(error.field) !== -1; });
  }

  function isQuestionVisible(question, answers) {
    return evalCondition(question.showIf, answers);
  }

  /* 表示すべき設問が1つ以上あるステップだけを返す（表示条件で全設問が外れたステップは飛ばす）。 */
  function visibleSteps(schema, answers) {
    return schema.steps.filter(function (step) {
      return step.questions.some(function (question) { return isQuestionVisible(question, answers); });
    });
  }

  /* currentStepId の次に表示すべきステップ（schema順で後ろにある最初の表示対象）。無ければ null。 */
  function nextStep(schema, answers, currentStepId) {
    var passed = currentStepId === null || currentStepId === undefined;
    var steps = schema.steps;
    for (var i = 0; i < steps.length; i++) {
      if (!passed) {
        if (steps[i].id === currentStepId) passed = true;
        continue;
      }
      if (steps[i].questions.some(function (q) { return isQuestionVisible(q, answers); })) return steps[i];
    }
    return null;
  }

  /* 現行料金などの開示パネルを出してよいか。開示の前提設問に回答済みの場合のみ真。 */
  function shouldReveal(step, answers) {
    return !!(step.reveal && !isEmptyValue(answers[step.reveal.requires]));
  }

  function isValidRespondentHash(value) {
    return typeof value === 'string' && UUID_PATTERN.test(value);
  }

  function sanitizeSurveyPath(value) {
    return typeof value === 'string' && SURVEY_PATH_PATTERN.test(value) ? value : '';
  }

  /*
   * 送信payload全体のサーバー側検証。
   * payload: { respondent_hash, survey_path, answers: {...} }
   * 戻り値: { ok, errors, record }。ok=falseのとき record は null。
   * 18歳以上でない回答は保存しない（AGE_NOT_ELIGIBLE）。
   */
  function validateSubmission(schema, payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return { ok: false, errors: [{ field: 'payload', code: 'INVALID_PAYLOAD' }], record: null };
    }
    if (!payload.answers || typeof payload.answers !== 'object' || Array.isArray(payload.answers) ||
        Object.keys(payload.answers).length > MAX_PAYLOAD_FIELDS) {
      return { ok: false, errors: [{ field: 'answers', code: 'INVALID_PAYLOAD' }], record: null };
    }
    if (!isValidRespondentHash(payload.respondent_hash)) {
      return { ok: false, errors: [{ field: 'respondent_hash', code: 'INVALID_RESPONDENT' }], record: null };
    }
    var ageField = schema.meta.ageField;
    if (payload.answers[ageField] === schema.meta.ageBlockValue) {
      return { ok: false, errors: [{ field: ageField, code: 'AGE_NOT_ELIGIBLE' }], record: null };
    }
    var processed = processAnswers(schema, payload.answers);
    if (processed.errors.length) return { ok: false, errors: processed.errors, record: null };

    var record = { respondent_hash: payload.respondent_hash };
    Object.keys(processed.answers).forEach(function (field) { record[field] = processed.answers[field]; });
    record.survey_path = sanitizeSurveyPath(payload.survey_path);
    record.is_test = normalizeTestFlag(payload.is_test);
    return { ok: true, errors: [], record: record };
  }

  /* 数式インジェクション対策。シートが値を数式として解釈しないよう、先頭に ' を付ける。 */
  function guardFormula(text) {
    return FORMULA_TRIGGER.test(text) ? "'" + text : text;
  }

  function unguardFormula(text) {
    return text.charAt(0) === "'" && FORMULA_TRIGGER.test(text.slice(1)) ? text.slice(1) : text;
  }

  /* record → responsesシートの1行（列順はresponseColumns）。timestampは呼び出し側が渡す。 */
  function recordToRow(schema, record, timestamp) {
    var textFields = {};
    eachQuestion(schema, function (question) {
      if (question.type === 'text') textFields[question.id] = true;
      (question.otherTexts || []).forEach(function (other) { textFields[other.field] = true; });
    });
    return responseColumns(schema).map(function (column) {
      if (column === 'timestamp') return timestamp;
      var value = record[column];
      if (Array.isArray(value)) return value.join(',');
      if (value === undefined || value === null) return '';
      var text = String(value);
      return textFields[column] ? guardFormula(text) : text;
    });
  }

  /* シートから読んだ行(オブジェクト) → 分析用record（multiは配列へ戻す）。 */
  function rowToRecord(schema, rowObject) {
    var multi = {};
    var text = {};
    eachQuestion(schema, function (question) {
      if (question.type === 'multi') multi[question.id] = true;
      if (question.type === 'text') text[question.id] = true;
      (question.otherTexts || []).forEach(function (other) { text[other.field] = true; });
    });
    var record = {};
    responseColumns(schema).forEach(function (column) {
      var value = rowObject[column];
      if (value === undefined || value === null) value = '';
      if (multi[column]) record[column] = value === '' ? [] : String(value).split(',');
      else if (text[column]) record[column] = unguardFormula(String(value));
      else record[column] = value;
    });
    return record;
  }

  function generateUuid(cryptoObject) {
    var c = cryptoObject;
    if (c && typeof c.randomUUID === 'function') return c.randomUUID();
    var bytes = new Array(16);
    var i;
    if (c && typeof c.getRandomValues === 'function') {
      var buf = new Uint8Array(16);
      c.getRandomValues(buf);
      for (i = 0; i < 16; i++) bytes[i] = buf[i];
    } else {
      for (i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
    }
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    var hex = bytes.map(function (b) { return (b + 0x100).toString(16).slice(1); }).join('');
    return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-' +
      hex.slice(16, 20) + '-' + hex.slice(20);
  }

  /* 複数選択のチェック操作。排他(exclusive)・併用不可(conflictsWith)・上限(maxSelect)を反映した新しい選択配列を返す。 */
  function toggleMulti(question, current, value, checked) {
    var selected = toList(current).slice();
    var option = findOption(question, value);
    if (!option) return selected;
    if (!checked) return selected.filter(function (item) { return item !== value; });

    if (selected.indexOf(value) === -1) selected.push(value);
    if (option.exclusive) {
      selected = [value];
    } else {
      selected = selected.filter(function (item) {
        if (item === value) return true;
        var other = findOption(question, item);
        if (other && other.exclusive) return false;
        if ((option.conflictsWith || []).indexOf(item) !== -1) return false;
        if (((other && other.conflictsWith) || []).indexOf(value) !== -1) return false;
        return true;
      });
    }
    if (question.maxSelect && selected.length > question.maxSelect) {
      return toList(current).slice();
    }
    return optionValues(question).filter(function (item) { return selected.indexOf(item) !== -1; });
  }

  return {
    evalCondition: evalCondition,
    isEmptyValue: isEmptyValue,
    toList: toList,
    eachQuestion: eachQuestion,
    findQuestion: findQuestion,
    findOption: findOption,
    fieldsOfQuestion: fieldsOfQuestion,
    responseFields: responseFields,
    responseColumns: responseColumns,
    eventColumns: eventColumns,
    optionalTailColumns: OPTIONAL_TAIL_COLUMNS,
    isTestFlag: isTestFlag,
    normalizeTestFlag: normalizeTestFlag,
    processAnswers: processAnswers,
    stepFields: stepFields,
    stepErrors: stepErrors,
    isQuestionVisible: isQuestionVisible,
    visibleSteps: visibleSteps,
    nextStep: nextStep,
    shouldReveal: shouldReveal,
    isValidRespondentHash: isValidRespondentHash,
    sanitizeSurveyPath: sanitizeSurveyPath,
    validateSubmission: validateSubmission,
    recordToRow: recordToRow,
    rowToRecord: rowToRecord,
    generateUuid: generateUuid,
    toggleMulti: toggleMulti,
    cleanText: cleanText
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = SurveyCore;

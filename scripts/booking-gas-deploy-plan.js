#!/usr/bin/env node
'use strict';
/*
 * Issue #874: Booking GAS本番workflow（.github/workflows/booking-gas-production.yml）の
 * 入力検査と運営向けRun Summaryを1か所にまとめる。GAS・Google・GitHub APIには一切アクセスしない。
 *
 *   plan               承認前（validate job）: 入力を検査し、実行計画（scope・対象・対象外）を書く
 *   approved           承認後（deploy job先頭）: 同じ検査をもう一度行い、承認を通過してjobが始まったことを書く
 *   passed <STAGE>     読取り段階（TEST／PREFLIGHT_*）の成功を1行書く
 *   stop <STAGE>       失敗した段階に応じて「更新前停止」「部分適用/UNKNOWN」などを書く（終了コードは0。workflow側でexit 1）
 *   done               全段階成功時の完了表示（更新した対象・更新していない対象・次の手順）
 *
 * 表示するのは scope・main SHAの先頭12桁・対象名・段階・固定コードだけ。Secret・Script/Deployment ID・
 * メール・clasp生出力は扱わない（このスクリプトには渡されない／読まない）。
 */
var fs = require('fs');
var path = require('path');

var SCOPES = {
  full: { admin: true, public: true },
  'admin-only': { admin: true, public: false },
  'public-only': { admin: false, public: true }
};
var LABEL = { admin: 'Booking Admin', public: 'Booking Web App（Public）' };
var NO_RETRY = '無条件の再実行・自動rollbackはしません。対象Deploymentの状態を読取りで確認してから次の操作を判断してください。';

var READ_ONLY_STAGES = {
  TEST: 'テスト',
  TEST_ISOLATION: 'テスト隔離の確認（プロセス・ファイルの残存またはworkspace変更）',
  PREFLIGHT_ADMIN: 'Booking Admin preflight（読取り）',
  PREFLIGHT_PUBLIC: 'Booking Web App preflight（読取り）',
  SCHEMA_GUARD: 'Bookings schema guard（読取り）'
};
var STAGE_TARGET = {
  PREFLIGHT_ADMIN: 'admin', PREFLIGHT_PUBLIC: 'public', SCHEMA_GUARD: 'public',
  UPDATE_ADMIN: 'admin', UPDATE_PUBLIC: 'public', VERIFY_ADMIN: 'admin', VERIFY_PUBLIC: 'public'
};

function fail(message) {
  process.stderr.write(message + '\n');
  process.exit(1);
}

function writeSummary(lines) {
  var file = process.env.GITHUB_STEP_SUMMARY;
  if (file) fs.appendFileSync(file, lines.join('\n') + '\n');
}

function readScope() {
  var scope = process.env.SCOPE;
  if (!Object.prototype.hasOwnProperty.call(SCOPES, scope || '')) {
    fail('scope must be full, admin-only or public-only. Nothing was changed.');
  }
  return scope;
}

/* 承認前・承認後の両方で同じ検査を行う（どちらも書込み前）。 */
function readInputs() {
  var scope = readScope();
  var migrated = process.env.SCHEMA_MIGRATED;
  if (migrated !== 'true' && migrated !== 'false') {
    fail('schema_migrated must be true or false. Nothing was changed.');
  }
  if (scope === 'public-only' && migrated === 'true') {
    fail('schema_migrated=true cannot be combined with scope=public-only. A Bookings schema change must go through ' +
      'scope=admin-only -> migrateBookingsSchema (Booking Admin Apps Script editor) -> scope=full with schema_migrated=true. Nothing was changed.');
  }
  if (process.env.GITHUB_REF !== 'refs/heads/main') {
    fail('This workflow runs only from main. Nothing was changed.');
  }
  if (!/^[0-9a-f]{40}$/.test(process.env.GITHUB_SHA || '')) {
    fail('GITHUB_SHA is not a 40-digit commit SHA; nothing was changed.');
  }
  return { scope: scope, migrated: migrated === 'true', sha: process.env.GITHUB_SHA };
}

function targetLines(scope) {
  return ['admin', 'public'].map(function (t) {
    return '- ' + LABEL[t] + ': ' + (SCOPES[scope][t] ? '更新対象' : '対象外（読取り・更新とも行わない／skipped）');
  });
}

function markerApplied(target) {
  var dir = process.env.RUNNER_TEMP;
  return Boolean(dir) && fs.existsSync(path.join(dir, 'booking-gas-' + target + '-update-applied'));
}

function plan() {
  var inputs = readInputs();
  writeSummary([
    '## Booking GAS 本番反映',
    '- scope: `' + inputs.scope + '`',
    '- main: `' + inputs.sha.slice(0, 12) + '`（GitHub Actionsが自動取得。反映確認は内部で40桁を厳密照合）',
    '- schema_migrated: `' + String(inputs.migrated) + '`'
  ].concat(targetLines(inputs.scope), [
    '- 次: `booking-production` Environmentの承認（保護ルールはSettingsの設定値に従う）→ 承認後にテスト → preflight → 更新 → post-check',
    '- 承認はテスト成功を意味しません。承認後のテスト・preflight・schema guardが失敗した場合、GASへの書込みは0回で停止します。'
  ]));
  console.log('Booking deploy inputs are valid: scope=' + inputs.scope);
}

function approved() {
  var inputs = readInputs();
  writeSummary([
    '- ✅ 承認: deploy jobが `booking-production` Environmentで開始しました（Required reviewersの有無はSettings依存。この表示はテスト結果ではありません）'
  ]);
  console.log('Deploy job started in booking-production: scope=' + inputs.scope);
}

function passed(stage) {
  readScope();
  if (!Object.prototype.hasOwnProperty.call(READ_ONLY_STAGES, stage || '')) fail('Unknown stage.');
  writeSummary(['- ✅ ' + READ_ONLY_STAGES[stage] + ': OK']);
}

function stop(stage) {
  var scope = readScope();
  var targets = SCOPES[scope];
  var lines = [];
  var message;
  if (Object.prototype.hasOwnProperty.call(READ_ONLY_STAGES, stage || '')) {
    message = READ_ONLY_STAGES[stage] + 'で停止しました。更新前停止: GASへの書込みは0回です（' +
      ['admin', 'public'].filter(function (t) { return targets[t]; }).map(function (t) { return LABEL[t]; }).join('・') +
      'とも変更なし）。原因を直してから新しいrunで起動してください。';
    lines.push('- ❌ ' + message);
    writeSummary(lines);
    process.stderr.write('Stopped before any update (stage=' + stage + '): no GAS deployment was written.\n');
    return;
  }
  var target = STAGE_TARGET[stage];
  if (!target || !targets[target]) fail('Unknown stage for scope ' + scope + '.');
  var other = target === 'admin' ? 'public' : 'admin';
  var applied = markerApplied(target);
  var stderr;

  if (stage === 'UPDATE_ADMIN' || stage === 'UPDATE_PUBLIC') {
    var state = applied
      ? '更新は適用済み・反映確認は未完了（UNKNOWN）'
      : '更新が完了しませんでした（push済みの可能性があるため状態はUNKNOWN）';
    var headline = (stage === 'UPDATE_PUBLIC' && scope === 'full') ? '部分適用/UNKNOWN' : 'UNKNOWN';
    lines.push('- ❌ ' + headline + ': ' + LABEL[target] + ' — ' + state);
    if (!targets[other]) {
      lines.push('- ' + LABEL[other] + ': 対象外（変更なし）');
    } else if (stage === 'UPDATE_ADMIN') {
      lines.push('- ' + LABEL.public + ': 未着手（変更なし）');
    } else {
      lines.push('- ' + LABEL.admin + ': 今回のmainへ更新済み（反映確認OK）');
    }
    if (target === 'admin') {
      stderr = (applied
        ? 'Booking Admin deployment update was applied but its verification failed; '
        : 'Booking Admin update did not complete; ') +
        (targets.public ? 'the Booking Web App was not started.' : 'the Booking Web App is out of scope (unchanged).') +
        ' Check the Admin deployment state read-only before deciding on any re-run.';
    } else {
      stderr = (targets.admin
        ? 'Booking Admin is updated to the current main commit. '
        : 'Booking Admin is out of scope (unchanged). ') +
        (applied
          ? 'The Booking Web App deployment update was applied but its verification failed; check the Web App deployment state.'
          : 'The Booking Web App update did not complete; the Web App deployment state must be checked before re-running.');
    }
  } else {
    lines.push('- ❌ 事後確認未完了/UNKNOWN: ' + LABEL[target] + ' — ' +
      (applied ? 'このrunで更新は成功しましたが、最終post-checkで今回のmainを確認できませんでした'
        : '今回のmainを確認できませんでした'));
    stderr = LABEL[target].replace('（Public）', '') + ' post-check did not confirm the current main commit (read-only retries exhausted). ' +
      'Final confirmation is NOT complete. Check the deployment state read-only before deciding on any re-run; do not assume a rollback.';
  }
  lines.push('- ' + NO_RETRY);
  writeSummary(lines);
  process.stderr.write(stderr + '\n');
}

function done() {
  var scope = readScope();
  var updated = ['admin', 'public'].filter(function (t) { return SCOPES[scope][t]; }).map(function (t) { return LABEL[t]; });
  var untouched = ['admin', 'public'].filter(function (t) { return !SCOPES[scope][t]; }).map(function (t) { return LABEL[t]; });
  var lines = ['- ✅ 完了（scope=`' + scope + '`）: 更新・反映確認OK = ' + updated.join('、') +
    (untouched.length ? ' ／ 更新していない対象 = ' + untouched.join('、') + '（変更なし）' : '')];
  if (scope === 'admin-only') {
    lines.push('- 次の手順: Booking AdminのApps Scriptエディタで `migrateBookingsSchema` を実行し、成功を確認してから scope=`full`・schema_migrated=`true` で実行してください（schema変更・初回bootstrapの場合）。');
    console.log('Booking Admin was updated; the Booking Web App deployment was left unchanged. Run migrateBookingsSchema in the Booking Admin Apps Script editor, then run this workflow with scope=full and schema_migrated=true.');
  } else if (scope === 'public-only') {
    console.log('Booking Web App was updated and verified; the Booking Admin deployment was left unchanged.');
  } else {
    console.log('Booking Admin and Booking Web App were updated and verified.');
  }
  writeSummary(lines);
}

var command = process.argv[2];
var commands = { plan: plan, approved: approved, passed: passed, stop: stop, done: done };
if (!Object.prototype.hasOwnProperty.call(commands, command || '')) fail('Unsupported command.');
commands[command](process.argv[3]);

#!/usr/bin/env bash
# Issue #804 PR-C1: Booking Webhook / Survey(public|admin) の本番更新の前に、更新対象1つについて
# 必要条件を「読取りだけ」で確認する（push / update-deployment / show-file-status は呼ばない）。
#   確認内容: 必須Secrets → 資格情報JSON(と必要ならuser) → (Webhookのみ)独立GAS確認 →
#            list-deployments → 既存Deployment IDの完全一致・一意性 → pull(appsscript.json) → 配布物の組立て
# 第1引数 ROLE は許可リストの固定名（任意のscript path・環境を受け取らない）:
#   booking-webhook | survey-public | survey-admin
# 必要な環境変数: CLASPRC_JSON_VALUE / SCRIPT_ID / DEPLOYMENT_ID / RUNNER_TEMP / GITHUB_WORKSPACE
#   booking-webhook のみ追加: PUBLIC_SCRIPT_ID / ADMIN_SCRIPT_ID（Booking本体と別GASであることの確認）
# 失敗は `GAS preflight failed: role=<ROLE> stage=<段階> code=<固定コード>. No deployment was updated.`
# の固定形式のみ（Secret・ID・メール・clasp生出力は出さない）。preflightは更新権限や将来のAPI成功を保証しない。
set -euo pipefail
# shellcheck source=gas-deployment-list-lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/gas-deployment-list-lib.sh"

role="${1:-}"
case "$role" in
  booking-webhook) clasp_user="booking-owner" ;;
  survey-public|survey-admin) clasp_user="" ;;
  *) echo "Unsupported role" >&2; exit 1 ;;
esac

preflight_dir="$RUNNER_TEMP/gas-preflight-$role"
remote_dir="$RUNNER_TEMP/gas-preflight-remote-$role"
auth_file="$RUNNER_TEMP/.clasprc-preflight-$role.json"
umask 077
list_stdout="$RUNNER_TEMP/gas-preflight-list-$role.stdout"
list_stderr="$RUNNER_TEMP/gas-preflight-list-$role.stderr"
cleanup() { rm -rf "$preflight_dir" "$remote_dir"; rm -f "$auth_file" "$list_stdout" "$list_stderr"; }
trap cleanup EXIT

fail() {
  echo "GAS preflight failed: role=${role} stage=$1 code=$2. No deployment was updated." >&2
  exit 1
}

clasp_cmd() {
  if [[ -n "$clasp_user" ]]; then clasp --auth "$auth_file" --user "$clasp_user" "$@"
  else clasp --auth "$auth_file" "$@"; fi
}

script_id="${SCRIPT_ID:-}"
deployment_id="${DEPLOYMENT_ID:-}"
credential="${CLASPRC_JSON_VALUE:-}"
if [[ -z "$credential" || -z "$script_id" || -z "$deployment_id" ]]; then
  fail SECRETS SECRET_MISSING
fi

# 資格情報: JSONオブジェクトであること。Webhookは booking-owner のtokenも必須（他userへfallbackしない）。
mkdir -p "$remote_dir"
if ! AUTH_FILE="$auth_file" PROJECT_DIR="$remote_dir" SCRIPT_ID="$script_id" CLASP_USER="$clasp_user" \
  SELECTED_CLASPRC_JSON="$credential" node <<'NODE'
const fs = require('fs');
const path = require('path');
let auth;
try {
  auth = JSON.parse(process.env.SELECTED_CLASPRC_JSON);
  if (!auth || typeof auth !== 'object' || Array.isArray(auth)) throw new Error();
} catch (_) { process.exit(1); }
if (process.env.CLASP_USER && (!auth.tokens || !auth.tokens[process.env.CLASP_USER])) process.exit(1);
fs.writeFileSync(process.env.AUTH_FILE, process.env.SELECTED_CLASPRC_JSON, { mode: 0o600 });
fs.writeFileSync(path.join(process.env.PROJECT_DIR, '.clasp.json'),
  JSON.stringify({ scriptId: process.env.SCRIPT_ID, rootDir: '.' }));
NODE
then
  fail CREDENTIAL CLASP_CREDENTIAL_OR_USER_MISMATCH
fi

# Webhookは独立GAS。Booking本体(Public/Admin)と同じScript IDなら更新前に拒否する。
if [[ "$role" == "booking-webhook" ]]; then
  if [[ "$script_id" == "${PUBLIC_SCRIPT_ID:-}" || "$script_id" == "${ADMIN_SCRIPT_ID:-}" ]]; then
    fail PROJECT WEBHOOK_NOT_INDEPENDENT
  fi
fi

cd "$remote_dir"
if ! clasp_cmd list-deployments >"$list_stdout" 2>"$list_stderr"; then
  fail LIST "$(gas_list_error_code "$list_stdout" "$list_stderr")"
fi
# claspの一覧行（- ID @version - description）のID欄を完全一致で照合する（部分一致・説明文中のIDは不可）。
if [[ "$(gas_deployment_id_count "$deployment_id" "$list_stdout")" -ne 1 ]]; then
  fail DEPLOYMENT DEPLOYMENT_ID_MISSING_OR_NOT_UNIQUE
fi

if ! clasp_cmd pull >/dev/null 2>&1; then
  fail PULL CLASP_PULL_FAILED
fi
[[ -f appsscript.json ]] || fail PULL MANIFEST_MISSING

cd "$GITHUB_WORKSPACE"
rm -rf "$preflight_dir"
build_ok=false
case "$role" in
  booking-webhook)
    node scripts/prepare-booking-gas-project.js webhook "$preflight_dir" "$GITHUB_WORKSPACE/gas/booking/webhook/appsscript.json" >/dev/null 2>&1 && build_ok=true ;;
  survey-public)
    node scripts/prepare-survey-gas-project.js public "$preflight_dir" >/dev/null 2>&1 && build_ok=true ;;
  survey-admin)
    node scripts/prepare-survey-gas-project.js admin "$preflight_dir" >/dev/null 2>&1 && build_ok=true ;;
esac
[[ "$build_ok" == "true" ]] || fail BUILD MANIFEST_OR_DISTRIBUTION_INVALID

echo "GAS preflight passed: role=${role} (read-only; authentication, deployment and distribution verified)"

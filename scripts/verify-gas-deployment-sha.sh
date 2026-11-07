#!/usr/bin/env bash
# Issue #804 PR-C1: Webhook / Survey の update-deployment 成功後に、更新を再実行せず読取りだけで
# 「対象Deploymentが今回のSHAへ更新されたこと」を確認する。
#   - 一覧行（- ID @version - description）のID欄が完全一致し、かつ一意であること
#   - その同じ行のdescriptionが正確に `main <GITHUB_SHA>` と一致すること（別行のSHA・説明文中のID・前置き/追記/別記載のSHAを含む部分一致は不可）
#   - 一時的な反映遅延だけを最大5回・5秒間隔の `list-deployments` 読取りで待つ。認証/一覧エラー・ID不在/非一意は即時停止（fail closed）
# push / update-deployment の再実行・自動rollbackは行わない。照合できない場合は「更新済みの可能性・最終確認は未完了」と表示して停止する。
# 第1引数 ROLE: booking-webhook | survey-public | survey-admin（許可リスト）
# 必要な環境変数: AUTH_FILE / DEPLOYMENT_ID / GITHUB_SHA / RUNNER_TEMP / GITHUB_WORKSPACE（作業ディレクトリは対象GASの.clasp.jsonがある場所）
# 出力はSecret・ID・メール・clasp生出力を含まない固定形式のみ。
set -euo pipefail

role="${1:-}"
case "$role" in
  booking-webhook) clasp_user="booking-owner" ;;
  survey-public|survey-admin) clasp_user="" ;;
  *) echo "Unsupported role" >&2; exit 1 ;;
esac

attempts="${VERIFY_ATTEMPTS:-5}"
delay="${VERIFY_DELAY_SECONDS:-5}"
umask 077
list_stdout="$RUNNER_TEMP/gas-verify-list-$role.stdout"
list_stderr="$RUNNER_TEMP/gas-verify-list-$role.stderr"
trap 'rm -f "$list_stdout" "$list_stderr"' EXIT

stop() {
  echo "GAS post-update verification failed: role=${role} stage=VERIFY code=$1. The deployment update was applied but is NOT confirmed at the current main commit; final confirmation is incomplete. Check the deployment state read-only before deciding on any re-run; do not assume a rollback or re-push." >&2
  exit 1
}

clasp_list() {
  if [[ -n "$clasp_user" ]]; then clasp --auth "$AUTH_FILE" --user "$clasp_user" list-deployments
  else clasp --auth "$AUTH_FILE" list-deployments; fi
}

for ((attempt=1; attempt<=attempts; attempt++)); do
  if ! clasp_list >"$list_stdout" 2>"$list_stderr"; then
    if ! code="$(node -e '
      const fs = require("fs");
      const { classify } = require(process.argv[1]);
      const read = (f) => { try { return fs.readFileSync(f, "utf8").slice(0, 1024 * 1024); } catch (_) { return ""; } };
      process.stdout.write(classify(read(process.argv[2]) + "\n" + read(process.argv[3])));
    ' "$GITHUB_WORKSPACE/scripts/classify-clasp-list-error.js" "$list_stdout" "$list_stderr" 2>/dev/null)"; then
      code="UNCLASSIFIED"
    fi
    [[ "$code" =~ ^[A-Z_]+$ ]] || code="UNCLASSIFIED"
    stop "$code"
  fi
  if [[ "$(awk -v id="$DEPLOYMENT_ID" '$1 == "-" && $2 == id { count++ } END { print count+0 }' "$list_stdout")" -ne 1 ]]; then
    stop DEPLOYMENT_ID_MISSING_OR_NOT_UNIQUE
  fi
  # 対象行を「- ID @version - description」に分解し、descriptionが正確に `main <今回の40桁SHA>` と一致する場合だけ成功にする
  # （前置き・追記・別記載のSHAを含む部分一致は不可）。末尾の空白とCRだけは無視する。
  description="$(awk -v id="$DEPLOYMENT_ID" '
    $1 == "-" && $2 == id && $3 ~ /^@/ && $4 == "-" {
      line = $0
      sub(/^[[:space:]]*-[[:space:]]+[^[:space:]]+[[:space:]]+@[^[:space:]]+[[:space:]]+-[[:space:]]*/, "", line)
      sub(/[[:space:]\r]+$/, "", line)
      print line
    }' "$list_stdout")"
  if [[ "$description" == "main ${GITHUB_SHA}" ]]; then
    echo "Verified role=${role}: the existing deployment shows the current main commit"
    exit 0
  fi
  if [[ "$attempt" -lt "$attempts" ]]; then
    echo "Waiting for the deployment description to reflect the current main commit (attempt ${attempt}/${attempts}: SHA_MISMATCH)."
    sleep "$delay"
  fi
done
stop SHA_MISMATCH

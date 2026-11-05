#!/usr/bin/env bash
# Issue #787: 検証専用GAS「SwitchBot Access Test」へのコード反映（本番 #768/#778 とは別系統）。
#   deploy   : 入力・ID検査 → pull(対象照合) → 配布物検査 → push → pull照合
#              ＋ SBAT_DEPLOYMENT_ID が設定されている場合のみ、その固定Deploymentを更新（新規作成はしない）
#   rollback : 固定Deploymentを既存の版へ戻す（SBAT_DEPLOYMENT_ID 必須）
# 必要な環境変数: SBAT_CLASPRC_JSON / SBAT_SCRIPT_ID / SBAT_FORBIDDEN_IDS / (任意)SBAT_DEPLOYMENT_ID /
#   DG_EVENT / DG_REF / DG_ENABLED / DG_EXECUTOR_VAR / DG_EXECUTOR_INPUT / RUNNER_TEMP / GITHUB_WORKSPACE / GITHUB_SHA
#   (rollback) ROLLBACK_VERSION
# 出力にはSecret・ID・clasp生出力を含めない。set -x は使わない。
# Script/User Properties・ACCESS_ENABLED・トリガー・Webhook・SwitchBot実API・メール・台帳には触れない。
# clasp run / create-deployment / deploy / delete-deployment は呼ばない。失敗・UNKNOWN時に再デプロイしない。
set -euo pipefail
set +x

mode="${1:-deploy}"
if [[ "$mode" != "deploy" && "$mode" != "rollback" ]]; then
  echo "Unsupported mode" >&2
  exit 1
fi

lib="$GITHUB_WORKSPACE/scripts/switchbot-access-test-gas-deploy-lib.js"
prepare="$GITHUB_WORKSPACE/scripts/prepare-switchbot-access-gas-project.js"
clasp_user="default"
retry_attempts=5
retry_delay_seconds="${SBAT_RETRY_DELAY_SECONDS:-5}"

summary() { [[ -n "${GITHUB_STEP_SUMMARY:-}" ]] && echo "$1" >> "$GITHUB_STEP_SUMMARY" || true; }
fail() { echo "$1" >&2; summary "- ❌ $1"; exit 1; }

# kill switch（停止）・起動条件・実行主体の宣言。clasp・認証ファイルに触れる前に判定する。
rc=0; status="$(node "$lib" check-run)" || rc=$?
if [[ "$status" == "DEPLOY_DISABLED" ]]; then
  echo "Deploy is disabled by the kill switch; nothing was changed."
  summary "- ⏸ 検証GASへの自動反映は停止中（Environment変数 SWITCHBOT_ACCESS_TEST_DEPLOY_ENABLED が true ではありません）。何も変更していません"
  exit 0
fi
[[ "$rc" -eq 0 && "$status" == "OK" ]] || fail "Run check failed: ${status:-CHECK_ERROR}. Nothing was changed."

if [[ -z "${SBAT_CLASPRC_JSON:-}" || -z "${SBAT_SCRIPT_ID:-}" ]]; then
  fail "Required switchbot-access-test secrets are not configured. Nothing was changed."
fi
export SBAT_CLASPRC_JSON SBAT_SCRIPT_ID SBAT_FORBIDDEN_IDS="${SBAT_FORBIDDEN_IDS:-}" SBAT_DEPLOYMENT_ID="${SBAT_DEPLOYMENT_ID:-}"
echo "::add-mask::$SBAT_SCRIPT_ID"
[[ -z "$SBAT_DEPLOYMENT_ID" ]] || echo "::add-mask::$SBAT_DEPLOYMENT_ID"

rc=0; status="$(node "$lib" check-ids)" || rc=$?
[[ "$rc" -eq 0 && "$status" == "OK" ]] || fail "ID check failed: ${status:-ID_CHECK_ERROR}. Nothing was changed."
with_deployment=false
node "$lib" has-deployment-id && with_deployment=true
if [[ "$mode" == "rollback" && "$with_deployment" != "true" ]]; then
  fail "Rollback needs the approved fixed deployment secret; nothing was changed."
fi

umask 077
work="$RUNNER_TEMP/switchbot-access-test-gas"
auth_file="$work/.clasprc.json"
remote_dir="$work/remote"
deploy_dir="$work/deploy"
verify_dir="$work/verify"
bundle_dir="$work/bundle"
out="$work/out"
cleanup() { rm -rf "$work"; }
trap cleanup EXIT
rm -rf "$work"
mkdir -p "$remote_dir" "$deploy_dir" "$verify_dir" "$out"

status="$(node "$lib" check-credential || true)"
[[ "$status" == "OK" ]] || fail "clasp credential check failed: $status. Nothing was changed."
node "$lib" write-config "$auth_file" "$remote_dir"
cp "$remote_dir/.clasp.json" "$deploy_dir/.clasp.json"
cp "$remote_dir/.clasp.json" "$verify_dir/.clasp.json"

clasp_run() { # <dir> <outfile> <args...>
  local dir="$1" outfile="$2"; shift 2
  (cd "$dir" && clasp --auth "$auth_file" --user "$clasp_user" "$@" >"$outfile" 2>"$outfile.err")
}
read_deployments() {
  clasp_run "$remote_dir" "$out/list.json" list-deployments --json || { echo "clasp list-deployments failed." >&2; return 1; }
}
read_versions() {
  clasp_run "$remote_dir" "$out/versions.json" list-versions --json || { echo "clasp list-versions failed." >&2; return 1; }
}

# ---- 更新前の読取り（ここまでの失敗は何も変更しない） ----
echo "Running clasp pull (target check)"
clasp_run "$remote_dir" "$out/pull.out" pull || fail "clasp pull failed (auth/permission/target); nothing was changed."
remote_state="$(node "$lib" check-remote "$remote_dir" || true)"
case "$remote_state" in
  OK|OK_BLANK) ;;
  *) fail "Target project mismatch: $remote_state. Nothing was changed." ;;
esac
node "$prepare" "$bundle_dir" >/dev/null || fail "Bundle assembly failed; nothing was changed."
if [[ -f "$remote_dir/appsscript.json" ]]; then
  status="$(node "$lib" check-manifest "$remote_dir/appsscript.json" "$bundle_dir/appsscript.json" "$mode" || true)"
  [[ "$status" == "OK" ]] || fail "Manifest check failed: $status. Nothing was changed."
fi

previous_version="-"
if [[ "$with_deployment" == "true" ]]; then
  read_deployments || fail "Could not read deployments before update; nothing was changed."
  if ! previous_version="$(node "$lib" pick-deployment "$out/list.json" 2>"$out/pick.err")"; then
    fail "Configured deployment could not be uniquely verified in the target project: $(head -c 80 "$out/pick.err" | tr -cd 'A-Z_'). Nothing was changed."
  fi
  summary "- 更新前の公開バージョン: \`@$previous_version\`"
  read_versions || fail "Could not read versions before update; nothing was changed."
fi

if [[ "$mode" == "rollback" ]]; then
  target="${ROLLBACK_VERSION:-}"
  [[ "$target" =~ ^[1-9][0-9]{0,5}$ ]] || fail "ROLLBACK_VERSION must be a positive integer; nothing was changed."
  [[ "$target" != "$previous_version" ]] || fail "Deployment is already at @$target; nothing was changed."
  node "$lib" has-version "$out/versions.json" "$target" || fail "Version @$target does not exist in the target project; nothing was changed."
  summary "- ロールバック先: \`@$target\`（説明: \`$(node "$lib" describe-version "$out/versions.json" "$target")\`）"
  echo "Rolling the SAME deployment back to version @$target"
  clasp_run "$remote_dir" "$out/update.out" update-deployment "$SBAT_DEPLOYMENT_ID" -V "$target" \
    --description "rollback to v${target} (run ${GITHUB_RUN_ID:-manual})" \
    || echo "clasp update-deployment (rollback) reported failure; reconciling by read-only checks." >&2
  expected_version="$target"; expected_desc="-"
else
  [[ "${GITHUB_SHA:-}" =~ ^[0-9a-f]{40}$ ]] || fail "GITHUB_SHA is not a commit SHA; nothing was changed."
  status="$(node "$lib" check-bundle "$bundle_dir" || true)"
  [[ "$status" == "OK" ]] || fail "Bundle check failed: $status. Nothing was changed."
  summary "- ✅ 配布物の完全性検査: 成功（対象GASの状態: \`$remote_state\`）"
  cp "$bundle_dir"/*.gs "$bundle_dir/appsscript.json" "$deploy_dir/"

  echo "Running clasp push --force"
  clasp_run "$deploy_dir" "$out/push.out" push --force || fail "clasp push failed; the published deployment was not changed. Do not re-run blindly; check the project state."

  echo "Verifying pushed source (pull back and compare)"
  clasp_run "$verify_dir" "$out/pullback.out" pull || fail "UNKNOWN_STATE: post-push pull failed. Check the project source before any re-run."
  status="$(node "$lib" compare-sources "$deploy_dir" "$verify_dir" || true)"
  [[ "$status" == "OK" ]] || fail "UNKNOWN_STATE: pushed source verification failed: $status. Check the project source before any re-run."
  summary "- ✅ ソース反映（clasp push + 照合）: 成功"

  if [[ "$with_deployment" != "true" ]]; then
    summary "- 方式: ソース反映のみ（固定Deployment用Secret未設定のため、Webアプリ公開・Deployment更新は行わない）"
    summary "- 対象main SHA: \`${GITHUB_SHA}\`"
    summary "- 検証範囲: ソース照合のみ。ACCESS_ENABLED／Script・User Properties／トリガー／Webhook／実API／メールは未操作（反映成功＝GAS診断成功＝実機試験GOではない）"
    echo "Source pushed and verified (no deployment update)."
    exit 0
  fi
  previous_max="$(node "$lib" max-version "$out/versions.json")"
  echo "Running clasp update-deployment (new version, same deployment)"
  clasp_run "$remote_dir" "$out/update.out" update-deployment "$SBAT_DEPLOYMENT_ID" --description "main ${GITHUB_SHA}" \
    || echo "clasp update-deployment reported failure; reconciling by read-only checks." >&2
  expected_version="any"; expected_desc="main ${GITHUB_SHA}"
fi

# ---- 更新後の照合（読取りのみ。上限付き。更新・pushは繰り返さない） ----
verified=false
for ((i=1; i<=retry_attempts; i++)); do
  if read_deployments; then
    rc=0; node "$lib" deployment-matches "$out/list.json" "$expected_version" "$expected_desc" || rc=$?
    if [[ $rc -eq 0 ]]; then
      current="$(node "$lib" pick-deployment "$out/list.json")"
      if [[ "$mode" == "rollback" ]] || (( current > previous_max )); then verified=true; break; fi
    fi
    [[ $rc -ne 2 ]] || break
  fi
  (( i < retry_attempts )) && { echo "Waiting for deployment state to reflect the update (attempt $i/$retry_attempts)"; sleep "$retry_delay_seconds"; }
done

if [[ "$verified" != "true" ]]; then
  if read_deployments && now="$(node "$lib" pick-deployment "$out/list.json" 2>/dev/null)"; then
    [[ "$now" != "$previous_version" ]] || fail "Deployment update was NOT applied (still @$previous_version). The published version is unchanged."
    fail "UNKNOWN_STATE: deployment is at @$now (previous @$previous_version) but did not match the expected state. Follow the rollback runbook; do not re-run blindly."
  fi
  fail "UNKNOWN_STATE: could not read the deployment after update. Follow the rollback runbook; do not re-run blindly."
fi

now="$(node "$lib" pick-deployment "$out/list.json")"
summary "- ✅ 公開バージョン更新（同一Deployment／同一 /exec URL）: \`@$previous_version\` → \`@$now\`"
summary "- 検証範囲: ソース照合・公開版番号・説明の読取りのみ。ACCESS_ENABLED／Properties／トリガー／Webhook／実API／メールは未操作（反映成功＝GAS診断成功＝実機試験GOではない）"

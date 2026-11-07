#!/usr/bin/env bash
# Issue #723: 独立SwitchBot検証GAS（gas/switchbot-verify/）を、既存Webアプリ Deployment のまま更新する。
#   deploy   : pull(対象照合) → push → pull照合(ソース反映) → 新バージョン作成＋既存Deployment更新 → 読取り検証
#   rollback : 同じDeploymentを、ROLLBACK_VERSION（既存の版）へ戻す（Deploymentの削除・再作成はしない）
# 必要な環境変数: SBV_CLASPRC_JSON / SBV_SCRIPT_ID / SBV_DEPLOYMENT_ID / RUNNER_TEMP / GITHUB_WORKSPACE /
#   GITHUB_SHA / (rollback) ROLLBACK_VERSION
# 出力にはSecret・ID・clasp生出力を含めない（固定メッセージ／版番号のみ）。set -x は使わない。
# Script Properties / Webhook設定 / トリガーには触れない（clasp push は .gs と appsscript.json のみ）。
set -euo pipefail
set +x

mode="${1:-deploy}"
if [[ "$mode" != "deploy" && "$mode" != "rollback" ]]; then
  echo "Unsupported mode" >&2
  exit 1
fi

lib="$GITHUB_WORKSPACE/scripts/switchbot-verify-gas-deploy-lib.js"
src_dir="$GITHUB_WORKSPACE/gas/switchbot-verify"
clasp_user="default"
retry_attempts=5
retry_delay_seconds="${SBV_RETRY_DELAY_SECONDS:-5}"

summary() { [[ -n "${GITHUB_STEP_SUMMARY:-}" ]] && echo "$1" >> "$GITHUB_STEP_SUMMARY" || true; }
fail() { echo "$1" >&2; summary "- ❌ $1"; exit 1; }

# ---- 入力検査（Google・認証ファイルに触れる前。失敗しても何も変更しない） ----
if [[ "$mode" == "rollback" ]]; then
  target="${ROLLBACK_VERSION:-}"
  [[ "$target" =~ ^[1-9][0-9]{0,5}$ ]] || fail "ROLLBACK_VERSION must be a positive integer; nothing was changed."
else
  [[ "${GITHUB_SHA:-}" =~ ^[0-9a-f]{40}$ ]] || fail "GITHUB_SHA is not a commit SHA; nothing was changed."
fi

if [[ -z "${SBV_CLASPRC_JSON:-}" || -z "${SBV_SCRIPT_ID:-}" || -z "${SBV_DEPLOYMENT_ID:-}" ]]; then
  echo "Required switchbot-verify secrets are not configured." >&2
  exit 1
fi
export SBV_CLASPRC_JSON SBV_SCRIPT_ID SBV_DEPLOYMENT_ID
# 値そのものをログに出さないための追加マスク（GitHubの自動マスクだけに依存しない補助）。
echo "::add-mask::$SBV_SCRIPT_ID"
echo "::add-mask::$SBV_DEPLOYMENT_ID"

umask 077
work="$RUNNER_TEMP/switchbot-verify-gas"
auth_file="$work/.clasprc.json"
remote_dir="$work/remote"
deploy_dir="$work/deploy"
verify_dir="$work/verify"
out="$work/out"
# 認証ファイル・clasp出力は成功／失敗／中断のいずれでも削除する。
cleanup() { rm -rf "$work"; }
trap cleanup EXIT
rm -rf "$work"
mkdir -p "$remote_dir" "$deploy_dir" "$verify_dir" "$out"

cred_status="$(node "$lib" check-credential || true)"
[[ "$cred_status" == "OK" ]] || fail "clasp credential check failed: $cred_status"
node "$lib" write-config "$auth_file" "$remote_dir" x
cp "$remote_dir/.clasp.json" "$deploy_dir/.clasp.json"
cp "$remote_dir/.clasp.json" "$verify_dir/.clasp.json"

# clasp は常に出力をファイルへ。生出力は表示しない。
clasp_run() { # <dir> <outfile> <args...>
  local dir="$1" outfile="$2"; shift 2
  (cd "$dir" && clasp --auth "$auth_file" --user "$clasp_user" "$@" >"$outfile" 2>"$outfile.err")
}
classify_list_error() { # <phase>
  node "$GITHUB_WORKSPACE/scripts/classify-clasp-list-error.js" "$out/list.json" "$out/list.json.err" "$1" >&2 || true
}
read_deployments() { # <phase> -> $out/list.json
  clasp_run "$remote_dir" "$out/list.json" list-deployments --json || { classify_list_error "$1"; return 1; }
}
read_versions() {
  clasp_run "$remote_dir" "$out/versions.json" list-versions --json || {
    echo "clasp list-versions failed." >&2; return 1; }
}

# ---- 更新前の読取り（ここまでの失敗は公開Deploymentに一切影響しない） ----
echo "Reading existing deployments (before update)"
read_deployments before || fail "Could not read deployments before update; nothing was changed."
if ! previous_version="$(SBV_DEPLOYMENT_ID="$SBV_DEPLOYMENT_ID" node "$lib" pick-deployment "$out/list.json" 2>"$out/pick.err")"; then
  fail "Configured deployment could not be uniquely verified in the target project: $(head -c 80 "$out/pick.err" | tr -cd 'A-Z_'). Nothing was changed."
fi
echo "Previous published version: $previous_version"
summary "- 更新前の公開バージョン: \`@$previous_version\`"

read_versions || fail "Could not read versions before update; nothing was changed."

# 対象照合（deploy／rollback共通・読取りのみ）: pull した既存プロジェクトが独立SwitchBot検証GASであること。
# Booking/Survey等の取り違えで、他プロジェクトのDeploymentを更新・巻き戻ししないための防止。
echo "Running clasp pull (target check)"
clasp_run "$remote_dir" "$out/pull.out" pull || fail "clasp pull failed; nothing was changed."
status="$(node "$lib" check-remote "$remote_dir" || true)"
[[ "$status" == "OK" ]] || fail "Target project mismatch: $status. Nothing was changed."
[[ -f "$remote_dir/appsscript.json" ]] || fail "Target project returned no manifest; nothing was changed."

# ---- 更新前の読取り確認（モード別）。ここまでは公開Deploymentにも編集用ソースにも一切書き込まない ----
if [[ "$mode" == "rollback" ]]; then
  # rollbackではWebアプリの実行主体・アクセス権だけを照合する（新scope検査は行わない）。
  status="$(node "$lib" check-manifest "$remote_dir/appsscript.json" "$src_dir/appsscript.json" webapp-only || true)"
  [[ "$status" == "OK" ]] || fail "Manifest check failed: $status. Nothing was changed."
  [[ "$target" != "$previous_version" ]] || fail "Deployment is already at @$target; nothing was changed."
  node "$lib" has-version "$out/versions.json" "$target" || fail "Version @$target does not exist in the target project; nothing was changed."
else
  status="$(node "$lib" check-manifest "$remote_dir/appsscript.json" "$src_dir/appsscript.json" || true)"
  [[ "$status" == "OK" ]] || fail "Manifest check failed: $status. Nothing was changed."
  # デプロイ対象は .gs と appsscript.json のみ（他ファイルを混ぜない）。
  shopt -s nullglob
  files=("$src_dir"/*.gs "$src_dir/appsscript.json")
  shopt -u nullglob
  [[ -f "$src_dir/SwitchBotVerify.gs" && -f "$src_dir/appsscript.json" ]] || fail "Source files are incomplete; nothing was changed."
fi

# 境界: 認証・対象GAS・Deployment（完全一致・一意）・版・manifest・配布物の読取り確認が完了。以降が最初の書込み。
# 読取り確認は更新権限・将来のAPI成功・GAS実行時権限を保証しない（更新後の読取り照合で別途確認する）。
echo "Preflight passed (read-only checks complete; the first write follows)"
summary "- ✅ 更新前の読取り確認（preflight）: 成功（ここまでは何も書き込んでいません）"

if [[ "$mode" == "rollback" ]]; then
  echo "Rolling the SAME deployment back to version @$target"
  if ! clasp_run "$remote_dir" "$out/update.out" update-deployment "$SBV_DEPLOYMENT_ID" -V "$target" \
      --description "rollback to v${target} (run ${GITHUB_RUN_ID:-manual})"; then
    echo "clasp update-deployment (rollback) reported failure; reconciling by read-only checks." >&2
  fi
  expected_version="$target"
  expected_desc="-"
else
  cp "${files[@]}" "$deploy_dir/"

  echo "Running clasp push --force"
  if ! clasp_run "$deploy_dir" "$out/push.out" push --force; then
    cat "$out/push.out" "$out/push.out.err" > "$out/push.all" 2>/dev/null || true
    node "$GITHUB_WORKSPACE/scripts/classify-clasp-push-error.js" "$out/push.all" >&2 || true
    fail "clasp push failed; the published deployment was not changed."
  fi

  # 1段階目の確認: 編集用ソース（HEAD）にmainの内容が反映されたか。公開版の更新とは別。
  echo "Verifying pushed source (pull back and compare)"
  clasp_run "$verify_dir" "$out/pullback.out" pull || fail "Post-push pull failed; the published deployment was not changed."
  status="$(node "$lib" compare-sources "$deploy_dir" "$verify_dir" || true)"
  [[ "$status" == "OK" ]] || fail "Pushed source verification failed: $status. The published deployment was not changed."
  summary "- ✅ ソース反映（clasp push + 照合）: 成功"

  previous_max="$(node "$lib" max-version "$out/versions.json")"

  # 2段階目: 新バージョンを作成し、既存Deploymentをそのバージョンへ更新（URL・ID不変）。再実行はしない。
  echo "Running clasp update-deployment (new version, same deployment)"
  if ! clasp_run "$remote_dir" "$out/update.out" update-deployment "$SBV_DEPLOYMENT_ID" \
      --description "main ${GITHUB_SHA}"; then
    echo "clasp update-deployment reported failure; reconciling by read-only checks." >&2
  fi
  expected_version="newer-than-$previous_max"
  expected_desc="main ${GITHUB_SHA}"
fi

# ---- 更新後の照合（読取りのみ。上限付き。更新・pushは繰り返さない） ----
verified=false
for ((i=1; i<=retry_attempts; i++)); do
  if read_deployments after; then
    if [[ "$mode" == "rollback" ]]; then
      rc=0; SBV_DEPLOYMENT_ID="$SBV_DEPLOYMENT_ID" node "$lib" deployment-matches "$out/list.json" "$expected_version" "$expected_desc" || rc=$?
      if [[ $rc -eq 0 ]]; then verified=true; break; fi
    else
      rc=0; SBV_DEPLOYMENT_ID="$SBV_DEPLOYMENT_ID" node "$lib" deployment-matches "$out/list.json" any "$expected_desc" || rc=$?
      if [[ $rc -eq 0 ]]; then
        current="$(SBV_DEPLOYMENT_ID="$SBV_DEPLOYMENT_ID" node "$lib" pick-deployment "$out/list.json")"
        if (( current > previous_max )); then verified=true; break; fi
      fi
    fi
    [[ $rc -ne 2 ]] || break   # ID消失・非一意は再試行せず即停止
  fi
  (( i < retry_attempts )) && { echo "Waiting for deployment state to reflect the update (attempt $i/$retry_attempts)"; sleep "$retry_delay_seconds"; }
done

if [[ "$verified" != "true" ]]; then
  # 状態の分類（固定語のみ）。成功扱いにはしない。
  if read_deployments after && now="$(SBV_DEPLOYMENT_ID="$SBV_DEPLOYMENT_ID" node "$lib" pick-deployment "$out/list.json" 2>/dev/null)"; then
    if [[ "$now" == "$previous_version" ]]; then
      fail "Deployment update was NOT applied (still @$previous_version). The published version is unchanged."
    fi
    fail "UNKNOWN_STATE: deployment is at @$now (previous @$previous_version) but did not match the expected state. Follow the rollback runbook; do not re-run blindly."
  fi
  fail "UNKNOWN_STATE: could not read the deployment after update. Follow the rollback runbook; do not re-run blindly."
fi

now="$(SBV_DEPLOYMENT_ID="$SBV_DEPLOYMENT_ID" node "$lib" pick-deployment "$out/list.json")"
echo "Published version is now @$now (same deployment, same /exec URL)"
summary "- ✅ 公開バージョン更新（同一Deployment／同一 /exec URL）: \`@$previous_version\` → \`@$now\`"
summary "- commit: \`${GITHUB_SHA}\`"

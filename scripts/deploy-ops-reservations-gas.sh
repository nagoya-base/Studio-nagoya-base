#!/usr/bin/env bash
# Issue #936: 運営アプリ（予約確認）専用GAS を、既存の専用Webアプリ Deployment のまま更新する。
#   deploy   : 配布物の組立・検査 → pull(対象照合) → push → pull照合(ソース反映) → 新バージョン作成＋既存Deployment更新 → 読取り照合
#   rollback : 同じDeploymentを、ROLLBACK_VERSION（既存の版）へ戻す（Deploymentの削除・再作成はしない）
# 必要な環境変数: OPS_CLASPRC_JSON / OPS_SCRIPT_ID / OPS_DEPLOYMENT_ID / RUNNER_TEMP / GITHUB_WORKSPACE /
#   GITHUB_SHA / (rollback) ROLLBACK_VERSION
# 出力にはSecret・ID・clasp生出力を含めない（固定メッセージ／版番号のみ）。set -x は使わない。
# プロジェクトやDeploymentを新規作成しない（ID未設定は書込み前に停止）。Script Properties（OPS_OWNER_EMAIL・台帳ID）・
# トリガーには触れない（clasp push は .gs/.html/appsscript.json のみ）。clasp run・create-deployment・deploy は呼ばない。
set -euo pipefail
set +x

mode="${1:-deploy}"
if [[ "$mode" != "deploy" && "$mode" != "rollback" ]]; then
  echo "Unsupported mode" >&2
  exit 1
fi

lib="$GITHUB_WORKSPACE/scripts/ops-reservations-gas-deploy-lib.js"
prepare="$GITHUB_WORKSPACE/scripts/prepare-ops-reservations-gas-project.js"
clasp_user="default"
retry_attempts=5
retry_delay_seconds="${OPS_RETRY_DELAY_SECONDS:-5}"

summary() { [[ -n "${GITHUB_STEP_SUMMARY:-}" ]] && echo "$1" >> "$GITHUB_STEP_SUMMARY" || true; }
fail() { echo "$1" >&2; summary "- ❌ 失敗: $1"; exit 1; }
now_stamp() { echo "$(TZ=Asia/Tokyo date '+%Y-%m-%d %H:%M:%S') JST / $(date -u '+%Y-%m-%d %H:%M:%S') UTC"; }

# ---- 入力検査（Google・認証ファイルに触れる前。失敗しても何も変更しない） ----
if [[ "$mode" == "rollback" ]]; then
  target="${ROLLBACK_VERSION:-}"; target="${target//[[:space:]]/}"
  [[ "$target" =~ ^[1-9][0-9]{0,5}$ ]] || fail "ROLLBACK_VERSION must be a positive integer; nothing was changed."
else
  [[ "${GITHUB_SHA:-}" =~ ^[0-9a-f]{40}$ ]] || fail "GITHUB_SHA is not a commit SHA; nothing was changed."
fi

if [[ -z "${OPS_CLASPRC_JSON:-}" || -z "${OPS_SCRIPT_ID:-}" || -z "${OPS_DEPLOYMENT_ID:-}" ]]; then
  fail "初回設定が未完了です（専用のSecrets 3件が未設定）。何も変更していません。手順: docs/ops-reservations-gas-deploy-936.md"
fi
export OPS_CLASPRC_JSON OPS_SCRIPT_ID OPS_DEPLOYMENT_ID
# 値そのものをログに出さないための追加マスク（GitHubの自動マスクだけに依存しない補助）。
echo "::add-mask::$OPS_SCRIPT_ID"
echo "::add-mask::$OPS_DEPLOYMENT_ID"

umask 077
work="$RUNNER_TEMP/ops-reservations-gas"
auth_file="$work/.clasprc.json"
remote_dir="$work/remote"
deploy_dir="$work/deploy"
verify_dir="$work/verify"
bundle_dir="$work/bundle"
out="$work/out"
# 認証ファイル・clasp出力は成功／失敗／中断のいずれでも削除する。
cleanup() { rm -rf "$work"; }
trap cleanup EXIT
rm -rf "$work"
mkdir -p "$remote_dir" "$deploy_dir" "$verify_dir" "$out"

cred_status="$(node "$lib" check-credential || true)"
[[ "$cred_status" == "OK" ]] || fail "clasp credential check failed: $cred_status"
node "$lib" write-config "$auth_file" "$remote_dir"
cp "$remote_dir/.clasp.json" "$deploy_dir/.clasp.json"
cp "$remote_dir/.clasp.json" "$verify_dir/.clasp.json"

# clasp は常に出力をファイルへ。生出力は表示しない。
clasp_run() { # <dir> <outfile> <args...>
  local dir="$1" outfile="$2"; shift 2
  (cd "$dir" && clasp --auth "$auth_file" --user "$clasp_user" "$@" >"$outfile" 2>"$outfile.err")
}
read_deployments() { # <phase> -> $out/list.json
  clasp_run "$remote_dir" "$out/list.json" list-deployments --json || {
    node "$GITHUB_WORKSPACE/scripts/classify-clasp-list-error.js" "$out/list.json" "$out/list.json.err" "$1" >&2 || true
    return 1
  }
}
read_versions() {
  clasp_run "$remote_dir" "$out/versions.json" list-versions --json || { echo "clasp list-versions failed." >&2; return 1; }
}

# ---- 更新前の読取り（ここまでの失敗は公開Deploymentにも編集用ソースにも一切影響しない） ----
echo "Reading existing deployments (before update)"
read_deployments before || fail "Could not read deployments before update; nothing was changed."
if ! previous_version="$(node "$lib" pick-deployment "$out/list.json" 2>"$out/pick.err")"; then
  fail "Configured deployment could not be uniquely verified in the target project: $(head -c 80 "$out/pick.err" | tr -cd 'A-Z_'). Nothing was changed."
fi
echo "Previous published version: $previous_version"
summary "- 更新前の公開バージョン: \`@$previous_version\`"
read_versions || fail "Could not read versions before update; nothing was changed."

# 対象照合（deploy／rollback共通・読取りのみ）: 運営アプリ専用GASであり、既存の業務用GASでないこと。
echo "Running clasp pull (target check)"
clasp_run "$remote_dir" "$out/pull.out" pull || fail "clasp pull failed; nothing was changed."
remote_kind="$(node "$lib" check-remote "$remote_dir" || true)"
[[ "$remote_kind" == "OK" || "$remote_kind" == "OK_PRISTINE" ]] || fail "Target project mismatch: $remote_kind. Nothing was changed."
[[ -f "$remote_dir/appsscript.json" ]] || fail "Target project returned no manifest; nothing was changed."
if [[ "$remote_kind" == "OK_PRISTINE" ]]; then
  summary "- ℹ️ 対象は空の専用プロジェクト（初回配置）。業務用コードは無いことを確認済み"
else
  summary "- ✅ 対象確認: 運営アプリ専用GAS（OpsApi等あり／予約・決済・鍵のファイルなし）"
fi

# 配布物（deployでもrollbackでも manifest 設定の照合に使う）。組立のみ。失敗なら何も書き込まない。
node "$prepare" "$bundle_dir" >/dev/null || fail "Bundle assembly failed; nothing was changed."
status="$(node "$lib" check-bundle "$bundle_dir" || true)"
[[ "$status" == "OK" ]] || fail "Bundle check failed: $status. Nothing was changed."
status="$(node "$lib" check-manifest "$remote_dir/appsscript.json" "$bundle_dir/appsscript.json" || true)"
[[ "$status" == "OK" ]] || fail "Manifest check failed: $status. Nothing was changed."

if [[ "$mode" == "rollback" ]]; then
  [[ "$target" != "$previous_version" ]] || fail "Deployment is already at @$target; nothing was changed."
  node "$lib" has-version "$out/versions.json" "$target" || fail "Version @$target does not exist in the target project; nothing was changed."
  target_desc="$(node "$lib" describe-version "$out/versions.json" "$target")"
fi

# 境界: 認証・対象GAS・Deployment（完全一致・一意）・版・manifest・配布物の読取り確認が完了。以降が最初の書込み。
# 読取り確認は更新権限・将来のAPI成功・GAS実行時権限を保証しない（更新後の読取り照合で別途確認する）。
echo "Preflight passed (read-only checks complete; the first write follows)"
summary "- ✅ 更新前の読取り確認（preflight）: 成功（ここまでは何も書き込んでいません）"

if [[ "$mode" == "rollback" ]]; then
  summary "- ロールバック先: \`@$target\`（説明: \`$target_desc\`）"
  echo "Rolling the SAME deployment back to version @$target"
  if ! clasp_run "$remote_dir" "$out/update.out" update-deployment "$OPS_DEPLOYMENT_ID" -V "$target" \
      --description "rollback to v${target} (run ${GITHUB_RUN_ID:-manual})"; then
    echo "clasp update-deployment (rollback) reported failure; reconciling by read-only checks." >&2
  fi
  expected_version="$target"
  expected_desc="-"
else
  # デプロイ対象は配布物（.gs / .html / appsscript.json のみ）。
  cp "$bundle_dir"/*.gs "$bundle_dir"/*.html "$bundle_dir/appsscript.json" "$deploy_dir/"

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
  if ! clasp_run "$remote_dir" "$out/update.out" update-deployment "$OPS_DEPLOYMENT_ID" \
      --description "main ${GITHUB_SHA}"; then
    echo "clasp update-deployment reported failure; reconciling by read-only checks." >&2
  fi
  expected_version="any"
  expected_desc="main ${GITHUB_SHA}"
fi

# ---- 更新後の照合（読取りのみ。上限付き。更新・pushは繰り返さない） ----
# API受理だけで成功としない。同じDeployment IDの公開版番号と説明を読み直して一致を確認する。
verified=false
for ((i=1; i<=retry_attempts; i++)); do
  if read_deployments after; then
    rc=0; node "$lib" deployment-matches "$out/list.json" "$expected_version" "$expected_desc" || rc=$?
    if [[ $rc -eq 0 ]]; then
      if [[ "$mode" == "rollback" ]]; then verified=true; break; fi
      current="$(node "$lib" pick-deployment "$out/list.json")"
      if (( current > previous_max )); then verified=true; break; fi
    fi
    [[ $rc -ne 2 ]] || break   # ID消失・非一意は再試行せず即停止
  fi
  (( i < retry_attempts )) && { echo "Waiting for deployment state to reflect the update (attempt $i/$retry_attempts)"; sleep "$retry_delay_seconds"; }
done

if [[ "$verified" != "true" ]]; then
  # 状態の分類（固定語のみ）。成功扱いにはしない。
  if read_deployments after && now="$(node "$lib" pick-deployment "$out/list.json" 2>/dev/null)"; then
    if [[ "$now" == "$previous_version" ]]; then
      fail "Deployment update was NOT applied (still @$previous_version). The published version is unchanged."
    fi
    fail "UNKNOWN_STATE: deployment is at @$now (previous @$previous_version) but did not match the expected state. Follow the recovery steps; do not re-run blindly."
  fi
  fail "UNKNOWN_STATE: could not read the deployment after update. Follow the recovery steps; do not re-run blindly."
fi

now="$(node "$lib" pick-deployment "$out/list.json")"
echo "Published version is now @$now (same deployment, same /exec URL)"
summary "- ✅ 公開バージョン更新（同一Deployment／同一 /exec URL）: \`@$previous_version\` → \`@$now\`"
if [[ "$mode" == "rollback" ]]; then
  summary "- 方式: 既存Deploymentを既存版へ戻す（clasp update-deployment -V。Deployment削除・再作成なし）"
else
  summary "- 方式: 既存Deployment更新（clasp push → 新版作成 → clasp update-deployment。新規プロジェクト・Deployment作成なし）"
  summary "- 反映したmain SHA: \`${GITHUB_SHA}\`"
fi
summary "- 処理日時: $(now_stamp)"
summary "- 利用URL: 変わりません（同じDeployment IDを更新し、更新後に同一IDで照合済み）。公開ログにはURL・IDを出しません。一度ブックマークしたURLがそのまま使えます"
summary "- 設定: 所有者のみ・実行者=デプロイ者・読み取り専用scopeを維持（配布物のmanifestを検査し、pushしたソースを照合済み）。Script Properties（所有者・台帳接続先）・トリガーは未操作"
summary "- 区別: これは機械的な更新成功です。スマホで実際に一覧・詳細が表示されることの確認（画面の実利用確認）は別に行ってください"

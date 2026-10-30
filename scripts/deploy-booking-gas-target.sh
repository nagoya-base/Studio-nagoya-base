#!/usr/bin/env bash
# 既存のBooking GASプロジェクト1つ（admin|public）を、既存Deploymentのまま更新する（Issue #671で
# workflowのrunブロックから切り出した。内容は従来の単一target用stepと同一）。
# 第2引数に verify を渡すと更新せず、既存Deploymentの所属と今回のmain SHAの反映だけを確認する
# （post-check用。clasp list-deployments の出力そのものは表示しない）。
# 必要な環境変数: CLASPRC_JSON / PUBLIC_CLASPRC_JSON / PUBLIC_SCRIPT_ID / PUBLIC_DEPLOYMENT_ID /
#   ADMIN_SCRIPT_ID / ADMIN_DEPLOYMENT_ID / RUNNER_TEMP / GITHUB_WORKSPACE / GITHUB_SHA
# 出力にはSecret・ID・clasp生出力を含めない（固定メッセージとclassifierの分類のみ）。
set -euo pipefail

target="${1:-}"
mode="${2:-deploy}"
if [[ "$mode" != "deploy" && "$mode" != "verify" ]]; then
  echo "Unsupported mode" >&2
  exit 1
fi

# Deployment ID と今回のmain SHAの説明文が同じ行にあるかだけを確認する（出力は固定メッセージのみ）。
deployment_has_current_sha() {
  grep -F -- "$deployment_id" "$list_stdout" | grep -Fq -- "main ${GITHUB_SHA}"
}

case "$target" in
  public)
    selected_clasprc_json="$PUBLIC_CLASPRC_JSON"
    clasp_user="booking-owner"
    script_id="$PUBLIC_SCRIPT_ID"
    deployment_id="$PUBLIC_DEPLOYMENT_ID"
    ;;
  admin)
    selected_clasprc_json="$CLASPRC_JSON"
    clasp_user="default"
    script_id="$ADMIN_SCRIPT_ID"
    deployment_id="$ADMIN_DEPLOYMENT_ID"
    ;;
  *)
    echo "Unsupported target" >&2
    exit 1
    ;;
esac

if [[ -z "$selected_clasprc_json" || -z "$script_id" || -z "$deployment_id" ]]; then
  echo "Required booking-production secrets are not configured." >&2
  exit 1
fi

auth_file="$RUNNER_TEMP/.clasprc.json"
remote_dir="$RUNNER_TEMP/booking-gas-remote"
deploy_dir="$RUNNER_TEMP/booking-gas-deploy"
umask 077
list_stdout="$RUNNER_TEMP/clasp-list-deployments.stdout"
list_stderr="$RUNNER_TEMP/clasp-list-deployments.stderr"
push_log="$RUNNER_TEMP/clasp-push.log"
trap 'rm -f "$list_stdout" "$list_stderr" "$push_log" "$auth_file"' EXIT
mkdir -p "$remote_dir"

AUTH_FILE="$auth_file" PROJECT_DIR="$remote_dir" SCRIPT_ID="$script_id" \
  CLASP_USER="$clasp_user" SELECTED_CLASPRC_JSON="$selected_clasprc_json" node <<'NODE'
const fs = require('fs');
const path = require('path');
const authJson = process.env.SELECTED_CLASPRC_JSON;
let auth;
try {
  auth = JSON.parse(authJson);
  if (!auth || typeof auth !== 'object' || Array.isArray(auth)) throw new Error();
} catch (_) {
  console.error('clasp credential setup failed: CLASP_CREDENTIAL_OR_USER_MISMATCH');
  process.exit(1);
}
if (process.env.CLASP_USER === 'booking-owner' &&
    (!auth.tokens || !auth.tokens['booking-owner'])) {
  throw new Error('The public clasp credential does not contain the required user.');
}
fs.writeFileSync(process.env.AUTH_FILE, authJson, { mode: 0o600 });
fs.writeFileSync(
  path.join(process.env.PROJECT_DIR, '.clasp.json'),
  JSON.stringify({ scriptId: process.env.SCRIPT_ID, rootDir: '.' })
);
NODE

cd "$remote_dir"
echo "Running clasp list-deployments (before update)"
if ! clasp --auth "$auth_file" --user "$clasp_user" list-deployments >"$list_stdout" 2>"$list_stderr"; then
  node "$GITHUB_WORKSPACE/scripts/classify-clasp-list-error.js" "$list_stdout" "$list_stderr" before >&2
  exit 1
fi
if ! grep -Fq -- "$deployment_id" "$list_stdout"; then
  echo "Configured deployment ID does not belong to the selected existing GAS project." >&2
  exit 1
fi

if [[ "$mode" == "verify" ]]; then
  if ! deployment_has_current_sha; then
    echo "Existing $target deployment does not show the current main commit." >&2
    exit 1
  fi
  echo "Verified existing $target deployment is at the current main commit"
  exit 0
fi

echo "Running clasp pull"
if ! clasp --auth "$auth_file" --user "$clasp_user" pull >/dev/null 2>&1; then
  echo "clasp pull failed." >&2
  exit 1
fi
if [[ ! -f appsscript.json ]]; then
  echo "Existing GAS project did not return appsscript.json; refusing to push." >&2
  exit 1
fi

cd "$GITHUB_WORKSPACE"
manifest_path="$remote_dir/appsscript.json"
if [[ "$target" == "public" ]]; then
  # The public manifest is version-controlled. The admin manifest is
  # preserved from its existing container-bound project; the builder only
  # appends missing required oauthScopes (script.external_request).
  manifest_path="$GITHUB_WORKSPACE/gas/booking/public/appsscript.json"
fi
node scripts/prepare-booking-gas-project.js \
  "$target" "$deploy_dir" "$manifest_path"

PROJECT_DIR="$deploy_dir" SCRIPT_ID="$script_id" node <<'NODE'
const fs = require('fs');
const path = require('path');
fs.writeFileSync(
  path.join(process.env.PROJECT_DIR, '.clasp.json'),
  JSON.stringify({ scriptId: process.env.SCRIPT_ID, rootDir: '.' })
);
NODE

cd "$deploy_dir"
echo "Running clasp show-file-status"
if ! clasp --auth "$auth_file" --user "$clasp_user" show-file-status >/dev/null 2>&1; then
  echo "clasp show-file-status failed." >&2
  exit 1
fi
echo "Running clasp push --force"
# Never print clasp's raw output: Google errors may include identifiers.
# The script emits a fixed category (plus sanitized allowlisted fields if unclassified).
if ! clasp --auth "$auth_file" --user "$clasp_user" push --force >"$push_log" 2>&1; then
  node "$GITHUB_WORKSPACE/scripts/classify-clasp-push-error.js" "$push_log" >&2
  exit 1
fi
rm -f "$push_log"
# update-deployment が成功した事実だけを記録する（workflowが「更新前の失敗」と「更新後の検証失敗」を
# 区別して案内するため。IDやSecretは含まない空ファイル）。
rm -f "$RUNNER_TEMP/booking-gas-$target-update-applied"
echo "Running clasp update-deployment"
if ! clasp --auth "$auth_file" --user "$clasp_user" update-deployment "$deployment_id" \
  --description "main ${GITHUB_SHA}" >/dev/null 2>&1; then
  echo "clasp update-deployment failed." >&2
  exit 1
fi

touch "$RUNNER_TEMP/booking-gas-$target-update-applied"
echo "Running clasp list-deployments (after update)"
if ! clasp --auth "$auth_file" --user "$clasp_user" list-deployments >"$list_stdout" 2>"$list_stderr"; then
  node "$GITHUB_WORKSPACE/scripts/classify-clasp-list-error.js" "$list_stdout" "$list_stderr" after >&2
  exit 1
fi
if ! grep -Fq -- "$deployment_id" "$list_stdout"; then
  echo "Existing deployment could not be verified after update." >&2
  exit 1
fi
if ! deployment_has_current_sha; then
  echo "Existing $target deployment does not show the current main commit after update." >&2
  exit 1
fi
echo "Updated existing $target deployment to the current main commit"

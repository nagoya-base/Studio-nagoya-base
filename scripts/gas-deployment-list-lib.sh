#!/usr/bin/env bash
# Issue #804 PR-E1: GASデプロイ系スクリプトで重複していた「clasp list-deployments の読取り処理」の共通部品。
# source 専用（単体実行しない）。読取りだけを行い、clasp の push / update-deployment は呼ばない。
# 出力・戻り値は固定形式のみ（Secret・ID・メール・clasp生出力は返さない）。
#   gas_list_error_code <stdout_file> <stderr_file>   一覧失敗を固定コード(大文字+_)に分類して標準出力へ。不明は UNCLASSIFIED
#   gas_deployment_id_count <deployment_id> <list_file>  ID欄が完全一致する行数（部分一致・説明文中のIDは数えない）
#   gas_deployment_description <deployment_id> <list_file>  ID欄が完全一致する行の description 全体（末尾の空白/CRのみ除去）
# 分類ロジックは scripts/classify-clasp-list-error.js に集約したままで、ここは呼び出し口だけを共通化する。
[[ "${BASH_SOURCE[0]}" != "$0" ]] || { echo "This file is a library; do not run it directly." >&2; exit 1; }

_gas_deployment_list_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

gas_list_error_code() {
  local code
  if ! code="$(node -e '
    const fs = require("fs");
    const { classify } = require(process.argv[1]);
    const read = (f) => { try { return fs.readFileSync(f, "utf8").slice(0, 1024 * 1024); } catch (_) { return ""; } };
    process.stdout.write(classify(read(process.argv[2]) + "\n" + read(process.argv[3])));
  ' "$_gas_deployment_list_dir/classify-clasp-list-error.js" "$1" "$2" 2>/dev/null)"; then
    code="UNCLASSIFIED"
  fi
  [[ "$code" =~ ^[A-Z_]+$ ]] || code="UNCLASSIFIED"
  printf '%s' "$code"
}

gas_deployment_id_count() {
  awk -v id="$1" '$1 == "-" && $2 == id { count++ } END { print count+0 }' "$2"
}

gas_deployment_description() {
  awk -v id="$1" '
    $1 == "-" && $2 == id && $3 ~ /^@/ && $4 == "-" {
      line = $0
      sub(/^[[:space:]]*-[[:space:]]+[^[:space:]]+[[:space:]]+@[^[:space:]]+[[:space:]]+-[[:space:]]*/, "", line)
      sub(/[[:space:]\r]+$/, "", line)
      print line
    }' "$2"
}

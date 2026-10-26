#!/bin/bash
# Claude Code クラウドセッション開始時に stripe-webhook-relay の依存を入れる (#549)
# ルートの `npm test` が cloud-run/stripe-webhook-relay のテストも実行し、
# `stripe` が無いと失敗するため。
set -uo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

relay_dir="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "$0")/../.." && pwd)}/cloud-run/stripe-webhook-relay"

# 失敗してもセッション開始は止めない
if ! (cd "$relay_dir" && npm install --no-audit --no-fund); then
  echo "warning: stripe-webhook-relay の npm install に失敗しました。handler.test.js が失敗する可能性があります" >&2
fi
exit 0

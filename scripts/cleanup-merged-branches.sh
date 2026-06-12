#!/usr/bin/env bash
# 終了済みリモートブランチの一括削除スクリプト（2026-06-12 調査時点）
#
# 使い方:
#   bash scripts/cleanup-merged-branches.sh        # 削除対象を表示のみ（dry-run）
#   bash scripts/cleanup-merged-branches.sh --run  # 実際に削除
#
# 削除対象の判定基準:
#   A) origin/main にマージ済み（git branch -r --merged origin/main）
#   B) PR がマージ済み（スカッシュマージのため A では検出不可）
#   C) PR がマージされずクローズ（不採用。PRページの「Restore branch」で復元可能）
#
# 残しているブランチ:
#   - campaign/end-sns-review                  … PR #142（7/1 マージ予定）
#   - claude/snb-reservation-conversion-3x8550 … PR #141（Draft・URL差し替え待ち）
#   - PR が存在せず main 未マージの13本（下部のコメント参照）

set -euo pipefail

# A) main にマージ済み
MERGED_INTO_MAIN=(
  claude/kinari-theme-switcher-8clii5      # PR #139, #140
  claude/legal-inline-jekyll-ja-xp3r81
  claude/snb-gallery-legal-modal-ewy522    # PR #138
  claude/snb-index-restructure-wtq8ir      # PR #145
  claude/snb-voices-section-3x8550         # PR #143
  claude/studio-website-audit-q6zywb       # PR #132
  color/natural-light                      # PR #134
  copilot/add-theme-switching-feature      # PR #109
  copilot/create-reservation-flow          # PR #108（クローズだが内容はmainに反映済み）
  copilot/edit-bondage-files               # PR #127
  copilot/edit-snb-contact-section         # PR #125
  copilot/edit-snb-site-files              # PR #126
  copilot/fix-theme-switcher-button-position # PR #111
  copilot/move-theme-switcher-button       # PR #112
  copilot/review-all-pages-code
  fix/pr1-copy-meta-calendar               # PR #133
  restore-theme-switcher-safe
)

# B) PR がスカッシュマージ済み
PR_MERGED=(
  claude/add-studio-logo-favicon-9sZ0x     # PR #64-66
  claude/reorganize-prohibited-items-QeRxt # PR #57
  copilot/add-equipment-rental-options     # PR #70
  copilot/add-fee-details-to-bondage-pages # PR #72
  copilot/add-google-analytics-privacy-policy # PR #68
  copilot/add-reservation-availability-news # PR #51
  copilot/change-index-in-mens-folder      # PR #52
  copilot/correct-bondage-membership-fees  # PR #88
  copilot/enable-reservation-link          # PR #50
  copilot/fix-neon-background-mismatch     # PR #104
  copilot/implement-cta-bifurcation        # PR #55
  copilot/improve-extension-fee-promotion  # PR #74
  copilot/reflect-terms-changes-on-other-pages # PR #59
  copilot/review-bondage-index-html        # PR #54
  copilot/suggest-ai-code-review-aspects   # PR #86
  copilot/update-hero-section-and-features # PR #84
  copilot/update-hreflang-to-english-page  # PR #87
  copilot/update-studio-x-page             # PR #71
  feat/issue-61-calendar-below-hero        # PR #62
)

# C) PR がマージされずクローズ（不採用）
PR_CLOSED_UNMERGED=(
  claude/add-analytics-privacy-policy-qxbdK # PR #137（#68 が代わりに採用）
  color/natural-dark                        # PR #135（natural-light #134 が採用）
  copilot/replace-image-with-8539-ping      # PR #105
)

ALL=("${MERGED_INTO_MAIN[@]}" "${PR_MERGED[@]}" "${PR_CLOSED_UNMERGED[@]}")

if [[ "${1:-}" == "--run" ]]; then
  git push origin --delete "${ALL[@]}"
  git fetch --prune origin
  echo "削除完了: ${#ALL[@]} 本"
else
  printf '%s\n' "${ALL[@]}"
  echo
  echo "(dry-run) 上記 ${#ALL[@]} 本を削除します。実行するには: bash $0 --run"
fi

# --- 参考: 残している PR なし・main 未マージのブランチ（要判断） ---
# claude/nagoya-studio-page-update-lCXZ6
# claude/studio-x-homepage-redesign-v8ZOp
# claude/studio-x-landing-page-VeyuI
# claude/update-equipment-section-fD0NH
# copilot/check-price-notation-consistency
# copilot/fix-mens-redirect-loop
# copilot/implement-photography-equipment
# copilot/merge-pull-request
# copilot/setup-photography-equipment
# copilot/suggest-ai-code-review-points
# copilot/update-image-names
# copilot/update-issue-86-status
# copilot/update-mens-index-html

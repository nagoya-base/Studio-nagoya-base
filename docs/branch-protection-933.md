# main ブランチ保護（Issue #933）

このPRで**保護設定そのものは変更していない**。有効化はオーナーの個別承認後に、オーナーが行う。

## 構成

| 要素 | 内容 |
| --- | --- |
| 必須check | `required-gate`（`.github/workflows/pr-required-gate.yml`） |
| 理由 | `booking-pr-tests.yml` は paths フィルター付き。サイトだけのPRでは生成されず、必須にすると永久Pendingになる。`required-gate` は paths フィルターなしで**全PRに必ず生成**される |
| 実行内容 | `npm test`（秘密・Environment・外部APIなし、`contents: read`） |
| 既存の `booking-pr-tests.yml` | 変更なし。対象パスのPRでは隔離テスト等が追加で走る（必須checkには登録しない） |
| ルールセット案 | `.github/rulesets/main-protection.json` |

残余リスク: 必須checkは `required-gate` のみ。`booking-pr-tests.yml` の `booking-test-isolation`（隔離ジョブ）は必須に含めない（paths限定でPendingになるため）。保護導入後も、このジョブの失敗は自動ではマージを阻止しない。対象パスのPRでは、マージ前に当該jobの成功を人間が確認する（レビュー手順で確認）。

ルールセット案の内容:

- 対象は `refs/heads/main` のみ
- Pull request必須（直接push禁止）。承認レビュー人数は **0**（単独運営でマージ不能にならないため。1にするのはレビュー担当者が確保できてから）
- 必須check `required-gate`、ブランチを最新にしてからマージ（strict）
- force-push禁止（`non_fast_forward`）、branch削除禁止（`deletion`）
- 必須checkの送信元を GitHub Actions（`integration_id: 15368`）に固定する。別ユーザー/統合が同名の status/check を投稿しても必須checkを満たせない。登録時にAPIが `integration_id` を受け付けるか、有効化後のreadbackで `integration_id` が残っているかを確認する（受け付けない・消える場合は残余リスクとして本書に記録する）
- **恒常的なバイパスは設けない**（`bypass_actors: []`）。adminでもPRで必須CIを回避できてしまう設定を常設しないため。緊急時の例外は下記「緊急復旧」のRuleset一時Disableのみ（理由・証跡を記録）
- Codex/AIレビューは人間承認の代替としない
- conversation resolution は未強制（`required_review_thread_resolution: false`）。運用が固まったら `true` を検討

## 有効化前の確認（オーナー）

1. GitHubプラン／リポジトリ種別でRulesetsが使えるか（Settings → Rules）。使えない場合は Branch protection で同等設定（`required-gate` を必須、force-push・削除禁止）。
2. このPRをマージし、`required-gate` が**一度以上実行されてcheck名が存在する**こと（未実行のcheckは選択できない）。
3. 現在の状態を記録（変更前の証跡）:
   ```
   gh api repos/nagoya-base/Studio-nagoya-base/branches/main --jq .protected
   gh api repos/nagoya-base/Studio-nagoya-base/rulesets
   ```
4. デプロイ影響: Pages・各GAS・SwitchBot の deploy workflow は `main` へのpush後に走る。PR経由マージ後のpushは保護の対象外（ルールはマージを許可する）ため停止しない。Actions の `GITHUB_TOKEN` による `main` への直接pushが必要な workflow がないか確認する（現行の workflow は `contents: read`／`workflow_dispatch` 中心）。

## 有効化（オーナーが実行）

```
gh api -X POST repos/nagoya-base/Studio-nagoya-base/rulesets --input .github/rulesets/main-protection.json
```

注意: `strict_required_status_checks_policy: true` のため、mainが更新されるたびPRを最新化して `required-gate` を再実行する必要がある。
注意: Ruleset作成のPOSTが成功しても、有効化の確認は別に行う（UIで Active、`gh api .../rulesets/<id>` の `enforcement` と `required_status_checks` の `integration_id` をreadback）。PRのマージだけでは保護は有効にならない。

有効化後の確認: `gh api repos/nagoya-base/Studio-nagoya-base/rulesets` と、テスト用PR
（①サイトだけを触るPRで `required-gate` が走りPendingにならない、②テスト失敗中はマージ不可、③通過でマージ可）。
Rulesets方式では `main.protected` の値だけで未保護と断定しない。

## 緊急復旧・ロールバック

- 設定を戻す（責任者: リポジトリオーナー）: Settings → Rules → `main-protection` を **Disabled** にする、または
  `gh api -X DELETE repos/nagoya-base/Studio-nagoya-base/rulesets/<id>`。
- `required-gate` 自体が壊れて全PRがマージ不能になった場合: 上記でルールセットを一時Disabled → 修正PRをマージ → 再度Active。
  ルールセットを一時Disableした場合は、理由・日時・元に戻した事実を該当Issueに記録する。
- 恒常的な管理者バイパスはない。オーナーは唯一の管理者でもRulesetの編集・無効化ができるため、ロックアウトにはならない。通常PRでは例外を使わない。
- 本番の障害対応で `main` を戻す場合も、revert PR を作成して `required-gate` を通すのを原則とする。間に合わない場合のみ上記の一時無効化を使う。

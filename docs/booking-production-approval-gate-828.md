# Booking本番 Environment承認（booking-production）の扱い（Issue #828）

**この文書は設計・評価・手順の記録です。`booking-production` の設定変更は、運営者の明示的GOを得るまで行いません。**
Issueの作成も、この文書・PRのマージも、設定変更の許可ではありません。
Secrets値・clasp認証JSON・完全なScript/Deployment ID・Webhook URL・生ログは、この文書にも Issue・PR にも書きません。

## 1. 課題

2026-11-07 の Booking 正規更新（#817 で記録）では、テスト成功後に `Review pending deployments` が出て、
GitHub画面での手動承認待ちになった。アプリ／連携エージェントはActionsを起動できても、この承認で止まり、完了まで進められない。
手順自体の不具合ではなく、**Environment保護ルール（Required reviewers）と操作経路の不整合**である。

`Review pending deployments` はEnvironment承認であり、`schema_migrated` 入力（Booking schema変更時の事実確認）とは別物。
前者をどう扱っても、後者の必要性は変わらない。

## 2. 棚卸し：`booking-production` を使うjob（リポジトリ読取り結果）

| workflow | 起動 | 条件 | 書込み | 備考 |
| --- | --- | --- | --- | --- |
| Deploy Booking GAS to production | `workflow_dispatch`のみ | 各jobに`github.ref == refs/heads/main`／`needs: test`／concurrency `booking-gas-production` | Booking Admin・Public（既存Deployment更新） | `environment:` を持つのは deploy job 1つだけ（承認は1回） |
| Update Booking Webhook GAS | `workflow_dispatch`のみ | testjobがmain限定、deployは`needs: test`で連動（deploy自体に直接のmain条件はない）／concurrency `booking-gas-webhook-production` | Webhook専用GAS（Booking本体とは別GAS） | **同じEnvironmentを共有** |
| Confirm booking-production Google account | 手動のみ | Environment内で完結 | なし（アカウント確認のみ） | **同じEnvironmentを共有** |

共通：`permissions: contents: read`／テストjobはSecretsなし／deploy内は「読取りpreflight → 更新 → 事後SHA/版照合」。
Secretsは `booking-production` のEnvironment secretsにあり、**Environmentを外れて参照するjobはない**（Repository secretsへ重複登録しない方針）。

### GitHub側の設定（リポジトリからは読めない＝未確認）

次はリポジトリのファイルでは確認できず、**運営者がSettings → Environments → `booking-production` で確認して記録する**。

- Required reviewers（人数・個人かTeamか）
- Prevent self-review の有無
- Wait timer
- Deployment branches and tags（`main`のみか）
- Environment secrets の**名前一覧のみ**（値は見ない・書かない）
- Actions実行権限（誰がRun workflowできるか＝リポジトリのwrite権限者）

## 3. 影響範囲（承認ゲートを外した場合／変えた場合）

承認は **Environment単位** なので、Required reviewersを外すと**3 workflowすべて**で承認待ちがなくなる。

- Booking Admin/Public：dispatchした人が、テスト緑の直後に更新まで進める。
- **Booking Webhook：同様に承認なしで更新される。** Webhookは決済確定経路に関わるため、Admin/Publicより被害が大きくなり得る。
  Webhookだけ承認を残す場合は、**Environmentを分離する**（案③）以外に方法がない。
- Confirm account：読取りのみのため影響は小さい。
- 他Environment（`survey-production` / `switchbot-access-production` / `switchbot-verify` 等）は**対象外・変更しない**。

## 4. 方式比較

| 案 | 内容 | 良い点 | 懸念 |
| --- | --- | --- | --- |
| ① 解除 | Required reviewersを外し、dispatch＋既存テスト／preflight／post-checkに委ねる | アプリから最後まで進む。手順が最短 | 人の承認が消える。**preflight／post-checkは承認の代替ではない**（誤った内容を正しく反映することは防げない）。Webhookも巻き込まれる。dispatch権限者＝実質の承認者になる |
| ② ゲートを残しアプリが正規に承認 | Required reviewersを維持し、アプリが運営者本人の権限で承認APIを呼ぶ（運営者が内容確認後に明示指示） | 承認者・時刻がGitHubの履歴に残る。Webhook含め保護を弱めない | GitHub Appのbot自身はreviewerにできない（reviewerはユーザー／Team）。アプリが**運営者のユーザー権限**で動く構成が必要。Prevent self-reviewが有効だと、dispatch者と同一人物は承認できない（この場合は別の承認者が要る）。**承認API利用可否は未検証** |
| ③ Environment分離 | Admin/Public用とWebhook用でEnvironmentを分け、一方だけ承認を外す／残す | 影響を限定できる。Webhookだけ人の承認を維持できる | Secretsの再登録（移設）が必要で、運営者作業が増える。workflow・テスト・手順書の改修を伴う |

### 推奨（運営者の判断材料。決定ではない）

1. **第一候補は②**。承認者・時刻が履歴に残り、Webhookを含め保護を弱めない。成立条件は「アプリが運営者のユーザー権限で承認APIを呼べること」と「Prevent self-reviewとの整合」。
2. ②が成立しない場合（権限・self-review制約など）は、**③でAdmin/Publicのみ承認を外す**ことを検討する。Webhookは承認を残す。
3. ①（共有Environmentのまま全解除）は、Webhookの承認も失うため**推奨しない**。採る場合は §5 の保護すべてが残ることの照合と、Webhook影響の許容を運営者が明示すること。

GitHub側の権限制約・承認APIの利用可否は**実環境で未検証**。運営者の確認結果を §8 に記録してから採否を決める。

## 5. 案①（または③の承認なし側）を採る場合に残すべき保護

実装・設定との照合結果（リポジトリで確認できる分）：

| 保護 | 現状 | 確認方法 |
| --- | --- | --- |
| `workflow_dispatch`のみ（push／PR／scheduleで起動しない） | ✓ | `test/booking-approval-gate-828.test.js` |
| branch = `main` のみ（testjobの `if`。Webhookのdeployは`needs: test`経由、Booking本体は各jobにも`if`） | ✓ | 同上 |
| 更新前にテスト（`needs: test`） | ✓ | 既存 `booking-gas-production-workflow.test.js` |
| 読取りpreflight → 既存Deployment更新 → SHA/版のpost-check／失敗時停止 | ✓ | 既存テスト |
| concurrency（同時実行なし・途中キャンセルなし） | ✓ | 既存テスト |
| Secretsは `booking-production` のEnvironment secretsのみ・必要stepだけに渡す | ✓ | 既存テスト |
| 誰がdispatchできるか（リポジトリwrite権限者）／操作履歴 | **設定依存・未確認** | §8 の記録 |
| Deployment branches が `main` のみ | **設定依存・未確認** | §8 の記録 |

**注意**：承認を外すと、リポジトリへのwrite権限者は誰でも本番更新を起動できる。write権限者の一覧確認と最小化が前提になる。

## 6. 実施手順（運営者GO取得後。実施主体＝運営者）

1. **事前**：§2 の未確認項目を確認し、§8 に「変更前」を記録（設定状態のみ。Secrets値は不要）。
2. **GO**：運営者が採用案（②／③／①）と対象Environmentを明示して承認する。
3. **変更**：運営者が Settings → Environments で実施（②なら権限整備、③ならEnvironment新設とSecrets移設、①ならRequired reviewers解除）。アプリ・エージェントはSettingsを変更しない。
4. **変更後**：§8 に「変更後」を記録。必要なら workflow／テスト／手順書を別PRで改修する。
5. **検証**：確認のためだけに本番更新を走らせない。**次回の正規Booking更新**で、承認待ちの有無・テスト・preflight・post-checkの結果を #817 へ**実行URLと結果のみ**追記する。

## 7. 復旧（変更前へ戻す）

- Required reviewers を再設定する（記録した変更前の人数・Team・Prevent self-reviewに戻す）。
- ③を行った場合は、移設したEnvironment・Secretsの対応を元に戻すか、旧Environmentを維持していたかを確認する。
- 戻すまでの間、必要なら該当2 workflow（Booking GAS本番／Webhook）の実行を止める（Actionsの無効化、またはwrite権限の確認）。
- 戻した後、Required reviewersが効くこと（次回dispatchで承認待ちになること）を確認する。

## 8. 設定変更記録（運営者が記入。Secrets値は書かない）

| 項目 | 変更前 | 変更後 | 記録日・実施者 |
| --- | --- | --- | --- |
| Required reviewers | 未記入 | 未記入 | |
| Prevent self-review | 未記入 | 未記入 | |
| Wait timer | 未記入 | 未記入 | |
| Deployment branches and tags | 未記入 | 未記入 | |
| Actions実行権限（dispatch可能な範囲） | 未記入 | 未記入 | |
| 承認APIの利用可否（②の場合） | 未検証 | 未記入 | |
| 次回正規更新の実行URL／承認待ち有無／結果 | — | 未記入（#817へ追記） | |

## 9. 受入条件との対応

- アプリから進められる：**方式未決定のため未検証**（運営者GOと §8 の確認後、次回正規更新で検証）。
- Webhookへの副作用：§3 に明文化（共有Environment＝解除で同時に外れる）。許容可否は運営者が判断。
- main／dispatch限定・テスト／preflight／post-check／concurrency／Secretsスコープ：弱めていない（本PRはworkflowを変更しない。静的テストで固定）。
- 手順書・テスト・記録の一致：本文書、`docs/gas-operator-one-screen-817.md`、`docs/booking-gas-production-deploy.md` を整合。
- 戻す手順：§7。

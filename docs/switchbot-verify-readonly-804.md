# SwitchBot 読み取り診断の統合入口（Issue #804 PR-E2 / 旧入口の整理 PR-F）

## 運営者向け：使い方

**Actions → 「SwitchBot read-only diagnostics (manual)」** を開き、`operation` を選んで実行します。
読むだけの診断です。鍵の発行・削除や Webhook の登録・削除は、この入口からは**できません**。

| やりたいこと | operation | 追加で入力するもの | 以前の入口（#804 PR-Fで廃止） |
|---|---|---|---|
| 登録済みデバイスIDが正しいか確認 | `device-id` | `last4`（末尾4桁） | SwitchBot device ID check |
| 鍵一覧を取得できるか・件数 | `keylist` | `last4`（末尾4桁） | SwitchBot keyList check |
| Webhook の登録URL照会の応答を確認 | `webhook-url` | なし | SwitchBot queryWebhook raw diagnostic |
| Webhook の詳細照会の応答を確認 | `webhook-details` | `target`（current / old） | SwitchBot queryDetails diagnostic |

- 実行前に Environment `switchbot-verify` の承認が必要です（廃止した以前の入口と同じ）。
- `last4` は `device-id` / `keylist` のときだけ必須です。形式が違うと、SwitchBot に接続する前に止まります。
- 結果の読み方は廃止した以前の入口と同じです（出力はそのまま引き継いでいます）。

### エラーが出たとき
- 「operation が不正」「末尾4桁の入力が必要」→ 入力を直して再実行（SwitchBot には接続していません）。
- 「未設定」→ Environment `switchbot-verify` の該当 Secret を登録（値はログやIssueに貼らない）。
- 診断が失敗扱いになる → 各診断の既存の表示に従います。**Webhook 診断は 0 件・未登録とは断定しません**（以前と同じ）。
- 変更が必要な作業（鍵の発行/削除・Webhook 登録/削除・復旧）は、従来どおり専用の入口
  （`switchbot-verify-key.yml`）で行います。

## 廃止した入口と、残した入口（#804 PR-F）
診断の入口はこの1つに集約しました。次の5本は廃止（workflowファイルを削除）しています。
- `switchbot-verify-device-id.yml` / `switchbot-verify-keylist.yml` / `switchbot-verify-webhook-raw.yml` / `switchbot-verify-webhook-details.yml`：上表の operation に置き換え済み。診断scriptは本入口が使うため残しています。
- `switchbot-verify-webhook-setup-once.yml`：#741 の一回限りの例外検証（実行済み・Issue完了）。Webhookを変更する入口で、再実行しない運用のため、scriptとテストごと削除しました。

残した入口（意図的）：
- **SwitchBot devices check（`switchbot-verify-devices.yml`）**：repository secrets を使い、Environment secrets の他入口と保管境界が違うため、単純に移していません。
- **`switchbot-verify-key.yml`**：変更・復旧を含む11操作。診断入口から呼びません。
- **`switchbot-verify-gas-deploy.yml`**：別GASの更新入口。診断ではありません。

### 廃止の根拠（非機密のrun情報のみ）
最終実行はいずれも2026-11-03（device-id: 6回／keylist: 6回／webhook-raw: 1回／webhook-details: 2回／setup-once: 1回・成功）。以後の実行はなく、他workflow・手順書からの呼び出しもありません（`switchbot-passcode-verification-713.md` の参照先だけ本入口へ更新）。

### 万一戻したいとき
削除したworkflowはGit履歴に残っています（このPRを revert すれば復活）。診断scriptは残っているため、本入口が使えない場合も旧workflowを戻すだけで同じ診断ができます。

## 技術詳細
- 追加済み（PR-E2）：`.github/workflows/switchbot-verify-readonly.yml`、`scripts/switchbot-verify-readonly.js`、`test/switchbot-verify-readonly-804.test.js`。
- 入口スクリプトは許可リスト（自前プロパティのみ）で既存の診断スクリプトを呼ぶ薄い層です。診断の判定・出力・終了コードは変えていません。
- 診断へ渡す環境変数はその診断に必要な名前だけ。workflow でも Secret は選択した operation の step にだけ渡し、job 全体の `env` には置きません（`secrets: inherit` なし）。
- `fetch` を読み取り専用ガードで包み、`GET /v1.1/devices` と `POST /v1.1/webhook/queryWebhook`（`action` が `queryUrl` / `queryDetails` のみ）以外は送信前に例外で止めます（診断側に変更APIが紛れ込んでも到達不能）。
- concurrency は専用 group `switchbot-verify-readonly`（`cancel-in-progress: false`）。変更系 `switchbot-verify-key` の待ち行列とは共有しません（待機中の変更系 run を押し出さないため）。
- 起動は `workflow_dispatch` のみ、`permissions: contents: read`。

## 未検証・注意
- 実Actions・実SwitchBot APIでの動作確認（2026-11-07、main `b99f4c5`、読み取りのみ・全4操作success。詳細は #817）：
  `device-id` [run 42336779489](https://github.com/nagoya-base/Studio-nagoya-base/actions/runs/42336779489) ／
  `keylist` [run 42337088217](https://github.com/nagoya-base/Studio-nagoya-base/actions/runs/42337088217) ／
  `webhook-url` [run 42337412214](https://github.com/nagoya-base/Studio-nagoya-base/actions/runs/42337412214) ／
  `webhook-details` [run 42337742979](https://github.com/nagoya-base/Studio-nagoya-base/actions/runs/42337742979)。
- 上記は入口が動くことの確認だけです。Webhookの実配信・到達、鍵の有効性・解錠、期限境界試験（#756）の成功は証明しません。
- 診断は SwitchBot Token/Secret の有効性を読み取りで確認するだけで、鍵・Webhook の実運用可否を保証しません。

# 鍵管理用・独立GAS 資格情報3件の初回登録（簡素化手順・Issue #772）

独立GAS「SwitchBot Access Production」の資格情報3件（`SWITCHBOT_TOKEN` / `SWITCHBOT_SECRET` / `WEBHOOK_SHARED_TOKEN`）を、
**追加のGCPプロジェクト・OAuth・API実行可能Deployment・ローカルCLI認証なし**で、GASエディタとプロジェクト設定画面だけで
一度だけ User Properties へ移す標準手順。#770/#771 の CLI + Execution API 経路は履歴として残すが、**初回登録の標準手順ではない**。

**このPRのマージは移行の実行を意味しない。** 実行・デプロイ・`ACCESS_ENABLED` ON・マージは運営者が別途行う。
`ACCESS_ENABLED` は OFF のまま、GAS Deployment・トリガー・Webhook登録・SwitchBot APIには一切触れない。

## 1. 仕組み

```
設定画面: Script Properties に一時キー3件を登録
   BOOTSTRAP_SWITCHBOT_TOKEN / BOOTSTRAP_SWITCHBOT_SECRET / BOOTSTRAP_WEBHOOK_SHARED_TOKEN
        │  エディタで accessMigrateCredentialsOnce を手動で1回実行
        ▼
User Properties: SWITCHBOT_TOKEN / SWITCHBOT_SECRET / WEBHOOK_SHARED_TOKEN（実行者本人のみ）
        └─ 成功後、一時キー3件を削除（他の Script Properties は読まず・変えない）
```

使うのは公式サポート範囲の機能のみ（エディタでの関数実行、プロジェクト設定のスクリプトプロパティ、`PropertiesService`）。
独立GASのエディタには安全な秘密入力ダイアログがない（`Browser.inputBox` / container-bound の `Ui` は使えない）ため、
入力欄は設けず、設定画面の Script Properties を一時的な入力口として使う。

## 2. セキュリティ上のトレードオフ（必ず理解してから実施）

- **この方式は「秘密を常に User Properties だけに置く」運用と同等の安全性ではない。** 登録から移行完了までの短時間、
  秘密3件が **Script Properties に平文**で存在する。Script Properties はプロジェクトの編集者全員が読める。
- 運営者の申告（Issue #772 コメント）により、独立GASは**本人しか閲覧・編集しない**前提で、この方式を採用する。**実施前に必ず §3 で実際の共有設定を確認**する。
- Script Properties の変更履歴や Google 内部ログからの完全消去は保証できない。削除は「プロパティの現在値の除去」である。
  漏えいが疑われる場合・手順が途中で失敗して一時キーが残った可能性がある場合は、SwitchBot の Token/Secret をローテーション（再発行）し、Webhook共有トークンも作り直す。
- 編集者が本人以外にもいる／確認できない場合は**この方式を使わない**。代替: #770 の CLI + Execution API 経路（docs/switchbot-access-credentials-770.md。GCP/OAuth/API Deployment の追加が必要）。

## 3. 事前ゲート（秘密を入力する前に、すべて確認。1つでも満たせなければ中止）

1. GASプロジェクトの共有設定（エディタ右上「共有」）で、**編集者・閲覧者が運営者本人のみ**（他のユーザー・グループ・「リンクを知っている全員」が無い）。
2. Webアプリの実行ユーザー（Deployment の「次のユーザーとして実行」）が**運営者本人**で、エディタを開いているアカウントも同じ本人。
3. `ACCESS_ENABLED` が未設定（OFF）。GitHub自動デプロイもOFF。
4. エディタで `accessBootstrapStatus` を実行し（**秘密を入力する前**。`ACCESS_ENABLED` が ON/不明だと `ok:false` になる）、実行ログが `"ok":true`、`SWITCHBOT_*` / `WEBHOOK_SHARED_TOKEN` が **`MISSING`**、`BOOTSTRAP_*` が **`ABSENT`**、`"accessEnabled":"OFF"` であること。
5. `accessCheckSetup` で `config` が `VALID`（既存の `ACCESS_CONFIG` 等が SET）。

## 4. 手順（Windows・1操作ずつ）

> 秘密をチャット・Issue・PR・メモ帳・スクリーンショット・画面共有に貼らない。

**A. Webhook共有トークンをローカルで作る**
1. Windows のスタートで「PowerShell」を開く。
2. 次の1行を貼って Enter（画面には表示されず、クリップボードに入る。24バイト＝32文字・URL安全）:
   `$b=New-Object byte[] 24; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); [Convert]::ToBase64String($b).Replace('+','-').Replace('/','_') | Set-Clipboard`
3. ブラウザで GASエディタ →（左の歯車）**プロジェクトの設定** → 下へスクロールして **スクリプト プロパティ** → **スクリプト プロパティを編集** を開く。
4. **プロパティを追加**。プロパティ名 `BOOTSTRAP_WEBHOOK_SHARED_TOKEN`、値に **貼り付け**（Ctrl+V）。
5. パスワードマネージャに「Webhook共有トークン（鍵管理GAS）」として**同じ値を保管**（貼り付けて保存）。この値は後の Webhook 登録（別承認）で使う。

**B. SwitchBot の Token / Secret を入れる**（運営者が所持するもの。SwitchBotアプリで確認）
6. **プロパティを追加**。名前 `BOOTSTRAP_SWITCHBOT_TOKEN`、値に Token を貼り付け。
7. **プロパティを追加**。名前 `BOOTSTRAP_SWITCHBOT_SECRET`、値に Secret を貼り付け。
8. **スクリプト プロパティを保存**。既存の `ACCESS_*` / `LEDGER_*` は**編集・削除しない**。

**C. 移行を1回だけ実行**
9. エディタに戻り、上部の関数選択で **`accessMigrateCredentialsOnce`** を選び **実行**。
10. 実行ログ（下部）に `"ok":true,"code":"OK"` と、`bootstrap` の3件が `ABSENT`、`status` の3件が `SET`、`"accessEnabled":"OFF"` が出ることを確認（値は出ない）。
11. 設定画面のスクリプト プロパティを開き直し、**`BOOTSTRAP_*` が1件も残っていない**ことを目視確認。
12. 関数 **`accessBootstrapStatus`** を実行し、`BOOTSTRAP_*` が3件 `ABSENT` / 正式3件 `SET` を再確認。続けて **`accessCheckSetup`** を実行し、3件 `SET` / `ACCESS_ENABLED=OFF` / `config=VALID` を確認。

**D. 後片付け**
13. Windows の **Win+V**（クリップボード履歴）→ **すべてクリア**。PowerShell のウィンドウを閉じる。
14. （必要なら）Token/Secret をローテーションする。次の作業（Webhook URL登録・鍵発行・`ACCESS_ENABLED` ON）は**別承認（#756/#757 承認前は行わない）**。

## 5. 失敗時の動作と復旧

関数は固定コードだけを返し、値・例外メッセージはログ/戻り値に出さない。**認可後の失敗では一時キーを可能な限り削除する**
（その後は手順 A〜C をやり直し、Token/Secret を再入力）。

| code | 意味 | 対応 |
| --- | --- | --- |
| `OK` | 移行完了・一時キー削除済み | 手順11以降 |
| `NOT_AUTHORIZED` / `IDENTITY_UNAVAILABLE` / `ACCOUNT_MISMATCH` | 許可管理者本人・実効ユーザー一致を確認できない | **何も変更せず停止**（一時キーも消さない）。運営者本人のアカウントで開き直す。入力済みなら `accessScrubBootstrapCredentials` で消去 |
| `USER_PROPS_NOT_EMPTY` | 移行先が1件でもSET。**上書きしない** | 一時キーは削除される。置換が必要なら #770 の replace 経路（別判断） |
| `BOOTSTRAP_INCOMPLETE` / `INPUT_INVALID` / `INPUT_DUPLICATE` | 一時キーの欠落・形式不備・3種の重複 | 何も登録されない。一時キーは削除される。不備の名前は `invalid` に出る。A〜Cをやり直す |
| `ACCESS_NOT_OFF` / `ACCESS_STATE_UNKNOWN` | `ACCESS_ENABLED` が ON、または読取不能・想定外の値。**何も書かずに停止**（実行直前とロック下の書込み直前の2回確認。`accessBootstrapStatus` も同じ条件で `ok:false`） | 一時キーは自動では消さない。`ACCESS_ENABLED` を意図せず ON にしていないか確認し、**OFF に戻すまで移行しない**。入力済みの秘密は `accessScrubBootstrapCredentials` か設定画面の手動削除で消す |
| `BOOTSTRAP_MISSING` | 一時キーが無い | 何も変更しない。手順 A〜B から |
| `READ_FAILED` / `STATE_CHANGED` / `LOCK_BUSY` / `LOCK_UNAVAILABLE` | 読取不能・競合・ロック | 何も書かない。少し待って `accessBootstrapStatus` で状態確認後に再実行 |
| `WRITE_FAILED` / `VERIFY_FAILED` | 書込み/照合失敗。書いた分は元に戻した | 一時キーは削除される。やり直し |
| **`ROLLBACK_FAILED`** | 書込み失敗後、移行先の**部分書込みを戻せなかった可能性** | **以降の操作を停止**。`accessBootstrapStatus` で状態点検し、秘密をローテーション。User Properties を手動で整えるまで `ACCESS_ENABLED` は OFF のまま |
| **`MIGRATED_CLEANUP_FAILED`** | 移行はできたが一時キーが消えていない | **直ちに設定画面で `BOOTSTRAP_*` を手動削除**し、`accessBootstrapStatus` で `ABSENT` を確認。残存時間が長い／不明ならローテーション |
| `cleanup: CLEANUP_FAILED`（他コードに付随） | 失敗後の一時キー削除に失敗 | 同上。手動削除して `accessScrubBootstrapCredentials` / `accessBootstrapStatus` で確認 |

一時キーが残っていないかは、設定画面の目視と `accessBootstrapStatus`（読取専用）で必ず二重に確認する。

## 6. 撤去・再登録・保管

- 撤去: User Properties の3件は §4 の関数では消さない（誤消去防止）。必要時は別途判断（#770 の経路/エディタの一時関数）。
- 再登録（差替え）: 移行先が SET のため本関数は拒否する（`USER_PROPS_NOT_EMPTY`）。#770 の replace 経路を使う別判断とする。
- Webhook共有トークンはパスワードマネージャで保管。GitHub・GASソース・実行ログ・Issue/PRには値を残さない。

## 7. 既存の #770 API登録関数について（レビュー結果）

`accessSetupCredentialsApi` / `accessCredentialStatusApi` と `scripts/switchbot-access-setup-credentials.js` は**削除せず残す**。
呼び出し経路はAPI実行可能Deployment（未作成）のみで、現状は到達不能のため無効化しても安全性は上がらない一方、
置換（replace）用途で再利用できる。標準手順から外し、ソースコメントで明記した。設定画面に存在しない項目を案内しない。

## 8. 守る範囲

- Script Properties は `BOOTSTRAP_*` 3キーのみ読み・消去（書込みなし）。User Properties は正式3キーのみ。
- `ACCESS_ENABLED`・Deployment・トリガー・Webhook登録・SwitchBot API・ネットワークには触れない（テストで検証）。
- #754 は独立GASの読取り診断成功までOPEN。#756/#757 承認前の鍵自動発行は禁止。

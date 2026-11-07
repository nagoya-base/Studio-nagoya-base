# 37DD 期限境界（開始前／期間内／期限後）解錠試験 手順（親 #748・計画 #756）

独立GAS `SwitchBot Access Test` の37DDだけで、未来開始・短期間の試験キー1件の解錠を粗い境界で観測する手動入口。
**コード作成・PRマージ・デプロイ・ARMED設定をもって実機GOとはしない。** 本PRは入口とモックテストの追加のみで、実機通信・実機操作・本番ONは含まない。

## GOの段階（混同しない）

| 段階 | 内容 | 実機への作用 |
| --- | --- | --- |
| ① PRレビュー | 本PRのCI／Codex／タケル再レビュー。マージは実機実行を認めない | なし |
| ② デプロイGO | 運営者が明示。**検証用の独立GAS（`SwitchBot Access Test`）だけ**に反映。本番Access GAS（@6）・01FDには触れない。反映後、通信なしの `accessBndStatus` を #756 に記録して再レビュー | なし（通信ゼロ） |
| ③ 実機API／解錠GO | 試験日・担当・完全ID非公開一致・通信回数・試行回数・A2再試行の可否・回収責任者を #756 に揃えて運営者が明示 | 37DDのみ |

## 証拠の限界（必ず併記）

- 過去の37DD試験（#791/#797）は一度も解錠していない。`startTime/endTime` の単位・時刻解釈（秒／JST／端末時計）が実機で効くかは**未検証**。モックは「秒で送る」ことしか示さない。
- A1（開始前）・A4（期限後）の**拒否だけでは時間制御の証明にならない**。「登録済み・同一キー・一時ロックや通信不良なし」という前提と併せて読む。前提が崩れた拒否は `INCONCLUSIVE`。
- 解錠はAPIで観測できない現地の物理操作で、結果は**オーナーの申告**。コードは申告時刻の整合（A1は開始前、A2/A3は期間内、A4は期限後）だけ機械検査する。
- 境界は粗い（S±180／E±180秒）。精密な秒境界、2予約約1分重複、変更・延長・取消、別送メール、01FDは**別フェーズ・別GO**。
- 単一端末・単一キー・1回の観測。再現性・機種差は未検証。

## 試験キーと時刻（案。承認値はGO欄で確定）

- `type=timeLimit`、開始 S = T0+600秒、有効期間 900秒（終了 E = S+900）。ガード：開始オフセット300〜900、期間600〜1800秒の範囲外は通信前に拒否（`TIME_WINDOW_GUARD`）。
- **T0 は送信直前の時計で固定**：状態の永続から送信までの時計差が5秒を超えたら `createKey` を送らず停止（`ISSUE_CLOCK_DRIFT`）。
- 出力は `timeUnit=EPOCH_SECONDS_NOT_VERIFIED_ON_DEVICE`（単位は実機未保証）と `timeProfile`。`VERIFY_ISSUED` は返却された開始・終了が要求と一致するかを照合（返らなければ `attrEcho=NOT_RETURNED_UNVERIFIED` と記録）。
- **A1の余裕を機械的に確保**：`VERIFY_ISSUED` は発行から120秒以上、かつ S−240秒より前でなければ実行しない。遅れたら通信せず `A1_HEADROOM_INSUFFICIENT` で停止し、その回は続行しない（試験キーは公式アプリで回収）。

## 通信計画（合計4回・各段階1回・再送なし・deleteKeyなし）

| 段階 | 承認値 | 通信 | 条件 |
| --- | --- | --- | --- |
| 1 | `LIST` | GET 1回 | 完全deviceIdで1件一致・試験キー形式の残骸なし。基準と #791/#797 状態の指紋を保存 |
| 2 | `ISSUE` | createKey 1回 | LISTから60秒以上900秒以内。暗証番号・申告が揃う。通信前に暗証番号を破棄 |
| 3 | `VERIFY_ISSUED` | GET 1回 | 発行から120秒以上かつ S−240秒より前。件数=基準+1、通常キー不変 |
| — | `A1`〜`A4` 申告 | 通信0 | 現地の物理操作の結果を申告（下記） |
| 4 | `FINAL_LIST` | GET 1回 | E+300秒以降。期限切れキーの残存／不在を観測（残っても自動削除しない） |
| — | `APP_ABSENT` / `APP_PRESENT` | 通信0 | 公式アプリで試験キーを手動削除し、不在を目視 → `RECOVERED`（回収の完了。合否は `verdict` で別に判定） |

- 上限は4回で固定（`BND_MAX_CALLS=4`）。追加GET・createKey再送・予算リセットは含まない。
- 通信前に「承認の消費＋呼出し回数＋送信済みマーカー」を永続。永続に失敗したら通信しない。timeout／UNKNOWN／不受理は再送も追加確認もせず `STOPPED`（以後の変更操作は自動で止まる）。
- #791（`STOPPED`・5/5）と #797（`COMPLETE`・6/6）の状態は**読むだけ**。両ARMED／APPROVALが未設定であることと、状態の指紋が試験中に変わっていないことを毎段階確認する（変化は `LEGACY_STATE_CHANGED` で停止）。
- `FINAL_LIST` が取得できなくても追加GETや無承認の削除はしない。
- **STOPPED の保存に失敗した場合**：停止（`persistStop`／`halt`）の書込み結果を必ず検査し、失敗時は `STOP_NOT_PERSISTED`（先頭の固定コード）＋元の理由＋`persistence=NOT_PERSISTED`＋`manualRecovery=true` を返す。`STOPPED` が保存されたとは報告しない。通信後の停止なら永続状態は `*_SENT` のまま残り、それが再送抑止になる（以後の段階は `INTERRUPTED_MANUAL_RECOVERY`）。通信前の停止なら永続状態は変わらない。いずれも自動再送・追加通信・無断復旧はしない。公式アプリで試験キーの有無を確認し、残っていれば手動削除、状態の修復はオーナーが `accessBndStatus` で確認してから行う。

## 使い捨て暗証番号の取扱い（秘密破棄の状態遷移）

```
未設定 ──(オーナー設定: PASSCODE=8桁 / ATTEST=NOT_IN_USE_CONFIRMED)──▶ 設定済み
設定済み ──ISSUE が通信前に読取・両方を削除し読み直しで消滅確認──▶ 破棄済み(CONSUMED) ──▶ createKey 送信
設定済み ──ISSUE の拒否・失敗・例外のどの経路──▶ 両方を削除（SCRUBBED_ON_STOP）
           （環境・実行者・端末・#791/#797・ARMED・ロック・状態読取など、**最初のゲートでの早期拒否を含む**。通信は常にゼロ。削除するのはこの2プロパティだけで、未設定なら削除操作自体を行わない）
削除に失敗 ──▶ 通信せず STOPPED(PASSCODE_DELETE_FAILED)・手動復旧（残留を成功扱いしない）
ISSUE 以外の段階で残留を検出 ──▶ 削除して停止(PASSCODE_RESIDUAL)
```

- 設定先は Script Properties の `ACCESS_BND_TEST_PASSCODE`（8桁数字。全桁同一・連番は拒否）と `ACCESS_BND_PASSCODE_ATTEST=NOT_IN_USE_CONFIRMED`。
- **既存の通常コードとの重複はシステムでは検証できない**ため、オーナーの申告がなければ発行しない（`PASSCODE_UNIQUENESS_UNATTESTED`）。通常コードと別の番号にする。終了後は再利用しない。
- 値は出力・ログ・戻り値・状態・テストのスナップショットに出ない。状態確認は `PRESENT/ABSENT` のみ。
- **オーナーの入力に必要な番号は、オーナー自身が非公開に保持する**（記憶または手元の紙。Issue・チャット・スクリーンショット・Script Propertiesの履歴に残さない）。スクリプトは番号を再表示しない。試験後は紙を破棄する。設定はISSUE**直前**に行い、LIST〜ISSUE間に置かない。
- 拒否で破棄された場合（例：間隔不足）は設定し直す。

## 解錠観測（申告）と一時ロック対策

承認値（`ACCESS_BND_TEST_APPROVAL`）を設定して `accessBndObserve` を1回ずつ実行する。外れた時刻の申告は状態を変えず拒否される（`OBSERVATION_TIME_MISMATCH`。その場合は `*_SKIPPED` を申告する）。

| 承認値 | 意味 | 結果 |
| --- | --- | --- |
| `A1_DENIED` / `A1_INCONCLUSIVE` / `A1_SKIPPED` | 開始前（S−180秒目安）に1回試行 | 記録して次へ |
| `A1_UNLOCKED` | 開始前に解錠できた | **重大・即 STOPPED** |
| `A2_UNLOCKED` / `A2_SKIPPED` | 期間内（S+180秒目安） | 記録して次へ |
| `A2_DENIED` | 期間内で拒否 | `ACCESS_BND_A2_RETRY_GO=ALLOWED_ONCE` がなければ STOPPED。あれば許可を消費して `A2_RETRY_PENDING`（再試行はS+300秒目安） |
| `A2R_UNLOCKED` / `A2R_DENIED` | 再試行の結果 | 解錠は記録／拒否は STOPPED |
| `A2R_SKIPPED` | 許可された再試行を実施しなかった（期限切れ・兆候等） | 記録して次へ（A2 は未解錠のままなので合否は `BOUNDARY_NOT_ESTABLISHED`） |
| `A3_UNLOCKED` / `A3_SKIPPED` | 期間末尾（E−180秒目安） | 記録して次へ |
| `A3_DENIED` | 期間末尾で拒否 | **STOPPED**（失効が早い疑い） |
| `A4_DENIED` / `A4_INCONCLUSIVE` / `A4_SKIPPED` | 期限後（E+180秒目安）に1回試行 | 記録して次へ |
| `A4_UNLOCKED` | 期限後も解錠できた | **重大・即 STOPPED** |
| `KEYPAD_LOCK_SIGN` | ロック・警報・異音等の兆候。**A4記録後・FINAL_LIST後（回収前）でも記録できる** | 即 STOPPED。合否は `BOUNDARY_NOT_ESTABLISHED`（暫定のPASSも無効） |

- **永続の順序**：観測の申告は「状態の永続 → 承認の消費」の順。状態を書けなければ承認を消費せず状態も進めない（再申告できる）。重大な申告（解錠異常・ロック兆候・A2拒否）を永続できなければ `CRITICAL_NOT_PERSISTED`＋`manualRecovery`（`STOPPED` と偽って報告しない）。公式アプリで試験キーを手動回収し、状態を修復してから再申告する。
- **A2を機械的に2回試行しない。** 最初の拒否の時点で、通信外で安全な原因確認（キーパッドの表示・電池・距離・基準時計との差・誤入力でないこと）を行う。2回目の可否はGO欄で明記し、許可（`ALLOWED_ONCE`）がなければ試行しない。
- **誤入力の一時ロック・警報への影響は未確認。** GO前に、機種／公式アプリの案内で「誤入力の回数上限・ロック・警報」を可能な範囲で確認し、結果（確認済／未確認）をGO欄に記載する。確認できない、またはロック・警報があり得る場合は A1／A4 を**試行せず** `*_SKIPPED` とする（拒否の実測は諦め、未実施として記録）。兆候が出たら直ちに停止し、代替解錠で復旧する。
- 通常キーでの解錠確認は、試験中に異常兆候（ロック・警報・通信不良）が一度でもあれば無理に行わない。
- **回数上限**：A1=1回・A2=1回（許可があれば再試行1回）・A3=1回・A4=1回。

## 回収（完了条件）

試験キーはAPIで削除しない。**公式アプリで専用試験キー（名前が `TST` で始まる1件）のみ手動削除し、アプリ上の不在を目視**してから `APP_ABSENT` を記録する。

- 期限切れは「無害」ではない。残存を放置せず、`RECOVERED` は回収後にだけ付く。
- `FINAL_LISTED_APP_PENDING` で `APP_ABSENT` → `RECOVERED`（**回収の完了**であって試験合格ではない）。API観測（`FINAL_LIST`）と公式アプリの結果は**別々に記録**する。
- 途中停止（STOPPED／中断）からの回収は `APP_ABSENT` で `STOPPED_RECOVERED`（`ABORTED_AND_RECOVERED`）。合否は `BOUNDARY_NOT_ESTABLISHED`。
- `APP_PRESENT`（削除できない）は `STOPPED` のまま、管理者による別個の回収判断。**回収が済むまで 01FD へ進まない。**
- 発行前の停止（試験キーを作っていない）には回収記録は不要。

## 回収と試験合否は別々に記録する（`recovery` と `verdict`）

手動回収が済んだこと（`recovery=RECOVERED`）は成功として記録するが、**境界試験の合否ではない**。合否は観測の申告から独立に判定する。

| `verdict` | 条件 | 01FDの判断への使用 |
| --- | --- | --- |
| `BOUNDARY_PASS` | A1=`DENIED`・A2=`UNLOCKED`（許可再試行での解錠は `a2Basis=RETRY_GRANTED` として根拠を区別）・A3=`UNLOCKED`・A4=`DENIED`、かつ前提の証拠（`VERIFY_ISSUED` の `attrEcho=RETURNED_AND_MATCHED`）がそろう | 使用可（`USABLE_FOR_01FD_JUDGEMENT`）。ただし粗い境界・単一端末・申告ベースの限界を併記 |
| `BOUNDARY_PARTIAL` | `SKIPPED` を含む（未実施の観測がある） | 使用不可 |
| `BOUNDARY_INCONCLUSIVE` | `INCONCLUSIVE`（前提が崩れた拒否）を含む | 使用不可 |
| `BOUNDARY_PARTIAL_PREMISE_UNVERIFIED` | 観測は期待どおりだが、返却された開始・終了が確認できない | 使用不可 |
| `BOUNDARY_NOT_ESTABLISHED` | 観測が欠ける、または重大異常・ロック兆候・途中停止 | 使用不可 |

`FINAL_LIST` の出力にも暫定の `verdict` を出し、`accessBndAppCheck` が最終の `recovery`／`verdict`／`outcome`（`RECOVERED_AND_BOUNDARY_PASS`／`RECOVERED_BUT_NOT_PASS`／`ABORTED_AND_RECOVERED`）を出す。状態遷移上の `COMPLETE` は使わない（`RECOVERED` は回収の完了）。

## 当日の操作（オーナー現地立会い・代替解錠手段あり。**③のGOが #756 に記録されたあとのみ**）

0. 事前に #756 へ通信回数（4回）・コマンド・停止条件・試行回数・A2再試行の可否・誤入力ロック案内の確認結果を記録し、この手順書と合致していることを確認する。GO前に ARMED／APPROVAL／暗証番号を設定しない。基準時計（NTP同期のスマホ、JST）を1つに決める。
1. `accessBndStatus`（通信ゼロ）で `gates=PASS`・`prerequisites=PASS`・`state=INIT`・`callsUsed=0`・`passcode=ABSENT`・`legacyState=STOPPED`・`numIdState=COMPLETE` を確認。**`ok=true` はゲート通過のみで、GOでも実行可能の判定でもない。**
2. GO後、`ACCESS_BND_TEST_ARMED=BND_PLAN_V1_4CALLS` を設定。
3. 段階ごとに `ACCESS_BND_TEST_APPROVAL=<段階名>` を設定 → 対応する関数を1回実行 → 結果コードを #756 に時刻と固定コードのみで記録 → 次へ。
   `LIST`（`accessBndStep1List`）→ 60秒以上待つ → 暗証番号と申告を設定 → `ISSUE`（`accessBndStep2Issue`）→ 120秒以上待ち、S−240秒前に `VERIFY_ISSUED`（`accessBndStep3VerifyIssued`）→ 観測 A1〜A4（`accessBndObserve`）→ E+300秒以降に `FINAL_LIST`（`accessBndStep4FinalList`）。
4. 公式アプリで試験キーのみ手動削除し、不在を目視して `ACCESS_BND_TEST_APPROVAL=APP_ABSENT`（残るなら `APP_PRESENT`）で `accessBndAppCheck`。
5. 終了後（成功・停止とも）`ACCESS_BND_TEST_ARMED`・`ACCESS_BND_A2_RETRY_GO`・暗証番号／申告プロパティが残っていないことを `accessBndStatus` で確認し、残っていれば削除する。`ACCESS_ENABLED=false`・トリガー0を確認。

## 停止・手動復旧

`STOPPED` / `STOPPED_MANUAL_RECOVERY` / `INTERRUPTED_MANUAL_RECOVERY`／各エラーコードのとき、以後の変更操作は自動で止まる（再送・自動削除なし）。timeout／UNKNOWN は追加の確認通信をせず、公式アプリから非通信で照合する。

1. 公式アプリで37DDのキー一覧を確認する。`ACCESS_BND_TEST_ARMED` は先に削除してよい（`STOPPED` では以後の変更操作が自動で止まる）。**途中停止後の回収記録（`APP_ABSENT`／`APP_PRESENT`）は、武装解除後も通信なしで記録できる**（ARMED の値違いは拒否）。通常の完了記録（`FINAL_LISTED_APP_PENDING` から）は武装が必要なので、削除は記録の後にする。
2. 名前が `TST` で始まる試験キーが残っていれば、**オーナーが公式アプリで手動削除**。通常キーは触らない。代替解錠手段を確保したうえで行う。
3. `APP_ABSENT`／`APP_PRESENT` を記録し、結果コード・回数・時刻のみを #756 に記録する（秘密情報・ID・キー名は書かない）。
4. **`ACCESS_BND_TEST_STATE` を削除・編集して予算を戻す操作は運用上禁止**。#791/#797 の状態も触らない。再試験は #756 での新たな個別GOと別途の安全レビューを前提とする。

## 結果コード（抜粋）

| コード | 意味 |
| --- | --- |
| `BND_<段階>_OK` / `BND_OBSERVE_OK` / `BND_APP_CHECK_OK` | その段階が成功（申告は観測者の申告） |
| `PASSCODE_UNIQUENESS_UNATTESTED` / `PASSCODE_INVALID` / `PASSCODE_NOT_SET` | 暗証番号の条件未達。通信せず、暗証番号と申告は破棄 |
| `PASSCODE_DELETE_FAILED` / `PASSCODE_RESIDUAL` | 破棄失敗・残留。通信せず停止、手動復旧 |
| `TIME_WINDOW_GUARD` / `ISSUE_CLOCK_DRIFT` / `A1_HEADROOM_INSUFFICIENT` | 時刻ガード。通信せず停止（`ISSUE_CLOCK_DRIFT` と `A1_HEADROOM_INSUFFICIENT` は STOPPED） |
| `OBSERVATION_WINDOW_NOT_ELAPSED` / `INTERVAL_NOT_ELAPSED` | 最短間隔未達。通信せず、承認・回数は消費しない |
| `OBSERVATION_TIME_MISMATCH` | 申告時刻が整合しない。状態不変（`*_SKIPPED` を申告） |
| `A1_UNLOCKED_BEFORE_START` / `A4_UNLOCKED_AFTER_END` | 重大。STOPPED・手動回収・01FD保留 |
| `A2_DENIED_NO_RETRY_GO` / `A2_DENIED_AFTER_RETRY` / `A3_DENIED_IN_WINDOW` | 期間内で解錠不能。成功扱いしない。反映遅延／時刻解釈／端末状態は未区別として記録 |
| `KEYPAD_LOCK_OR_ALARM_SIGN` | ロック・警報の兆候。STOPPED |
| `STOP_NOT_PERSISTED` | 停止の状態を保存できなかった。`STOPPED` と偽らず手動対応（`*_SENT` が残れば再送は抑止される） |
| `LEGACY_STATE_CHANGED` / `NUMID_STATE_NOT_COMPLETE` | #791/#797 の状態が不変でない。通信せず停止 |
| `APP_STILL_PRESENT` | 公式アプリに残存。STOPPED・管理者対応（`recovery=NOT_RECOVERED`） |
| `BND_APP_CHECK_OK` | 回収の記録が成功したことだけを示す。合否は `verdict` を見る |
| `NOT_ARMED` / `ARMED_PLAN_MISMATCH` / `STAGE_NOT_APPROVED` / ゲート系 | 通信前に停止（通信ゼロ） |

## 記録テンプレート（秘密なし）

```
実施日時：  版/SHA・Deployment：  通信：使用 n/4   基準時計：   誤入力ロック案内の確認：確認済/未確認
LIST/ISSUE/VERIFY/FINAL：結果コード・時刻・keyCount・attrEcho
A1(S-180) 時刻 拒否/解錠/INCONCLUSIVE/SKIPPED ｜ A2(S+180) 時刻 … ｜ A3(E-180) 時刻 … ｜ A4(E+180) 時刻 …
FINAL_LIST：期限切れキー 残存/不在   公式アプリ：手動削除→不在目視 はい/いいえ（APIとは別記録）
後片付け：ARMED／A2_RETRY_GO／暗証番号／申告 削除、OFF、トリガー0、通常キー保全
recovery：RECOVERED/NOT_RECOVERED　verdict：BOUNDARY_PASS/PARTIAL/INCONCLUSIVE/PARTIAL_PREMISE_UNVERIFIED/NOT_ESTABLISHED（a2Basis 併記）
実測／未実施：開始前不可・期間内可・期限後不可（粗い境界±180秒・申告ベース）／精密境界・削除後不可・01FDは未実施
記録しないもの：暗証番号・Token/Secret・完全ID・passcode ID・キー名・生レスポンス
```

## 本Issueの範囲外

実機での実行、本番Access GAS・01FD・予約・決済・通知への接続、精密な秒境界、2予約約1分重複、変更・延長・取消、別送メール、#791/#797 の入口・状態の変更、`deleteKey`（#797で削除成功済み。削除後の解錠不可は未実施として残る）。

## 検証

`test/switchbot-access-boundary-test-756.test.js`（モック・実機通信ゼロ）と `test/switchbot-access-prod-reject-entries-754.test.js`（本番設定での全入口の通信前拒否）。

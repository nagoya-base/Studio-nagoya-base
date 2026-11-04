# 予約連携: SwitchBot 期間限定キー自動発行・削除（Issue #748）

実装: `gas/switchbot-access/SwitchBotAccessCore.gs`（純粋ロジック）/ テスト: `test/switchbot-access-core.test.js`。
**本書は予約とSwitchBot鍵の連携設計の現行正本（Issue #750、2026-11-04時点の運営決定を反映）。** コアは状態機械・照合・安全停止とモックテストまで実装済み（#749/#751/#763）。**予約GASへの結線(#753 PR-A)はコード実装済み（フラグOFF。本番migration・デプロイ未実施）。独立GAS(#754)・配送(#752)・実機検証(#756)・本番有効化は未実施**（末尾「未実施」）。機能フラグ `enabled` は既定OFF。OFF時は変更APIを呼ばず、状態も書かない。コード・Script Properties・実API・デプロイは本書の更新では変更しない。

## 商用利用ゲート
`config.commercialUseApproved === true` でなければ、`enabled` でも対象外（`COMMERCIAL_USE_NOT_APPROVED`）。
**このフラグの意味は「SwitchBotの承認」ではない。** SwitchBotはOpen APIの個別商用利用可否判定・事前承認を行わず、利用者の判断と責任を求めた。SNB運営者は法人回答を踏まえ、公開Open APIを自己の判断と責任で採用する方針を決裁済み（#755）。フラグは「運営者の採用決裁・リスク受容の記録後に管理者が設定する」ものと読む（名称・意味の整合は別途レビュー。コードは未変更）。対外的に公式提携等を主張しない。SLA・個別支援なし、予告なき変更/停止のリスクは #754 の監視・安全停止と #757 の代替入室体制で受ける。決裁済みでも本番ONは #756 実機試験・#757 移行判定の後。

## 予約連携の確定設計（#750、現行）
過去の「確定直後に発行」「ハイブリッド（永続イベント）方式」「延長締切の未実装差分を#753で実装」「BUFFER_MINUTES既定値を30へ変更するPR」は**採用されていない/無効**（経緯はIssue #750 の履歴を参照）。

### 発行・配送
| 項目 | 決定 |
|---|---|
| 対象 | SNB（→Keypad末尾01FD）のみ。完全deviceId一致の非公開対応表。37DD（自宅検証機）は本番の対象・フォールバックにしない |
| 発行条件 | `CONFIRMED`＋Stripeは実入金確認／現金・PayPayは管理者承認。失効予約の復活は、復活成功に加え入金/承認を別途確認した場合のみ（復活成功だけでは発行しない） |
| 発行開始 | **利用前日12:00 JST以降の最初の照合**。前日12:00以降に確定・承認・復活した予約は、条件成立後の最初の照合で直ちに発行。時刻はサーバー時刻をAsia/Tokyoに換算し、「前日」は利用日(JST)の1日前（月・年跨ぎを含む）。前日11:59:59は発行せず12:00:00以降は発行。前日より前の変更/取消は未発行のため鍵操作なし |
| 有効期間 | 開始15分前〜終了15分後。SwitchBotへの指定は**開始のみ1分繰上げ**、終了は+15分そのまま（運営者の観測。59秒境界は#756で未実測。確定仕様として扱わない） |
| 配送 | 予約確認メール/前日リマインドとは**別の暗証番号専用メール**を独立GASが送る。発行の反映確認後のみ、前日18:00 JST以降の最初の照合で送信。18時以降の確定・反映確認は確認でき次第送信。暗証番号はBooking Adminへ渡さない。前日リマインドには、SNBかつ鍵機能ONの場合のみ「入室用の暗証番号は、別のメールでお送りします。」の一行を追加。未着/結果不明は管理者通知→代替入室（手動解錠・手動パスコード発行・物理キー。場所や番号は公開しない） |
| 安全ゲート | 最新revision・予約状態一致を送信直前にも確認。旧キー削除がUNKNOWNの間は新キーを無条件に発行しない。#751（削除）/#763（発行Webhook）の規則を継承 |

### 予約更新の識別（revision）
- Bookings台帳の**末尾に整数 `revision` 列を追加する方針**（運営が推奨案を採用。updatedAt単独の代用は不可）。確定/復活/取消/日時・延長/支払・承認の更新経路で、**既存のLock内で単調増加**させる。参照・再配信では増やさない。人数のみの変更で対象/期間が不変なら不要な再発行をしない。
- 既存行の空欄は初回照合時に0とみなす（全行書換えなし）。
- 列追加は schema 変更のため #673 の **admin-only → migrateBookingsSchema → full** に従い、ロールバックと旧行の初回取り込みの確認を #753 のPRで必須とする。本書の更新ではschemaを変更しない。

### 検出方式と照合範囲（5分ごとの台帳照合のみ）
永続イベント通知・ハイブリッド方式は**採用しない**。独立GASの5分ごとの時間主導トリガーで台帳を照合する。

**通常の照合対象は次の和集合**:
1. 利用日が当日・翌日のSNB予約
2. 独立GASの状態ストアに、発行済み・発行確認待ち・削除待ち・UNKNOWNなど**鍵操作記録が残る予約（変更後の利用日を問わない）**

②は最新の台帳の状態・revision・期間と照合するまで対象から外さない。**日付変更で期間外に出ても旧レコードを日付フィルタで捨てない。** 前日に発行済みの予約が翌週へ延期・別施設へ変更・取消・SNB対象外化・支払承認喪失された場合も、旧キーの削除確認（またはUNKNOWNの管理者対応）を追跡し、最新予約のキーと混同しない。
- 処理条件は独立に評価する: **revision変化／12:00の発行開始到達／18:00の配送開始到達／未完了の発行・削除・配送状態**。**revisionが不変でも時刻到達で処理する**。
- 未解決状態は日付にかかわらず保持・監視し、変更APIコマンドを自動再送しない。旧キーが2日弱で必ず消えると仮定しない。
- 負荷: revision不変かつ時刻条件・未完了状態がない予約は何もしない。SwitchBot APIは発行・削除・反映確認時のみ呼ぶ（上限1日10,000回に対し十分小さい見込み。所要時間は#754で計測）。
- 許容する検知遅れ: 取消・短縮時に旧キーが最大約5分残る／延長時の新期間反映に数分〜十数分。

### 予約ルールとの責務分担
- 予約間バッファー30分・当日延長の締切（旧終了の60分前、管理者commit時刻で例外なく厳密判定）は **#758が実装済み**（2026-11-19 00:00 JST施行予定、施行日時ゲート。実値は独立未検証）。鍵側(#753)は予約ルールを持たず、**確定後の予約キーイベント連携のみ**を担当する。重複実装しない。
- 別々の正規予約間の約1分のキー重複（BUFFER30分＋前後15分）は運営が許容。取消済み・旧改訂・誤Keypad・UNKNOWNキーの残存や無条件の旧新併存は不許可。施行前に作成された間隔30分未満の予約は運営確認で該当なし（#756/#757の前に再点検）。

### 容量
運営申告は確定1件、多い月で約4件。01FDの既存コード19件（期限切れ3件）を含めても想定は約32件で、容量は制約ではなく**安全装置**として扱う（閾値到達で発行停止＋管理者通知）。**80件という閾値は推奨案であり未承認の定数。** 機種別の公式上限・既存19件の内訳・期限切れ3件の棚卸し（非公開環境で1件ずつ確認。一括削除しない）は #754/#756 で確認する。

### 入室中延長
対応は必須要件だが**キー更新方式は未確定**。公開APIは `createKey`/`deleteKey` のみで、既存キーの期限更新は前提にしない。同一番号の再登録可否、旧キー削除後の空白時間、新番号先行発行の一時併存は**未検証**で、#751の安全条件（旧キー削除確認後に新キー）を無断で緩めない。方式変更が必要なら設計レビュー・実機試験後に別対象として扱う。状態別の決定表（発行前/発行後未送付/送付後/入室中/旧期限直前/失効後）は#754/#756で作成する。

### 後続Issueへの引継ぎ
| Issue | 引き継ぐ要件 |
|---|---|
| #751 | 削除確認コア。入室中延長の方式変更が必要なら別途安全審査 |
| #752 | 別メール配送（前日18:00以降・反映確認後のみ・重複抑止・結果不明時の手動救済・延長時の再案内） |
| #753 | 確定後の予約キーイベント連携、revision列とschema移行(#673)、前日リマインド一行追記、**発行時刻到達とrevision変化を独立トリガーとする**受入条件 |
| #754 | 独立GAS（5分照合、排他、認証、状態保存）、**当日・翌日＋日付を問わない鍵操作レコードの和集合照合**、延期後の旧キー削除・UNKNOWN監視、容量/監視/代替入室 |
| #756 | 37DD→01FDの段階的実機試験、59秒境界、同一番号再登録・入室中延長、前日12:00発行→18時台の両メール、18:00後確定の即時送付 |
| #757 | 本番移行可否、代替入室体制、停止/ロールバック、証跡集約 |

**回帰テスト（#753/#754/#752）**: 前日発行→翌週への日程変更／取消／SNB対象外への変更、当日・翌日フィルタ外でも旧キー照合・削除確認が継続、deleteKey再送なし、UNKNOWN時の管理者通知、revision不変の12:00発行と18:00配送、未完了状態の長期監視、前日11:59:59/12:00:00と月・年跨ぎ、台帳初回取り込み、送信済・未送信メールの競合。

## 予約システム接続（PR-A、Issue #753）— 実装済み範囲（フラグOFF）
実装: `gas/booking/shared/AccessKeySnapshot.gs`（純粋ロジック）／`SpreadsheetRepository.gs`（revision増分）／`BookingsSchema.gs`（`revision`列）／`BookingMailTemplates.gs`＋`Config.gs`（前日リマインド一行）。テスト: `test/switchbot-booking-link-753.test.js`。**鍵API・独立GAS・配送・デプロイ・本番migration・有効化は本PRの対象外**（予約GASは鍵モジュールを参照せず、鍵APIの呼び出し点を持たない。テストで固定）。

### 引渡し方式
予約GASは何も「送らない」。台帳（Bookings）を正本とし、独立GAS(#754)が5分ごとに読む。予約側が保証するのは次の3点。
1. **`revision`**（Bookings末尾の整数列）が、鍵に関係する項目の実変更ごとに単調増加する。
2. **`AccessKeySnapshot.build(record, {facility, room})`** が最新スナップショットを返す: `bookingId / revision / brand / facility / room / status / paymentStatus(支払根拠) / date / startTime / endDate / endTime / blockers / digest`。個人情報・暗証番号は含まない。
3. **`toCoreInput(snapshot, nowMs)`** が、コア `createEngine().sync()` へ渡す入力と方針（`SYNC` / `FREEZE`）を返す。

### revisionを増やす更新経路（対象入口）
書込みは `SpreadsheetRepository` の5関数（`updateBookingFields` / `updateBookingScheduleAtomic` / `updateBookingRescheduleFeeAtomic` / `updateBookingCancellationStateAtomic` / `updateBookingPaymentStateAtomic`）が出口。ここで一括して判定するため、確定（承認・Stripe入金）・復活（EXPIRED→CONFIRMED）・取消・失効・日時変更（`BookingReschedule.commit`）・延長/短縮・料金精算・要復旧フラグ・返金待ちの全経路を網羅する（個別経路への増分コードの散在なし）。
- 増やす条件: **変更前後のどちらかが `CONFIRMED`** かつ `KEY_RELEVANT_FIELDS`（status / brand / paymentMethod / paymentStatus / paymentConfirmedAt / confirmedAt / startAt / endAt / feeSettlementState / feeRecoveryRequiredAt / paymentRecoveryRequiredAt）の値が実際に変わる。人数・メール送信済み・料金明細・PENDING中の更新・同値の再書込み/再配信では増えない。元の日時へ戻す変更も**新しいrevision**（A→B→AでAのrevisionを再利用しない）。
- **書込み後に+1する**（先に増やすと「新revision＋旧内容」を鍵側が読み、その後の内容変更が同revisionのまま古い鍵を残す）。最悪でも「旧revision＋新内容」で、`digest`（鍵関係項目の指紋）がrevisionと食い違うため検知できる。
- 呼び出し元の既存Lock内で実行（新しいLockは取らない）。`BookingReschedule.commit` は既にScriptLock内。
- **失敗しても予約処理を巻き戻さない**: 列が未migration／セル不正値／書込み失敗では例外を出さず、固定コードのみログ（`ACCESS_KEY_REVISION_BUMP_FAILED: REVISION_COLUMN_MISSING|REVISION_INVALID|REVISION_WRITE_FAILED`）。個人情報・予約IDは出さない。

### schema差分と移行（#673）
- 差分: `BookingsSchema.HEADERS` の**末尾に `revision` を1列追加**のみ（途中挿入・並べ替えなし）。既存行の空欄は0とみなす（全行書換えなし）。
- 手順: マージ → production workflowを `scope=admin-only` → 管理者が `migrateBookingsSchema` を1回実行（追加は1セル: ヘッダー `revision`）→ `scope=full, schema_migrated=true`。**本番migrationは本PRでは実施しない。**
- 新旧混在: 旧コードは末尾の余分な列を無視。新コード＋未migrationシートは上記のとおりログのみで動作（予約作成・変更・取消・決済・返金・管理画面は従来どおり）。
- ロールバック: コードを戻しても `revision` 列は残るだけで無害（列は削除しない）。再度戻す場合、列の値は据え置き。
- 旧行の初回取り込み: 独立GAS(#754)が未取込の予約を `tracked.revision=null` として扱い、`triggers()` が `REVISION_CHANGED` を返して初回照合する。既存の確定済み予約は revision=0 のまま取り込まれ、以降の変更で1,2,…と増える。migration後に**revisionが増えていない既存予約がある**場合も、コアは `revision` の大小でしか古さを判断しないため同revisionの内容変更は検知できない → `digest` 比較で検知し停止・通知する（#754の受入条件）。

### 前日12:00の発行開始・当日予約・独立トリガー
- `issueWindow(snapshot, nowMs)`: 発行開始＝利用日の前日12:00 JST（利用日0:00の12時間前。月・年・うるう日跨ぎはエポック演算）。11:59:59は未開、12:00:00から開。
- `toCoreInput`: 確定予約が未開のときは `status` を `HOLD_BEFORE_ISSUE_WINDOW` に置換して `sync` へ渡す。コアは非CONFIRMEDを「発行しない・旧キーは削除対象・取消扱いにしない」と扱うため、(a)前日12:00前に日程が動いた予約の旧キーは回収され、(b)同revisionのまま12:00以降の最初の照合で初めて発行される。
- **当日予約**（前日12:00を過ぎてから確定・承認・復活）は、確定後の最初の照合で `open` となり即時発行（開始後・終了+15分前でも発行。終了+15分以降は `ALREADY_ENDED`）。
- `triggers(snapshot, tracked, nowMs)`: `REVISION_CHANGED` / `ISSUE_WINDOW_REACHED` / `OPEN_KEY_RECORD` を**独立に**判定（revision不変でも時刻到達で処理）。

### 凍結（FREEZE）と取消の扱い
確定予約に次のblockerがある間は**鍵操作を一切しない**（発行も削除もしない＝既存キーは旧revisionのまま残る）。管理者通知は `{予約ID, revision, 理由コード}` のみ: `PAYMENT_UNVERIFIED`（Stripeは `paymentStatus=paid` かつ `paymentConfirmedAt`、現金/PayPayは管理者確定の `confirmedAt` が無い）／`EXTENSION_CHARGE_PENDING`（`feeSettlementState` が `PENDING_CHARGE|PENDING_DECISION`。短縮の `PENDING_REFUND` は止めない）／`RECOVERY_REQUIRED`（`feeRecoveryRequiredAt|paymentRecoveryRequiredAt`）／`TIME_INVALID`・`TIME_NOT_MINUTE_ALIGNED`（秒を丸めない）／`BRAND_UNKNOWN`（空brandをSNB扱いにしない）。revision/ID不正は取消でも凍結。**取消・SNB対象外化（他ブランドへ変更）は凍結せず旧キー削除へ進む。** 現金/PayPayの承認根拠（承認者の監査項目）は#750で未確定のため、`confirmedAt` を暫定の台帳根拠とし、根拠がなければ安全停止側。**失効予約の復活は `confirmedAt` を書き `expiredAt` を残すため、`expiredAt` が残る現金/PayPayは復活後の独立した承認証跡が台帳に定義されるまで `UNVERIFIED`（復活だけでは発行しない。代替入室へ）。** 他ブランドへ変更された予約は運用上のblockerで凍結せず旧キー削除へ進む（brand空は凍結）。

### 前日リマインドの一行
SNBかつScript Property `ACCESS_KEY_NOTICE_ENABLED='true'` のときだけ「入室用の暗証番号は、別のメールでお送りします。」を1行追加（既定OFF・OFFの本文は完全に不変）。別暗証番号メール(#752)が送れる状態になるまでtrueにしない。

### #754への引継ぎ（本PRの前提）
- 5分照合は `build → toCoreInput → (SYNC) engine.sync` を和集合（当日・翌日＋鍵操作記録が残る予約）に対して実行する。`FREEZE` は通知のみ。
- **静穏時間**: 同一予約の `Range` 書込みは複数回に分かれる（例: 日時変更の直後に料金精算）。`revision` の最新変化から約60秒（または同一内容の2回連続読取）安定してから `SYNC` する。精算中の中間状態で発行しない。
- revisionと `digest` の食い違い、`REVISION_*` ログの発生、列欠落は管理者通知して停止（新規発行・変更をしない）。

## コアの設計判断（Issue「実装前に固定する設計」への回答）
| 論点 | 判断 |
|---|---|
| 発行対象 | `status=CONFIRMED` かつ `paymentStatus ∈ config.eligiblePaymentStatuses` かつ `brand ∈ config.eligibleBrands`。受付・未確定・取消・失効は発行しない。現地払いを含めるかは管理者設定（既定は空＝発行しない） |
| 期間 | JST入力を+9hで変換。`start = 利用開始 − graceBeforeSec`、`end = 利用終了 + graceAfterSec`。猶予は**必須設定**（未設定は停止。推測値なし） |
| 変更 | 改訂/期間/Keypadが変わったら旧キーを削除→削除確認後に新キー。旧キーが未確定（UNKNOWN等）の間は新規発行しない。入室中の延長方式は未確定（上記「入室中延長」） |
| 取消 | 旧キー削除を追跡。削除失敗でも予約取消・返金は巻き戻さない（本モジュールは例外を予約側へ伝播させない前提のアダプタで呼ぶ）。残存は管理者通知 |
| 期限切れ | `EXPIRED`（削除と区別）→ keyList残存確認 → 0件で `ARCHIVED_EXPIRED`、残存は通知＋`adminDelete`。終端状態のみ `retentionSec`（既定30日）後に破棄。未解決は破棄しない |
| Keypad | `config.keypads` の brand/facility/room→完全deviceId対応表のみ。0件/複数件は送信前停止、フォールバックなし |
| 受渡し | `deliverCode` 注入点。`ISSUED_CONFIRMED` 後のみ・1回のみ。暗証番号は予約確認メール/前日リマインドに載せず、独立GASの専用メールで送る（上記「発行・配送」、#752） |
| 実行基盤 | 予約GASから直接呼ばず、独立GAS（`switchbot-verify` と同型）へ引き渡す案を推奨。永続キュー=独立GASのScript Properties（状態）＋別Properties/Secret Manager相当（秘密）。常設受信=独立Webアプリ（Webhook, 共有トークン）。実行上限=`maxReads`(既定3)・`webhookWaitSec`(既定90) |

## 状態機械と二重発行防止
- 識別子: `予約ID:改訂:Keypad末尾4桁:ISSUE#attempt`。SwitchBot上の名前は `SNB-` + sha256(予約ID|改訂|deviceId|操作|attempt)先頭16桁（個人情報なし）。
- 送信前に `PLANNED`→`SENDING` を永続化。保存失敗なら送信しない。`SENDING` で再開したら**送信済みか不明**として `UNKNOWN`（再送しない）。
- 排他: `lock([予約, Keypad])` を注入（GAS: LockService）。同一イベントの再配信・ジョブ再実行・別インスタンス交互実行でも1件。
- `UNKNOWN`/`DELETE_SENDING` からの変更API自動再送は無い。復旧は `adminInspect`（読み取り）→ `adminResolveUnknown`（`CONFIRM_PRESENT`=keyList厳密1件のみ／`ABANDON_ABSENT`=0件のみ。いずれもkeyListで検証、操作者必須）。`ABANDONED` 後のみ新 attempt。

## 反映確認
- API受理(`httpCode=200 && statusCode=100`) ≠ 反映。
- commandIdあり: 認証済みWebhook(`createKey`/`deleteKey`・Keypad種別・commandId一致)の success **かつ** keyList厳密1件。evidence に `WEBHOOK_SUCCESS` と `KEYLIST_CONFIRMED` を別々に保存。Webhook成功でもkeyListに無ければ矛盾として `UNKNOWN`。failed→`FAILED`。重複Webhookは初回維持（巻き戻さない）。90秒未着は `UNKNOWN`。
  - **発行側の期限ルール（Issue #763、削除側と同じ）**: 成功根拠にするWebhookは、対象端末(`deviceMac`)・`createKey`・commandId一致のうえ、保存済み `receivedAtSec - sentAtSec <= webhookWaitSec`（既定90秒）のものだけ。期限内に受信したsuccessは、照合ジョブが遅れて動いても到着時刻を根拠に受け付ける（keyList厳密一致が別途必要）。期限後に到着したsuccess、送信時刻より前に受信したsuccess（古いイベントの誤流用防止）、`receivedAtSec`/`sentAtSec` の欠落・非数値、結果が食い違う重複（success→failed）は成功根拠にせず `UNKNOWN`＋通知（`WEBHOOK_TIMEOUT`/`ISSUE_WEBHOOK_CONFLICT`）。`UNKNOWN` 後に届いたWebhookで状態を巻き戻さず、createKeyも再送しない。`SENT_WAIT_WEBHOOK` で `sentAtSec` が欠落/非数値の旧・不正レコードは、Webhookの有無・期限前後を問わず `UNKNOWN`＋通知（`ISSUE_CONFIRM_FAILED`、無期限に待機しない）。failed先着は従来どおり `FAILED`。commandIdなし（`ACCEPTED_NO_COMMAND_ID`）はWebhook必須にせず、上限付きkeyList読取のみ（変更なし）。
- commandIdなし: `ACCEPTED_NO_COMMAND_ID` で変更APIを再送せず、読み取り専用keyListを最大 `maxReads` 回（再実行間隔=ジョブ周期）。0件のまま上限→`UNKNOWN`。複数件/ID欠落/属性矛盾/形式不正は即 `UNKNOWN`。
- 削除（Issue #751で補完）: 不在判定は対象Keypadの**keyList全体**から「保存済みpasscodeID」と「保存名」の**両方**の不在を独立に確認する（`inspectAbsence`）。別名で同IDが残る／同名で別IDが残る場合は不在とせず `UNKNOWN`。対象外端末・keyList欠落・id または name（非空文字列）が欠落した要素・非オブジェクト要素・passcodeID未保存は「不在」と補完せず `UNKNOWN`。
  - 送信前: 両不在なら `ALREADY_ABSENT`（deleteKey未送信）。保存ID・保存名が同一の1要素に一致し他に残存がない場合のみ1回送信。
  - **commandIdあり**: 同一端末(`deviceMac`)・`deleteKey`・同一`commandId`・`success` のWebhook **かつ** ID・名前の両不在が必要。証拠は `WEBHOOK_SUCCESS` と `KEYLIST_ABSENT` を別々に保存。Webhook未着は `webhookWaitSec`(既定90秒)まで保留（読取回数も消費しない）、超過は `UNKNOWN`。期限後に到着したイベント（`receivedAtSec - deleteSentAtSec > webhookWaitSec`）は照合タイミングによらず採用せず `UNKNOWN`。failed／その他結果／結果が食い違う重複は `UNKNOWN`＋通知。success＋残存は矛盾として `UNKNOWN`。別端末・別操作・別commandId・別種別のイベントは採用しない。
  - **commandIdなし**（2026-11-03の実機試験でcommandIdが返らなかった。公式仕様の確定ではない）: Webhookを必須にせず、変更APIは再送しない。keyList読取のみで確認し、上限は **回数 `maxReads`(既定3)** と **経過時間 `readWaitSec`(既定600秒)**。両上限は record（`reads`・`deleteSentAtSec`）に永続化され再起動で初期化しない。確認不能・上限超過は `UNKNOWN`＋通知。証拠は `KEYLIST_ABSENT` のみ（commandIdなしの結果をWebhook照合済みとして流用しない）。
  - Webhookの永続イベントは `端末×操作×commandId` ごとに保存。対象端末(`deviceMac`)が欠落した旧形式イベントは保存・採用しない（推測補完しない）。`deleteSentAtSec` 欠落の旧形式 `DELETE_SENT` も `UNKNOWN`。
  - 期限切れ確認（`sweep`）も同じ両不在条件。

## 秘密・通知・監査
- passcode は `secrets` 注入先（状態ストアと別領域）のみ。状態・通知・棚卸し・履歴に出さない。確定削除/拒否/放棄で破棄。
- 管理者通知は `{code, 予約ID, 改訂, Keypad末尾4桁, state}` のみ。同一 record×code は成功時のみ記録し重複抑止、通知失敗は次回再通知。
- 状態ストア（権限限定）には操作に必要な完全deviceIdを保持する。公開面（通知/棚卸し/Issue/PR/ログ）は末尾4桁まで。
- 履歴は `{時刻, from, to, 根拠}` のみ。

## ロールバック手順
1. `enabled=false`（新規発行・自動削除の停止）。発行済みキーは**消えない**。
2. `inventory()` で `unresolved=true` の record（PLANNED/UNKNOWN/送信済/ISSUED等）を棚卸し。
3. 期限・残存を `sweep()`/`adminInspect` で確認。必要な個別削除は `adminDelete`（フラグOFFでも可）。UNKNOWNは `adminResolveUnknown`。
4. 利用者へ代替入室手段を案内。
5. 直前の正常版へコード復旧。**状態データは削除しない。ロールバックを契機に createKey/deleteKey を再送しない。**
6. 状態整合を再確認。

## 状態遷移（削除、#751）
`ISSUED_CONFIRMED/EXPIRED → DELETE_PENDING →(両不在)→ ALREADY_ABSENT`／`→(残存の整合)→ DELETE_SENDING → DELETE_SENT →(条件充足)→ DELETED_CONFIRMED`。それ以外（ID/名前の片方残存・曖昧・Webhook failed/矛盾/期限超過・読取上限・保存失敗後の再開）は `UNKNOWN`（deleteKey自動再送なし）。

## 未実施（受け入れ条件との対応）
- [x] 予約結線(#753 PR-A、フラグOFF): revision列・増分・スナップショット・前日リマインド一行をコードとモックテストで実装（本番migration・デプロイは未実施）
- [ ] revision列の本番migration（admin-only → `migrateBookingsSchema` → full）と実施証跡
- [ ] 独立GAS(#754)・配送(#752)・本番フラグON（いずれも未着手/別PR）
- [ ] 独立GASへのデプロイ・常設Webhook受信（フラグOFFでの結線PRを別途レビュー）
- [ ] `commercialUseApproved` の意味の整合（運営者の採用決裁へ）と本番有効化判断の記録
- [ ] 非利用時間・現地確認者・代替入室手段を確保した01FDの限定実機検証（開始前不可/期間内可/期限後不可/削除後不可/変更/取消/59秒境界）
- [ ] 入室中延長の方式（同一番号再登録・併存の可否）の確定
- [ ] 01FDの機種別上限と容量閾値（80件は推奨案）の確定
- [ ] 2026-11-19の#758施行と実動作確認
- [ ] CI・デプロイ・本番有効化・実機確認の個別記録

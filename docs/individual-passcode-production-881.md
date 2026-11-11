# 個別暗証番号の正式運用への切替手順（Issue #881）

**正本は Issue #881。** SNB・Mens・Studio X の**切替以降の新規予約**に、予約別暗証番号（Access GASが別メールで送る）を正式適用するための、運営者向けの最短手順。
コードはScript Propertiesを書き換えない。**PRのマージだけでは本番は変わらない**。設定変更・デプロイは運営者本人が行う。
予約ID・暗証番号・完全deviceId・宛先・設定実値は、Issue/PR/ログに書かない。

設定分割（#859 / PR #871 の `split-v1`）は**前提にしない**。本手順は現行の旧形式 `ACCESS_CONFIG`（JSON一括）のまま行う。
`ACCESS_ELIGIBLE_BRANDS` などの分割プロパティを**足さない**（足すと `CONFIG_SOURCE_MIXED` で停止する）。

## 本PRで変わる文面

| メール | 変更 |
| --- | --- |
| 予約別暗証番号の通知（Access GAS） | 冒頭を「`<送信者名>`です。」「ご予約の入室用の暗証番号をお送りします。」の2行のみにし、「（この暗証番号は、予約確認メールとは別にお送りしています）」を削除。暗証番号・利用可能時間・対象・注意・問い合わせは従来どおり。※送信者名と「です。」の間の半角スペースもなくした |
| 予約確定メール（Booking） | 新方式対象予約だけ、次の3行を追加。対象外・`OFF` の本文は変わらない |
| 前日リマインド（Booking） | 新方式対象予約の #832 の一文を、次の3行に置き換え（旧「解錠コード」行は従来どおり出さない） |

```
入室用の暗証番号は、ご予約ごとに専用の番号を発行し、このメールとは別のメールでお送りします。
お届けは利用日前日の18時以降です（それ以降に確定したご予約は、確定後に順次お送りします）。
暗証番号のメールが届かない場合は、このメールにご返信ください。
```

- 「前日18時以降」は Access GAS の `delivery.startHoursBeforeDay` 既定値6に合わせている。この値を変える場合は文面も変更する。
- 「このメールにご返信」の返信先は Booking の `BOOKING_MAIL_REPLY_TO`。運営者が受け取れる宛先であることを確認する。
- 旧共通コードと新しい暗証番号を同じメールに載せない（新方式の確定メール・リマインドに旧コード行を出す経路はない）。

## 切替手順（この順番で実施する。逆の順番にはしない）

不変条件: **Bookingの新方式対象集合 ⊆ Access GASの発行・配送対象集合**（#832）。Access側を先に広げる。

1. **コード反映**（PRのレビューとCIが通り、マージした後）
   - Booking Admin: 通常のデプロイ手順で反映する。`ACCESS_PER_BOOKING_CODE_MODE` は変えない。
   - Access GAS: Actions → **Deploy SwitchBot access GAS**（`deployment_action=deploy`、ON中は `ON_CHANGE_APPROVED` の承認条件に従う）。
2. **Access GAS の設定変更**（Script Properties の `ACCESS_CONFIG` JSON。ほかのキーは変更しない）
   | キー | 正式運用の値 |
   | --- | --- |
   | `eligibleBrands` | `["snb","mens","studio_x"]` |
   | `limitedRollout` | `false`（キー削除でも可） |
   | `pilotBookingIds` | **キーごと削除**（`[]` にしない） |
   | `keypads` / `allowedLast4` | 3ブランドとも、実際の入口の端末へ `brand`/`facility`/`room` が完全一致で対応していること（#757「3ブランド化」節） |
   - 注意: `pilotBookingIds: []` を残すと**全件 `NOT_PILOT_TARGET` で発行停止**になり、診断は `PILOT_WITHOUT_LIMITED_ROLLOUT` を返す。1件の許可リストを残したまま `limitedRollout=false` にしても同様。どちらの状態も正式運用とは呼べない。
3. **Access の読取確認**: `accessCheckSetup` → `accessReadOnlyDiagnostics`。合格条件は次のとおり。
   - 設定が `VALID`
   - `issuance.state=READY`
   - `limitedRollout=OFF`、`pilotBookingIds=0`、`brands=3`
   - `PILOT_*` 系の警告と `CONFIG_SOURCE_MIXED` が出ていない
   - `ACCESS_ENABLED='true'`、トリガー（`accessDeliverJob` を含む）がある
   NGならここで止め、次の手順に進まない。
4. **Booking Admin の設定変更**: `ACCESS_PER_BOOKING_CODE_MODE=ALL`。`ACCESS_PER_BOOKING_CODE_PILOT_IDS` は削除する（`ALL` では使わない）。
   - 診断プレビューで、3ブランドの予約が `mailMethod=PER_BOOKING_CODE` / `codeMode=ALL` になることを確認する。その他のブランドは `LEGACY` のまま。
5. **切替直前の予約の確認**: 切替直前に確定メールや前日リマインドを旧方式（旧共通コード入り）で送った3ブランドの予約がないか、Booking Admin で確認する。
   - 該当する予約にも Access GAS が個別暗証番号を別送する。旧共通コードは残すので入室はできる。必要なら運営者から個別に案内する。
   - 結果は件数だけを #881 に記録する（IDは書かない）。
6. 最初の通常周期で、想定外の予約に発行・通知が出ていないか、通知の受け手が正しいかを確認し、開始日時・版・実施者を #881 に記録する（値・IDは書かない）。

## 停止・緊急時

- 発行停止: Access の `ACCESS_ENABLED` を `true` 以外にする（必要なら `accessRemoveTriggers`）。
- 案内を旧方式へ戻す: Booking の `ACCESS_PER_BOOKING_CODE_MODE=OFF`。戻す前に、対象予約の入室手段を確保しておく。
- 従来の共通暗証番号は**削除しない**（緊急入室用）。配送の失敗や未着時は、本人確認のうえ共通コードまたは手動手段で案内する。

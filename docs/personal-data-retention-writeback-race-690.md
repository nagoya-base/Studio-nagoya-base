# 書き戻し競合（消去後の個人情報の復活）の検証 — Issue #690 §2

親Issue #680。合成データのみで検証した（実Spreadsheet・実データ・実Deployment・業務スイッチには触れていない）。テスト: `test/personal-data-retention-writeback-race-690.test.js`。

## 結論
- **危険は実在する。** 「行を読む → 消去が走る → 読んだ値を書き戻す」の交差で、消去済みの個人情報が戻る関数が5つある（下表）。
- **ただし、消去対象になり得る行へ、ロックを共有しない別プロジェクトから書く入口は見つからなかった。** 公開Web App・WebhookはどちらもPENDING・非終端・未解約の行にしか書かない（状態ガード。テストで確認）。Booking Adminの書き手は消去と同じスクリプトロックで直列化される。
- **万一戻っても、翌日の日次実行が同じ行を再判定して再び消す**（テストで確認。戻った内容が残るのは最長で次回実行まで）。
- 消去のコードは変更しない。**方針バージョン（`2026-10-31.4`）・dry-run確認への影響はない。**
- この結論は「通常は更新しない」ではなく、下記の**不変条件と、それを固定するテスト**に依拠する。不変条件が崩れる変更が入ると、テストが落ちる。

## 1. 危険のある関数（プリミティブ単体の再現）
| 関数 | 書き戻す範囲 | 戻る列 |
| --- | --- | --- |
| `updateBookingCancellationStateAtomic` | `status`〜`updatedAt` | `note` |
| `updateBookingPaymentStateAtomic` | `paymentAttemptId`〜`paymentRecoveryReason` | `stripeCheckoutRequestSnapshot` / `paymentLastErrorMessage` / `paymentRecoveryReason` |
| `updateBookingRescheduleFeeAtomic` | `priceOverrideAmount`〜`feeRecoveryReason` | `feeSettlementNote` / `feeRecoveryReason` |
| `updateBookingRefundStateAtomic` | `refundAttemptId`〜`refundCheckedAt` | `refundReason` |
| `OptionOrderRepository.updateOrder` | 1行すべて | `customerEmail` / `declineReason` / `checkoutRequestJson` / `paymentRecoveryReason` |

対照: 1セルだけ書く `updateBookingFields`、日時3列の `updateBookingScheduleAtomic` は戻さない。`Members` の行書き込みは、解約済みの行に対して入口で止まる（下記）。`FeeSettlements`（状態4列）・`Recovery`（状態と日時のセル）・`BookingChanges`（空文字の書き込み）・`StripeEvents`（呼び出し側が渡す新しい値。終端は書かない）は、読んだ個人情報を書き戻さない。

## 2. 別プロジェクトからは届かない（不変条件）
消去の対象は「終端の状態になってから180日以上経った行」。次の不変条件で、別プロジェクトの書き手は対象行に届かない。

- **A. 終端は戻らない**: Bookingsの`CONFIRMED`（終了後）・`CANCELLED`・`EXPIRED`、OptionOrdersの`CONFIRMED`/`DECLINED`/`CANCELLED`、Membersの`canceled`。例外だった`EXPIRED`→復活（`reviveExpiredBooking`）は利用開始後は拒否される。公開側の予約可能期間（会員90日）は180日より短く、期限切れの予約は消去期限までに必ず開始を迎える。
- **B. 起算日時は遡らない**: 状態を変えた時点の日時が入る。180日経過した行が、新しい操作で急に対象になることはない。
- **C. 書き手は入口で状態を確認する**（テストで実際の入口を呼んで確認）:
  - `beginCardCheckout`: `PENDING`以外は`BOOKING_NOT_PENDING`
  - `startOptionCheckout`: 終端の注文は`ALREADY_PAID` / `ORDER_DECLINED`
  - `markCancelRequested`: `canceled`は何もしない（`applyState_`も同様）
  - `StripeEvents`の`claim` / `finalizeForProcessing`: 終端は`ALREADY_TERMINAL`で書かない
- **D. Web Appの入口の一覧が固定されている**: `Code.gs`が呼ぶ関数と、危険な関数の呼び出し元（ファイル別の件数）を、テストが一覧と照合する。増えたら落ちる。

## 3. 同じプロジェクト（Booking Admin）は直列化される
消去は1バッチごとにAdminのスクリプトロックを取り、取得後に再読込・再判定してから書く。Adminの返金・日程変更・Stripe受信処理・オプション承認も同じ`LockService.getScriptLock()`の中で書く（コード確認。書き手がロックを保持中は消去が`LOCK_TIMEOUT`で何も消さないことをテストで確認）。

## 4. 保証できない／確認していないもの（明示）
- **Spreadsheetの手動編集**（所有者による貼り付け・並べ替え等）は対象外。共有権限が所有者1名であることは#690で確認済み。
- **版の履歴**・メール・カレンダー・Stripe等は、この処理の消去対象外（告知文のとおり）。
- Adminの返金は複数段階（Stripe呼び出しを挟む）に分かれる。段階の間で**ロック外に持ち越した行の値を後で書く**箇所は、個別には確認していない。該当があれば、その書き込みで戻る可能性は「万一」の扱い（翌日に再び消える）になる。
- 不変条件AとBは仕様・実装の確認に依拠する。将来、終端を戻す操作や起算日時を遡る操作を追加する場合は、消去との関係を再検討する。
- 実Spreadsheet上の件数・状態はこの検証に含まない（dry-runで確認する）。

## 5. 採用しなかった対策
- 書き戻す範囲から個人情報の列を除く（範囲を分割する）: 連続範囲を1回の`setValues`で書く既存の設計（中途半端な状態を防ぐ）を崩すため、リスクに見合わない。
- 時間のずれを使うガード（書き手が古い行を判定して個人情報を書かない／消去に余裕日数を足す）: 正しく設計できるが、複数の書き込み関数と方針バージョンの変更を伴う。現時点の到達不能の確認で足りるため見送った。不変条件が崩れる変更が必要になった時点で検討する。

## 6. 開始前の運用上の注意（#690 §4）
- 開始直前のdry-runの`review` / `held`件数に加え、日次実行後に`getPersonalDataRetentionStatus()`の`attention`を確認する。
- 書き込みを伴うAdmin操作（返金・日程変更等）を、日次トリガーの実行時間帯（毎日4時台）に重ねない運用が望ましい（ロックで直列化されるため必須ではない）。

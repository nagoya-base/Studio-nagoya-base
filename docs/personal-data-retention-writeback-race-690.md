# 書き戻し競合（消去後の個人情報の復活）の検証 — Issue #690 §2

親Issue #680。合成データのみで検証した（実Spreadsheet・実データ・実Deployment・業務スイッチには触れていない）。テスト: `test/personal-data-retention-writeback-race-690.test.js`。

## 結論（検証した範囲と、残っているもの）
- **危険は実在する。** 「行を読む → 消去が走る → 読んだ値を書き戻す」の交差で、消去済みの個人情報が戻る関数が5つある（§1）。
- **検証した経路では、消去済みの個人情報は戻らない。** 戻るには「ロックの外で読んだ個人情報を、後で書く」書き手が要るが、既知の書き込み箇所をすべて洗い出して分類した（§3）。公開Web App・Webhookの入口は終端の行へ書かず（§2）、Adminの返金は実入口を呼び、Stripe呼び出しの各段階の間に消去を挟んでも戻らない（§4）。
- **#690 §2 の完了は、運営者のレビューで判定する。** 先に開始条件に残していた経路（日程変更・Stripe受信処理・決済リンク送信・オプション承認／否認・会員系Stripeイベント・料金復旧）は、すべて実入口の交差テストを追加した（§6）。ただし §7 の「検証の範囲外」は残る。**交差テストで確認できなかった経路が見つかった場合は、検証を足すか、保証できない対象を明示的に除外または復活防止を実装し、必要に応じて方針バージョンの更新とdry-run再確認を行うまで、自動消去を開始しない。** これは運営者の承認だけでは省略できない必須の開始条件で、PRのマージ（検証結果の取り込み）とは別に扱う。「到達不能で足りる」とは扱わない。
- 消去のコードは変更していない。方針バージョン（`2026-10-31.4`）・dry-run確認への影響はない。後続で消去側を変える場合は、方針バージョンの更新とdry-run再確認が必要になる。

## 1. 危険のある関数（プリミティブ単体の再現）
| 関数 | 書き戻す範囲 | 戻る列 |
| --- | --- | --- |
| `updateBookingCancellationStateAtomic` | `status`〜`updatedAt` | `note` |
| `updateBookingPaymentStateAtomic` | `paymentAttemptId`〜`paymentRecoveryReason` | `stripeCheckoutRequestSnapshot` / `paymentLastErrorMessage` / `paymentRecoveryReason` |
| `updateBookingRescheduleFeeAtomic` | `priceOverrideAmount`〜`feeRecoveryReason` | `feeSettlementNote` / `feeRecoveryReason` |
| `updateBookingRefundStateAtomic` | `refundAttemptId`〜`refundCheckedAt` | `refundReason` |
| `OptionOrderRepository.updateOrder` | 1行すべて | `customerEmail` / `declineReason` / `checkoutRequestJson` / `paymentRecoveryReason` |

これらは**引数で渡されない列を、関数の中で行を読み直して書き戻す**。戻る窓は、関数内の「読む→書く」の間（ミリ秒）だけで、呼び出し元がロックをまたいで持ち越した古い行の値は使われない。対照: 1セルだけ書く`updateBookingFields`、日時3列の`updateBookingScheduleAtomic`は戻さない。

## 2. 別プロジェクト（Web App・Webhook）は消去対象の行へ書かない
消去の対象は「終端の状態になってから180日以上経った行」。ロックを共有しない別プロジェクトの入口は、状態ガードで止まる（実際の入口を呼ぶテスト）。

- `beginCardCheckout`: `PENDING`以外は`BOOKING_NOT_PENDING`（`CONFIRMED`・`CANCELLED`・`EXPIRED`で確認）
- `startOptionCheckout`: 終端の注文は`ALREADY_PAID` / `ORDER_DECLINED`
- `markCancelRequested`: `canceled`の会員は何もしない（`applyState_`も同様）
- `StripeEvents`の`claim` / `finalizeForProcessing`: 終端は`ALREADY_TERMINAL`で書かない
- `reviveExpiredBooking`（Admin）: 利用開始後の`EXPIRED`は復活できない。公開側の予約可能期間（会員90日）は180日より短い

前提とする不変条件: 終端の状態は戻らない／起算日時は遡らない（状態を変えた時点の日時が入る）。Web Appの入口の一覧（`Code.gs`が呼ぶ関数）と、危険な関数の呼び出し元（ファイル別の件数）は、テストで固定している。増えると落ちる。

## 3. 書き込み箇所の分類（持ち越される値の監査）
関数の中で行を読み直す（§1）ため、ロックをまたいで持ち越されるのは**引数で渡す値だけ**。消去対象の列を引数に含む全ての呼び出し箇所を調べ、一覧をテストで固定した。

| 分類 | 内容 | 箇所 |
| --- | --- | --- |
| 新しく作った値 | その呼び出しで生成した理由文・エラー文・運営者の入力（返金理由、決済・精算の復旧理由、メール送信失敗の文、不承認理由、Checkoutの要求内容） | `BookingRefund`・`BookingReschedule`・`StripeWebhookProcessor`・`BookingMailer`の各`updateBookingFields`、`BookingRefund`のAtomic 4、`BookingReschedule`のAtomic 1、`BookingRepository`のAtomic 1、`OptionOrderService`の`updateOrder` 6（`decide_`は変数経由で不承認理由＝運営者の入力） |
| 同じロック内で読み直した値 | 送信先メールを`paymentLinkSentTo`へ写す決済リンク送信（`withLockedBookingRecord_`の中で読み直し、支払期限を過ぎた予約は送信拒否） | `BookingMailer` |
| 個人情報を含まない値 | `writeAttemptState_`（状態・Stripeの状態・確認日時）、`resolveFeeRecovery`（金額・復旧フラグ） | `BookingRefund`・`BookingReschedule` |

「新しく作った値」を書くのは**復活ではなく新しい入力**（書いた行が消去対象のままなら次回の実行で消える）。「ロック外で読んだ個人情報を後で書く」箇所は見つからなかった。

Issue #668の人数変更追補: `BookingReschedule.failPeopleChange`の追加1箇所は新規の固定復旧理由文、`resolvePeopleChange`のAtomic追加1箇所は復旧フラグの空値で、Adminの同じスクリプトロック内で書く。人数変更の確定はロック内で読み直し、将来の利用予約だけを対象にする。復旧は同じロック内で履歴から人数・料金等を戻し、旧精算備考も含むが、履歴が`PREPARED` / `RECOVERY_REQUIRED`の間は既存の依存未解決判定で親子とも消去対象から除外される。完了後は既存の`feeDetailsJson`限定投影で旧値・新値を含む追加キーを消す。消去の実装・方針バージョンは変更しない。

## 4. 返金の多段処理（実入口 + 各段階の間に消去）
`cancelWithRefund`（`FULL` / `PARTIAL` / `NONE`）を、消去対象の古い入金済み予約に対して実行する。返金は確認（Stripe呼び出し2回）→ロック内の準備→返金（1回）と、**Stripe呼び出しの間にロックを解放する**。各Stripe呼び出しの瞬間（ロックが外れている）に、Adminの消去を挟んだ。

- 操作の前に消去が済んでいる／確認の段階で消去が入る場合: 消去は11セルを消し、返金・取消の完了後も**消去前の値には戻らない**（残るのは今回の返金理由＝新しい入力のみ）。
- 返金が進行中の段階で消去が入る場合: 決済・返金の未解決として**保留となり何も消さない**（情報は利用中。取消確定後は起算日時が今になるため、180日後まで対象外）。
- 全ての書き込みがロック保持中に行われる。
- 観測された副作用: 消去後の予約へ返金すると、顧客メール（`email`）が空のため確認メールを送れない。消去後の古い予約への返金は想定が薄いが、運用上の注意として記す。

## 5. 自己修復の範囲と限界
万一戻った場合、日次実行が同じ行を再判定して消す（テストで確認）。ただし次の限界がある。

- 消去は**次回以降の実行**で行われる。1回の上限（200行・4分）には、**実際に消した行数**が数えられ、既に空の行は上限を消費しない（復活した行は、大量の消去済みの行の後ろにあっても次回の実行で消える。テストで確認）。初回の積み残しが大量にある間は、その分だけ遅れる。
- 書き手の更新で**保留の条件**（決済未解決等）が立った行は、保留中は消えない。保留中の情報は利用中のもので、保留が解けた翌日の実行で消える（テストで確認）。
- 自己修復は「復活しないことの証明」の代わりにならない。§2〜§4の確認に加えた、二次的な備えとして扱う。

## 6. 実入口の交差テスト（`test/personal-data-retention-writeback-race-entrypoints-690.test.js`）
消去対象の古い予約へ、実入口を呼び、**外部呼び出し（Stripe・メール・カレンダー）の各時点で消去を1回挟む**。書き手がロックを保持していない時点（段階の間）では消去が走り、保持している時点では消去が待たされて何も消さない（`LOCK_TIMEOUT`）。終了後に、消去が消した個人情報が消去前の値に戻っていないこと・Bookings／OptionOrdersへの書き込みが常にロック保持中であることを監査する。

| 経路 | 入口 | 結果 |
| --- | --- | --- |
| Stripe受信処理（予約の決済完了イベント） | `processPendingStripeWebhookEvents`（確定済み・入金済み／取消・返金済みの古い予約） | 段階の間に消去を挟んでも戻らない。書き込みはロック保持中 |
| 決済リンクの手動送信 | `sendPaymentLinkMailForBooking`（古い期限切れの予約） | 利用開始後のため拒否（消去後はメール空欄でも拒否）。Bookingsへ書かず、メールも送らない |
| オプション注文の承認・否認 | `approveOrder` / `declineOrder`（終端の`CONFIRMED` / `DECLINED`） | 終端の注文へは書かず、消去済みの個人情報は消去済みのまま |
| 日程変更 | `adminRescheduleBooking`（古い予約を未来へ移す。外部呼び出し5回） | 段階の間に消去を挟んでも戻らない。書き手がロックを持つ呼び出しでは消去が待たされる。書き込みはロック保持中 |
| 料金の復旧が必要な予約 | `feeRecoveryRequiredAt`が立った古い予約 | 消去が保留として何も消さない |
| 料金復旧の確定 | `adminResolveFeeRecovery`（書き込みの直前に消去を試みる） | 復旧フラグで保留中のため何も消されない。確定の書き込みはロック保持中で、精算メモ等は読み直した値のまま。確定後は翌日の実行で対象に戻り消える |
| 会員系Stripeイベント | `processPendingStripeWebhookEvents`（解約から180日超の会員へ、入会`checkout.session.completed`・`customer.subscription.updated`・`invoice.paid`・`charge.refunded`） | 会員メール・入会Checkoutのメールは、消去を挟んでも戻らない。解約済みへの状態更新は`MEMBERSHIP_STATE_STALE`で書かれない。入会・返金のStripe呼び出し3回の各瞬間で確認 |
| 決済リンクの送信が成功する経路 | `sendPaymentLinkMailForBooking`（開始前のPENDING予約） | 成功し、書き込みはロック保持中。送信後もPENDINGのため消去の対象外 |

`customer.subscription.updated`と`invoice.paid`は、外部呼び出しを挟まず1回のロック内で完結するため、確認したのは「消去が済んだ後に届く」ケースと状態ガードのみ（段階の間はない）。

## 7. 検証の範囲外（開始条件に残す）
交差テストは、§3の書き込み箇所の一覧にある経路と、§6の入口を対象にした。次は**範囲外**で、コード確認と一覧の固定にとどまる。
- §3の一覧にない新しい書き込み箇所（追加されると構造テストが落ちる）。
- 管理画面（`BookingAdminWeb`）の個別操作のうち、§6の入口以外（予約の確定・取消・復活、メールの再送、オプション付与など）。これらは同じスクリプトロックの中で、行を読み直して書く関数を呼ぶ（§1・§3）。
- 実Spreadsheetの実際の件数・状態。

交差テストで確認できなかった経路が見つかった場合の選択肢（運営者のレビューで決める。**いずれも完了しないまま開始する選択肢はない**）:
1. その入口の交差テストを追加する（実装変更なし）。
2. 保証できない経路は、その行を**消去から明示的に除外**する（消去側の判定に条件を足す）。この場合は別PR、**方針バージョンの更新とdry-run再確認**が必要。
3. 書き込み側に「前回の消去より前の個人情報を書かない」ガード（範囲の分割、または時間のずれを使うガード）を入れる。複数の書き込み関数と方針バージョンの変更を伴うため、必要性が確認できた場合に限る。

## 8. 保証できない／確認していないもの（明示）
- **Spreadsheetの手動編集**（所有者による貼り付け・並べ替え等）は対象外。共有権限が所有者1名であることは#690で確認済み。
- **版の履歴**・メール・カレンダー・Stripe等は、この処理の消去対象外（告知文のとおり）。
- §7の「検証の範囲外」。
- 実Spreadsheet上の件数・状態（dry-runで確認する）。

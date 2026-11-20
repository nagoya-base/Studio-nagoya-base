# Ops: 運営枠の閲覧（Issue #1003・閲覧専用）

Booking Admin（#999）が予約Calendarに置く `internalSlot=1` タグ付きイベントを、Ops の「予約・開催」一覧とホーム「運営枠」に表示する。
登録・変更・取消・メール送信・Calendar変更は Ops にない（編集は Booking Admin の運営枠パネル）。

## 設定（デプロイ前にオーナーが行う）
1. Ops GAS の Script Properties に `OPS_INTERNAL_SLOTS_CALENDAR_ID` を追加。値は Booking Admin の `CALENDAR_ID` と同じ（別Script Properties が必要な理由: Ops は別スクリプト・別デプロイで Booking Admin の設定を参照できないため）。未設定なら「読取先が未設定」と表示（0件とは表示しない）。
2. `appsscript.json` に `calendar.readonly` を追加済み。デプロイ後、所有者本人が専用URLを開き直して**再承認**する（承認前は「読み取り承認が済んでいません」と表示される）。書込みの `calendar` スコープは追加しない。
3. 実行アカウントがそのCalendarを読めること、`getTag('internalSlot')` が Booking Admin 側のタグを読めることを、実カレンダーで1件確認する。

## 仕様
- 要求 `op: internal_slots`（`opsListInternalSlots`）。認可は既存 `OpsAuth`。予約台帳とは別要求で、失敗しても `ok:true` + `state` で返し、予約一覧は影響を受けない。
- `state`: `ready` / `not_configured` / `no_access` / `auth_required` / `read_failed`。`ready` 以外で「0件」とは表示しない。種類・場所タグを読めない枠は `invalid` 件数で示す。
- 範囲は今日(JST)から90日。返す項目: id(`internal:` 名前空間)・種類・場所・件名・日付・開始/終了・リマインド済み（メモ欄は返さない）。
- 運営枠は予約件数・売上KPI・現地払い・鍵・Stripe・#995 SNBC実績の対象外。

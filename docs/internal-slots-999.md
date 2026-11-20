# 運営専用予約枠（Issue #999）

オーナー1人用。SNBCイベント・設営/片付け・清掃/メンテナンス・その他の時間を、Booking Adminから確保する。
新しい基盤は作らず、**予約Calendarにタグ付きイベントを置くだけ**。

## 仕組み（これだけ）
- 確保 = Calendarに `[運営 種別] 件名` のイベント（タグ `internalSlot=1`、`slotType`、`slotPlace`、メモは説明欄）。
- 公開の空き枠判定と `createBooking` の競合判定は、もともとCalendarの全イベントを見る。よって確保した瞬間に一般の空き枠から消え、
  一般予約と同じ時間は**両方向**で登録できない。既存予約の上書き・強制取消はしない。
- SNB / mens / Studio X は同一室（`Availability.gs`）。対象場所は記録・通知用で、衝突判定は場所で分けない。
- 開始・終了は同日内・15分刻み（公開予約の開始刻みと同じ）。
- Bookings台帳に行を作らない → 決済・未収・顧客メール・SwitchBot個別暗証番号（鍵）・顧客リマインド・Ops売上KPI（台帳だけを読む）の対象外。
  ダミーの予約者情報も作らない。SNBC参加費の実績は #995 側で別管理。

## 認可
`adminInternalSlotList/Create/Update/Cancel` は毎回 `isBookingAdminVerified_()` を通す。不許可は `FORBIDDEN` を返し、何も読み書きしない。
一般公開Web App（`Code.gs`）にも公開フォームにも導線・関数はない（Booking Adminのみ配布）。

## 通知（運営者宛のみ・`ADMIN_NOTIFICATION_EMAIL`）
- 前日リマインド: 既存の `sendNextDayReminders`（18時台）と21時台の補完に相乗り。送信済みはタグ `remindedAt` で再送しない。
- 当日分、または前日18時以降に登録した翌日分: 登録直後に通知して `remindedAt` を付ける（重複しない）。
- 変更・取消: そのつど簡素なメール。日時を変えたら `remindedAt` を外し、最終の日時で改めて前日通知する。
- 入室手順・キーボックス・暗証番号は載せない。

## デプロイ
Booking Adminのみ（`scope=admin-only` か `full`）。Bookingsシートの列追加なし（`migrateBookingsSchema` 不要）。画面は `admin/booking/booking-admin.js`（GitHub Pages）。

## 既知の範囲
- 履歴は台帳に残さない（Calendarイベントと運営者宛メールが記録）。取消はイベントの削除で、空き枠に戻る。
- Opsアプリ（`_ops-app`）の一覧には出ない（台帳専用のため。売上KPIに混ざらないことを優先）。
- 登録できる日付は今日から90日先まで（一覧の範囲と同じ。登録した枠は必ず一覧から編集・取消できる）。
- **残余リスク**: 公開Web AppとBooking Adminはスクリプトロックを共有できないため、同一ミリ秒帯に両者が同じ時間を書く競合は完全には防げない。運営枠側は作成・変更の直後に再照会して戻す。公開側の確定処理は変更しない（既存の管理者作成・日程変更と同じ制約。個人運営では登録前の画面確認で十分と判断）。
